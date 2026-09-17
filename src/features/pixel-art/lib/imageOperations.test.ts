import { describe, expect, it } from "vitest";
import { createPixelArtDocument, createPixelLayer } from "./document";
import { applyImageActions, diffImageDocuments, ImageOperationConflict, rebaseImageOperationActions, splitImageActionBatches, validateImageOperation, type ImageOperation, type ImageOperationTransform } from "./imageOperations";
import { resizePixelArtDocument } from "./resize";

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
  it("skips missing pixel targets and protects incomplete dimensions/layer-ID collisions", () => {
    const base = document();
    expect(applyImageActions(base, [{ type: "pixels", layer_id: "missing", changes: [[0, "#FF0000"]] }])).toEqual(base);
    expect(() => applyImageActions(base, [{ type: "pixels", layer_id: "a", changes: [[0, "#FF0000"]] }], { width: 3, height: 3 })).toThrow(ImageOperationConflict);
    expect(() => applyImageActions(base, [{ type: "layer-add", layer: createPixelLayer(2, 2, { id: "a", name: "Different" }), after_id: null }])).toThrow(ImageOperationConflict);
  });
  it("uses a single guarded replacement for dimensions/import only", () => {
    const base = document(); const next = createPixelArtDocument(3, 3);
    expect(diffImageDocuments(base, next)).toEqual([{ type: "replace", document: next }]);
    const modified = document(); modified.layers[0]!.pixels[0] = "#FF0000";
    expect(diffImageDocuments(base, modified, { replace: true })).toEqual([{ type: "import", document: modified }]);
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
  it.each(["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"] as const)("semantic resize %s preserves canonical concurrent pixels", (anchor) => {
    const base = document(); const canonical = document(); canonical.layers[0]!.pixels[0] = "#FF0000";
    const resized = resizePixelArtDocument(base, 3, 3, anchor);
    const actions = diffImageDocuments(base, resized, { resize: { width: 3, height: 3, anchor } });
    expect(actions).toEqual([{ type: "resize", width: 3, height: 3, anchor }]);
    expect(applyImageActions(canonical, actions)).toEqual(resizePixelArtDocument(canonical, 3, 3, anchor));
  });
  it("maps pending pixels through every geometry event including same-size ABA without mutating the packet", () => {
    const packet: ImageOperation = { operation_id: "stroke", base_revision: 0, width: 2, height: 2, actions: [{ type: "pixels", layer_id: "a", changes: [[0, "#FF0000"], [3, "#00FF00"]] }] };
    const original = structuredClone(packet);
    const transforms: ImageOperationTransform[] = [
      { revision: 1, from_width: 2, from_height: 2, to_width: 3, to_height: 3, offset_x: 1, offset_y: 1 },
      { revision: 2, from_width: 3, from_height: 3, to_width: 2, to_height: 2, offset_x: 0, offset_y: 0 },
    ];
    expect(rebaseImageOperationActions(packet, transforms)).toEqual({ width: 2, height: 2, actions: [{ type: "pixels", layer_id: "a", changes: [[3, "#FF0000"]] }] });
    expect(packet).toEqual(original);
  });
  it("a cropped pending pixel never reappears when a later undo restores dimensions", () => {
    const packet: ImageOperation = { operation_id: "stroke", base_revision: 0, width: 2, height: 2, actions: [{ type: "pixels", layer_id: "a", changes: [[3, "#FF0000"]] }] };
    const transforms: ImageOperationTransform[] = [
      { revision: 1, from_width: 2, from_height: 2, to_width: 1, to_height: 1, offset_x: 0, offset_y: 0 },
      { revision: 2, from_width: 1, from_height: 1, to_width: 2, to_height: 2, offset_x: 0, offset_y: 0 },
    ];
    expect(rebaseImageOperationActions(packet, transforms).actions).toEqual([{ type: "pixels", layer_id: "a", changes: [] }]);
  });
  it("rebases full new-layer/conditional expected-layer pixels using the same coordinate history", () => {
    const layer = createPixelLayer(2, 2, { id: "new", pixels: ["#FF0000"] });
    const packet: ImageOperation = { operation_id: "add", base_revision: 0, width: 2, height: 2, actions: [{ type: "layer-add", layer, after_id: "a" }, { type: "layer-remove", layer_id: "new", expected_layer: layer }] };
    const rebased = rebaseImageOperationActions(packet, [{ revision: 1, from_width: 2, from_height: 2, to_width: 3, to_height: 3, offset_x: 1, offset_y: 1 }]);
    expect(rebased.actions[0]).toMatchObject({ layer: { pixels: [null, null, null, null, "#FF0000", null, null, null, null] } });
    expect(rebased.actions[1]).toMatchObject({ expected_layer: { pixels: [null, null, null, null, "#FF0000", null, null, null, null] } });
  });
  it("coordinate dependencies disambiguate a locally pre-applied resize across equal-size frames", () => {
    const packet: ImageOperation = { operation_id: "stroke", base_revision: 0, width: 3, height: 3, coordinate_after_operation_id: "my-resize", actions: [{ type: "pixels", layer_id: "a", changes: [[4, "#FF0000"]] }] };
    const transforms: ImageOperationTransform[] = [
      { revision: 1, operation_id: "my-resize", user_id: "user", from_width: 2, from_height: 2, to_width: 3, to_height: 3, offset_x: 1, offset_y: 1 },
      { revision: 2, from_width: 3, from_height: 3, to_width: 4, to_height: 4, offset_x: 1, offset_y: 1 },
    ];
    expect(rebaseImageOperationActions(packet, transforms, "user").actions).toEqual([{ type: "pixels", layer_id: "a", changes: [[10, "#FF0000"]] }]);
    expect(rebaseImageOperationActions(packet, [], "user")).toMatchObject({ width: 3, height: 3 });
  });
});
