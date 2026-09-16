import { describe, expect, it } from "vitest";
import { createPixelArtDocument, createPixelLayer } from "./document";
import { applyImageActions, diffImageDocuments, ImageOperationConflict, splitImageActionBatches, validateImageOperation } from "./imageOperations";

const document = () => createPixelArtDocument(2, 2, { layers: [createPixelLayer(2, 2, { id: "a" })] });

describe("image operation deltas", () => {
  it("encodes only changed pixels and merges disjoint users", () => {
    const base = document();
    const left = document(); left.layers[0]!.pixels[0] = "#FF0000";
    const right = document(); right.layers[0]!.pixels[1] = "#00FF00";
    const actions = diffImageDocuments(base, left);
    expect(actions).toEqual([{ type: "pixels", layer_id: "a", changes: [[0, "#FF0000"]] }]);
    expect(applyImageActions(applyImageActions(base, actions), diffImageDocuments(base, right)).layers[0]!.pixels).toEqual(["#FF0000", "#00FF00", null, null]);
  });
  it("the last accepted normal write wins on the same pixel", () => {
    const base = document();
    const result = applyImageActions(base, [{ type: "pixels", layer_id: "a", changes: [[0, "#FF0000"], [0, "#00FF00"]] }]);
    expect(result.layers[0]!.pixels[0]).toBe("#00FF00");
  });
  it("conditional undo does not erase another user's subsequent pixel/property edits", () => {
    const before = document(); before.layers[0]!.pixels[0] = "#FF0000"; before.layers[0]!.name = "Mine";
    const after = document();
    const remote = document(); remote.layers[0]!.pixels[0] = "#00FF00"; remote.layers[0]!.name = "Theirs";
    const actions = diffImageDocuments(before, after, { conditional: true });
    expect(actions).toContainEqual({ type: "pixels", layer_id: "a", changes: [[0, null, "#FF0000"]] });
    expect(applyImageActions(remote, actions)).toEqual(remote);
    expect(applyImageActions(before, actions)).toEqual(after);
  });
  it("retains concurrent layers during local reorder and updates", () => {
    const base = document(); base.layers.push(createPixelLayer(2, 2, { id: "b" }));
    const local = document(); local.layers.unshift(createPixelLayer(2, 2, { id: "b", name: "Renamed" }));
    const remote = document(); remote.layers.push(createPixelLayer(2, 2, { id: "remote" }), createPixelLayer(2, 2, { id: "b" }));
    const merged = applyImageActions(remote, diffImageDocuments(base, local));
    expect(merged.layers.map((layer) => layer.id)).toEqual(["b", "remote", "a"]);
    expect(merged.layers[0]!.name).toBe("Renamed");
  });
  it("adds/deletes layers without whole-document replacement", () => {
    const base = document();
    const next = createPixelArtDocument(2, 2, { layers: [createPixelLayer(2, 2, { id: "new" })] });
    expect(diffImageDocuments(base, next).map((action) => action.type)).toEqual(["layer-add", "layer-remove"]);
    expect(applyImageActions(base, diffImageDocuments(base, next))).toEqual(next);
  });
  it("protects missing pixel targets, dimension changes and layer-ID collisions", () => {
    const base = document();
    expect(() => applyImageActions(base, [{ type: "pixels", layer_id: "missing", changes: [[0, "#FF0000"]] }])).toThrow(ImageOperationConflict);
    expect(() => applyImageActions(base, [{ type: "pixels", layer_id: "a", changes: [[0, "#FF0000"]] }], { width: 3, height: 3 })).toThrow(ImageOperationConflict);
    expect(() => applyImageActions(base, [{ type: "layer-add", layer: createPixelLayer(2, 2, { id: "a", name: "Different" }), after_id: null }])).toThrow(ImageOperationConflict);
  });
  it("uses a single guarded replacement for dimensions/import only", () => {
    const base = document(); const next = createPixelArtDocument(3, 3);
    expect(diffImageDocuments(base, next)).toEqual([{ type: "replace", document: next }]);
    const modified = document(); modified.layers[0]!.pixels[0] = "#FF0000";
    expect(diffImageDocuments(base, modified, { replace: true })).toEqual([{ type: "replace", document: modified }]);
  });
  it("validates conditional tuples, alpha and rejects malformed operations", () => {
    const operation = { operation_id: "x", base_revision: 0, width: 2, height: 2, actions: [{ type: "pixels", layer_id: "a", changes: [[0, "#AABBCCDD", null]] }] };
    expect(validateImageOperation(operation)).toBe(true);
    expect(validateImageOperation({ ...operation, actions: [{ type: "pixels", layer_id: "a", changes: [[4, "#AABBCC"]] }] })).toBe(false);
    expect(validateImageOperation({ ...operation, actions: [{ type: "pixels", layer_id: "a", changes: [[0, "#AABBCC", undefined]] }] })).toBe(false);
    expect(validateImageOperation({ ...operation, operation_id: "" })).toBe(false);
  });
  it("conditional layer deletion does not remove a collaborator's modified layer", () => {
    const before = document(); before.layers.push(createPixelLayer(2, 2, { id: "mine" }));
    const after = document(); const remote = structuredClone(before); remote.layers[1]!.pixels[0] = "#00FF00";
    const actions = diffImageDocuments(before, after, { conditional: true });
    expect(applyImageActions(remote, actions)).toEqual(remote);
    expect(applyImageActions(before, actions)).toEqual(after);
  });
  it("conditional order honors the order after its own add/remove actions", () => {
    const before = document(); before.layers.push(createPixelLayer(2, 2, { id: "b" }), createPixelLayer(2, 2, { id: "remove" }));
    const after = document(); after.layers.unshift(createPixelLayer(2, 2, { id: "b" })); after.layers.push(createPixelLayer(2, 2, { id: "add" }));
    expect(applyImageActions(before, diffImageDocuments(before, after, { conditional: true }))).toEqual(after);
    const changed = structuredClone(before); changed.layers.splice(1, 0, createPixelLayer(2, 2, { id: "remote" }));
    expect(applyImageActions(changed, diffImageDocuments(before, after, { conditional: true })).layers.filter((layer) => layer.id !== "remote").map((layer) => layer.id)).toEqual(["a", "add", "b"]);
  });
  it("splits large multi-layer pixel edits into bounded ordered packets", () => {
    const actions = Array.from({ length: 5 }, (_, layer) => ({ type: "pixels" as const, layer_id: `layer-${layer}`, changes: Array.from({ length: 65536 }, (_, pixel) => [pixel, "#FF0000"] as [number, string]) }));
    const batches = splitImageActionBatches(actions);
    expect(batches.map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(batches.flat()).toEqual(actions);
    expect(validateImageOperation({ operation_id: "large", base_revision: 0, width: 256, height: 256, actions })).toBe(false);
    expect(batches.every((actions) => validateImageOperation({ operation_id: "large", base_revision: 0, width: 256, height: 256, actions }))).toBe(true);
  });
});
