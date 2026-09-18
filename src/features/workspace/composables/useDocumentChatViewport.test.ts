import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope } from "vue";

import { useDocumentChatViewport } from "./useDocumentChatViewport";

describe("document chat viewport", () => {
  let visualViewport: EventTarget & { height: number; offsetTop: number };
  let mediaQuery: EventTarget & { matches: boolean };
  let fakeWindow: EventTarget & {
    innerHeight: number;
    visualViewport: typeof visualViewport | null;
    matchMedia: ReturnType<typeof vi.fn>;
    requestAnimationFrame: ReturnType<typeof vi.fn>;
    cancelAnimationFrame: ReturnType<typeof vi.fn>;
  };
  let frames: Map<number, FrameRequestCallback>;
  const cleanups: Array<() => void> = [];
  const makeViewport = (options: Parameters<typeof useDocumentChatViewport>[0] = {}) => {
    const scope = effectScope();
    const viewport = scope.run(() => useDocumentChatViewport(options))!;
    cleanups.push(() => scope.stop());
    return { viewport, scope };
  };
  const flushFrames = () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  };

  beforeEach(() => {
    frames = new Map();
    let frameId = 0;
    visualViewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
    mediaQuery = Object.assign(new EventTarget(), { matches: false });
    fakeWindow = Object.assign(new EventTarget(), {
      innerHeight: 844,
      visualViewport,
      matchMedia: vi.fn(() => mediaQuery),
      requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
        frames.set(++frameId, callback);
        return frameId;
      }),
      cancelAnimationFrame: vi.fn((id: number) => frames.delete(id)),
    });
    vi.stubGlobal("window", fakeWindow);
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    vi.unstubAllGlobals();
  });

  it("waits for start, measures synchronously and does not attach duplicate listeners", () => {
    const windowListener = vi.spyOn(fakeWindow, "addEventListener");
    const viewportListener = vi.spyOn(visualViewport, "addEventListener");
    const mediaListener = vi.spyOn(mediaQuery, "addEventListener");
    mediaQuery.matches = true;
    const onResize = vi.fn();
    const { viewport } = makeViewport({ onResize });
    expect(viewport.viewportStyle.value).toBeUndefined();
    expect(windowListener).not.toHaveBeenCalled();

    viewport.start();
    viewport.start();

    expect(viewport.viewportStyle.value).toEqual({
      "--document-info-viewport-height": "844px",
      "--document-info-viewport-top": "0px",
    });
    expect(viewport.isMobileLayout.value).toBe(true);
    expect(fakeWindow.matchMedia).toHaveBeenCalledExactlyOnceWith(
      "(max-width: 600px), (max-width: 960px) and (max-height: 500px)",
    );
    expect(windowListener).toHaveBeenCalledTimes(1);
    expect(viewportListener).toHaveBeenCalledTimes(2);
    expect(mediaListener).toHaveBeenCalledTimes(1);
    expect(fakeWindow.requestAnimationFrame).not.toHaveBeenCalled();
    expect(onResize).toHaveBeenCalledOnce();
  });

  it("coalesces keyboard resize and scroll bursts and reads the latest viewport in the frame", () => {
    const { viewport } = makeViewport({ onResize: () => observations.push(viewport.viewportStyle.value) });
    const observations: Array<typeof viewport.viewportStyle.value> = [];
    viewport.start();
    observations.length = 0;
    visualViewport.height = 540;
    visualViewport.dispatchEvent(new Event("resize"));
    visualViewport.height = 480;
    visualViewport.offsetTop = 32;
    visualViewport.dispatchEvent(new Event("scroll"));
    fakeWindow.dispatchEvent(new Event("resize"));
    visualViewport.height = 420;
    visualViewport.offsetTop = 56;

    expect(fakeWindow.requestAnimationFrame).toHaveBeenCalledOnce();
    expect(viewport.viewportStyle.value?.["--document-info-viewport-height"]).toBe("844px");
    expect(observations).toEqual([]);
    flushFrames();
    expect(observations).toEqual([{
      "--document-info-viewport-height": "420px",
      "--document-info-viewport-top": "56px",
    }]);

    visualViewport.height = 400;
    visualViewport.dispatchEvent(new Event("resize"));
    expect(fakeWindow.requestAnimationFrame).toHaveBeenCalledTimes(2);
    flushFrames();
    expect(viewport.viewportStyle.value?.["--document-info-viewport-height"]).toBe("400px");
  });

  it("updates the mobile layout directly from media-query changes without requiring a window resize", () => {
    const onResize = vi.fn();
    const { viewport } = makeViewport({ onResize });
    viewport.start();
    onResize.mockClear();

    mediaQuery.matches = true;
    mediaQuery.dispatchEvent(new Event("change"));
    expect(viewport.isMobileLayout.value).toBe(true);
    expect(fakeWindow.matchMedia).toHaveBeenCalledOnce();
    mediaQuery.matches = false;
    mediaQuery.dispatchEvent(new Event("change"));
    expect(viewport.isMobileLayout.value).toBe(false);
    expect(fakeWindow.requestAnimationFrame).toHaveBeenCalledOnce();
    flushFrames();
    expect(onResize).toHaveBeenCalledOnce();
  });

  it("uses the window height when visualViewport is unavailable", () => {
    fakeWindow.visualViewport = null;
    fakeWindow.innerHeight = 568;
    const { viewport } = makeViewport();
    viewport.start();
    expect(viewport.viewportStyle.value).toEqual({
      "--document-info-viewport-height": "568px",
      "--document-info-viewport-top": "0px",
    });
    fakeWindow.innerHeight = 320;
    fakeWindow.dispatchEvent(new Event("resize"));
    flushFrames();
    expect(viewport.viewportStyle.value?.["--document-info-viewport-height"]).toBe("320px");
  });

  it.each(["stop", "scope disposal"])("cancels the pending frame and removes every listener on %s", (cleanup) => {
    const removeWindowListener = vi.spyOn(fakeWindow, "removeEventListener");
    const removeViewportListener = vi.spyOn(visualViewport, "removeEventListener");
    const removeMediaListener = vi.spyOn(mediaQuery, "removeEventListener");
    const onResize = vi.fn();
    const { viewport, scope } = makeViewport({ onResize });
    viewport.start();
    onResize.mockClear();
    visualViewport.dispatchEvent(new Event("resize"));
    expect(frames.size).toBe(1);

    if (cleanup === "stop") viewport.stop();
    else scope.stop();
    viewport.stop();
    expect(fakeWindow.cancelAnimationFrame).toHaveBeenCalledExactlyOnceWith(1);
    expect(frames.size).toBe(0);
    expect(removeWindowListener).toHaveBeenCalledTimes(1);
    expect(removeViewportListener).toHaveBeenCalledTimes(2);
    expect(removeMediaListener).toHaveBeenCalledTimes(1);
    visualViewport.dispatchEvent(new Event("resize"));
    visualViewport.dispatchEvent(new Event("scroll"));
    fakeWindow.dispatchEvent(new Event("resize"));
    mediaQuery.matches = true;
    mediaQuery.dispatchEvent(new Event("change"));
    flushFrames();
    expect(onResize).not.toHaveBeenCalled();
    expect(viewport.isMobileLayout.value).toBe(false);
    expect(fakeWindow.requestAnimationFrame).toHaveBeenCalledOnce();
  });

  it("can restart after stop and measures the new viewport before subsequent events", () => {
    const { viewport } = makeViewport();
    viewport.start();
    visualViewport.dispatchEvent(new Event("resize"));
    viewport.stop();
    visualViewport.height = 420;
    visualViewport.offsetTop = 56;
    mediaQuery.matches = true;
    viewport.start();
    expect(viewport.isMobileLayout.value).toBe(true);
    expect(viewport.viewportStyle.value?.["--document-info-viewport-height"]).toBe("420px");
    visualViewport.height = 400;
    visualViewport.dispatchEvent(new Event("resize"));
    flushFrames();
    expect(viewport.viewportStyle.value?.["--document-info-viewport-height"]).toBe("400px");
  });

  it("allows start and stop during server rendering without accessing a window", () => {
    vi.stubGlobal("window", undefined);
    const { viewport } = makeViewport();
    expect(() => { viewport.start(); viewport.stop(); }).not.toThrow();
    expect(viewport.viewportStyle.value).toBeUndefined();
  });
});
