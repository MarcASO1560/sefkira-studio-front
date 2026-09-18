import { RealtimeClient, type RealtimeChannel } from "@supabase/realtime-js";

import {
  API_V1_URL,
  type PixelAvatarData,
  type ProjectFolderPublic,
  type ProjectResourcePublic,
} from "./api";

export const REALTIME_EVENT_NAMES = [
  "workspace.updated",
  "project.updated",
  "project.deleted",
  "project.access.updated",
  "project.share.updated",
  "document.chat.created",
] as const;

export type RealtimeEventName = (typeof REALTIME_EVENT_NAMES)[number];
export type RealtimeEventPayload = Record<string, unknown> & {
  actor_id?: string;
  created_at?: string;
  event_id?: number;
  project_id?: string;
};
export type RealtimeEventHandlers = Partial<
  Record<RealtimeEventName, (payload: RealtimeEventPayload) => void>
>;

type RealtimeConfig = {
  enabled: boolean;
  supabase_url?: string | null;
  publishable_key?: string | null;
  access_token?: string | null;
  expires_at?: string | null;
  channel?: string | null;
  latest_event_id: number;
};

type EnabledRealtimeConfig = RealtimeConfig & {
  supabase_url: string;
  publishable_key: string;
  access_token: string;
  expires_at: string;
  channel: string;
};

type ProjectPresenceUser = {
  id: string;
  username?: string | null;
  email: string;
  avatar_url?: string | null;
  avatar_pixel_art?: PixelAvatarData | null;
};

type ProjectPresenceConfig = {
  enabled: boolean;
  supabase_url?: string | null;
  publishable_key?: string | null;
  access_token?: string | null;
  expires_at?: string | null;
  channel?: string | null;
  user?: ProjectPresenceUser | null;
};

type EnabledProjectPresenceConfig = ProjectPresenceConfig & {
  supabase_url: string;
  publishable_key: string;
  access_token: string;
  expires_at: string;
  channel: string;
  user: ProjectPresenceUser;
};

export type ProjectPresenceMember = ProjectPresenceUser & {
  client_id?: string;
  resource_id: string;
  online_at?: string;
};

export type ProjectPresenceSnapshot = Record<string, ProjectPresenceMember[]>;

export type ProjectEditorActivityKind =
  | "cursor"
  | "document"
  | "pixels"
  | "selection"
  | "sync-request";

export type ProjectEditorActivity = {
  client_id: string;
  kind: ProjectEditorActivityKind;
  payload: Record<string, unknown>;
  resource_id: string;
  sent_at: string;
  sequence: number;
  user: ProjectPresenceUser;
};

type PersistedRealtimeEvent = {
  id: number;
  event: string;
  data: Record<string, unknown>;
  created_at: string;
};

export type RealtimeConnection = {
  close: () => void;
};

export type ProjectPresenceConnection = RealtimeConnection & {
  clientId: string;
  refresh: () => Promise<void>;
  sendEditorActivity: (
    kind: ProjectEditorActivityKind,
    payload: Record<string, unknown>,
  ) => void;
  setResourceId: (resourceId: string | null) => void;
};

const INITIAL_SUBSCRIPTION_TIMEOUT_MS = 8000;
const TOKEN_REFRESH_MARGIN_MS = 60000;
const PROJECT_PRESENCE_LEASE_MS = 15000;
const PROJECT_PRESENCE_CHECK_INTERVAL_MS = 10000;
const MAX_CATCH_UP_BATCHES = 20;

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const createRealtimeClientId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `realtime-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const fetchRealtimeConfig = async () => {
  const response = await fetch(`${API_V1_URL}/events/config`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Realtime configuration failed with ${response.status}`);
  }
  return (await response.json()) as RealtimeConfig;
};

class ProjectPresenceAccessError extends Error {
  constructor(readonly status: number) {
    super(`Realtime presence configuration failed with ${status}`);
  }
}

const fetchProjectPresenceConfig = async (projectId: string, signal: AbortSignal) => {
  const response = await fetch(
    `${API_V1_URL}/events/presence/config?project_id=${encodeURIComponent(projectId)}`,
    {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    },
  );
  if (!response.ok) {
    throw new ProjectPresenceAccessError(response.status);
  }
  return (await response.json()) as ProjectPresenceConfig;
};

const isSupabaseConfig = (
  config: RealtimeConfig,
): config is EnabledRealtimeConfig =>
  config.enabled &&
  Boolean(config.supabase_url) &&
  Boolean(config.publishable_key) &&
  Boolean(config.access_token) &&
  Boolean(config.expires_at) &&
  Boolean(config.channel);

const isProjectPresenceConfig = (
  config: ProjectPresenceConfig,
): config is EnabledProjectPresenceConfig =>
  config.enabled &&
  Boolean(config.supabase_url) &&
  Boolean(config.publishable_key) &&
  Boolean(config.access_token) &&
  Boolean(config.expires_at) &&
  Boolean(config.channel) &&
  Boolean(config.user?.id) &&
  Boolean(config.user?.email);

const normalizeProjectPresenceMember = (
  value: unknown,
): ProjectPresenceMember | null => {
  if (!isObject(value)) return null;

  const id = typeof value.id === "string" ? value.id : "";
  const email = typeof value.email === "string" ? value.email : "";
  const resourceId = typeof value.resource_id === "string" ? value.resource_id : "";
  if (!id || !email || !resourceId) return null;

  return {
    id,
    email,
    username: typeof value.username === "string" ? value.username : null,
    avatar_url: typeof value.avatar_url === "string" ? value.avatar_url : null,
    avatar_pixel_art: isObject(value.avatar_pixel_art)
      ? (value.avatar_pixel_art as PixelAvatarData)
      : null,
    client_id: typeof value.client_id === "string" ? value.client_id : undefined,
    resource_id: resourceId,
    online_at: typeof value.online_at === "string" ? value.online_at : undefined,
  };
};

export const groupProjectPresenceState = (
  state: Record<string, unknown[]>,
): ProjectPresenceSnapshot => {
  const grouped = new Map<string, Map<string, ProjectPresenceMember>>();

  for (const presences of Object.values(state)) {
    for (const presence of presences) {
      const member = normalizeProjectPresenceMember(presence);
      if (!member) continue;

      const members = grouped.get(member.resource_id) || new Map();
      const existing = members.get(member.id);
      if (
        !existing ||
        (member.online_at || "").localeCompare(existing.online_at || "") >= 0
      ) {
        members.set(member.id, member);
      }
      grouped.set(member.resource_id, members);
    }
  }

  return Object.fromEntries(
    [...grouped.entries()].map(([resourceId, members]) => [
      resourceId,
      [...members.values()].sort((left, right) =>
        (left.username || left.email || left.id).localeCompare(
          right.username || right.email || right.id,
        ),
      ),
    ]),
  );
};

export const aggregateProjectPresenceByFolder = (
  resourcePresence: ProjectPresenceSnapshot,
  folders: Array<Pick<ProjectFolderPublic, "id" | "parent_id">>,
  resources: Array<Pick<ProjectResourcePublic, "id" | "folder_id">>,
): ProjectPresenceSnapshot => {
  const foldersById = new Map(folders.map((folder) => [folder.id, folder]));
  const membersByFolder = new Map<string, Map<string, ProjectPresenceMember>>();

  for (const resource of resources) {
    const members = resourcePresence[resource.id] || [];
    if (members.length === 0) continue;

    let folderId = resource.folder_id || null;
    const visitedFolderIds = new Set<string>();
    while (folderId && !visitedFolderIds.has(folderId)) {
      visitedFolderIds.add(folderId);
      const folderMembers = membersByFolder.get(folderId) || new Map();
      for (const member of members) {
        const existing = folderMembers.get(member.id);
        if (
          !existing ||
          (member.online_at || "").localeCompare(existing.online_at || "") >= 0
        ) {
          folderMembers.set(member.id, member);
        }
      }
      membersByFolder.set(folderId, folderMembers);
      folderId = foldersById.get(folderId)?.parent_id || null;
    }
  }

  return Object.fromEntries(
    [...membersByFolder.entries()].map(([folderId, members]) => [
      folderId,
      [...members.values()].sort((left, right) =>
        (left.username || left.email || left.id).localeCompare(
          right.username || right.email || right.id,
        ),
      ),
    ]),
  );
};

const parseSsePayload = (event: Event): RealtimeEventPayload => {
  try {
    const payload = JSON.parse((event as MessageEvent<string>).data) as unknown;
    return isObject(payload) ? payload : {};
  } catch {
    return {};
  }
};

const connectSseFallback = (
  handlers: RealtimeEventHandlers,
  isClosed: () => boolean,
) => {
  if (isClosed() || typeof EventSource === "undefined") {
    return () => undefined;
  }

  const source = new EventSource(`${API_V1_URL}/events/stream`, {
    withCredentials: true,
  });
  for (const eventName of REALTIME_EVENT_NAMES) {
    const handler = handlers[eventName];
    if (handler) {
      source.addEventListener(eventName, (event) => handler(parseSsePayload(event)));
    }
  }

  return () => source.close();
};

const removeSupabaseConnection = (
  client: RealtimeClient,
  channel: RealtimeChannel,
) => {
  void client.removeChannel(channel).catch(() => undefined);
  // Closing an idle document must not keep heartbeats alive while a leave
  // acknowledgement is delayed or the socket is unavailable.
  void client.disconnect();
};

export const connectUserRealtime = (
  handlers: RealtimeEventHandlers,
): RealtimeConnection => {
  let closed = false;
  let cleanup: () => void = () => undefined;

  const installCleanup = (nextCleanup: () => void) => {
    cleanup();
    if (closed) {
      nextCleanup();
      return;
    }
    cleanup = nextCleanup;
  };

  const useSseFallback = () => {
    installCleanup(connectSseFallback(handlers, () => closed));
  };

  void (async () => {
    try {
      const config = await fetchRealtimeConfig();
      if (closed) {
        return;
      }
      if (!isSupabaseConfig(config)) {
        useSseFallback();
        return;
      }
      let activeConfig: EnabledRealtimeConfig = config;

      let lastEventId = Math.max(0, activeConfig.latest_event_id || 0);
      const seenEventIds = new Set<number>();
      let catchUpPromise: Promise<void> | null = null;

      const dispatch = (eventName: string, rawPayload: unknown) => {
        if (closed || !REALTIME_EVENT_NAMES.includes(eventName as RealtimeEventName)) {
          return;
        }

        const payload = isObject(rawPayload) ? rawPayload : {};
        const eventId =
          typeof payload.event_id === "number" && Number.isSafeInteger(payload.event_id)
            ? payload.event_id
            : null;
        if (eventId !== null) {
          if (seenEventIds.has(eventId)) {
            return;
          }
          seenEventIds.add(eventId);
          lastEventId = Math.max(lastEventId, eventId);
          if (seenEventIds.size > 500) {
            const recentIds = [...seenEventIds].slice(-250);
            seenEventIds.clear();
            recentIds.forEach((id) => seenEventIds.add(id));
          }
        }

        handlers[eventName as RealtimeEventName]?.(payload);
      };

      const catchUp = () => {
        if (catchUpPromise || closed) {
          return catchUpPromise;
        }

        catchUpPromise = (async () => {
          try {
            for (let batch = 0; batch < MAX_CATCH_UP_BATCHES && !closed; batch += 1) {
              const response = await fetch(
                `${API_V1_URL}/events/pending?after_event_id=${encodeURIComponent(lastEventId)}`,
                {
                  credentials: "same-origin",
                  headers: { Accept: "application/json" },
                },
              );
              if (!response.ok) {
                return;
              }

              const events = (await response.json()) as PersistedRealtimeEvent[];
              if (!Array.isArray(events)) {
                return;
              }
              for (const event of events) {
                dispatch(event.event, {
                  ...(isObject(event.data) ? event.data : {}),
                  event_id: event.id,
                  created_at: event.created_at,
                });
              }
              if (events.length < 50) {
                return;
              }
            }
          } catch {
            // The normal periodic refresh remains the final recovery path.
          }
        })().finally(() => {
          catchUpPromise = null;
        });
        return catchUpPromise;
      };

      const getAccessToken = async () => {
        if (closed) return null;
        const expiresAt = Date.parse(activeConfig.expires_at);
        if (Number.isFinite(expiresAt) && expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
          return activeConfig.access_token;
        }

        const refreshedConfig = await fetchRealtimeConfig();
        if (closed || !isSupabaseConfig(refreshedConfig)) {
          return null;
        }
        activeConfig = refreshedConfig;
        return activeConfig.access_token;
      };

      const realtimeUrl = `${activeConfig.supabase_url.replace(/^http/i, "ws")}/realtime/v1`;
      const client = new RealtimeClient(realtimeUrl, {
        accessToken: getAccessToken,
        params: { apikey: activeConfig.publishable_key },
      });
      // RealtimeClient starts resolving callback-based auth when the socket connects.
      // Resolve the initial token first so a private channel cannot race its first join
      // with an anonymous payload and be rejected by Realtime Authorization.
      await client.setAuth(activeConfig.access_token);
      if (closed) {
        client.disconnect();
        return;
      }
      const channel = client.channel(activeConfig.channel, {
        config: { private: true },
      });
      for (const eventName of REALTIME_EVENT_NAMES) {
        if (handlers[eventName]) {
          channel.on("broadcast", { event: eventName }, ({ payload }) => {
            dispatch(eventName, payload);
          });
        }
      }

      installCleanup(() => removeSupabaseConnection(client, channel));

      const subscribed = await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (result: boolean) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeoutId);
          resolve(result);
        };
        const timeoutId = window.setTimeout(
          () => finish(false),
          INITIAL_SUBSCRIPTION_TIMEOUT_MS,
        );

        channel.subscribe((status) => {
          if (status === "SUBSCRIBED") {
            finish(true);
            void catchUp();
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            finish(false);
          }
        });
      });

      if (!subscribed && !closed) {
        useSseFallback();
      }
    } catch (error) {
      if (!closed) {
        console.warn("Supabase Realtime unavailable; using SSE fallback.", error);
        useSseFallback();
      }
    }
  })();

  return {
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      cleanup();
      cleanup = () => undefined;
    },
  };
};

export const connectProjectPresence = (
  projectId: string,
  onSync: (snapshot: ProjectPresenceSnapshot) => void,
  initialResourceId: string | null = null,
  onEditorActivity: (activity: ProjectEditorActivity) => void = () => undefined,
  onAccessDenied: (status: number) => void = () => undefined,
): ProjectPresenceConnection => {
  let closed = false;
  let activeResourceId = initialResourceId;
  const clientId = createRealtimeClientId();
  let activitySequence = 0;
  let activeConfig: EnabledProjectPresenceConfig | null = null;
  let client: RealtimeClient | null = null;
  let channel: RealtimeChannel | null = null;
  let subscribed = false;
  let tracked = false;
  let roomGeneration = 0;
  let validationGeneration = 0;
  let verifiedAt: number | null = null;
  let verifying = false;
  let refreshPromise: Promise<void> | null = null;
  let refreshAbort: AbortController | null = null;
  let refreshKeepsLeaseActive = false;
  let leaseInterval: ReturnType<typeof setInterval> | null = null;
  let leaseExpiry: ReturnType<typeof setTimeout> | null = null;

  const isOnline = () => typeof navigator === "undefined" || navigator.onLine !== false;
  const hasFreshLease = () => {
    const expiresAt = Date.parse(activeConfig?.expires_at || "");
    const elapsed = verifiedAt === null ? Infinity : Date.now() - verifiedAt;
    return !closed && isOnline() && activeConfig !== null && verifiedAt !== null &&
      elapsed >= 0 && elapsed < PROJECT_PRESENCE_LEASE_MS &&
      Number.isFinite(expiresAt) && expiresAt > Date.now();
  };

  // Realtime caches RLS for each joined room. Retire the entire old socket,
  // rather than letting delayed callbacks/pushes leak across a project epoch.
  const retireRoom = () => {
    roomGeneration += 1;
    const oldChannel = channel;
    const oldClient = client;
    const wasTracked = tracked;
    channel = null;
    client = null;
    activeConfig = null;
    verifiedAt = null;
    subscribed = false;
    tracked = false;
    if (leaseExpiry !== null) clearTimeout(leaseExpiry);
    leaseExpiry = null;
    if (oldClient) {
      if (oldChannel) {
        if (wasTracked) void oldChannel.untrack().catch(() => undefined);
        void oldClient.removeChannel(oldChannel).catch(() => undefined);
      }
      // Do not wait for an unsubscribe acknowledgement from a failing socket.
      oldClient.disconnect();
    }
    onSync({});
  };

  const verifyLease = (config: EnabledProjectPresenceConfig) => {
    verifiedAt = Date.now();
    if (leaseExpiry !== null) clearTimeout(leaseExpiry);
    leaseExpiry = setTimeout(() => {
      leaseExpiry = null;
      if (!closed && !hasFreshLease()) {
        retireRoom();
        void refresh();
      }
    }, Math.min(PROJECT_PRESENCE_LEASE_MS, Date.parse(config.expires_at) - Date.now()));
  };

  const canUseRoom = () => {
    if (closed || !subscribed || !channel || !activeConfig) return false;
    if (!hasFreshLease()) {
      retireRoom();
      void refresh();
      return false;
    }
    return !verifying;
  };

  const publishPresence = async () => {
    if (!canUseRoom() || !channel || !activeConfig) return;
    const currentChannel = channel;
    if (!activeResourceId) {
      if (tracked) {
        tracked = false;
        await currentChannel.untrack();
      }
      return;
    }

    // Mark the dispatched track immediately: a later resource exit must send
    // untrack even if this track's acknowledgement is delayed or lost.
    tracked = true;
    await currentChannel.track({
      ...activeConfig.user,
      client_id: clientId,
      resource_id: activeResourceId,
      online_at: new Date().toISOString(),
    });
  };

  const queuePresencePublish = () => {
    void publishPresence().catch((error) => {
      if (!closed) console.warn("Supabase Presence update failed.", error);
    });
  };

  const sendEditorActivity = (
    kind: ProjectEditorActivityKind,
    payload: Record<string, unknown>,
  ) => {
    if (!canUseRoom() || !channel || !activeConfig || !activeResourceId) {
      return;
    }

    activitySequence += 1;
    const includePixelAvatar =
      kind === "sync-request" ||
      (kind === "document" && typeof payload.target_client_id === "string");
    void channel
      .send({
        type: "broadcast",
        event: "editor.activity",
        payload: {
          client_id: clientId,
          kind,
          payload,
          resource_id: activeResourceId,
          sent_at: new Date().toISOString(),
          sequence: activitySequence,
          user: {
            id: activeConfig.user.id,
            email: activeConfig.user.email,
            username: activeConfig.user.username,
            avatar_url: activeConfig.user.avatar_url,
            ...(includePixelAvatar
              ? { avatar_pixel_art: activeConfig.user.avatar_pixel_art }
              : {}),
          },
        } satisfies ProjectEditorActivity,
      })
      .catch((error) => {
        if (!closed) console.warn("Supabase collaboration update failed.", error);
      });
  };

  const installRoom = async (config: EnabledProjectPresenceConfig, interrupted: Promise<never>) => {
    const currentGeneration = roomGeneration;
    activeConfig = config;
    verifyLease(config);
    const realtimeUrl = `${config.supabase_url.replace(/^http/i, "ws")}/realtime/v1`;
    const currentClient = new RealtimeClient(realtimeUrl, {
      accessToken: async () => {
        if (closed || currentGeneration !== roomGeneration) return null;
        const expiresAt = Date.parse(activeConfig?.expires_at || "");
        if (!hasFreshLease() || expiresAt - Date.now() <= TOKEN_REFRESH_MARGIN_MS) await refresh();
        return currentGeneration === roomGeneration && hasFreshLease() ? activeConfig!.access_token : null;
      },
      params: { apikey: config.publishable_key },
      // Workers keep heartbeats alive in background tabs, but a stale lease
      // still requires a fresh API authorization before activity is exposed.
      worker: typeof window.Worker === "function",
    });
    client = currentClient;
    await Promise.race([currentClient.setAuth(config.access_token), interrupted]);
    if (closed || currentGeneration !== roomGeneration || currentClient !== client) return;
    const currentChannel = currentClient.channel(config.channel, {
      config: {
        broadcast: { ack: false, self: false },
        private: true,
        presence: { enabled: true, key: config.user.id },
      },
    });
    channel = currentChannel;
    const isCurrentRoom = () => !closed && currentGeneration === roomGeneration && currentChannel === channel;
    currentChannel.on("broadcast", { event: "editor.activity" }, ({ payload }) => {
      if (!isCurrentRoom() || !canUseRoom() || !isObject(payload)) return;
      const kind = payload.kind;
      const validKind = kind === "cursor" || kind === "document" || kind === "pixels" ||
        kind === "selection" || kind === "sync-request";
      if (
        !validKind || typeof payload.client_id !== "string" || payload.client_id === clientId ||
        typeof payload.resource_id !== "string" || typeof payload.sent_at !== "string" ||
        typeof payload.sequence !== "number" || !Number.isSafeInteger(payload.sequence) || payload.sequence < 1 ||
        !isObject(payload.user) || typeof payload.user.id !== "string" || typeof payload.user.email !== "string" ||
        (payload.user.username !== undefined && payload.user.username !== null && typeof payload.user.username !== "string") ||
        (payload.user.avatar_pixel_art !== undefined && payload.user.avatar_pixel_art !== null && !isObject(payload.user.avatar_pixel_art)) ||
        !isObject(payload.payload)
      ) return;
      onEditorActivity(payload as ProjectEditorActivity);
    });
    currentChannel.on("presence", { event: "sync" }, () => {
      if (isCurrentRoom() && canUseRoom()) onSync(groupProjectPresenceState(currentChannel.presenceState()));
    });
    verifying = false;
    currentChannel.subscribe((status) => {
      if (!isCurrentRoom()) return;
      if (status === "SUBSCRIBED") {
        subscribed = true;
        queuePresencePublish();
        sendEditorActivity("sync-request", {});
      } else if (status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        subscribed = false;
        onSync({});
      }
    });
  };

  const refresh = (keepFreshLeaseActive = false): Promise<void> => {
    if (closed || typeof window === "undefined") return Promise.resolve();
    if (!isOnline()) {
      retireRoom();
      return Promise.resolve();
    }
    if (refreshPromise) {
      if (keepFreshLeaseActive || !refreshKeepsLeaseActive) return refreshPromise;
      // An explicit access-change check supersedes a background renewal: its
      // response may have been authorized before the change was announced.
      verifying = true;
      validationGeneration += 1;
      refreshAbort?.abort();
      refreshAbort = null;
      refreshPromise = null;
      refreshKeepsLeaseActive = false;
    }
    if (activeConfig && !hasFreshLease()) retireRoom();
    const currentValidation = ++validationGeneration;
    const controller = new AbortController();
    refreshAbort = controller;
    // The periodic renewal must not freeze live ink during a slow HTTP check.
    // Only an already-authorized, unexpired lease may remain active. Explicit
    // access-change checks still pause immediately; expiry/errors retire it.
    refreshKeepsLeaseActive = keepFreshLeaseActive && hasFreshLease();
    verifying = !refreshKeepsLeaseActive;
    const nextPromise = (async () => {
      let abortListener: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(new Error("Realtime presence verification was interrupted or timed out."));
        controller.signal.addEventListener("abort", abortListener, { once: true });
      });
      const timeout = setTimeout(() => controller.abort(), INITIAL_SUBSCRIPTION_TIMEOUT_MS);
      try {
        const config = await Promise.race([fetchProjectPresenceConfig(projectId, controller.signal), aborted]);
        if (closed || currentValidation !== validationGeneration) return;
        if (!isOnline() || !config.enabled) {
          retireRoom();
          return;
        }
        if (!isProjectPresenceConfig(config) || !Number.isFinite(Date.parse(config.expires_at)) || Date.parse(config.expires_at) <= Date.now()) {
          throw new Error("Realtime presence configuration is invalid or expired.");
        }
        const sameRoom = client && channel && activeConfig &&
          activeConfig.channel === config.channel && activeConfig.supabase_url === config.supabase_url &&
          activeConfig.publishable_key === config.publishable_key && activeConfig.user.id === config.user.id;
        if (!sameRoom) {
          retireRoom();
          await installRoom(config, aborted);
        } else {
          const currentClient = client!;
          const currentGeneration = roomGeneration;
          activeConfig = config;
          verifyLease(config);
          await Promise.race([currentClient.setAuth(config.access_token), aborted]);
          if (closed || currentValidation !== validationGeneration || currentGeneration !== roomGeneration) return;
          verifying = false;
          if (canUseRoom() && channel) onSync(groupProjectPresenceState(channel.presenceState()));
        }
      } catch (error) {
        if (closed || currentValidation !== validationGeneration) return;
        if (error instanceof ProjectPresenceAccessError && [401, 403, 404].includes(error.status)) {
          close();
          onAccessDenied(error.status);
        } else {
          retireRoom();
          console.warn("Supabase Presence verification unavailable; activity paused until retry.", error);
        }
      } finally {
        clearTimeout(timeout);
        if (abortListener) controller.signal.removeEventListener("abort", abortListener);
        if (currentValidation === validationGeneration) {
          verifying = false;
          refreshAbort = null;
        }
      }
    })().finally(() => {
      if (refreshPromise === nextPromise) { refreshPromise = null; refreshKeepsLeaseActive = false; }
    });
    refreshPromise = nextPromise;
    return nextPromise;
  };

  const recheckAccess = () => { void refresh(); };
  const renewActiveLease = () => { void refresh(true); };
  const pauseOffline = () => {
    validationGeneration += 1;
    refreshAbort?.abort();
    refreshAbort = null;
    refreshPromise = null;
    refreshKeepsLeaseActive = false;
    verifying = false;
    retireRoom();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    validationGeneration += 1;
    refreshAbort?.abort();
    refreshAbort = null;
    if (leaseInterval !== null) clearInterval(leaseInterval);
    leaseInterval = null;
    if (typeof window !== "undefined") {
      window.removeEventListener?.("online", recheckAccess);
      window.removeEventListener?.("offline", pauseOffline);
    }
    if (typeof document !== "undefined") document.removeEventListener?.("visibilitychange", recheckAccess);
    retireRoom();
  };

  if (typeof window !== "undefined") {
    leaseInterval = setInterval(renewActiveLease, PROJECT_PRESENCE_CHECK_INTERVAL_MS);
    window.addEventListener?.("online", recheckAccess);
    window.addEventListener?.("offline", pauseOffline);
    if (typeof document !== "undefined") document.addEventListener?.("visibilitychange", recheckAccess);
    void refresh();
  }

  return {
    clientId,
    refresh,
    sendEditorActivity,
    setResourceId: (resourceId) => {
      const changed = activeResourceId !== resourceId;
      activeResourceId = resourceId;
      queuePresencePublish();
      if (changed && resourceId) sendEditorActivity("sync-request", {});
    },
    close,
  };
};
