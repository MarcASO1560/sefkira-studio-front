import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, shallowRef } from "vue";

import { useDocumentChatResize } from "./useDocumentChatResize";

class FakeHTMLElement extends EventTarget {
  parentElement: FakeHTMLElement | null = null;
  width = 1000;
  captures = new Set<number>();
  focus = vi.fn();
  getBoundingClientRect = vi.fn(() => ({ width: this.width }) as DOMRect);
  setPointerCapture = vi.fn((id: number) => { this.captures.add(id); });
  hasPointerCapture = vi.fn((id: number) => this.captures.has(id));
  releasePointerCapture = vi.fn((id: number) => {
    this.captures.delete(id);
    this.dispatchEvent(Object.assign(new Event("lostpointercapture"), { pointerId: id }));
  });
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  disconnected = false;
  observe = vi.fn();
  disconnect = vi.fn(() => { this.disconnected = true; });

  constructor(private callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }

  trigger() {
    if (!this.disconnected) this.callback([], this as unknown as ResizeObserver);
  }
}

const pointerEvent = (type: string, options: Partial<PointerEvent> = {}) => Object.assign(
  new Event(type, { cancelable: true }),
  { pointerId: 7, clientX: 1000, button: 0, isPrimary: true, ...options },
) as PointerEvent;
const keyboardEvent = (key: string, shiftKey = false) => Object.assign(
  new Event("keydown", { cancelable: true }), { key, shiftKey },
) as KeyboardEvent;

describe("document chat resize", () => {
  let host: FakeHTMLElement;
  let panel: FakeHTMLElement;
  let grip: FakeHTMLElement;
  let bodyStyle: { cursor: string; userSelect: string };
  let frames: Map<number, FrameRequestCallback>;
  let fakeWindow: EventTarget & {
    requestAnimationFrame: ReturnType<typeof vi.fn>;
    cancelAnimationFrame: ReturnType<typeof vi.fn>;
  };
  const cleanups: Array<() => void> = [];

  const makeResize = (options: { mobile?: boolean; onResize?: () => void } = {}) => {
    const scope = effectScope();
    const panelRef = shallowRef<HTMLElement | null>(panel as unknown as HTMLElement);
    const isMobileLayout = shallowRef(options.mobile ?? false);
    const resize = scope.run(() => useDocumentChatResize({
      panel: panelRef, isMobileLayout, onResize: options.onResize,
    }))!;
    grip.addEventListener("pointerdown", (event) => resize.startDrag(event as PointerEvent));
    grip.addEventListener("lostpointercapture", (event) => resize.endDrag(event as PointerEvent));
    cleanups.push(() => scope.stop());
    return { resize, scope, panelRef, isMobileLayout };
  };
  const beginDrag = (options: Partial<PointerEvent> = {}) => {
    const event = pointerEvent("pointerdown", options);
    grip.dispatchEvent(event);
    return event;
  };
  const flushFrames = () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  };

  beforeEach(() => {
    host = new FakeHTMLElement();
    panel = new FakeHTMLElement();
    panel.parentElement = host;
    grip = new FakeHTMLElement();
    bodyStyle = { cursor: "crosshair", userSelect: "text" };
    frames = new Map();
    let frameId = 0;
    fakeWindow = Object.assign(new EventTarget(), {
      requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
        frames.set(++frameId, callback);
        return frameId;
      }),
      cancelAnimationFrame: vi.fn((id: number) => frames.delete(id)),
    });
    FakeResizeObserver.instances = [];
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("document", { body: { style: bodyStyle } });
    vi.stubGlobal("HTMLElement", FakeHTMLElement);
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    vi.unstubAllGlobals();
  });

  it("waits for start and measures the editor region instead of the panel", () => {
    const listener = vi.spyOn(fakeWindow, "addEventListener");
    const onResize = vi.fn();
    panel.width = 380;
    const { resize } = makeResize({ onResize });
    expect(resize.panelStyle.value).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
    expect(FakeResizeObserver.instances).toHaveLength(0);

    resize.start();
    expect(resize.width.value).toBe(380);
    expect(resize.bounds.value).toEqual({ minimum: 280, maximum: 600 });
    expect(resize.panelStyle.value).toEqual({ "--document-chat-width": "380px" });
    expect(host.getBoundingClientRect).toHaveBeenCalledOnce();
    expect(panel.getBoundingClientRect).not.toHaveBeenCalled();
    expect(onResize).toHaveBeenCalledOnce();
    expect(FakeResizeObserver.instances[0]!.observe).toHaveBeenCalledExactlyOnceWith(host);
    expect(listener).toHaveBeenCalledExactlyOnceWith("resize", expect.any(Function));
  });

  it.each([
    [1400, 280, 640],
    [1000, 280, 600],
    [800, 280, 480],
    [500, 260, 260],
    [300, 60, 60],
    [200, 0, 0],
  ])("keeps canvas space when the editor region is %ipx wide", (available, minimum, maximum) => {
    host.width = available;
    const { resize } = makeResize();
    resize.start();
    resize.handleKeydown(keyboardEvent("End"));
    expect(resize.bounds.value).toEqual({ minimum, maximum });
    expect(resize.width.value).toBe(maximum);
    expect(resize.width.value).toBeLessThanOrEqual(available * 0.6);
    if (available >= 240) expect(available - resize.width.value).toBeGreaterThanOrEqual(240);
    resize.handleKeydown(keyboardEvent("Home"));
    expect(resize.width.value).toBe(minimum);
  });

  it("coalesces pointer moves into one frame and commits the final pointerup coordinate", () => {
    const onResize = vi.fn();
    const { resize } = makeResize({ onResize });
    resize.start();
    onResize.mockClear();
    expect(beginDrag().defaultPrevented).toBe(true);
    expect(grip.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(grip.setPointerCapture).toHaveBeenCalledExactlyOnceWith(7);
    expect(resize.isResizing.value).toBe(true);
    expect(bodyStyle).toEqual({ cursor: "col-resize", userSelect: "none" });

    resize.moveDrag(pointerEvent("pointermove", { clientX: 960 }));
    resize.moveDrag(pointerEvent("pointermove", { clientX: 920 }));
    expect(fakeWindow.requestAnimationFrame).toHaveBeenCalledOnce();
    expect(onResize).not.toHaveBeenCalled();
    expect(resize.width.value).toBe(380);
    flushFrames();
    expect(resize.width.value).toBe(460);
    expect(onResize).toHaveBeenCalledOnce();

    resize.moveDrag(pointerEvent("pointermove", { clientX: 900 }));
    resize.endDrag(pointerEvent("pointerup", { clientX: 880 }));
    expect(resize.width.value).toBe(500);
    expect(fakeWindow.cancelAnimationFrame).toHaveBeenCalledExactlyOnceWith(2);
    expect(frames.size).toBe(0);
    expect(grip.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(7);
    expect(resize.isResizing.value).toBe(false);
    expect(bodyStyle).toEqual({ cursor: "crosshair", userSelect: "text" });
  });

  it("clamps dragging to the minimum and maximum without losing the drag origin", () => {
    const { resize } = makeResize();
    resize.start();
    beginDrag();
    resize.moveDrag(pointerEvent("pointermove", { clientX: -1000 }));
    flushFrames();
    expect(resize.width.value).toBe(600);
    resize.moveDrag(pointerEvent("pointermove", { clientX: 2000 }));
    flushFrames();
    expect(resize.width.value).toBe(280);
    resize.moveDrag(pointerEvent("pointermove", { clientX: 980 }));
    flushFrames();
    expect(resize.width.value).toBe(400);
  });

  it("ignores secondary buttons, non-primary pointers and events from other pointers", () => {
    const { resize } = makeResize();
    resize.start();
    expect(beginDrag({ button: 2 }).defaultPrevented).toBe(false);
    expect(beginDrag({ isPrimary: false }).defaultPrevented).toBe(false);
    expect(resize.isResizing.value).toBe(false);
    expect(grip.setPointerCapture).not.toHaveBeenCalled();
    beginDrag();
    resize.moveDrag(pointerEvent("pointermove", { pointerId: 99, clientX: 900 }));
    resize.endDrag(pointerEvent("pointerup", { pointerId: 99, clientX: 900 }));
    expect(fakeWindow.requestAnimationFrame).not.toHaveBeenCalled();
    expect(resize.width.value).toBe(380);
    expect(resize.isResizing.value).toBe(true);
    expect(grip.hasPointerCapture(7)).toBe(true);
  });

  it.each(["pointercancel", "lostpointercapture", "blur", "stop", "scope disposal"])(
    "releases the drag, frame, and exact body styles on %s", (reason) => {
      const onResize = vi.fn();
      const removeListener = vi.spyOn(fakeWindow, "removeEventListener");
      const { resize, scope } = makeResize({ onResize });
      resize.start();
      const observer = FakeResizeObserver.instances[0]!;
      beginDrag();
      resize.moveDrag(pointerEvent("pointermove", { clientX: 880 }));
      expect(frames.size).toBe(1);
      if (reason === "pointercancel") resize.endDrag(pointerEvent("pointercancel"));
      else if (reason === "lostpointercapture") {
        grip.captures.delete(7);
        grip.dispatchEvent(pointerEvent("lostpointercapture"));
      } else if (reason === "blur") fakeWindow.dispatchEvent(new Event("blur"));
      else if (reason === "stop") resize.stop();
      else scope.stop();

      expect(resize.isResizing.value).toBe(false);
      expect(bodyStyle).toEqual({ cursor: "crosshair", userSelect: "text" });
      expect(frames.size).toBe(0);
      expect(fakeWindow.cancelAnimationFrame).toHaveBeenCalledExactlyOnceWith(1);
      expect(grip.hasPointerCapture(7)).toBe(false);
      expect(removeListener).toHaveBeenCalledWith("blur", expect.any(Function));
      expect(resize.width.value).toBe(500);
      onResize.mockClear();
      resize.moveDrag(pointerEvent("pointermove", { clientX: 800 }));
      fakeWindow.dispatchEvent(new Event("blur"));
      flushFrames();
      expect(onResize).not.toHaveBeenCalled();
      if (reason === "stop" || reason === "scope disposal") {
        expect(observer.disconnect).toHaveBeenCalledOnce();
        host.width = 500;
        observer.trigger();
        fakeWindow.dispatchEvent(new Event("resize"));
        expect(resize.width.value).toBe(500);
      }
    },
  );

  it("restores empty body styles and does not release someone else's pointer capture", () => {
    bodyStyle.cursor = "";
    bodyStyle.userSelect = "";
    const { resize } = makeResize();
    resize.start();
    beginDrag();
    grip.captures.delete(7);
    resize.endDrag(pointerEvent("pointercancel"));
    expect(bodyStyle).toEqual({ cursor: "", userSelect: "" });
    expect(grip.releasePointerCapture).not.toHaveBeenCalled();
  });

  it("recovers when pointer capture is unavailable without changing body styles", () => {
    const listener = vi.spyOn(fakeWindow, "addEventListener");
    const { resize } = makeResize();
    resize.start();
    listener.mockClear();
    grip.setPointerCapture.mockImplementation(() => { throw new Error("capture unavailable"); });
    expect(() => beginDrag()).not.toThrow();
    expect(resize.isResizing.value).toBe(false);
    expect(bodyStyle).toEqual({ cursor: "crosshair", userSelect: "text" });
    resize.moveDrag(pointerEvent("pointermove", { clientX: 900 }));
    expect(fakeWindow.requestAnimationFrame).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it("notifies composer reflow when parent sizing changes the effective width and preserves preference", () => {
    const observedWidths: number[] = [];
    const onResize = vi.fn(() => { observedWidths.push(resize.width.value); });
    const { resize } = makeResize({ onResize });
    resize.start();
    resize.handleKeydown(keyboardEvent("End"));
    expect(resize.width.value).toBe(600);
    expect(observedWidths).toEqual([380, 600]);
    onResize.mockClear();
    observedWidths.length = 0;

    host.width = 500;
    fakeWindow.dispatchEvent(new Event("resize"));
    expect(resize.width.value).toBe(260);
    host.width = 1000;
    fakeWindow.dispatchEvent(new Event("resize"));
    expect(resize.width.value).toBe(600);
    host.width = 700;
    FakeResizeObserver.instances[0]!.trigger();
    expect(resize.width.value).toBe(420);
    // The caller can remeasure wrapped composer text using the newly clamped width.
    expect(observedWidths).toEqual([260, 600, 420]);
    FakeResizeObserver.instances[0]!.trigger();
    fakeWindow.dispatchEvent(new Event("resize"));
    expect(onResize).toHaveBeenCalledTimes(3);

    host.width = 1400;
    FakeResizeObserver.instances[0]!.trigger();
    expect(resize.width.value).toBe(600);
    expect(resize.panelStyle.value).toEqual({ "--document-chat-width": "600px" });
    expect(observedWidths).toEqual([260, 600, 420, 600]);
    // A wider editor region does not need composer reflow if the chat width stays fixed.
    host.width = 1800;
    FakeResizeObserver.instances[0]!.trigger();
    expect(resize.width.value).toBe(600);
    expect(onResize).toHaveBeenCalledTimes(4);
  });

  it("supports keyboard steps, shift steps and boundary keys, leaving other keys untouched", () => {
    const { resize } = makeResize();
    resize.start();
    const left = keyboardEvent("ArrowLeft");
    resize.handleKeydown(left);
    expect(left.defaultPrevented).toBe(true);
    expect(resize.width.value).toBe(396);
    resize.handleKeydown(keyboardEvent("ArrowRight", true));
    expect(resize.width.value).toBe(348);
    resize.handleKeydown(keyboardEvent("Home"));
    expect(resize.width.value).toBe(280);
    resize.handleKeydown(keyboardEvent("End"));
    expect(resize.width.value).toBe(600);
    const enter = keyboardEvent("Enter");
    resize.handleKeydown(enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(resize.width.value).toBe(600);
  });

  it("reset ends the drag and restores the default responsive width", () => {
    const onResize = vi.fn();
    const { resize } = makeResize({ onResize });
    resize.start();
    beginDrag();
    resize.moveDrag(pointerEvent("pointermove", { clientX: 800 }));
    resize.reset();
    expect(resize.isResizing.value).toBe(false);
    expect(frames.size).toBe(0);
    expect(bodyStyle).toEqual({ cursor: "crosshair", userSelect: "text" });
    expect(resize.width.value).toBe(380);
    expect(onResize).toHaveBeenCalled();
    host.width = 800;
    fakeWindow.dispatchEvent(new Event("resize"));
    expect(resize.width.value).toBe(336);
  });

  it("disconnects previous effects when restarted and preserves the width across stops", () => {
    const { resize } = makeResize();
    resize.start();
    const oldObserver = FakeResizeObserver.instances[0]!;
    resize.handleKeydown(keyboardEvent("End"));
    resize.start();
    expect(oldObserver.disconnect).toHaveBeenCalledOnce();
    expect(FakeResizeObserver.instances).toHaveLength(2);
    resize.stop();
    resize.stop();
    expect(FakeResizeObserver.instances[1]!.disconnect).toHaveBeenCalledOnce();
    host.width = 1400;
    resize.start();
    expect(resize.width.value).toBe(600);
  });

  it("does not attach desktop effects or intercept gestures in mobile layout", () => {
    const listener = vi.spyOn(fakeWindow, "addEventListener");
    const { resize } = makeResize({ mobile: true });
    resize.start();
    expect(FakeResizeObserver.instances).toHaveLength(0);
    expect(listener).not.toHaveBeenCalled();
    expect(resize.panelStyle.value).toBeUndefined();
    expect(beginDrag().defaultPrevented).toBe(false);
    const key = keyboardEvent("ArrowLeft");
    resize.handleKeydown(key);
    expect(key.defaultPrevented).toBe(false);
    expect(grip.focus).not.toHaveBeenCalled();
    expect(fakeWindow.requestAnimationFrame).not.toHaveBeenCalled();
    expect(bodyStyle).toEqual({ cursor: "crosshair", userSelect: "text" });
  });

  it("switches to mobile by cleaning the active desktop drag and observer", () => {
    const { resize, isMobileLayout } = makeResize();
    resize.start();
    beginDrag();
    resize.moveDrag(pointerEvent("pointermove", { clientX: 900 }));
    isMobileLayout.value = true;
    resize.start();
    expect(resize.isResizing.value).toBe(false);
    expect(resize.panelStyle.value).toBeUndefined();
    expect(frames.size).toBe(0);
    expect(bodyStyle).toEqual({ cursor: "crosshair", userSelect: "text" });
    expect(FakeResizeObserver.instances).toHaveLength(1);
    expect(FakeResizeObserver.instances[0]!.disconnect).toHaveBeenCalledOnce();
    const key = keyboardEvent("End");
    resize.handleKeydown(key);
    expect(key.defaultPrevented).toBe(false);
  });

  it("allows desktop resizing without ResizeObserver and tolerates a missing panel", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const { resize, panelRef } = makeResize();
    panelRef.value = null;
    expect(() => resize.start()).not.toThrow();
    expect(resize.panelStyle.value).toBeUndefined();
    panelRef.value = panel as unknown as HTMLElement;
    resize.start();
    host.width = 500;
    fakeWindow.dispatchEvent(new Event("resize"));
    expect(resize.width.value).toBe(260);
  });

  it("does not access DOM globals during server rendering or disposal", () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("HTMLElement", undefined);
    vi.stubGlobal("ResizeObserver", undefined);
    const { resize, scope } = makeResize();
    expect(() => {
      resize.start();
      resize.startDrag(pointerEvent("pointerdown"));
      resize.moveDrag(pointerEvent("pointermove"));
      resize.endDrag(pointerEvent("pointerup"));
      resize.handleKeydown(keyboardEvent("End"));
      resize.reset();
      resize.stop();
      scope.stop();
    }).not.toThrow();
    expect(resize.panelStyle.value).toBeUndefined();
    expect(resize.isResizing.value).toBe(false);
  });
});
