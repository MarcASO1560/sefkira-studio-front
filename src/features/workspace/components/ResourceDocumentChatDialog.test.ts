// @ts-expect-error Node's test-only built-in is available without browser typings.
import { readFileSync } from "node:fs";

import * as vue from "vue";
import { compileScript, parse } from "vue/compiler-sfc";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DocumentChatMessage } from "../composables/useDocumentChat";
import * as presentation from "../lib/documentChatPresentation";

const source = readFileSync(new URL("./ResourceDocumentChatDialog.vue", import.meta.url), "utf8");
const { descriptor } = parse(source);
const compiled = compileScript(descriptor, { id: "document-chat-dialog-test" });
const script = transpileModule(compiled.content, {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
}).outputText;

class FakeElement extends EventTarget {
  isConnected = true;
  tabIndex = 0;
  style = { height: "", overflow: "" };
  scrollHeight = 44;
  clientHeight = 44;
  dataset: { messageKey?: string } = {};
  children: FakeElement[] = [];
  top = 0;
  focus = vi.fn(() => { fakeDocument.activeElement = this; });
  blur = vi.fn(() => {
    if (fakeDocument.activeElement === this) fakeDocument.activeElement = null;
  });
  contains(element: unknown) { return element === this || this.children.includes(element as FakeElement); }
  querySelectorAll(_selector: string): FakeElement[] { return this.children; }
  getBoundingClientRect() { return { top: this.top, bottom: this.top + 40 }; }
  getClientRects() { return [this.getBoundingClientRect()]; }
}

class FakeTimeline extends FakeElement {
  private position = 0;
  get scrollTop() { return this.position; }
  set scrollTop(value: number) { this.position = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); }
}

let fakeDocument: EventTarget & { activeElement: FakeElement | null; body: FakeElement };
let fakeWindow: EventTarget & {
  requestAnimationFrame: ReturnType<typeof vi.fn>;
  cancelAnimationFrame: ReturnType<typeof vi.fn>;
  getComputedStyle: ReturnType<typeof vi.fn>;
};
let frames: Map<number, FrameRequestCallback>;
const cleanups: Array<() => void> = [];
const settle = async () => {
  for (let index = 0; index < 5; index++) await vue.nextTick();
};
const flushFrames = () => {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
};
const message = (id: number, status: DocumentChatMessage["status"] = "sent"): DocumentChatMessage => ({
  id: status === "pending" ? null : id,
  project_id: "project",
  resource_id: "document",
  client_message_id: `message-${id}`,
  author: { id: "artist", username: "Artist" },
  body: `Message ${id}`,
  created_at: "2026-09-18T10:00:00Z",
  status,
});
const keyboard = (key: string, overrides: Partial<KeyboardEvent> = {}) => ({
  key, shiftKey: false, isComposing: false, keyCode: 0,
  preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), ...overrides,
});
const pointer = (button = 0) => ({ button, preventDefault: vi.fn() });

const setupChat = (mobile = false, initialMessages: DocumentChatMessage[] = []) => {
  const emit = vi.fn();
  const isMobileLayout = vue.ref(mobile);
  const startViewport = vi.fn();
  const stopViewport = vi.fn();
  const unmountHooks: Array<() => void> = [];
  const scope = vue.effectScope();
  const exports: { default?: { setup: (...args: unknown[]) => unknown } } = {};
  new Function("require", "exports", script)((name: string) => {
    if (name === "vue") return { ...vue, onBeforeUnmount: (hook: () => void) => unmountHooks.push(hook) };
    if (name === "@lucide/vue") return {};
    if (name === "../lib/documentChatPresentation") return presentation;
    if (name === "../composables/useDocumentChatViewport") return {
      useDocumentChatViewport: () => ({
        isMobileLayout, viewportStyle: vue.ref(), start: startViewport, stop: stopViewport,
      }),
    };
    throw new Error(`Unexpected SFC dependency: ${name}`);
  }, exports);
  const props = vue.reactive({
    open: false, documentName: "Document", participantsCount: 2, currentUserId: "artist",
    messages: initialMessages, loading: false, error: null, hasOlder: true, sending: false,
  });
  const state = scope.run(() => exports.default!.setup(props, { expose: () => {}, emit })) as {
    dialog: vue.Ref<HTMLElement | null>;
    timeline: vue.Ref<HTMLElement | null>;
    composer: vue.Ref<HTMLTextAreaElement | null>;
    closeButton: vue.Ref<HTMLButtonElement | null>;
    draft: vue.Ref<string>;
    isComposing: vue.Ref<boolean>;
    canSend: vue.ComputedRef<boolean>;
    handleComposerKeydown: (event: KeyboardEvent) => void;
    handleModalKeydown: (event: KeyboardEvent) => void;
    keepComposerFocused: (event: PointerEvent) => void;
    sendDraft: () => void;
    updateScrollPosition: () => void;
    scheduleComposerResize: () => void;
    loadOlder: () => void;
    finishClose: () => Promise<void>;
  };
  const composer = vue.markRaw(new FakeElement());
  const closeButton = vue.markRaw(new FakeElement());
  const dialog = vue.markRaw(new FakeElement());
  dialog.children = [closeButton, composer];
  const timeline = vue.markRaw(new FakeTimeline());
  timeline.scrollHeight = 1000;
  timeline.clientHeight = 200;
  state.composer.value = composer as unknown as HTMLTextAreaElement;
  state.closeButton.value = closeButton as unknown as HTMLButtonElement;
  state.dialog.value = dialog as unknown as HTMLElement;
  state.timeline.value = timeline as unknown as HTMLElement;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const hook of unmountHooks) hook();
    scope.stop();
  };
  cleanups.push(stop);
  return { state, props, emit, isMobileLayout, composer, closeButton, timeline, startViewport, stopViewport, stop };
};

beforeEach(() => {
  frames = new Map();
  let frameId = 0;
  fakeDocument = Object.assign(new EventTarget(), {
    activeElement: null as FakeElement | null,
    body: vue.markRaw(new FakeElement()),
  });
  fakeDocument.body.style.overflow = "scroll";
  fakeWindow = Object.assign(new EventTarget(), {
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    }),
    cancelAnimationFrame: vi.fn((id: number) => frames.delete(id)),
    getComputedStyle: vi.fn(() => ({ maxHeight: "104px" })),
  });
  vi.stubGlobal("window", fakeWindow);
  vi.stubGlobal("document", fakeDocument);
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("Node", FakeElement);
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

describe("ResourceDocumentChatDialog interaction", () => {
  it("leaves mobile Enter available for a newline and sends with desktop Enter", () => {
    const chat = setupChat(true);
    chat.state.draft.value = "  A message  ";
    const mobileEnter = keyboard("Enter");
    chat.state.handleComposerKeydown(mobileEnter as unknown as KeyboardEvent);
    expect(mobileEnter.preventDefault).not.toHaveBeenCalled();
    expect(chat.emit).not.toHaveBeenCalled();
    expect(chat.state.draft.value).toBe("  A message  ");

    chat.isMobileLayout.value = false;
    const desktopEnter = keyboard("Enter");
    chat.state.handleComposerKeydown(desktopEnter as unknown as KeyboardEvent);
    expect(desktopEnter.preventDefault).toHaveBeenCalledOnce();
    expect(chat.emit).toHaveBeenCalledExactlyOnceWith("send", "A message");
    expect(chat.state.draft.value).toBe("");
    expect(chat.composer.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])("does not intercept IME Enter or Escape (%j)", async (ime) => {
    const chat = setupChat();
    chat.props.open = true;
    await settle();
    chat.state.draft.value = "Composing a message";
    const enter = keyboard("Enter", ime);
    const escape = keyboard("Escape", ime);
    chat.state.handleComposerKeydown(enter as unknown as KeyboardEvent);
    chat.state.handleModalKeydown(escape as unknown as KeyboardEvent);
    expect(enter.preventDefault).not.toHaveBeenCalled();
    expect(escape.preventDefault).not.toHaveBeenCalled();
    expect(escape.stopImmediatePropagation).not.toHaveBeenCalled();
    expect(chat.emit).not.toHaveBeenCalled();
    const normalEscape = keyboard("Escape");
    chat.state.handleModalKeydown(normalEscape as unknown as KeyboardEvent);
    expect(chat.emit).toHaveBeenCalledExactlyOnceWith("close");
  });

  it("preserves existing composer focus for primary send presses without stealing inactive focus", () => {
    const chat = setupChat(true);
    fakeDocument.activeElement = chat.composer;
    const mobilePress = pointer();
    chat.state.keepComposerFocused(mobilePress as unknown as PointerEvent);
    expect(mobilePress.preventDefault).toHaveBeenCalledOnce();
    expect(fakeDocument.activeElement).toBe(chat.composer);

    chat.isMobileLayout.value = false;
    const desktopPress = pointer();
    chat.state.keepComposerFocused(desktopPress as unknown as PointerEvent);
    expect(desktopPress.preventDefault).toHaveBeenCalledOnce();
    chat.isMobileLayout.value = true;
    fakeDocument.activeElement = chat.closeButton;
    const unfocusedPress = pointer();
    chat.state.keepComposerFocused(unfocusedPress as unknown as PointerEvent);
    expect(unfocusedPress.preventDefault).not.toHaveBeenCalled();
    fakeDocument.activeElement = chat.composer;
    const secondaryPress = pointer(2);
    chat.state.keepComposerFocused(secondaryPress as unknown as PointerEvent);
    expect(secondaryPress.preventDefault).not.toHaveBeenCalled();
  });

  it("does not send through the button during IME composition and resets composition on close", async () => {
    const chat = setupChat();
    chat.props.open = true;
    await settle();
    chat.state.draft.value = "An unfinished character";
    chat.state.isComposing.value = true;
    expect(chat.state.canSend.value).toBe(false);
    chat.state.sendDraft();
    expect(chat.emit).not.toHaveBeenCalled();
    expect(chat.state.draft.value).toBe("An unfinished character");
    chat.props.open = false;
    await settle();
    expect(chat.state.isComposing.value).toBe(false);
  });

  it("keeps the modal locked through leave, restores focus afterward and does not steal focus on a rapid reopen", async () => {
    const previousFocus = vue.markRaw(new FakeElement());
    fakeDocument.activeElement = previousFocus;
    const chat = setupChat(true);
    chat.props.open = true;
    await settle();
    expect(fakeDocument.body.style.overflow).toBe("hidden");
    expect(fakeDocument.activeElement).toBe(chat.closeButton);

    chat.props.open = false;
    await settle();
    expect(fakeDocument.body.style.overflow).toBe("hidden");
    expect(previousFocus.focus).not.toHaveBeenCalled();
    const finishing = chat.state.finishClose();
    chat.props.open = true;
    await finishing;
    await settle();
    expect(previousFocus.focus).not.toHaveBeenCalled();
    expect(fakeDocument.activeElement).toBe(chat.closeButton);
    expect(fakeDocument.body.style.overflow).toBe("hidden");
    const stopCount = chat.stopViewport.mock.calls.length;
    await chat.state.finishClose();
    expect(chat.stopViewport).toHaveBeenCalledTimes(stopCount);

    chat.props.open = false;
    await settle();
    await chat.state.finishClose();
    expect(fakeDocument.body.style.overflow).toBe("scroll");
    expect(previousFocus.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(fakeDocument.activeElement).toBe(previousFocus);
  });

  it("restores the original focus and overflow after an ordinary completed leave", async () => {
    const previousFocus = vue.markRaw(new FakeElement());
    fakeDocument.activeElement = previousFocus;
    const chat = setupChat();
    chat.props.open = true;
    await settle();
    chat.props.open = false;
    await settle();
    expect(fakeDocument.body.style.overflow).toBe("hidden");
    await chat.state.finishClose();
    expect(fakeDocument.body.style.overflow).toBe("scroll");
    expect(previousFocus.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(fakeDocument.activeElement).toBe(previousFocus);
  });

  it("preserves the visible row on an actual prepend after status and realtime append updates", async () => {
    const pending = message(1, "pending");
    const second = message(2);
    const chat = setupChat(false, [pending, second]);
    chat.props.open = true;
    await settle();
    chat.timeline.scrollHeight = 1200;
    chat.timeline.scrollTop = 200;
    chat.state.updateScrollPosition();
    const row = (item: DocumentChatMessage, y: number) => {
      const element = vue.markRaw(new FakeElement());
      element.dataset.messageKey = `${item.author.id}:${item.client_message_id}`;
      element.top = y;
      element.getBoundingClientRect = () => ({
        top: element.top - chat.timeline.scrollTop,
        bottom: element.top - chat.timeline.scrollTop + 40,
      });
      return element;
    };
    const firstRow = row(pending, 180);
    const secondRow = row(second, 220);
    chat.timeline.children = [firstRow, secondRow];
    chat.state.loadOlder();
    expect(chat.emit).toHaveBeenCalledWith("loadOlder");
    chat.props.messages = [message(1), second];
    await settle();
    expect(chat.timeline.scrollTop).toBe(200);
    chat.props.messages = [...chat.props.messages, message(3)];
    await settle();
    expect(chat.timeline.scrollTop).toBe(200);

    const originalOffset = firstRow.getBoundingClientRect().top;
    // Simulate the DOM render between the pre-flush watcher and its nextTick restoration.
    vue.queuePostFlushCb(() => {
      firstRow.top += 160;
      secondRow.top += 160;
      chat.timeline.scrollHeight += 160;
      chat.timeline.children = [row(message(0), 20), firstRow, secondRow];
    });
    chat.props.messages = [message(0), ...chat.props.messages];
    await settle();
    expect(chat.timeline.scrollTop).toBe(360);
    expect(firstRow.getBoundingClientRect().top).toBe(originalOffset);
  });

  it.each([true, false])("composer growth follows the bottom only when it was already near it (%s)", async (nearBottom) => {
    const chat = setupChat();
    chat.props.open = true;
    await settle();
    chat.timeline.scrollTop = nearBottom ? 800 : 200;
    chat.state.updateScrollPosition();
    chat.composer.scrollHeight = 140;
    chat.state.scheduleComposerResize();
    chat.state.scheduleComposerResize();
    expect(frames.size).toBe(1);
    flushFrames();
    chat.timeline.clientHeight = 140;
    await settle();
    expect(chat.composer.style.height).toBe("104px");
    expect(chat.timeline.scrollTop).toBe(nearBottom ? 860 : 200);
  });

  it("cancels scheduled composer resizing and releases modal effects on unmount", async () => {
    const removeKeyListener = vi.spyOn(fakeWindow, "removeEventListener");
    const removeFocusListener = vi.spyOn(fakeDocument, "removeEventListener");
    const chat = setupChat();
    chat.props.open = true;
    await settle();
    chat.state.scheduleComposerResize();
    expect(frames.size).toBe(1);
    chat.stop();
    expect(frames.size).toBe(0);
    expect(fakeWindow.cancelAnimationFrame).toHaveBeenCalledOnce();
    expect(removeKeyListener).toHaveBeenCalledWith("keydown", chat.state.handleModalKeydown, true);
    expect(removeFocusListener).toHaveBeenCalledOnce();
    expect(chat.stopViewport).toHaveBeenCalledOnce();
    expect(fakeDocument.body.style.overflow).toBe("scroll");
  });
});
