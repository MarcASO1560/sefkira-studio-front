import { getCurrentScope, onScopeDispose } from "vue";

import type { ImageTool } from "../types";

export type ImageKeyboardAction =
  | { type: "select-tool"; tool: ImageTool }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "select-all" }
  | { type: "copy" }
  | { type: "cut" }
  | { type: "paste" }
  | { type: "duplicate-layer" }
  | { type: "delete-selection" }
  | { type: "nudge-selection"; deltaX: -1 | 0 | 1; deltaY: -1 | 0 | 1 }
  | { type: "escape" };

export type ImageKeyboardActionHandler = (
  action: ImageKeyboardAction,
  event: KeyboardEvent,
) => void;

export type ImageKeyboardShortcutOptions = {
  preventDefault?: boolean;
  target?: Pick<EventTarget, "addEventListener" | "removeEventListener"> | null;
};

const TOOL_SHORTCUTS: Readonly<Record<string, ImageTool>> = {
  a: "graffiti",
  b: "pencil",
  e: "erase",
  g: "fill",
  i: "picker",
  l: "line",
  m: "move",
  t: "rotate",
  o: "ellipse",
  r: "rectangle",
  s: "select",
};

type ModifierShortcutAction = "copy" | "cut" | "duplicate-layer" | "paste" | "redo" | "select-all";

const MODIFIER_SHORTCUTS: Readonly<Record<string, ModifierShortcutAction>> = {
  a: "select-all",
  c: "copy",
  j: "duplicate-layer",
  v: "paste",
  x: "cut",
  y: "redo",
};

const EDITABLE_TAG_NAMES = new Set(["input", "select", "textarea"]);

export const isEditableKeyboardTarget = (target: EventTarget | null) => {
  if (!target || typeof target !== "object") {
    return false;
  }

  const element = target as EventTarget & {
    closest?: (selector: string) => Element | null;
    isContentEditable?: boolean;
    tagName?: string;
  };
  const tagName = element.tagName?.toLowerCase();

  if (tagName && EDITABLE_TAG_NAMES.has(tagName)) {
    return true;
  }

  if (element.isContentEditable) {
    return true;
  }

  return Boolean(
    element.closest?.('[contenteditable]:not([contenteditable="false"])'),
  );
};

export const getImageKeyboardAction = (
  event: Pick<
    KeyboardEvent,
    | "altKey"
    | "ctrlKey"
    | "defaultPrevented"
    | "isComposing"
    | "key"
    | "metaKey"
    | "shiftKey"
    | "target"
  >,
): ImageKeyboardAction | null => {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.altKey ||
    isEditableKeyboardTarget(event.target)
  ) {
    return null;
  }

  const key = event.key.toLowerCase();
  const hasCommandModifier = event.ctrlKey || event.metaKey;

  if (hasCommandModifier) {
    if (key === "z") {
      return { type: event.shiftKey ? "redo" : "undo" };
    }

    const action = MODIFIER_SHORTCUTS[key];
    return action ? { type: action } : null;
  }

  const tool = TOOL_SHORTCUTS[key];
  if (tool) {
    return { type: "select-tool", tool };
  }

  switch (event.key) {
    case "Delete":
    case "Backspace":
      return { type: "delete-selection" };
    case "ArrowLeft":
      return { type: "nudge-selection", deltaX: -1, deltaY: 0 };
    case "ArrowRight":
      return { type: "nudge-selection", deltaX: 1, deltaY: 0 };
    case "ArrowUp":
      return { type: "nudge-selection", deltaX: 0, deltaY: -1 };
    case "ArrowDown":
      return { type: "nudge-selection", deltaX: 0, deltaY: 1 };
    case "Escape":
      return { type: "escape" };
    default:
      return null;
  }
};

const defaultKeyboardTarget = () =>
  typeof window === "undefined" ? null : window;

export const useImageKeyboardShortcuts = (
  onAction: ImageKeyboardActionHandler,
  options: ImageKeyboardShortcutOptions = {},
) => {
  const target = options.target === undefined ? defaultKeyboardTarget() : options.target;
  const shouldPreventDefault = options.preventDefault !== false;
  let disposed = false;

  const handleKeydown = (event: Event) => {
    const keyboardEvent = event as KeyboardEvent;
    const action = getImageKeyboardAction(keyboardEvent);

    if (!action) {
      return;
    }

    if (shouldPreventDefault) {
      keyboardEvent.preventDefault();
    }

    onAction(action, keyboardEvent);
  };

  target?.addEventListener("keydown", handleKeydown);

  const dispose = () => {
    if (disposed) {
      return;
    }

    disposed = true;
    target?.removeEventListener("keydown", handleKeydown);
  };

  if (getCurrentScope()) {
    onScopeDispose(dispose);
  }

  return { dispose };
};
