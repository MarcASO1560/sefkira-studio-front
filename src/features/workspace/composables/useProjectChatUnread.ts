import { getCurrentInstance, onBeforeUnmount, onMounted, ref, toValue, watch, type MaybeRefOrGetter } from "vue";
import { DocumentChatHttpError, getProjectChatUnread } from "../../../lib/api";

type Options = {
  projectId: MaybeRefOrGetter<string>;
  accountKey: MaybeRefOrGetter<string>;
  enabled: MaybeRefOrGetter<boolean>;
  onAccessDenied?: () => void;
};

/** Invalidations fetch authoritative counts; event replays never increment badges. */
export const useProjectChatUnread = (options: Options) => {
  const counts = ref<Record<string, number>>({});
  let started = false;
  let disposed = false;
  let generation = 0;
  let poll: ReturnType<typeof setTimeout> | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  let request: Promise<void> | null = null;
  let refreshAgain = false;
  const active = () => started && !disposed && !!toValue(options.projectId) && toValue(options.enabled);
  const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
  const clearTimers = () => {
    if (poll !== null) clearTimeout(poll);
    if (debounce !== null) clearTimeout(debounce);
    poll = debounce = null;
  };
  const refresh = (): Promise<void> => {
    if (!active() || !visible()) return Promise.resolve();
    if (request) { refreshAgain = true; return request; }
    const epoch = generation;
    const projectId = toValue(options.projectId);
    const current = new AbortController();
    controller = current;
    const task = (async () => {
      try {
        const summary = await getProjectChatUnread(projectId, { signal: current.signal });
        if (epoch !== generation || !active()) return;
        if (!Array.isArray(summary.documents)) return;
        const next: Record<string, number> = {};
        for (const entry of summary.documents) {
          if (typeof entry.resource_id !== "string" || !Number.isSafeInteger(entry.unread_count) || entry.unread_count < 0) continue;
          if (entry.unread_count > 0) next[entry.resource_id] = entry.unread_count;
        }
        counts.value = next;
      } catch (error) {
        if (epoch !== generation || current.signal.aborted || !active()) return;
        if (error instanceof DocumentChatHttpError && [401, 403, 404].includes(error.status)) {
          counts.value = {};
          options.onAccessDenied?.();
        }
        // A temporary network failure preserves the last confirmed indicators.
      } finally {
        if (epoch === generation) {
          request = null;
          controller = null;
          if (refreshAgain) { refreshAgain = false; void refresh(); }
        }
      }
    })();
    request = task;
    return task;
  };
  const schedulePoll = () => {
    if (poll !== null) clearTimeout(poll);
    poll = null;
    if (!active()) return;
    poll = setTimeout(() => { poll = null; void refresh(); schedulePoll(); }, 30000);
  };
  const receiveRealtime = (payload: unknown) => {
    if (!active() || !payload || typeof payload !== "object" ||
      (payload as { project_id?: unknown }).project_id !== toValue(options.projectId)) return;
    if (debounce !== null) clearTimeout(debounce);
    debounce = setTimeout(() => { debounce = null; void refresh(); }, 180);
  };
  const refreshOnReturn = () => { if (visible()) void refresh(); };
  const reset = () => {
    generation++;
    clearTimers();
    controller?.abort();
    controller = null;
    request = null;
    refreshAgain = false;
    counts.value = {};
    if (active()) { void refresh(); schedulePoll(); }
  };
  const stopWatch = watch([
    () => toValue(options.projectId), () => toValue(options.accountKey), () => toValue(options.enabled),
  ], reset);
  const start = () => {
    if (started || disposed) return;
    started = true;
    reset();
    if (typeof window !== "undefined") {
      window.addEventListener("focus", refreshOnReturn);
      window.addEventListener("online", refreshOnReturn);
      window.addEventListener("pageshow", refreshOnReturn);
    }
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", refreshOnReturn);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    started = false;
    reset();
    stopWatch();
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", refreshOnReturn);
      window.removeEventListener("online", refreshOnReturn);
      window.removeEventListener("pageshow", refreshOnReturn);
    }
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", refreshOnReturn);
  };
  if (getCurrentInstance()) { onMounted(start); onBeforeUnmount(dispose); }
  return { counts, refresh, receiveRealtime, start, dispose };
};
