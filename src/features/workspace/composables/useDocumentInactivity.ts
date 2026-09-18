import { getCurrentScope, onScopeDispose, toValue, type MaybeRefOrGetter } from "vue";

export const DOCUMENT_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

type Options = {
  element: MaybeRefOrGetter<HTMLElement | null>;
  onIdle: () => void;
  /** Include document-owned controls rendered outside the editor, such as teleported dialogs. */
  isActivityWithinDocument?: (event: Event) => boolean;
};
const activityEvents = [
  "keydown", "input", "pointerdown", "pointermove", "pointerup", "wheel",
  "touchstart", "touchmove", "touchend",
] as const;
const activityListenerOptions = { capture: true, passive: true };

/** Tracks this person's document interaction; server messages and presence never extend the deadline. */
export const useDocumentInactivity = (options: Options) => {
  let activeWindow: Window | null = null;
  let activeDocument: Document | null = null;
  let deadline = 0;
  let timer: number | null = null;

  const stop = () => {
    if (!activeWindow || !activeDocument) return;
    if (timer !== null) activeWindow.clearTimeout(timer);
    timer = null;
    for (const event of activityEvents) {
      activeDocument.removeEventListener(event, handleActivity, activityListenerOptions);
    }
    activeDocument.removeEventListener("visibilitychange", handleWake);
    activeWindow.removeEventListener("focus", handleWake);
    activeWindow.removeEventListener("pageshow", handleWake);
    activeDocument = null;
    activeWindow = null;
  };
  const expireIfDue = () => {
    if (!activeWindow || Date.now() < deadline) return false;
    // Stop before notifying, so concurrent wake/activity events cannot notify twice.
    stop();
    options.onIdle();
    return true;
  };
  const scheduleCheck = () => {
    if (!activeWindow) return;
    if (timer !== null) activeWindow.clearTimeout(timer);
    timer = activeWindow.setTimeout(() => {
      timer = null;
      if (!expireIfDue()) scheduleCheck();
    }, Math.max(0, deadline - Date.now()));
  };
  function handleWake() {
    if (!expireIfDue()) scheduleCheck();
  }
  function handleActivity(event: Event) {
    // A suspended tab can deliver user input before its overdue timer/focus event.
    if (!activeWindow || expireIfDue()) return;
    const element = toValue(options.element);
    const insideEditor = typeof Node !== "undefined" && event.target instanceof Node
      && Boolean(element?.contains(event.target));
    if (insideEditor || options.isActivityWithinDocument?.(event)) {
      deadline = Date.now() + DOCUMENT_INACTIVITY_TIMEOUT_MS;
      // The existing check will rearm against the new absolute deadline. Pointer
      // movement therefore does not allocate a new timer for every event.
    }
  }
  const start = () => {
    if (activeWindow || typeof window === "undefined" || typeof document === "undefined") return;
    activeWindow = window;
    activeDocument = document;
    deadline = Date.now() + DOCUMENT_INACTIVITY_TIMEOUT_MS;
    for (const event of activityEvents) {
      activeDocument.addEventListener(event, handleActivity, activityListenerOptions);
    }
    activeDocument.addEventListener("visibilitychange", handleWake);
    activeWindow.addEventListener("focus", handleWake);
    activeWindow.addEventListener("pageshow", handleWake);
    scheduleCheck();
  };

  if (getCurrentScope()) onScopeDispose(stop);
  return { start, stop };
};
