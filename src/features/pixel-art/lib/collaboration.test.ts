import { describe, expect, it } from "vitest";

import type { ProjectEditorActivity } from "../../../lib/realtime";
import { createPixelLayer } from "./document";
import { PIXEL_ART_PASTEL_PALETTE } from "./palette";
import {
  applyCollaborativePixelPatch,
  canSendCollaborativeActivity,
  collaboratorColor,
  readCollaborativeCursor,
  readCollaborativeDocument,
  readCollaborativePixelPatch,
  readCollaborativeSelection,
  serializeCollaborativeSelection,
} from "./collaboration";

const activity = (
  kind: ProjectEditorActivity["kind"],
  payload: Record<string, unknown>,
): ProjectEditorActivity => ({
  client_id: "client-2",
  kind,
  payload,
  resource_id: "resource-1",
  sent_at: "2026-09-14T14:00:00Z",
  sequence: 1,
  user: { id: "user-2", email: "artist@example.com", username: "Artist" },
});

describe("pixel-art collaboration", () => {
  it.each(["document", "pixels", "selection", "sync-request"] as const)(
    "keeps %s synchronization enabled in background documents",
    (kind) => {
      expect(canSendCollaborativeActivity(kind, {}, "hidden")).toBe(true);
      expect(canSendCollaborativeActivity(kind, {}, "visible")).toBe(true);
    },
  );

  it("hides a background cursor without treating the document as disconnected", () => {
    expect(canSendCollaborativeActivity("cursor", { visible: false }, "hidden")).toBe(true);
    expect(canSendCollaborativeActivity("cursor", { visible: true }, "hidden")).toBe(false);
    expect(canSendCollaborativeActivity("cursor", {}, "hidden")).toBe(false);
    expect(canSendCollaborativeActivity("cursor", { visible: true }, "visible")).toBe(true);
  });

  it("accepts finite cursor positions across the workspace and rejects unsafe offsets", () => {
    expect(
      readCollaborativeCursor(
        activity("cursor", { height: 16, tool: "pencil", visible: true, width: 16, x: 3, y: 4 }),
      ),
    ).toEqual({ height: 16, tool: "pencil", visible: true, width: 16, x: 3, y: 4 });
    expect(
      readCollaborativeCursor(
        activity("cursor", {
          height: 16,
          tool: "pencil",
          visible: true,
          width: 16,
          x: -8.5,
          y: 20.25,
        }),
      ),
    ).toEqual({
      height: 16,
      tool: "pencil",
      visible: true,
      width: 16,
      x: -8.5,
      y: 20.25,
    });
    expect(
      readCollaborativeCursor(
        activity("cursor", {
          height: 16,
          tool: "pencil",
          visible: true,
          width: 16,
          x: 100001,
          y: 4,
        }),
      ),
    ).toBeNull();
  });

  it("applies only valid pixel patches to their target layer", () => {
    const layer = createPixelLayer(2, 2, { id: "layer-1" });
    const patch = readCollaborativePixelPatch(
      activity("pixels", {
        changes: [[1, "#ff0000"], [3, null]],
        height: 2,
        layer_id: "layer-1",
        width: 2,
      }),
    );
    expect(patch).not.toBeNull();
    expect(applyCollaborativePixelPatch([layer], patch!, 2, 2)?.[0]?.pixels).toEqual([
      null,
      "#ff0000",
      null,
      null,
    ]);
  });

  it("rejects malformed documents and accepts valid version 2 documents", () => {
    expect(readCollaborativeDocument(activity("document", { document: { version: 2 } }))).toBeNull();
    const layer = createPixelLayer(1, 1, { id: "layer-1" });
    expect(
      readCollaborativeDocument(
        activity("document", {
          document: { version: 2, width: 1, height: 1, palette: [], layers: [layer] },
        }),
      )?.layers[0]?.id,
    ).toBe("layer-1");
  });

  it("reads selection clearing and normalizes legacy rectangular payloads", () => {
    expect(readCollaborativeSelection(activity("selection", { selection: null }))).toBeNull();
    expect(
      readCollaborativeSelection(
        activity("selection", { selection: { height: 2, width: 3, x: 1, y: 4 } }),
      ),
    ).toEqual({
      height: 2,
      kind: "rectangle",
      mode: "replace",
      width: 3,
      x: 1,
      y: 4,
    });
    expect(
      readCollaborativeSelection(
        activity("selection", { selection: { height: 2, width: 3, x: -2, y: 4 } }),
      ),
    ).toMatchObject({ height: 2, width: 3, x: -2, y: 4 });
    expect(readCollaborativeSelection(activity("cursor", { selection: null }))).toBeUndefined();
  });

  it("bit-packs masked selections and restores their runtime mask", () => {
    const data = Uint8Array.from([0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
    const selection = {
      height: 3,
      kind: "lasso" as const,
      mask: { data, height: 3, width: 4 },
      mode: "add" as const,
      width: 2,
      x: 1,
      y: 0,
    };

    const serialized = serializeCollaborativeSelection(selection);
    expect(serialized).toEqual({
      height: 3,
      kind: "lasso",
      mask: { data: "JgQ=", encoding: "bitset-v1", height: 3, width: 4 },
      mode: "add",
      width: 2,
      x: 1,
      y: 0,
    });

    expect(
      readCollaborativeSelection(activity("selection", { selection: serialized })),
    ).toEqual({
      height: 3,
      kind: "lasso",
      mask: {
        bounds: { height: 3, width: 2, x: 1, y: 0 },
        data,
        height: 3,
        width: 4,
      },
      mode: "add",
      width: 2,
      x: 1,
      y: 0,
    });
  });

  it("keeps serialized rectangle bounds readable by legacy peers", () => {
    expect(
      serializeCollaborativeSelection({ height: 2, width: 3, x: 1, y: 4 }),
    ).toEqual({
      height: 2,
      kind: "rectangle",
      mode: "replace",
      width: 3,
      x: 1,
      y: 4,
    });
    expect(serializeCollaborativeSelection(null)).toBeNull();
  });

  it.each([
    { height: 1, width: 257, x: 0, y: 0 },
    { height: 1, width: 1, x: 256, y: 0 },
    { height: 1, kind: "ellipse", width: 1, x: 0, y: 0 },
    { height: 1, mode: "toggle", width: 1, x: 0, y: 0 },
    { height: 1, kind: "lasso", width: 1, x: 0, y: 0 },
    {
      height: 1,
      kind: "wand",
      mask: { data: "AQ==", encoding: "bytes-v1", height: 1, width: 1 },
      width: 1,
      x: 0,
      y: 0,
    },
    {
      height: 1,
      kind: "wand",
      mask: { data: "not-base64", encoding: "bitset-v1", height: 1, width: 1 },
      width: 1,
      x: 0,
      y: 0,
    },
    {
      height: 1,
      kind: "wand",
      mask: { data: "gA==", encoding: "bitset-v1", height: 1, width: 1 },
      width: 1,
      x: 0,
      y: 0,
    },
    {
      height: 1,
      kind: "wand",
      mask: { data: "AA==", encoding: "bitset-v1", height: 1, width: 1 },
      width: 1,
      x: 0,
      y: 0,
    },
    {
      height: 1,
      kind: "wand",
      mask: { data: "AQ==", encoding: "bitset-v1", height: 1, width: 1 },
      width: 1,
      x: 1,
      y: 0,
    },
  ])("rejects unsafe or malformed selection payload %#", (selection) => {
    expect(readCollaborativeSelection(activity("selection", { selection }))).toBeUndefined();
  });

  it("rejects invalid local masks before they reach realtime", () => {
    expect(() =>
      serializeCollaborativeSelection({
        height: 1,
        kind: "lasso",
        width: 1,
        x: 0,
        y: 0,
      }),
    ).toThrow(/require a pixel mask/i);
    expect(() =>
      serializeCollaborativeSelection({
        height: 1,
        kind: "wand",
        mask: { data: Uint8Array.from([2]), height: 1, width: 1 },
        width: 1,
        x: 0,
        y: 0,
      }),
    ).toThrow(/either 0 or 1/i);
    expect(() =>
      serializeCollaborativeSelection({
        height: 1,
        kind: "wand",
        mask: { data: Uint8Array.from([1, 0]), height: 1, width: 2 },
        width: 1,
        x: 1,
        y: 0,
      }),
    ).toThrow(/bounds must match/i);
  });

  it("caps a full-size collaborative mask to a compact fixed payload", () => {
    const data = new Uint8Array(256 * 256);
    data[0] = 1;
    data[data.length - 1] = 1;
    const serialized = serializeCollaborativeSelection({
      height: 256,
      kind: "wand",
      mask: { data, height: 256, width: 256 },
      mode: "intersect",
      width: 256,
      x: 0,
      y: 0,
    });

    expect(serialized?.mask?.data).toHaveLength(10_924);
    const restored = readCollaborativeSelection(
      activity("selection", { selection: serialized }),
    );
    expect(restored?.mask?.data).toHaveLength(256 * 256);
    expect(restored?.mask?.data[0]).toBe(1);
    expect(restored?.mask?.data.at(-1)).toBe(1);
  });

  it("returns stable collaborator colors", () => {
    expect(collaboratorColor("user-2")).toBe(collaboratorColor("user-2"));
    expect(PIXEL_ART_PASTEL_PALETTE).toHaveLength(16);
    expect(PIXEL_ART_PASTEL_PALETTE).toContain(collaboratorColor("user-2"));
  });
});
