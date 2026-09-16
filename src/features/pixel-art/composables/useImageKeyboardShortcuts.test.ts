import { describe, expect, it, vi } from "vitest";

import {
  getImageKeyboardAction,
  isEditableKeyboardTarget,
  useImageKeyboardShortcuts,
  type ImageKeyboardAction,
} from "./useImageKeyboardShortcuts";
import type { ImageTool } from "../types";

type KeyboardEventOverrides = Partial<
  Pick<
    KeyboardEvent,
    | "altKey"
    | "ctrlKey"
    | "defaultPrevented"
    | "isComposing"
    | "metaKey"
    | "shiftKey"
    | "target"
  >
>;

const keyboardEvent = (key: string, overrides: KeyboardEventOverrides = {}) =>
  ({
    altKey: false,
    ctrlKey: false,
    defaultPrevented: false,
    isComposing: false,
    key,
    metaKey: false,
    shiftKey: false,
    target: null,
    ...overrides,
  }) as Pick<
    KeyboardEvent,
    | "altKey"
    | "ctrlKey"
    | "defaultPrevented"
    | "isComposing"
    | "key"
    | "metaKey"
    | "shiftKey"
    | "target"
  >;

class KeyboardTarget {
  listener: ((event: Event) => void) | null = null;

  addEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
    this.listener =
      typeof listener === "function" ? listener : (event) => listener.handleEvent(event);
  }

  removeEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
    const candidate =
      typeof listener === "function" ? listener : (event: Event) => listener.handleEvent(event);

    if (this.listener === candidate || typeof listener === "function") {
      this.listener = null;
    }
  }

  dispatch(event: KeyboardEvent) {
    this.listener?.(event);
  }
}

describe("getImageKeyboardAction", () => {
  it.each<[string, ImageTool]>([
    ["a", "graffiti"],
    ["b", "pencil"],
    ["E", "erase"],
    ["g", "fill"],
    ["I", "picker"],
    ["l", "line"],
    ["R", "rectangle"],
    ["o", "ellipse"],
    ["S", "select"],
    ["m", "move"],
    ["t", "rotate"],
  ])("maps %s to the %s tool", (key, tool) => {
    expect(getImageKeyboardAction(keyboardEvent(key))).toEqual({
      type: "select-tool",
      tool,
    });
  });

  it("maps undo and both redo variants for Ctrl and Cmd", () => {
    expect(getImageKeyboardAction(keyboardEvent("z", { ctrlKey: true }))).toEqual({
      type: "undo",
    });
    expect(
      getImageKeyboardAction(keyboardEvent("Z", { metaKey: true, shiftKey: true })),
    ).toEqual({ type: "redo" });
    expect(getImageKeyboardAction(keyboardEvent("y", { ctrlKey: true }))).toEqual({
      type: "redo",
    });
    expect(getImageKeyboardAction(keyboardEvent("Y", { metaKey: true }))).toEqual({
      type: "redo",
    });
  });

  it.each<[string, ImageKeyboardAction["type"]]>([
    ["a", "select-all"],
    ["c", "copy"],
    ["x", "cut"],
    ["v", "paste"],
    ["j", "duplicate-layer"],
  ])("maps Ctrl/Cmd+%s to %s", (key, type) => {
    expect(getImageKeyboardAction(keyboardEvent(key, { ctrlKey: true }))).toEqual({ type });
    expect(getImageKeyboardAction(keyboardEvent(key.toUpperCase(), { metaKey: true }))).toEqual({
      type,
    });
  });

  it.each(["Delete", "Backspace"])("maps %s to delete-selection", (key) => {
    expect(getImageKeyboardAction(keyboardEvent(key))).toEqual({
      type: "delete-selection",
    });
  });

  it.each<[string, -1 | 0 | 1, -1 | 0 | 1]>([
    ["ArrowLeft", -1, 0],
    ["ArrowRight", 1, 0],
    ["ArrowUp", 0, -1],
    ["ArrowDown", 0, 1],
  ])("maps %s to a one-pixel nudge", (key, deltaX, deltaY) => {
    expect(getImageKeyboardAction(keyboardEvent(key))).toEqual({
      type: "nudge-selection",
      deltaX,
      deltaY,
    });
  });

  it("maps Escape", () => {
    expect(getImageKeyboardAction(keyboardEvent("Escape"))).toEqual({ type: "escape" });
  });

  it("ignores editable controls and contenteditable descendants", () => {
    for (const tagName of ["INPUT", "textarea", "Select"]) {
      expect(
        getImageKeyboardAction(
          keyboardEvent("b", { target: { tagName } as unknown as EventTarget }),
        ),
      ).toBeNull();
    }

    expect(
      getImageKeyboardAction(
        keyboardEvent("z", {
          ctrlKey: true,
          target: { isContentEditable: true } as unknown as EventTarget,
        }),
      ),
    ).toBeNull();
    expect(
      getImageKeyboardAction(
        keyboardEvent("Delete", {
          target: { closest: () => ({}) } as unknown as EventTarget,
        }),
      ),
    ).toBeNull();
  });

  it("does not classify unrelated targets as editable", () => {
    expect(isEditableKeyboardTarget(null)).toBe(false);
    expect(isEditableKeyboardTarget({ tagName: "BUTTON" } as unknown as EventTarget)).toBe(false);
    expect(
      isEditableKeyboardTarget({ closest: () => null } as unknown as EventTarget),
    ).toBe(false);
  });

  it("ignores composition, prevented events, Alt shortcuts, and unknown keys", () => {
    expect(getImageKeyboardAction(keyboardEvent("b", { isComposing: true }))).toBeNull();
    expect(getImageKeyboardAction(keyboardEvent("b", { defaultPrevented: true }))).toBeNull();
    expect(getImageKeyboardAction(keyboardEvent("b", { altKey: true }))).toBeNull();
    expect(getImageKeyboardAction(keyboardEvent("q"))).toBeNull();
  });

  it("does not trigger drawing tools or navigation actions with command modifiers", () => {
    expect(getImageKeyboardAction(keyboardEvent("b", { ctrlKey: true }))).toBeNull();
    expect(getImageKeyboardAction(keyboardEvent("ArrowLeft", { metaKey: true }))).toBeNull();
    expect(getImageKeyboardAction(keyboardEvent("Backspace", { ctrlKey: true }))).toBeNull();
  });
});

describe("useImageKeyboardShortcuts", () => {
  it("dispatches typed actions, prevents handled defaults, and disposes", () => {
    const target = new KeyboardTarget();
    const onAction = vi.fn();
    const shortcuts = useImageKeyboardShortcuts(onAction, { target });
    const preventDefault = vi.fn();
    const event = {
      ...keyboardEvent("b"),
      preventDefault,
    } as unknown as KeyboardEvent;

    target.dispatch(event);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onAction).toHaveBeenCalledWith(
      { type: "select-tool", tool: "pencil" },
      event,
    );

    shortcuts.dispose();
    shortcuts.dispose();
    target.dispatch(event);
    expect(onAction).toHaveBeenCalledOnce();
  });

  it("does not prevent ignored shortcuts", () => {
    const target = new KeyboardTarget();
    const onAction = vi.fn();
    useImageKeyboardShortcuts(onAction, { target });
    const preventDefault = vi.fn();

    target.dispatch({ ...keyboardEvent("q"), preventDefault } as unknown as KeyboardEvent);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("can leave browser defaults enabled", () => {
    const target = new KeyboardTarget();
    const onAction = vi.fn();
    useImageKeyboardShortcuts(onAction, { preventDefault: false, target });
    const preventDefault = vi.fn();

    target.dispatch(
      { ...keyboardEvent("Delete"), preventDefault } as unknown as KeyboardEvent,
    );

    expect(preventDefault).not.toHaveBeenCalled();
    expect(onAction).toHaveBeenCalledWith(
      { type: "delete-selection" },
      expect.anything(),
    );
  });
});
