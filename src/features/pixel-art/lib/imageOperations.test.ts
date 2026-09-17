import { describe, expect, it } from "vitest";
import { createPixelArtDocument, createPixelLayer } from "./document";
import { applyImageActions, diffImageDocuments, ImageOperationConflict, rebaseImageOperationActions, splitImageActionBatches, toImageOperationPacket, validateImageOperation, type ImageOperation, type ImageOperationTransform } from "./imageOperations";
import { resizePixelArtDocument } from "./resize";

const document = () => createPixelArtDocument(2, 2, { layers: [createPixelLayer(2, 2, { id: "a" })] });

describe("image operation deltas", () => {
  const runPacket = (overrides: Partial<ImageOperation> = {}): ImageOperation => ({ operation_id: "fill", base_revision: 0, width: 1024, height: 1024, actions: [{ type: "pixel-runs", layer_id: "a", color: "#12345680", runs: [[0, 1_048_576]] }], ...overrides });
  it("validates a full atomic span fill and keeps its single wire action intact", () => {
    const operation = runPacket(); const frozen = structuredClone(operation);
    expect(validateImageOperation(operation)).toBe(true); expect(JSON.stringify(toImageOperationPacket(operation)).length).toBeLessThan(250);
    expect(splitImageActionBatches(operation.actions)).toEqual([operation.actions]); expect(operation).toEqual(frozen);
    expect(validateImageOperation(runPacket({ width: 2048, height: 2048, actions: [{ type: "pixel-runs", layer_id: "a", color: null, runs: [[0, 4_194_304]] }] }))).toBe(true);
  });
  it.each([
    [], [[-1, 1]], [[0, 0]], [[0, -1]], [[0.5, 1]], [[0, 1.5]], [[0, Infinity]],
    [[1_048_576, 1]], [[1_048_575, 2]], [[0, 3], [2, 1]], [[5, 1], [0, 1]], [[0]], [[0, 1, 2]], [null],
  ].map((runs) => ({ runs })))("rejects malformed runs %j without weakening legacy per-pixel quotas", ({ runs }) => {
    expect(validateImageOperation(runPacket({ actions: [{ type: "pixel-runs", layer_id: "a", color: "#FFFFFF", runs: runs as never }] }))).toBe(false);
  });
  it("enforces run-count, color, layer and total mixed-action coverage budgets", () => {
    const action = { type: "pixel-runs" as const, layer_id: "a", color: null, runs: Array.from({ length: 65_537 }, (_, index) => [index * 2, 1] as [number, number]) };
    expect(validateImageOperation(runPacket({ actions: [action] }))).toBe(false);
    expect(validateImageOperation(runPacket({ actions: [{ ...action, runs: [[0, 1]], color: "invalid" }] }))).toBe(false);
    expect(validateImageOperation(runPacket({ actions: [{ ...action, runs: [[0, 1]], layer_id: " " }] }))).toBe(false);
    const full = { type: "pixel-runs" as const, layer_id: "a", color: "#FFFFFF", runs: [[0, 4_194_304]] as [number, number][] };
    const extra = { type: "pixels" as const, layer_id: "b", changes: [[0, null]] as [number, null][] };
    expect(validateImageOperation(runPacket({ width: 2048, height: 2048, actions: [full, extra] }))).toBe(false);
    expect(splitImageActionBatches([full, extra])).toEqual([[full], [extra]]);
    expect(validateImageOperation(runPacket({ actions: [{ ...full, runs: [[0, 1_048_576]] }, { ...full, runs: [[0, 1_048_576]], layer_id: "b" }] }))).toBe(true);
  });
  it("applies uniform runs in order, preserving alpha/null, other layers and immutable source arrays", () => {
    const base = createPixelArtDocument(4, 3, { layers: [createPixelLayer(4, 3, { id: "a", pixels: Array(12).fill("#111111") }), createPixelLayer(4, 3, { id: "other", pixels: ["#222222"] })] });
    Object.freeze(base.layers[0]!.pixels); const original = structuredClone(base);
    const next = applyImageActions(base, [{ type: "pixel-runs", layer_id: "a", color: "#abcdef80", runs: [[2, 7]] }, { type: "pixel-runs", layer_id: "a", color: null, runs: [[4, 2]] }]);
    expect(next.layers[0]!.pixels).toEqual(["#111111", "#111111", "#ABCDEF80", "#ABCDEF80", null, null, "#ABCDEF80", "#ABCDEF80", "#ABCDEF80", "#111111", "#111111", "#111111"]);
    expect(next.layers[1]).toEqual(base.layers[1]); expect(base).toEqual(original);
    expect(applyImageActions(base, [{ type: "pixel-runs", layer_id: "missing", color: null, runs: [[0, 1]] }])).toEqual(base);
  });
  it("compresses large uniform diffs including erasure but leaves mixed and conditional edits exact", () => {
    const base = createPixelArtDocument(64, 64, { layers: [createPixelLayer(64, 64, { id: "a" })] });
    const filled = createPixelArtDocument(64, 64, { layers: [createPixelLayer(64, 64, { id: "a", pixels: Array(4096).fill("#12345680") })] });
    expect(diffImageDocuments(base, filled)).toEqual([{ type: "pixel-runs", layer_id: "a", color: "#12345680", runs: [[0, 4096]] }]);
    expect(diffImageDocuments(filled, base)).toEqual([{ type: "pixel-runs", layer_id: "a", color: null, runs: [[0, 4096]] }]);
    expect(applyImageActions(base, diffImageDocuments(base, filled))).toEqual(filled);
    const conditional = diffImageDocuments(base, filled, { conditional: true }); expect(conditional[0]).toMatchObject({ type: "pixels" });
    expect(conditional[0]?.type === "pixels" && conditional[0].changes.every((change) => change.length === 3 && change[2] === null)).toBe(true);
    filled.layers[0]!.pixels[4095] = "#FFFFFF"; const mixed = diffImageDocuments(base, filled);
    expect(mixed[0]?.type).toBe("pixels"); expect(applyImageActions(base, mixed)).toEqual(filled);
  });
  it("falls back safely to legacy tuples if uniform changes need more than 65536 fragmented runs", () => {
    const base = createPixelArtDocument(4096, 33, { layers: [createPixelLayer(4096, 33, { id: "a" })] });
    const filled = structuredClone(base); for (let index = 0; index < 65_537; index += 1) filled.layers[0]!.pixels[index * 2] = "#FF0000";
    const actions = diffImageDocuments(base, filled); expect(actions[0]?.type).toBe("pixels");
    expect(actions[0]?.type === "pixels" && actions[0].changes.length).toBe(65_537);
    expect(splitImageActionBatches(actions).flat().every((action) => action.type === "pixels" && action.changes.length <= 65_536)).toBe(true);
  });
  it("clips runs through resize/undo ABA without resurrecting cropped pixels or mutating originals", () => {
    const operation = runPacket({ width: 4, height: 3, actions: [{ type: "pixel-runs", layer_id: "a", color: "#FF0000", runs: [[0, 12]] }] });
    const original = structuredClone(operation); Object.freeze((operation.actions[0] as { runs: [number, number][] }).runs[0]);
    const events: ImageOperationTransform[] = [{ revision: 1, from_width: 4, from_height: 3, to_width: 3, to_height: 2, offset_x: -1, offset_y: -1 }, { revision: 2, from_width: 3, from_height: 2, to_width: 4, to_height: 3, offset_x: 1, offset_y: 1 }];
    const rebased = rebaseImageOperationActions(operation, events);
    expect(rebased.actions).toEqual([{ type: "pixel-runs", layer_id: "a", color: "#FF0000", runs: [[5, 3], [9, 3]] }]); expect(operation).toEqual(original);
    const cropped = rebaseImageOperationActions(runPacket({ width: 4, height: 3, actions: [{ type: "pixel-runs", layer_id: "a", color: null, runs: [[0, 4]] }] }), events);
    expect(cropped.actions).toEqual([{ type: "pixel-runs", layer_id: "a", color: null, runs: [] }]);
    const source = createPixelArtDocument(4, 3, { layers: [createPixelLayer(4, 3, { id: "a" })] }); expect(applyImageActions(source, cropped.actions, cropped)).toEqual(source);
    expect(validateImageOperation({ ...operation, actions: cropped.actions })).toBe(false);
  });
  it("maps many span frames identically to individual pixels, clipping every intermediate event", () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const initialWidth = seed % 7 + 1; const initialHeight = seed % 5 + 1;
      const indexes = Array.from({ length: initialWidth * initialHeight }, (_, index) => index).filter((index) => (index * 17 + seed) % 5 < 3);
      const runs: [number, number][] = []; for (const index of indexes) { const last = runs.at(-1); if (last && last[0] + last[1] === index) last[1] += 1; else runs.push([index, 1]); }
      let width = initialWidth; let height = initialHeight; const events: ImageOperationTransform[] = [];
      for (let revision = 1; revision <= 3; revision += 1) { const nextWidth = (seed * revision * 3) % 8 + 1; const nextHeight = (seed * revision * 5) % 7 + 1; events.push({ revision, from_width: width, from_height: height, to_width: nextWidth, to_height: nextHeight, offset_x: (seed + revision) % 5 - 2, offset_y: (seed * revision) % 5 - 2 }); width = nextWidth; height = nextHeight; }
      const pixels = rebaseImageOperationActions(runPacket({ width: initialWidth, height: initialHeight, actions: [{ type: "pixels", layer_id: "a", changes: indexes.map((index) => [index, "#FF0000"]) }] }), events);
      const spans = rebaseImageOperationActions(runPacket({ width: initialWidth, height: initialHeight, actions: [{ type: "pixel-runs", layer_id: "a", color: "#FF0000", runs }] }), events);
      const expanded = spans.actions.flatMap((action) => action.type === "pixel-runs" ? action.runs.flatMap(([start, length]) => Array.from({ length }, (_, index) => start + index)) : []);
      expect(expanded).toEqual(pixels.actions.flatMap((action) => action.type === "pixels" ? action.changes.map(([index]) => index) : []));
    }
  });
  it("validates indexes beyond 65535 while enforcing canvas area and packet-count bounds", () => {
    const packet: ImageOperation = { operation_id: "large", base_revision: 0, width: 1024, height: 1024, actions: [{ type: "pixels", layer_id: "a", changes: [[1_048_575, "#12345680"]] }] };
    expect(validateImageOperation(packet)).toBe(true);
    expect(validateImageOperation({ ...packet, width: 4096, height: 4096 })).toBe(false);
    expect(validateImageOperation({ ...packet, actions: [{ type: "pixels", layer_id: "a", changes: [[1_048_576, null]] }] })).toBe(false);
    expect(validateImageOperation({ ...packet, actions: [{ type: "resize", width: 2048, height: 2048, anchor: "center" }] })).toBe(true);
    expect(validateImageOperation({ ...packet, actions: [{ type: "resize", width: 2049, height: 2048, anchor: "center" }] })).toBe(false);
  });
  it("splits one 1024-square fill into ordered valid bounded actions and packets", () => {
    const changes = Array.from({ length: 1_048_576 }, (_, index) => [index, "#123456"] as [number, string]);
    const actions = [{ type: "pixels" as const, layer_id: "a", changes }]; const batches = splitImageActionBatches(actions);
    expect(batches.flat().flatMap((action) => action.type === "pixels" ? action.changes : [])).toEqual(changes);
    expect(batches.flat().every((action) => action.type === "pixels" && action.changes.length <= 65_536)).toBe(true);
    expect(batches.every((actions) => validateImageOperation({ operation_id: "fill", base_revision: 0, width: 1024, height: 1024, actions }))).toBe(true);
    expect(actions[0]!.changes).toBe(changes);
  });
  it("compacts structural snapshots before packet-size checks without altering attempted packets", () => {
    const large = createPixelArtDocument(1024, 1024);
    const operation: ImageOperation = { operation_id: "import", base_revision: 0, width: 2, height: 2, actions: [{ type: "import", document: large }], _client_attempted: true, _client_expected_document: document() };
    const batch = splitImageActionBatches(operation.actions); expect(batch).toEqual([operation.actions]);
    const wire = toImageOperationPacket(operation);
    expect(wire).not.toHaveProperty("_client_attempted"); expect(wire).not.toHaveProperty("_client_expected_document");
    expect(validateImageOperation(wire)).toBe(true); expect(JSON.stringify(wire).length).toBeLessThan(20_000);
    expect(Array.isArray(large.layers[0]!.pixels)).toBe(true); expect(operation.actions[0]).toEqual({ type: "import", document: large });
    const layerPacket = toImageOperationPacket({ ...operation, width: 1024, height: 1024, actions: [{ type: "layer-add", layer: large.layers[0]!, after_id: null }, { type: "layer-remove", layer_id: "old", expected_layer: large.layers[0]! }] });
    expect(validateImageOperation(layerPacket)).toBe(true); expect(JSON.stringify(layerPacket).length).toBeLessThan(40_000);
  });
  it("rejects aggregate resize/layer-add allocations before cloning source buffers", () => {
    const layer = { id: "base", name: "Base", visible: true, locked: false, opacity: 1, pixels: [null] };
    const source = { version: 2 as const, width: 2048, height: 2048, palette: [], layers: Array.from({ length: 4 }, (_, index) => ({ ...layer, id: `layer-${index}` })) };
    const read = Object.getOwnPropertyDescriptor(source.layers[0]!, "pixels")!;
    Object.defineProperty(source.layers[0]!, "pixels", { get() { throw new Error("must not clone"); } });
    expect(() => applyImageActions(source, [{ type: "layer-add", layer: { ...layer, id: "extra" }, after_id: null }])).toThrow("total layer-pixel limit");
    Object.defineProperty(source.layers[0]!, "pixels", read);
    expect(() => resizePixelArtDocument({ ...source, width: 1024, height: 1024, layers: [...source.layers, { ...layer, id: "five" }] }, 2048, 2048, "center")).toThrow("layer pixels");
  });
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
