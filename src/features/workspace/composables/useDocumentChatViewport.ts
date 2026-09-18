import { getCurrentScope, onScopeDispose, ref } from "vue";

import { getDocumentInfoViewportStyle } from "../lib/documentInfoViewport";

type Options = { onResize?: () => void };
const viewportQuery = "(max-width: 600px), (max-width: 960px) and (max-height: 500px)";

export const useDocumentChatViewport = (options: Options = {}) => {
  const isMobileLayout = ref(false);
  const viewportStyle = ref<ReturnType<typeof getDocumentInfoViewportStyle>>();
  let activeWindow: Window | null = null;
  let activeViewport: VisualViewport | null = null;
  let mediaQuery: MediaQueryList | null = null;
  let frame: number | null = null;

  const updateViewport = () => {
    if (!activeWindow) return;
    viewportStyle.value = getDocumentInfoViewportStyle(activeWindow.visualViewport, activeWindow.innerHeight);
    isMobileLayout.value = mediaQuery?.matches ?? false;
    options.onResize?.();
  };
  const scheduleViewportUpdate = () => {
    if (!activeWindow || frame !== null) return;
    frame = activeWindow.requestAnimationFrame(() => {
      frame = null;
      updateViewport();
    });
  };
  const handleMediaQueryChange = () => {
    isMobileLayout.value = mediaQuery?.matches ?? false;
    scheduleViewportUpdate();
  };

  const stop = () => {
    if (!activeWindow) return;
    activeWindow.removeEventListener("resize", scheduleViewportUpdate);
    activeViewport?.removeEventListener("resize", scheduleViewportUpdate);
    activeViewport?.removeEventListener("scroll", scheduleViewportUpdate);
    mediaQuery?.removeEventListener("change", handleMediaQueryChange);
    if (frame !== null) activeWindow.cancelAnimationFrame(frame);
    frame = null;
    mediaQuery = null;
    activeViewport = null;
    activeWindow = null;
  };
  const start = () => {
    if (activeWindow || typeof window === "undefined") return;
    activeWindow = window;
    activeViewport = window.visualViewport;
    mediaQuery = window.matchMedia(viewportQuery);
    updateViewport();
    if (!activeWindow || !mediaQuery) return;
    activeWindow.addEventListener("resize", scheduleViewportUpdate);
    activeViewport?.addEventListener("resize", scheduleViewportUpdate);
    activeViewport?.addEventListener("scroll", scheduleViewportUpdate);
    mediaQuery.addEventListener("change", handleMediaQueryChange);
  };

  // Component unmount also disposes its setup scope.
  if (getCurrentScope()) onScopeDispose(stop);
  return { isMobileLayout, viewportStyle, start, stop };
};
