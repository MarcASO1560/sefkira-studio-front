import { describe, expect, it } from "vitest";

import {
  DEFAULT_IMAGE_EDITOR_SESSION,
  normalizeImageEditorSession,
} from "./editorSession";

describe("normalizeImageEditorSession", () => {
  it("restores the pixel rotation tool", () => {
    expect(normalizeImageEditorSession({ activeTool: "rotate" }).activeTool).toBe("rotate");
  });
  it("keeps stable per-user editing context", () => {
    const session = normalizeImageEditorSession({
      activeLayerId: "layer-ink",
      primaryColor: "#12ab34",
      secondaryColor: "#001122cc",
      activeTool: "graffiti",
      brushSize: 6,
      brushShape: "circle",
      shapeFilled: true,
      selectionOptions: {
        kind: "wand",
        mode: "add",
        contiguous: false,
      },
      lastInspectorPanel: "transform",
      preferences: {
        ...DEFAULT_IMAGE_EDITOR_SESSION.preferences,
        background: "#121212",
        zoom: 12,
      },
      viewport: { mode: "custom", panX: 42, panY: -18, rotationRadians: Math.PI / 2 },
      canvasModes: {
        horizontalMirror: true,
        verticalMirror: false,
        wrapAround: true,
        horizontalAxisY: 9.5,
        verticalAxisX: 12,
        horizontalLineVisible: false,
        verticalLineVisible: true,
        horizontalLineLocked: true,
        verticalLineLocked: false,
      },
    });

    expect(session).toMatchObject({
      activeLayerId: "layer-ink",
      primaryColor: "#12AB34",
      secondaryColor: "#001122CC",
      activeTool: "graffiti",
      brushSize: 6,
      brushShape: "circle",
      shapeFilled: true,
      selectionOptions: {
        kind: "wand",
        mode: "add",
        contiguous: false,
      },
      lastInspectorPanel: "transform",
      viewport: { mode: "custom", panX: 42, panY: -18 },
      canvasModes: {
        horizontalMirror: true,
        wrapAround: true,
        horizontalAxisY: 9.5,
        horizontalLineVisible: false,
        horizontalLineLocked: true,
      },
    });
    expect(session.preferences.zoom).toBe(12);
  });

  it("rejects malformed and transient state", () => {
    const session = normalizeImageEditorSession({
      activeTool: "laser",
      brushSize: 99,
      primaryColor: "red",
      selectionOptions: { kind: "polygon", mode: "xor", contiguous: "yes" },
      selection: { x: 0, y: 0, width: 1, height: 1 },
      clipboard: ["#FFFFFF"],
      history: ["old snapshot"],
      viewport: { mode: "broken", panX: Number.POSITIVE_INFINITY },
    });

    expect(session.activeTool).toBe("pencil");
    expect(session.brushSize).toBe(8);
    expect(session.primaryColor).toBe("#FFFFFF");
    expect(session.selectionOptions).toEqual(
      DEFAULT_IMAGE_EDITOR_SESSION.selectionOptions,
    );
    expect(session.viewport).toEqual(DEFAULT_IMAGE_EDITOR_SESSION.viewport);
    expect(session).not.toHaveProperty("selection");
    expect(session).not.toHaveProperty("clipboard");
    expect(session).not.toHaveProperty("history");
  });
});
