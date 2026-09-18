import { computed, getCurrentInstance, onBeforeUnmount, onMounted, ref, toValue, watch, type MaybeRefOrGetter } from "vue";
import {
  DocumentChatHttpError, getDocumentChatMessages, postDocumentChatMessage,
  type DocumentChatAuthor, type DocumentChatMessagePublic,
} from "../../../lib/api";

export type DocumentChatMessage = Omit<DocumentChatMessagePublic, "id"> & {
  id: number | null;
  status: "sent" | "pending" | "failed";
  error?: string;
};
type Options = {
  projectId: MaybeRefOrGetter<string>;
  resourceId: MaybeRefOrGetter<string>;
  user: MaybeRefOrGetter<DocumentChatAuthor | null>;
};
type Context = { projectId: string; resourceId: string; user: DocumentChatAuthor };
const storagePrefix = "sefkirastudio.document-chat.pending.v1";
const messageKey = (message: Pick<DocumentChatMessage, "author" | "client_message_id">) =>
  `${message.author.id}:${message.client_message_id}`;
const compareMessages = (a: DocumentChatMessage, b: DocumentChatMessage) => {
  if (a.id !== null && b.id !== null) return a.id - b.id;
  if (a.id !== null) return -1;
  if (b.id !== null) return 1;
  return a.created_at.localeCompare(b.created_at) || a.client_message_id.localeCompare(b.client_message_id);
};
const isDenied = (error: unknown) => error instanceof DocumentChatHttpError && [401, 403, 404].includes(error.status);
const newClientId = () => {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const value = Math.floor(Math.random() * 16);
    return (character === "x" ? value : (value & 3) | 8).toString(16);
  });
};

/** A document conversation, independent of canvas operations and revision saves. */
export const useDocumentChat = (options: Options) => {
  const messages = ref<DocumentChatMessage[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const hasOlder = ref(false);
  const isOpen = ref(false);
  const unreadCount = ref(0);
  const accessDenied = ref(false);
  const sending = computed(() => messages.value.some((message) => message.status === "pending"));
  let started = false;
  let disposed = false;
  let generation = 0;
  let context: Context | null = null;
  let initialized = false;
  // Advance this only from ordered server pages, never from a live event. Live
  // delivery can be out of order; its maximum ID is not a safe catch-up cursor.
  let forwardCursor: number | null = null;
  let beforeCursor: number | null = null;
  let syncing: Promise<void> | null = null;
  let syncAgain = false;
  let olderLoading = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const controllers = new Set<AbortController>();
  const inFlight = new Map<string, Promise<boolean>>();

  const storageKey = (current: Context) => `${storagePrefix}:${current.user.id}:${current.projectId}:${current.resourceId}`;
  const isCurrent = (epoch: number) => !disposed && started && epoch === generation && !!context;
  const makeController = () => { const controller = new AbortController(); controllers.add(controller); return controller; };
  const clearTimer = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  const persistPending = () => {
    if (!context || typeof window === "undefined") return;
    try {
      const pending = messages.value.filter((message) => message.status !== "sent" && message.author.id === context!.user.id);
      // One receipt per storage entry: a second tab must not overwrite or clear
      // another tab's unacknowledged messages with its own queue snapshot.
      for (const message of pending) {
        window.localStorage.setItem(`${storageKey(context)}:${message.client_message_id}`, JSON.stringify(message));
      }
    } catch {
      error.value = "This browser cannot store pending messages. Keep the chat open until they are sent.";
    }
  };
  const restorePending = (current: Context): DocumentChatMessage[] => {
    if (typeof window === "undefined") return [];
    try {
      const prefix = `${storageKey(current)}:`;
      const keys = Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.key(index))
        .filter((key): key is string => !!key && key.startsWith(prefix));
      const unique = new Map<string, DocumentChatMessage>();
      for (const key of keys) {
        let value: unknown;
        try { value = JSON.parse(window.localStorage.getItem(key) || "null"); }
        catch { continue; }
        if (!value || typeof value !== "object") continue;
        const message = value as Partial<DocumentChatMessage>;
        if (message.author?.id !== current.user.id || message.project_id !== current.projectId ||
          message.resource_id !== current.resourceId || typeof message.body !== "string" ||
          !message.body.trim() || message.body.length > 2000 || typeof message.client_message_id !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(message.client_message_id) ||
          typeof message.created_at !== "string" || !Number.isFinite(Date.parse(message.created_at)) ||
          key !== `${prefix}${message.client_message_id}`) continue;
        const restored: DocumentChatMessage = {
          id: null, project_id: current.projectId, resource_id: current.resourceId,
          client_message_id: message.client_message_id, author: current.user,
          body: message.body, created_at: message.created_at, status: "failed",
          error: "Waiting to reconnect. You can retry this message.",
        };
        unique.set(messageKey(restored), restored);
      }
      return [...unique.values()].sort(compareMessages);
    } catch { return []; }
  };
  const merge = (incoming: DocumentChatMessagePublic[], countUnread: boolean) => {
    if (!context) return;
    const existing = new Map(messages.value.map((message) => [messageKey(message), message]));
    for (const message of incoming) {
      if (message.project_id !== context.projectId || message.resource_id !== context.resourceId) continue;
      const key = messageKey(message);
      if (!existing.has(key) && countUnread && !isOpen.value && message.author.id !== context.user.id) unreadCount.value++;
      existing.set(key, { ...message, status: "sent" });
      if (message.author.id === context.user.id && typeof window !== "undefined") {
        try { window.localStorage.removeItem(`${storageKey(context)}:${message.client_message_id}`); }
        catch { /* The persisted receipt is safe to retry if its cleanup fails. */ }
      }
    }
    messages.value = [...existing.values()].sort(compareMessages);
    persistPending();
  };
  const denyAccess = () => {
    accessDenied.value = true;
    error.value = "You no longer have access to this document's chat.";
    clearTimer();
    for (const controller of controllers) controller.abort();
  };
  const retryMessage = (clientMessageId: string): Promise<boolean> => {
    if (!context || !started || disposed || accessDenied.value) return Promise.resolve(false);
    const current = context;
    const epoch = generation;
    const row = messages.value.find((message) => message.client_message_id === clientMessageId && message.author.id === current.user.id);
    if (!row || row.status === "sent") return Promise.resolve(!!row);
    const key = messageKey(row);
    const existingRequest = inFlight.get(key);
    if (existingRequest) return existingRequest;
    const controller = makeController();
    row.status = "pending";
    delete row.error;
    persistPending();
    const request = (async () => {
      try {
        const accepted = await postDocumentChatMessage(current.projectId, current.resourceId,
          { client_message_id: row.client_message_id, body: row.body }, { signal: controller.signal });
        if (!isCurrent(epoch)) return false;
        merge([accepted], false);
        return true;
      } catch (cause) {
        if (!isCurrent(epoch)) return false;
        const pending = messages.value.find((message) => messageKey(message) === key);
        // A realtime echo can acknowledge the send even if its HTTP response was lost.
        if (pending?.status === "sent") return true;
        if (pending) {
          pending.status = "failed";
          pending.error = isDenied(cause) ? "Access to this document was revoked." : "Message not sent. Retry when your connection returns.";
          persistPending();
        }
        if (isDenied(cause)) denyAccess();
        return false;
      } finally {
        controllers.delete(controller);
        if (isCurrent(epoch)) inFlight.delete(key);
      }
    })();
    inFlight.set(key, request);
    return request;
  };
  const retryPending = async (epoch: number) => {
    for (const message of messages.value.filter((row) => row.status === "failed")) {
      if (!isCurrent(epoch) || accessDenied.value) return;
      await retryMessage(message.client_message_id);
    }
  };
  const catchUp = (): Promise<void> => {
    if (!context || !started || disposed || accessDenied.value) return Promise.resolve();
    if (syncing) { syncAgain = true; return syncing; }
    const current = context;
    const epoch = generation;
    const controller = makeController();
    const initial = !initialized;
    if (initial) loading.value = true;
    const task = (async () => {
      try {
        if (!initialized) {
          const page = await getDocumentChatMessages(current.projectId, current.resourceId, { limit: 50, signal: controller.signal });
          if (!isCurrent(epoch)) return;
          merge(page.messages, false);
          hasOlder.value = page.has_more;
          beforeCursor = page.next_before_id;
          forwardCursor = page.messages.at(-1)?.id ?? 0;
          initialized = true;
        } else {
          let more = true;
          while (more && isCurrent(epoch) && !accessDenied.value) {
            const previous = forwardCursor ?? 0;
            const page = await getDocumentChatMessages(current.projectId, current.resourceId,
              { limit: 100, afterId: previous, signal: controller.signal });
            if (!isCurrent(epoch)) return;
            merge(page.messages, true);
            const last = page.messages.at(-1)?.id;
            if (last !== undefined && last > previous) forwardCursor = last;
            more = page.has_more && last !== undefined && last > previous;
          }
        }
        if (!isCurrent(epoch)) return;
        error.value = null;
        await retryPending(epoch);
      } catch (cause) {
        if (!isCurrent(epoch)) return;
        if (isDenied(cause)) denyAccess();
        else if (!controller.signal.aborted) error.value = "Couldn't load the chat. Check your connection and retry.";
      } finally {
        controllers.delete(controller);
        if (isCurrent(epoch)) {
          loading.value = false;
          syncing = null;
          if (syncAgain && !accessDenied.value) { syncAgain = false; void catchUp(); }
        }
      }
    })();
    syncing = task;
    return task;
  };
  const loadOlder = async () => {
    if (!context || !started || disposed || accessDenied.value || olderLoading || !hasOlder.value || beforeCursor === null) return;
    const current = context;
    const epoch = generation;
    const controller = makeController();
    olderLoading = true;
    loading.value = true;
    try {
      const page = await getDocumentChatMessages(current.projectId, current.resourceId,
        { limit: 50, beforeId: beforeCursor, signal: controller.signal });
      if (!isCurrent(epoch)) return;
      merge(page.messages, false);
      hasOlder.value = page.has_more;
      beforeCursor = page.next_before_id;
      error.value = null;
    } catch (cause) {
      if (!isCurrent(epoch)) return;
      if (isDenied(cause)) denyAccess();
      else if (!controller.signal.aborted) error.value = "Couldn't load older messages. Please retry.";
    } finally {
      controllers.delete(controller);
      if (isCurrent(epoch)) { olderLoading = false; loading.value = false; }
    }
  };
  const receiveRealtime = (payload: unknown) => {
    if (!context || !started || disposed || accessDenied.value || !payload || typeof payload !== "object") return;
    const event = payload as { project_id?: unknown; resource_id?: unknown; message?: unknown };
    if (event.project_id !== context.projectId || event.resource_id !== context.resourceId || !event.message || typeof event.message !== "object") return;
    const message = event.message as DocumentChatMessagePublic;
    if (!Number.isSafeInteger(message.id) || message.id < 1 || typeof message.client_message_id !== "string" ||
      typeof message.body !== "string" || message.body.length > 2000 || typeof message.created_at !== "string" ||
      !Number.isFinite(Date.parse(message.created_at)) || !message.author || typeof message.author.id !== "string") return;
    merge([message], initialized);
    void catchUp();
  };
  const schedulePoll = () => {
    clearTimer();
    if (!started || disposed || !context || accessDenied.value) return;
    timer = setTimeout(() => {
      timer = null;
      if (typeof document === "undefined" || document.visibilityState !== "hidden") void catchUp();
      schedulePoll();
    }, isOpen.value ? 5000 : 15000);
  };
  const resetContext = () => {
    generation++;
    clearTimer();
    for (const controller of controllers) controller.abort();
    controllers.clear();
    inFlight.clear();
    syncing = null;
    syncAgain = false;
    olderLoading = false;
    initialized = false;
    forwardCursor = null;
    beforeCursor = null;
    loading.value = false;
    hasOlder.value = false;
    error.value = null;
    accessDenied.value = false;
    unreadCount.value = 0;
    isOpen.value = false;
    const projectId = toValue(options.projectId);
    const resourceId = toValue(options.resourceId);
    const user = toValue(options.user);
    context = projectId && resourceId && user?.id ? { projectId, resourceId, user } : null;
    messages.value = context ? restorePending(context) : [];
    if (context && started && !disposed) { void catchUp(); schedulePoll(); }
  };
  const refreshOnReturn = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    void catchUp();
  };
  const setOpen = (open: boolean) => {
    if (disposed) return;
    isOpen.value = open;
    if (open) { unreadCount.value = 0; void catchUp(); }
    schedulePoll();
  };
  const sendMessage = (body: string): Promise<boolean> => {
    const text = body.trim();
    if (!context || !started || disposed || accessDenied.value || !text || text.length > 2000) return Promise.resolve(false);
    const user = toValue(options.user) || context.user;
    const message: DocumentChatMessage = {
      id: null, client_message_id: newClientId(), project_id: context.projectId,
      resource_id: context.resourceId, author: user, body: text,
      created_at: new Date().toISOString(), status: "failed",
    };
    messages.value = [...messages.value, message];
    persistPending();
    return retryMessage(message.client_message_id);
  };
  const stopWatch = watch([() => toValue(options.projectId), () => toValue(options.resourceId), () => toValue(options.user)?.id || ""],
    () => { if (started && !disposed) resetContext(); });
  const start = () => {
    if (started || disposed) return;
    started = true;
    resetContext();
    if (typeof window !== "undefined") {
      window.addEventListener("focus", refreshOnReturn);
      window.addEventListener("online", refreshOnReturn);
      window.addEventListener("pageshow", refreshOnReturn);
    }
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", refreshOnReturn);
  };
  const dispose = () => {
    if (disposed) return;
    persistPending();
    disposed = true;
    started = false;
    generation++;
    clearTimer();
    for (const controller of controllers) controller.abort();
    controllers.clear();
    stopWatch();
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", refreshOnReturn);
      window.removeEventListener("online", refreshOnReturn);
      window.removeEventListener("pageshow", refreshOnReturn);
    }
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", refreshOnReturn);
  };
  if (getCurrentInstance()) { onMounted(start); onBeforeUnmount(dispose); }
  return { messages, loading, error, hasOlder, isOpen, unreadCount, sending, accessDenied,
    setOpen, sendMessage, retryMessage, loadOlder, receiveRealtime, catchUp, start, dispose };
};
