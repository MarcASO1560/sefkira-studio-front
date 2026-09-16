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
  sendEditorActivity: (
    kind: ProjectEditorActivityKind,
    payload: Record<string, unknown>,
  ) => void;
  setResourceId: (resourceId: string | null) => void;
};

const INITIAL_SUBSCRIPTION_TIMEOUT_MS = 8000;
const TOKEN_REFRESH_MARGIN_MS = 60000;
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

const fetchProjectPresenceConfig = async (projectId: string) => {
  const response = await fetch(
    `${API_V1_URL}/events/presence/config?project_id=${encodeURIComponent(projectId)}`,
    {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    },
  );
  if (!response.ok) {
    throw new Error(`Realtime presence configuration failed with ${response.status}`);
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
  void client.removeChannel(channel).finally(() => client.disconnect());
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
        const expiresAt = Date.parse(activeConfig.expires_at);
        if (Number.isFinite(expiresAt) && expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
          return activeConfig.access_token;
        }

        const refreshedConfig = await fetchRealtimeConfig();
        if (!isSupabaseConfig(refreshedConfig)) {
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

  const publishPresence = async () => {
    if (closed || !subscribed || !channel || !activeConfig) return;
    if (!activeResourceId) {
      if (tracked) {
        await channel.untrack();
        tracked = false;
      }
      return;
    }

    await channel.track({
      ...activeConfig.user,
      client_id: clientId,
      resource_id: activeResourceId,
      online_at: new Date().toISOString(),
    });
    tracked = true;
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
    if (closed || !subscribed || !channel || !activeConfig || !activeResourceId) {
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

  if (typeof window !== "undefined") {
    void (async () => {
      try {
        const config = await fetchProjectPresenceConfig(projectId);
        if (closed || !isProjectPresenceConfig(config)) {
          onSync({});
          return;
        }
        activeConfig = config;

        const getAccessToken = async () => {
          if (!activeConfig) return null;
          const expiresAt = Date.parse(activeConfig.expires_at);
          if (Number.isFinite(expiresAt) && expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
            return activeConfig.access_token;
          }

          const refreshedConfig = await fetchProjectPresenceConfig(projectId);
          if (!isProjectPresenceConfig(refreshedConfig)) return null;
          activeConfig = refreshedConfig;
          return activeConfig.access_token;
        };

        const realtimeUrl = `${config.supabase_url.replace(/^http/i, "ws")}/realtime/v1`;
        client = new RealtimeClient(realtimeUrl, {
          accessToken: getAccessToken,
          params: { apikey: config.publishable_key },
          // Browser-tab timers are throttled in the background. Run the
          // heartbeat in Supabase's worker when the browser supports it.
          worker: typeof window.Worker === "function",
        });
        await client.setAuth(config.access_token);
        if (closed) {
          client.disconnect();
          client = null;
          return;
        }
        channel = client.channel(config.channel, {
          config: {
            broadcast: { ack: false, self: false },
            private: true,
            presence: { enabled: true, key: config.user.id },
          },
        });
        channel.on("broadcast", { event: "editor.activity" }, ({ payload }) => {
          if (closed || !isObject(payload)) return;

          const kind = payload.kind;
          const validKind =
            kind === "cursor" ||
            kind === "document" ||
            kind === "pixels" ||
            kind === "selection" ||
            kind === "sync-request";
          if (
            !validKind ||
            typeof payload.client_id !== "string" ||
            payload.client_id === clientId ||
            typeof payload.resource_id !== "string" ||
            typeof payload.sent_at !== "string" ||
            typeof payload.sequence !== "number" ||
            !Number.isSafeInteger(payload.sequence) ||
            payload.sequence < 1 ||
            !isObject(payload.user) ||
            typeof payload.user.id !== "string" ||
            typeof payload.user.email !== "string" ||
            (payload.user.username !== undefined &&
              payload.user.username !== null &&
              typeof payload.user.username !== "string") ||
            (payload.user.avatar_pixel_art !== undefined &&
              payload.user.avatar_pixel_art !== null &&
              !isObject(payload.user.avatar_pixel_art)) ||
            !isObject(payload.payload)
          ) {
            return;
          }

          onEditorActivity(payload as ProjectEditorActivity);
        });
        channel.on("presence", { event: "sync" }, () => {
          if (!closed && channel) {
            onSync(groupProjectPresenceState(channel.presenceState()));
          }
        });
        channel.subscribe((status) => {
          if (closed) return;
          if (status === "SUBSCRIBED") {
            subscribed = true;
            queuePresencePublish();
            sendEditorActivity("sync-request", {});
          } else if (
            status === "CLOSED" ||
            status === "CHANNEL_ERROR" ||
            status === "TIMED_OUT"
          ) {
            subscribed = false;
            onSync({});
          }
        });
      } catch (error) {
        if (!closed) {
          console.warn("Supabase Presence unavailable.", error);
          onSync({});
        }
      }
    })();
  }

  return {
    clientId,
    sendEditorActivity,
    setResourceId: (resourceId) => {
      const changed = activeResourceId !== resourceId;
      activeResourceId = resourceId;
      queuePresencePublish();
      if (changed && resourceId) sendEditorActivity("sync-request", {});
    },
    close: () => {
      if (closed) return;
      closed = true;
      subscribed = false;
      onSync({});

      const currentChannel = channel;
      const currentClient = client;
      channel = null;
      client = null;
      if (currentChannel && currentClient) {
        const untrack = tracked
          ? currentChannel.untrack().catch(() => undefined)
          : Promise.resolve();
        tracked = false;
        void untrack.finally(() => removeSupabaseConnection(currentClient, currentChannel));
      }
    },
  };
};
