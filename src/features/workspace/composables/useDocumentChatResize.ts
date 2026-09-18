import { computed, getCurrentScope, onScopeDispose, ref, type Ref } from "vue";

type Options = {
  panel: Ref<HTMLElement | null>;
  isMobileLayout: Ref<boolean>;
  onResize?: () => void;
};

export const useDocumentChatResize = ({ panel, isMobileLayout, onResize }: Options) => {
  const preferredWidth = ref<number | null>(null);
  const availableWidth = ref(0);
  const isResizing = ref(false);
  const bounds = computed(() => {
    const maximum = Math.max(0, Math.min(640, availableWidth.value * 0.6, availableWidth.value - 240));
    return { minimum: Math.min(280, maximum), maximum };
  });
  const clampWidth = (value: number) => Math.max(bounds.value.minimum, Math.min(bounds.value.maximum, value));
  const width = computed(() => clampWidth(preferredWidth.value ?? Math.min(380, availableWidth.value * 0.42)));
  const panelStyle = computed(() => !isMobileLayout.value && availableWidth.value > 0
    ? { "--document-chat-width": `${width.value}px` } : undefined);
  let observer: ResizeObserver | null = null;
  let activeWindow: Window | null = null;
  let drag: { target: HTMLElement; pointerId: number; x: number; width: number } | null = null;
  let previousBodyStyle: { cursor: string; userSelect: string } | null = null;
  let pendingWidth: number | null = null;
  let frame: number | null = null;

  const applyWidth = (value: number) => {
    preferredWidth.value = clampWidth(value);
    onResize?.();
  };
  const flushWidth = () => {
    if (pendingWidth !== null) applyWidth(pendingWidth);
    pendingWidth = null;
  };
  const stopDrag = () => {
    const previousDrag = drag;
    drag = null;
    isResizing.value = false;
    if (frame !== null) activeWindow?.cancelAnimationFrame(frame);
    frame = null;
    flushWidth();
    activeWindow?.removeEventListener("blur", stopDrag);
    if (previousBodyStyle && typeof document !== "undefined") {
      document.body.style.cursor = previousBodyStyle.cursor;
      document.body.style.userSelect = previousBodyStyle.userSelect;
    }
    previousBodyStyle = null;
    if (previousDrag?.target.hasPointerCapture?.(previousDrag.pointerId)) {
      previousDrag.target.releasePointerCapture(previousDrag.pointerId);
    }
  };
  const measure = () => {
    const previousWidth = width.value;
    availableWidth.value = panel.value?.parentElement?.getBoundingClientRect().width ?? 0;
    if (width.value !== previousWidth) onResize?.();
  };
  const stop = () => {
    stopDrag();
    observer?.disconnect();
    observer = null;
    activeWindow?.removeEventListener("resize", measure);
    activeWindow = null;
  };
  const start = () => {
    stop();
    if (typeof window === "undefined" || isMobileLayout.value || !panel.value?.parentElement) return;
    activeWindow = window;
    measure();
    activeWindow.addEventListener("resize", measure);
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(measure);
      observer.observe(panel.value.parentElement);
    }
  };
  const startDrag = (event: PointerEvent) => {
    if (isMobileLayout.value || !activeWindow || event.button !== 0 || !event.isPrimary
      || !(event.currentTarget instanceof HTMLElement)) return;
    stopDrag();
    measure();
    event.preventDefault();
    const target = event.currentTarget;
    target.focus({ preventScroll: true });
    drag = { target, pointerId: event.pointerId, x: event.clientX, width: width.value };
    try { target.setPointerCapture(event.pointerId); }
    catch { drag = null; return; }
    isResizing.value = true;
    previousBodyStyle = { cursor: document.body.style.cursor, userSelect: document.body.style.userSelect };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    activeWindow.addEventListener("blur", stopDrag);
  };
  const moveDrag = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId || !activeWindow) return;
    pendingWidth = drag.width + drag.x - event.clientX;
    if (frame !== null) return;
    frame = activeWindow.requestAnimationFrame(() => {
      frame = null;
      flushWidth();
    });
  };
  const endDrag = (event: PointerEvent) => {
    if (drag?.pointerId !== event.pointerId) return;
    if (event.type === "pointerup") pendingWidth = drag.width + drag.x - event.clientX;
    stopDrag();
  };
  const handleKeydown = (event: KeyboardEvent) => {
    if (isMobileLayout.value || !activeWindow) return;
    const step = event.shiftKey ? 48 : 16;
    const nextWidth = event.key === "ArrowLeft" ? width.value + step
      : event.key === "ArrowRight" ? width.value - step
      : event.key === "Home" ? bounds.value.minimum
      : event.key === "End" ? bounds.value.maximum : null;
    if (nextWidth === null) return;
    event.preventDefault();
    applyWidth(nextWidth);
  };
  const reset = () => {
    stopDrag();
    preferredWidth.value = null;
    onResize?.();
  };

  if (getCurrentScope()) onScopeDispose(stop);
  return { width, bounds, panelStyle, isResizing, start, stop, startDrag, moveDrag, endDrag, handleKeydown, reset };
};
