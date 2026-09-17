import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectResourceDetail } from "../../../lib/api";
import { clonePixelArtDocument, createPixelArtDocument, createPixelLayer } from "../lib/document";
import { applyImageActions, rebaseImageOperationActions, type ImageOperation, type ImageOperationTransform } from "../lib/imageOperations";
import type { ImageOperationStore, StoredImageOperationQueue } from "../lib/imageOperationStore";
import { ImageOperationHttpError, type ImageOperationTransport } from "../lib/imageOperationsApi";
import type { PixelArtDocumentV2 } from "../types";
import { useImageOperationSync } from "./useImageOperationSync";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); };
const baseDocument = () => createPixelArtDocument(2, 2, { layers: [createPixelLayer(2, 2, { id: "layer" })] });
const resource = (document = baseDocument(), revision = 0): ProjectResourceDetail => ({ id: "resource", project_id: "project", name: "Image", type: "image", revision, data: { pixel_art: document }, resource_metadata: {}, position: 0, created_at: "2026-01-01", updated_at: "2026-01-01" });
const memoryStore = () => {
  let saved: StoredImageOperationQueue | null = null;
  const store: ImageOperationStore = { read: vi.fn(async () => saved ? clone(saved) : null), write: vi.fn(async (value) => { saved = clone(value); }) };
  return { store, get saved() { return saved; } };
};
const server = () => {
  let current = resource();
  const receipts = new Map<string, number>();
  const sendOperation = vi.fn(async (operation: ImageOperation) => {
    const receipt = receipts.get(operation.operation_id);
    if (receipt !== undefined) return { operation_id: operation.operation_id, applied_revision: receipt, resource: clone(current) };
    current = resource(applyImageActions(current.data.pixel_art as PixelArtDocumentV2, operation.actions, operation), current.revision + 1);
    receipts.set(operation.operation_id, current.revision);
    return { operation_id: operation.operation_id, applied_revision: current.revision, resource: clone(current) };
  });
  const transport: ImageOperationTransport = { fetchResource: vi.fn(async () => clone(current)), sendOperation };
  return { transport, sendOperation, get current() { return current; }, replace(value: ProjectResourceDetail) { current = clone(value); } };
};
const sharedServer = () => {
  let current = resource();
  const transforms: ImageOperationTransform[] = [];
  const receipts = new Map<string, number>();
  const frames = new Map<string, number>();
  const history: Array<{ before: PixelArtDocumentV2; after: PixelArtDocumentV2; group?: string; geometry?: { x: number; y: number } }> = [];
  let cursor = 0;
  const flags = () => ({ can_undo: cursor > 0, can_redo: cursor < history.length });
  const state = (since: number) => ({ resource: clone(current), history: flags(), transforms: clone(transforms.filter((event) => event.revision > since)) });
  const sendOperation = vi.fn(async (operation: ImageOperation) => {
    const receipt = receipts.get(operation.operation_id);
    if (receipt !== undefined) return { operation_id: operation.operation_id, applied_revision: receipt, ...state(operation.base_revision) };
    const before = clone(current.data.pixel_art as PixelArtDocumentV2);
    const action = operation.actions[0]!;
    let next = before;
    let geometry: { x: number; y: number } | undefined;
    if (action.type === "undo") {
      if (cursor > 0) { const entry = history[--cursor]!; next = clone(entry.before); if (entry.geometry) geometry = { x: -entry.geometry.x, y: -entry.geometry.y }; }
    } else if (action.type === "redo") {
      if (cursor < history.length) { const entry = history[cursor++]!; next = clone(entry.after); geometry = entry.geometry; }
    } else {
      const dependencyRevision = operation.coordinate_after_operation_id ? frames.get(operation.coordinate_after_operation_id) : undefined;
      const rebased = rebaseImageOperationActions({ ...operation, ...(dependencyRevision !== undefined ? { _client_dependency_revision: dependencyRevision } : {}) }, transforms, "user");
      next = applyImageActions(before, rebased.actions, rebased);
      if (action.type === "resize") {
        const horizontal = action.anchor.includes("left") ? 0 : action.anchor.includes("right") ? 1 : 0.5;
        const vertical = action.anchor.includes("top") ? 0 : action.anchor.includes("bottom") ? 1 : 0.5;
        geometry = { x: Math.round((next.width - before.width) * horizontal), y: Math.round((next.height - before.height) * vertical) };
      } else if (action.type === "import") geometry = { x: 0, y: 0 };
      if (JSON.stringify(before) !== JSON.stringify(next)) {
        history.splice(cursor);
        const last = history.at(-1);
        if (operation.history_group_id && last?.group === operation.history_group_id && !geometry) last.after = clone(next);
        else history.push({ before, after: clone(next), group: operation.history_group_id, geometry });
        cursor = history.length;
      }
    }
    current = resource(next, current.revision + 1);
    if (geometry) transforms.push({ revision: current.revision, operation_id: operation.operation_id, user_id: "user", from_width: before.width, from_height: before.height, to_width: next.width, to_height: next.height, offset_x: geometry.x, offset_y: geometry.y });
    if (action.type === "resize" || action.type === "import") frames.set(operation.operation_id, current.revision);
    receipts.set(operation.operation_id, current.revision);
    return { operation_id: operation.operation_id, applied_revision: current.revision, ...state(operation.base_revision) };
  });
  const transport: ImageOperationTransport = { fetchResource: vi.fn(async () => clone(current)), fetchState: vi.fn(async (since) => state(since)), sendOperation };
  return { transport, sendOperation, get current() { return current; }, get transforms() { return clone(transforms); } };
};
const client = (store: ImageOperationStore, transport: ImageOperationTransport, extra: Partial<Parameters<typeof useImageOperationSync>[0]> = {}) => {
  let document = baseDocument();
  const onDocument = vi.fn((value: PixelArtDocumentV2) => { document = clonePixelArtDocument(value); });
  const sync = useImageOperationSync({ projectId: "project", resourceId: "resource", userId: "user", store, transport, onDocument, ...extra });
  return { sync, onDocument, get document() { return clonePixelArtDocument(document); } };
};

describe("durable image operation synchronization", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("queues normalized sparse brush deltas on a 256-square canvas without changing caller data", async () => {
    const initial = createPixelArtDocument(256, 256, { layers: [createPixelLayer(256, 256, { id: "large" }), createPixelLayer(256, 256, { id: "untouched" })] });
    const remote = server(); remote.replace(resource(initial)); const disk = memoryStore(); const local = client(disk.store, remote.transport, { isOnline: () => false }); await local.sync.start(remote.current);
    const changes = Object.freeze([Object.freeze({ index: 65535, before: null, after: "#ff0000" }), Object.freeze({ index: 0, after: "#00ff00" })]);
    await local.sync.schedulePixels(256, 256, "large", changes, { historyGroupId: "brush", previewSequence: 2 });
    expect(disk.saved?.operations).toHaveLength(1); expect(disk.saved?.operations[0]).toMatchObject({ base_revision: 0, width: 256, height: 256, history_group_id: "brush", actions: [{ type: "pixels", layer_id: "large", changes: [[0, "#00FF00"], [65535, "#FF0000"]] }] });
    expect(disk.saved?.localDocument?.layers[0]?.pixels[0]).toBe("#00FF00"); expect(disk.saved?.localDocument?.layers[0]?.pixels[65535]).toBe("#FF0000"); expect(disk.saved?.localDocument?.layers[1]?.pixels.every((pixel) => pixel === null)).toBe(true);
    expect(initial.layers[0]?.pixels[0]).toBeNull(); expect(changes[0]?.after).toBe("#ff0000"); expect(remote.sendOperation).not.toHaveBeenCalled(); local.sync.dispose();
  });

  it("de-duplicates net sparse deltas and skips no-ops without journal writes", async () => {
    const remote = server(); const disk = memoryStore(); const local = client(disk.store, remote.transport, { isOnline: () => false }); await local.sync.start(remote.current); vi.mocked(disk.store.write).mockClear();
    await local.sync.schedulePixels(2, 2, "layer", [{ index: 0, after: null }, { index: 1, after: "#FF0000" }, { index: 1, before: "#FF0000", after: null }]);
    expect(disk.store.write).not.toHaveBeenCalled(); expect(local.sync.pendingCount.value).toBe(0);
    await local.sync.schedulePixels(2, 2, "layer", [{ index: 3, after: "#FF0000" }, { index: 0, after: "#00FF00" }, { index: 3, before: null, after: "#0000FF" }]);
    expect(disk.saved?.operations[0]?.actions).toEqual([{ type: "pixels", layer_id: "layer", changes: [[0, "#00FF00"], [3, "#0000FF"]] }]); local.sync.dispose();
  });

  it.each([
    { name: "wrong width", width: 3, height: 2, layer: "layer", changes: [{ index: 0, after: "#FF0000" }] },
    { name: "wrong height", width: 2, height: 3, layer: "layer", changes: [{ index: 0, after: "#FF0000" }] },
    { name: "missing layer", width: 2, height: 2, layer: "missing", changes: [{ index: 0, after: "#FF0000" }] },
    { name: "out of bounds", width: 2, height: 2, layer: "layer", changes: [{ index: 4, after: "#FF0000" }] },
    { name: "negative index", width: 2, height: 2, layer: "layer", changes: [{ index: -1, after: "#FF0000" }] },
    { name: "fractional index", width: 2, height: 2, layer: "layer", changes: [{ index: 0.5, after: "#FF0000" }] },
    { name: "invalid color", width: 2, height: 2, layer: "layer", changes: [{ index: 0, after: "invalid" }] },
    { name: "stale before", width: 2, height: 2, layer: "layer", changes: [{ index: 0, before: "#00FF00", after: "#FF0000" }] },
    { name: "invalid previous color", width: 2, height: 2, layer: "layer", changes: [{ index: 0, before: "invalid", after: "#FF0000" }] },
  ])("rejects malformed sparse input: $name, preserving the existing queue and local document", async ({ width, height, layer, changes }) => {
    const remote = server(); const disk = memoryStore(); const local = client(disk.store, remote.transport, { isOnline: () => false }); await local.sync.start(remote.current);
    await local.sync.schedulePixels(2, 2, "layer", [{ index: 2, after: "#0000FF" }]); const preserved = clone(disk.saved); vi.mocked(disk.store.write).mockClear();
    await local.sync.schedulePixels(width, height, layer, changes); expect(disk.store.write).not.toHaveBeenCalled(); expect(disk.saved).toEqual(preserved); expect(local.sync.errorMessage.value).not.toBe("");
    const desired = baseDocument(); desired.layers[0]!.pixels[2] = "#0000FF"; await local.sync.schedule(desired); expect(local.sync.pendingCount.value).toBe(1); local.sync.dispose();
  });

  it("uses the server coordinate lineage for sparse pixels scheduled during a paused gesture", async () => {
    const remote = sharedServer(); const disk = memoryStore(); const local = client(disk.store, remote.transport); const other = client(memoryStore().store, remote.transport); await local.sync.start(remote.current); await other.sync.start(remote.current);
    local.sync.setInteractionActive(true); const resize = { width: 3, height: 3, anchor: "bottom-right" as const }; await other.sync.schedule(applyImageActions(other.document, [{ type: "resize", ...resize }]), { resize }); await other.sync.flush(); await local.sync.refresh();
    await local.sync.schedulePixels(2, 2, "layer", [{ index: 0, before: null, after: "#FF0000" }]); expect(disk.saved?.operations[0]).toMatchObject({ base_revision: 0, width: 2, height: 2 });
    local.sync.setInteractionActive(false); await local.sync.flush(); expect(local.document.width).toBe(3); expect(local.document.layers[0]?.pixels[4]).toBe("#FF0000"); expect(local.sync.status.value).toBe("saved"); local.sync.dispose(); other.sync.dispose();
  });

  it("preserves an exact pending resize dependency and recovers sparse pixels after reload", async () => {
    const remote = sharedServer(); let connected = false; const disk = memoryStore(); const local = client(disk.store, remote.transport, { isOnline: () => connected }); await local.sync.start(remote.current);
    const resize = { width: 3, height: 3, anchor: "center" as const }; await local.sync.schedule(applyImageActions(local.document, [{ type: "resize", ...resize }]), { resize }); const resizeId = disk.saved?.operations[0]?.operation_id;
    await local.sync.schedulePixels(3, 3, "layer", [{ index: 4, before: null, after: "#FF0000" }], { historyGroupId: "after-resize" });
    expect(disk.saved?.operations[1]).toMatchObject({ coordinate_after_operation_id: resizeId, width: 3, height: 3, actions: [{ type: "pixels", layer_id: "layer", changes: [[4, "#FF0000"]] }] });
    local.sync.dispose(); await settle(); const recovered = client(disk.store, remote.transport, { isOnline: () => connected }); await recovered.sync.start(remote.current); expect(recovered.document.layers[0]?.pixels[4]).toBe("#FF0000"); connected = true; await recovered.sync.retry();
    expect(remote.sendOperation.mock.calls[1]?.[0].coordinate_after_operation_id).toBe(resizeId); expect(recovered.document.width).toBe(3); expect(recovered.document.layers[0]?.pixels[4]).toBe("#FF0000"); expect(disk.saved?.operations).toEqual([]); recovered.sync.dispose();
  });

  it("never mutates an attempted sparse packet or its in-flight journal snapshot on later pointer frames", async () => {
    const remote = server(); const disk = memoryStore(); const local = client(disk.store, remote.transport); await local.sync.start(remote.current);
    const send = remote.transport.sendOperation; const gate = deferred<void>(); remote.transport.sendOperation = async (operation) => { await gate.promise; return send(operation); };
    await local.sync.schedulePixels(2, 2, "layer", [{ index: 0, after: "#FF0000" }], { historyGroupId: "stroke" }); const flushing = local.sync.flush(); await settle(); const frozen = clone(disk.saved?.operations[0]);
    const heldFrame = disk.saved?.localDocument; await local.sync.schedulePixels(2, 2, "layer", [{ index: 0, before: "#FF0000", after: "#00FF00" }, { index: 1, after: "#0000FF" }], { historyGroupId: "stroke" });
    expect(disk.saved?.operations[0]).toEqual(frozen); expect(disk.saved?.operations).toHaveLength(2); expect(heldFrame?.layers[0]?.pixels).toEqual(["#FF0000", null, null, null]);
    gate.resolve(); await flushing; expect(remote.sendOperation.mock.calls[0]?.[0].actions).toEqual([{ type: "pixels", layer_id: "layer", changes: [[0, "#FF0000"]] }]); expect(remote.sendOperation.mock.calls[1]?.[0].actions).toEqual([{ type: "pixels", layer_id: "layer", changes: [[0, "#00FF00"], [1, "#0000FF"]] }]);
    expect(local.document.layers[0]?.pixels).toEqual(["#00FF00", "#0000FF", null, null]); local.sync.dispose();
  });

  it("the asynchronous journal retains an immutable complete local frame while the next sparse edit arrives", async () => {
    const remote = server(); const disk = memoryStore(); const local = client(disk.store, remote.transport, { isOnline: () => false }); await local.sync.start(remote.current);
    const write = disk.store.write; const gate = deferred<void>(); let firstFrame: StoredImageOperationQueue | null = null;
    disk.store.write = async (queue) => { if (!firstFrame) { firstFrame = queue; await gate.promise; } await write(queue); };
    const first = local.sync.schedulePixels(2, 2, "layer", [{ index: 0, after: "#FF0000" }]); await settle(); const second = local.sync.schedulePixels(2, 2, "layer", [{ index: 1, after: "#00FF00" }]); await settle();
    const frame = firstFrame as StoredImageOperationQueue | null; expect(frame?.localDocument?.layers[0]?.pixels).toEqual(["#FF0000", null, null, null]); expect(frame?.operations[0]?.actions).toEqual([{ type: "pixels", layer_id: "layer", changes: [[0, "#FF0000"]] }]); expect(frame?.resource?.data.pixel_art).toEqual(baseDocument());
    gate.resolve(); await Promise.all([first, second]); expect(disk.saved?.localDocument?.layers[0]?.pixels).toEqual(["#FF0000", "#00FF00", null, null]); local.sync.dispose();
  });

  it("encodes conditional sparse erasing against the observed value and keeps later full-document edits consistent", async () => {
    const remote = server(); const local = client(memoryStore().store, remote.transport); await local.sync.start(remote.current);
    await local.sync.schedulePixels(2, 2, "layer", [{ index: 0, after: "#FF0000" }]); await local.sync.flush(); await local.sync.schedulePixels(2, 2, "layer", [{ index: 0, before: "#FF0000", after: null }], { conditional: true }); await local.sync.flush();
    expect(remote.sendOperation.mock.calls.at(-1)?.[0].actions).toEqual([{ type: "pixels", layer_id: "layer", changes: [[0, null, "#FF0000"]] }]); const green = local.document; green.layers[0]!.pixels[1] = "#00FF00"; await local.sync.schedule(green); await local.sync.flush(); expect(local.document.layers[0]?.pixels).toEqual([null, "#00FF00", null, null]); local.sync.dispose();
  });

  it("does not overwrite an unreadable recovered journal when a sparse edit is attempted", async () => {
    const remote = server(); const disk = memoryStore(); disk.store.read = async () => { throw new Error("Journal unavailable"); }; const local = client(disk.store, remote.transport); await local.sync.start(remote.current);
    await local.sync.schedulePixels(2, 2, "layer", [{ index: 0, after: "#FF0000" }]); expect(disk.store.write).not.toHaveBeenCalled(); expect(remote.sendOperation).not.toHaveBeenCalled(); expect(local.sync.hasPendingChanges.value).toBe(true); local.sync.dispose();
  });

  it("two clients retain disjoint pixels without full image saves", async () => {
    const remote = server(); const one = client(memoryStore().store, remote.transport); const two = client(memoryStore().store, remote.transport);
    await one.sync.start(remote.current); await two.sync.start(remote.current);
    const left = one.document; left.layers[0]!.pixels[0] = "#FF0000";
    const right = two.document; right.layers[0]!.pixels[1] = "#00FF00";
    await one.sync.schedule(left); await two.sync.schedule(right);
    await Promise.all([one.sync.flush(), two.sync.flush()]);
    await one.sync.refresh(); await two.sync.refresh();
    expect(one.document.layers[0]!.pixels).toEqual(["#FF0000", "#00FF00", null, null]);
    expect(two.document).toEqual(one.document);
    expect(remote.sendOperation.mock.calls.every(([operation]) => operation.actions.every((action) => action.type === "pixels"))).toBe(true);
    expect(one.sync.status.value).toBe("saved"); expect(two.sync.hasPendingChanges.value).toBe(false);
    one.sync.dispose(); two.sync.dispose();
  });

  it("never turns an incoming remote pixel into a later outgoing local edit", async () => {
    const remote = server(); const local = client(memoryStore().store, remote.transport);
    await local.sync.start(remote.current);
    const changed = baseDocument(); changed.layers[0]!.pixels[0] = "#FF0000";
    remote.replace(resource(changed, 1)); await local.sync.refresh();
    const drawing = local.document; drawing.layers[0]!.pixels[1] = "#00FF00";
    await local.sync.schedule(drawing); await local.sync.flush();
    expect(remote.sendOperation.mock.calls[0]![0].actions).toEqual([{ type: "pixels", layer_id: "layer", changes: [[1, "#00FF00"]] }]);
    local.sync.dispose();
  });

  it("records synchronously, but never transmits before durable transaction completion", async () => {
    const remote = server(); const disk = memoryStore(); const gate = deferred<void>();
    disk.store.write = vi.fn(async () => gate.promise);
    const local = client(disk.store, remote.transport); await local.sync.start(remote.current);
    const drawing = local.document; drawing.layers[0]!.pixels[0] = "#FF0000";
    const saving = local.sync.schedule(drawing);
    expect(local.sync.hasPendingChanges.value).toBe(true);
    await vi.advanceTimersByTimeAsync(420);
    expect(remote.sendOperation).not.toHaveBeenCalled();
    gate.resolve(); await saving; await local.sync.flush();
    expect(remote.sendOperation).toHaveBeenCalledOnce(); local.sync.dispose();
  });
  it("coalesces unsent mousemove deltas into one packet, without coalescing conditional undo", async () => {
    const remote = server(); const disk = memoryStore(); const local = client(disk.store, remote.transport); await local.sync.start(remote.current);
    const one = local.document; one.layers[0]!.pixels[0] = "#FF0000";
    const two = clonePixelArtDocument(one); two.layers[0]!.pixels[1] = "#00FF00";
    const three = clonePixelArtDocument(two); three.layers[0]!.pixels[0] = "#0000FF";
    await Promise.all([local.sync.schedule(one), local.sync.schedule(two), local.sync.schedule(three)]);
    expect(disk.saved?.operations).toHaveLength(1); expect(local.sync.pendingCount.value).toBe(1);
    expect(disk.saved?.operations[0]!.actions).toEqual([{ type: "pixels", layer_id: "layer", changes: [[0, "#0000FF"], [1, "#00FF00"]] }]);
    await local.sync.schedule(two, { conditional: true });
    expect(disk.saved?.operations).toHaveLength(2); await local.sync.flush(); expect(remote.sendOperation).toHaveBeenCalledTimes(2); local.sync.dispose();
  });
  it("sends bounded batches during a continuous stroke instead of waiting for a pause", async () => {
    const remote = server(); const local = client(memoryStore().store, remote.transport); await local.sync.start(remote.current);
    for (let frame = 0; frame < 20; frame += 1) {
      const drawing = local.document;
      drawing.layers[0]!.pixels[0] = frame % 2 ? "#00FF00" : "#FF0000";
      await local.sync.schedule(drawing, { historyGroupId: "continuous-stroke" });
      await vi.advanceTimersByTimeAsync(25);
      if (frame === 3) expect(remote.sendOperation).toHaveBeenCalledOnce();
    }
    expect(remote.sendOperation.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(remote.sendOperation.mock.calls.every(([operation]) => operation.history_group_id === "continuous-stroke")).toBe(true);
    expect(local.sync.hasPendingChanges.value).toBe(false); local.sync.dispose();
  });
  it("normal pixel and layer-field batches do not fetch the full canvas before each POST", async () => {
    const remote = sharedServer(); const local = client(memoryStore().store, remote.transport); await local.sync.start(remote.current);
    vi.mocked(remote.transport.fetchState!).mockClear();
    const red = local.document; red.layers[0]!.pixels[0] = "#FF0000"; await local.sync.schedule(red); await local.sync.flush();
    const renamed = local.document; renamed.layers[0]!.name = "Renamed layer"; await local.sync.schedule(renamed); await local.sync.flush();
    expect(remote.sendOperation).toHaveBeenCalledTimes(2); expect(remote.transport.fetchState).not.toHaveBeenCalled();
    expect(local.document.layers[0]!).toMatchObject({ name: "Renamed layer", pixels: ["#FF0000", null, null, null] }); local.sync.dispose();
  });
  it("server-confirmed deltas rebase through an unseen anchored resize without a pre-send GET", async () => {
    const remote = sharedServer(); const onConflict = vi.fn(); const local = client(memoryStore().store, remote.transport, { onConflict }); const other = client(memoryStore().store, remote.transport);
    await local.sync.start(remote.current); await other.sync.start(remote.current);
    const red = local.document; red.layers[0]!.pixels[0] = "#FF0000"; await local.sync.schedule(red);
    const resize = { width: 3, height: 3, anchor: "bottom-right" as const };
    await other.sync.schedule(applyImageActions(other.document, [{ type: "resize", ...resize }]), { resize }); await other.sync.flush();
    vi.mocked(remote.transport.fetchState!).mockClear(); await local.sync.flush();
    expect(remote.transport.fetchState).not.toHaveBeenCalled(); expect(local.document.width).toBe(3);
    expect(local.document.layers[0]!.pixels[4]).toBe("#FF0000"); expect(onConflict).not.toHaveBeenCalled();
    expect(remote.sendOperation.mock.calls.at(-1)![0]).toMatchObject({ width: 2, height: 2, base_revision: 0 }); local.sync.dispose(); other.sync.dispose();
  });
  it("coalesces concurrent canonical refresh requests into one GET", async () => {
    const remote = sharedServer(); const local = client(memoryStore().store, remote.transport); await local.sync.start(remote.current);
    const fetch = remote.transport.fetchState!; const gate = deferred<void>();
    remote.transport.fetchState = vi.fn(async (since) => { await gate.promise; return fetch(since); });
    const refreshing = [local.sync.refresh(), local.sync.refresh(), local.sync.refresh()]; await settle();
    expect(remote.transport.fetchState).toHaveBeenCalledOnce(); gate.resolve();
    expect(await Promise.all(refreshing)).toEqual([true, true, true]); local.sync.dispose();
  });
  it("a fresh ACK-triggered refresh bypasses an older in-flight GET without accepting its late snapshot", async () => {
    const remote = sharedServer(); const local = client(memoryStore().store, remote.transport); const other = client(memoryStore().store, remote.transport);
    await local.sync.start(remote.current); await other.sync.start(remote.current);
    const fetch = remote.transport.fetchState!; const oldResponse = deferred<void>(); let requests = 0;
    remote.transport.fetchState = vi.fn(async (since) => {
      requests += 1;
      if (requests === 1) { const snapshot = await fetch(since); await oldResponse.promise; return snapshot; }
      return fetch(since);
    });
    const ordinary = local.sync.refresh(); await settle(); expect(remote.transport.fetchState).toHaveBeenCalledOnce();
    const red = other.document; red.layers[0]!.pixels[0] = "#FF0000"; await other.sync.schedule(red); await other.sync.flush();
    const fresh = local.sync.refresh(true); await settle(); expect(remote.transport.fetchState).toHaveBeenCalledTimes(2);
    expect(await fresh).toBe(true); expect(local.document.layers[0]!.pixels[0]).toBe("#FF0000");
    oldResponse.resolve(); expect(await ordinary).toBe(true);
    expect(local.document.layers[0]!.pixels[0]).toBe("#FF0000"); expect(local.sync.canUndo.value).toBe(true); local.sync.dispose(); other.sync.dispose();
  });
  it("fetches older coordinate history when new pending changes cannot use an in-flight GET", async () => {
    const remote = sharedServer(); const local = client(memoryStore().store, remote.transport); const other = client(memoryStore().store, remote.transport);
    await local.sync.start(remote.current); await other.sync.start(remote.current); local.sync.setInteractionActive(true);
    const resize = { width: 3, height: 3, anchor: "bottom-right" as const };
    await other.sync.schedule(applyImageActions(other.document, [{ type: "resize", ...resize }]), { resize }); await other.sync.flush(); await local.sync.refresh();
    const fetch = remote.transport.fetchState!; const gate = deferred<void>(); let first = true;
    remote.transport.fetchState = vi.fn(async (since) => { if (first) { first = false; await gate.promise; } return fetch(since); });
    const refreshing = local.sync.refresh(); await settle(); expect(remote.transport.fetchState).toHaveBeenCalledWith(1);
    const oldFrame = local.document; oldFrame.layers[0]!.pixels[0] = "#FF0000"; await local.sync.schedule(oldFrame);
    const following = local.sync.refresh(); await settle(); expect(remote.transport.fetchState).toHaveBeenCalledOnce(); gate.resolve();
    expect(await refreshing).toBe(true); expect(await following).toBe(true); expect(remote.transport.fetchState).toHaveBeenCalledTimes(2);
    expect(remote.transport.fetchState).toHaveBeenLastCalledWith(0); local.sync.setInteractionActive(false);
    expect(local.document.layers[0]!.pixels[4]).toBe("#FF0000"); await local.sync.flush(); local.sync.dispose(); other.sync.dispose();
  });
  it("does not starve a durable frozen packet while later pointer frames keep writing", async () => {
    const remote = server(); const disk = memoryStore(); const save = disk.store.write;
    const writes: Array<{ queue: StoredImageOperationQueue; gate: ReturnType<typeof deferred<void>> }> = [];
    disk.store.write = vi.fn(async (queue) => { const snapshot = clone(queue); const gate = deferred<void>(); writes.push({ queue: snapshot, gate }); await gate.promise; await save(snapshot); });
    const send = remote.transport.sendOperation;
    remote.transport.sendOperation = vi.fn(async (operation) => {
      const stored = disk.saved!.operations.find((pending) => pending.operation_id === operation.operation_id);
      expect(stored?._client_attempted).toBe(true); expect(stored?.actions).toEqual(operation.actions); return send(operation);
    });
    const local = client(disk.store, remote.transport); await local.sync.start(remote.current);
    const first = local.document; first.layers[0]!.pixels[0] = "#FF0000"; const savingFirst = local.sync.schedule(first); await settle();
    await vi.advanceTimersByTimeAsync(100); expect(remote.sendOperation).not.toHaveBeenCalled();
    const second = clone(first); second.layers[0]!.pixels[1] = "#00FF00"; const savingSecond = local.sync.schedule(second);
    writes[0]!.gate.resolve(); await settle(); expect(writes).toHaveLength(2);
    const third = clone(second); third.layers[0]!.pixels[2] = "#0000FF"; const savingThird = local.sync.schedule(third);
    writes[1]!.gate.resolve(); await settle();
    expect(writes.length).toBeGreaterThanOrEqual(3); expect(remote.sendOperation).toHaveBeenCalledOnce();
    expect(remote.sendOperation.mock.calls[0]![0].actions).toEqual([{ type: "pixels", layer_id: "layer", changes: [[0, "#FF0000"]] }]);
    for (let index = 0; index < writes.length && index < 15; index += 1) { writes[index]!.gate.resolve(); await settle(); }
    await Promise.all([savingFirst, savingSecond, savingThird]); await local.sync.flush();
    expect(remote.current.data.pixel_art).toEqual(third); expect(local.sync.hasPendingChanges.value).toBe(false); local.sync.dispose();
  });
  it("does not transmit an old account's packet when the account changes during its durable write", async () => {
    const remote = server(); const disk = memoryStore(); const save = disk.store.write; const gate = deferred<void>(); let currentUser = "user";
    disk.store.write = vi.fn(async (queue) => { await gate.promise; await save(queue); });
    const local = client(disk.store, remote.transport, { userId: () => currentUser }); await local.sync.start(remote.current);
    const red = local.document; red.layers[0]!.pixels[0] = "#FF0000"; const saving = local.sync.schedule(red);
    const flushing = local.sync.flush(); await settle(); currentUser = "different-user"; gate.resolve(); await saving; await flushing;
    expect(remote.sendOperation).not.toHaveBeenCalled(); expect(local.sync.hasPendingChanges.value).toBe(true);
    expect(local.sync.errorMessage.value).toMatch(/signed-in account changed/); local.sync.dispose();
  });
  it("acknowledges the frozen preview watermark even while document publication is deferred", async () => {
    const remote = server(); const send = remote.transport.sendOperation; const gate = deferred<void>(); let first = true;
    remote.transport.sendOperation = async (operation) => { const result = await send(operation); if (first) { first = false; await gate.promise; } return result; };
    const onAcknowledged = vi.fn(); const disk = memoryStore(); const local = client(disk.store, remote.transport, { onAcknowledged }); await local.sync.start(remote.current);
    const initialPublications = local.onDocument.mock.calls.length; local.sync.setInteractionActive(true);
    const red = local.document; red.layers[0]!.pixels[0] = "#FF0000"; await local.sync.schedule(red, { previewSequence: 1 });
    const green = clone(red); green.layers[0]!.pixels[1] = "#00FF00"; await local.sync.schedule(green, { previewSequence: 2 });
    const flushing = local.sync.flush(); await settle();
    const blue = clone(green); blue.layers[0]!.pixels[2] = "#0000FF"; await local.sync.schedule(blue, { previewSequence: 3 }); gate.resolve(); await flushing;
    expect(onAcknowledged.mock.calls.map(([acknowledgement]) => acknowledgement.previewSequence)).toEqual([2, 3]);
    expect(onAcknowledged.mock.calls[0]![0]).toMatchObject({ operationId: remote.sendOperation.mock.calls[0]![0].operation_id, appliedRevision: 1 });
    expect(local.onDocument).toHaveBeenCalledTimes(initialPublications);
    expect(remote.sendOperation.mock.calls.every(([operation]) => !("previewSequence" in operation))).toBe(true);
    expect(disk.saved).not.toHaveProperty("previewSequence"); local.sync.setInteractionActive(false);
    expect(local.document).toEqual(blue); local.sync.dispose();
  });
  it("refreshes canonical state after reconnect even with no local pending operations", async () => {
    const remote = server(); const local = client(memoryStore().store, remote.transport); await local.sync.start(remote.current);
    const changed = baseDocument(); changed.layers[0]!.pixels[1] = "#00FF00"; remote.replace(resource(changed, 1));
    await local.sync.retry(); expect(local.document).toEqual(changed); expect(remote.sendOperation).not.toHaveBeenCalled(); local.sync.dispose();
  });
  it("a clean offline tab becomes saved again when connectivity returns", async () => {
    const remote = server(); let online = false; const local = client(memoryStore().store, remote.transport, { isOnline: () => online }); await local.sync.start(remote.current);
    expect(local.sync.status.value).toBe("offline"); online = true; await local.sync.retry();
    expect(local.sync.status.value).toBe("saved"); expect(local.sync.errorMessage.value).toBe(""); expect(local.sync.hasPendingChanges.value).toBe(false); local.sync.dispose();
  });
  it("successful refresh automatically retries a transient send failure while navigator remains online", async () => {
    const remote = server(); const send = remote.transport.sendOperation; let fail = true;
    remote.transport.sendOperation = async (operation) => { if (fail) { fail = false; throw new TypeError("Failed to fetch"); } return send(operation); };
    const local = client(memoryStore().store, remote.transport); await local.sync.start(remote.current);
    const drawing = local.document; drawing.layers[0]!.pixels[0] = "#FF0000"; await local.sync.schedule(drawing); await local.sync.flush();
    expect(local.sync.status.value).toBe("error"); await local.sync.refresh(); expect(remote.sendOperation).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000); await local.sync.refresh();
    expect(local.sync.status.value).toBe("saved"); expect(local.sync.hasPendingChanges.value).toBe(false); expect(remote.current.data.pixel_art).toEqual(drawing); local.sync.dispose();
  });
  it.each([409, 422, 401, 403])("refresh never auto-retries an exceptional HTTP %s failure", async (status) => {
    const remote = server(); const send = vi.fn(async () => { throw new ImageOperationHttpError(status, { message: "Rejected" }); }); remote.transport.sendOperation = send;
    const local = client(memoryStore().store, remote.transport); await local.sync.start(remote.current);
    const drawing = local.document; drawing.layers[0]!.pixels[0] = "#FF0000"; await local.sync.schedule(drawing); await local.sync.flush();
    await vi.advanceTimersByTimeAsync(30000); await local.sync.refresh(); await local.sync.refresh();
    expect(send).toHaveBeenCalledOnce(); expect(local.sync.hasPendingChanges.value).toBe(true); local.sync.dispose();
  });

  it("retains operations in memory and does not transmit after disk failure", async () => {
    const remote = server(); const disk = memoryStore();
    disk.store.write = vi.fn(async () => { throw new Error("Disk full"); });
    const local = client(disk.store, remote.transport); await local.sync.start(remote.current);
    const drawing = local.document; drawing.layers[0]!.pixels[0] = "#FF0000";
    await local.sync.schedule(drawing); await local.sync.flush();
    expect(remote.sendOperation).not.toHaveBeenCalled(); expect(local.sync.hasPendingChanges.value).toBe(true); expect(local.sync.status.value).toBe("error");
    disk.store.write = vi.fn(async () => undefined); await local.sync.retry();
    expect(remote.sendOperation).toHaveBeenCalledOnce(); expect(local.sync.hasPendingChanges.value).toBe(false); local.sync.dispose();
  });

  it("recovers an offline queue after reload, overlays the latest remote state and drains on reconnect", async () => {
    const remote = server(); const disk = memoryStore(); let online = false;
    const first = client(disk.store, remote.transport, { isOnline: () => online }); await first.sync.start(remote.current);
    const drawing = first.document; drawing.layers[0]!.pixels[0] = "#FF0000";
    await first.sync.schedule(drawing); first.sync.dispose(); await settle();
    const changed = baseDocument(); changed.layers[0]!.pixels[1] = "#00FF00"; remote.replace(resource(changed, 1));
    const reopened = client(disk.store, remote.transport, { isOnline: () => online }); await reopened.sync.start(remote.current);
    expect(reopened.document.layers[0]!.pixels).toEqual(["#FF0000", "#00FF00", null, null]);
    expect(reopened.sync.status.value).toBe("offline"); online = true; await reopened.sync.retry();
    expect(remote.current.data.pixel_art).toEqual(reopened.document); expect(disk.saved?.operations).toEqual([]); reopened.sync.dispose();
  });
  it.each(["resize", "layer-delete"])("recovers the exact local copy after a %s conflict and reload", async (conflict) => {
    const remote = server(); const disk = memoryStore(); const local = client(disk.store, remote.transport, { isOnline: () => false });
    const initial = baseDocument(); initial.layers.push(createPixelLayer(2, 2, { id: "other" })); remote.replace(resource(initial)); await local.sync.start(remote.current);
    const drawing = local.document; drawing.layers[0]!.pixels[0] = "#FF0000"; await local.sync.schedule(drawing);
    const changed = conflict === "resize" ? createPixelArtDocument(3, 3) : createPixelArtDocument(2, 2, { layers: [createPixelLayer(2, 2, { id: "other" })] });
    remote.replace(resource(changed, 1)); await local.sync.refresh();
    const expectedLocal = conflict === "resize" ? drawing : changed;
    expect(disk.saved?.localDocument).toEqual(expectedLocal); expect(disk.saved?.localDocumentUnencodable).toBe(false);
    expect(disk.saved?.resource?.revision).toBe(1); local.sync.dispose(); await settle();
    const reopened = client(disk.store, remote.transport, { isOnline: () => false }); await reopened.sync.start(remote.current);
    expect(reopened.document).toEqual(expectedLocal); expect(reopened.sync.hasPendingChanges.value).toBe(true); expect(disk.saved?.operations).toHaveLength(1);
    if (conflict === "resize") expect(reopened.sync.errorMessage.value).toMatch(/dimensions changed/); else expect(reopened.sync.errorMessage.value).toBe(""); reopened.sync.dispose();
  });

  it("retries the same identifier after a lost ACK and receives current canonical state", async () => {
    const remote = server(); const disk = memoryStore(); const send = remote.transport.sendOperation;
    let lost = true;
    remote.transport.sendOperation = vi.fn(async (operation) => {
      const acknowledgement = await send(operation);
      if (lost) { lost = false; throw new Error("ACK lost"); }
      return acknowledgement;
    });
    const local = client(disk.store, remote.transport); await local.sync.start(remote.current);
    const drawing = local.document; drawing.layers[0]!.pixels[0] = "#FF0000";
    await local.sync.schedule(drawing); await local.sync.flush();
    const id = disk.saved!.operations[0]!.operation_id;
    const changed = baseDocument(); changed.layers[0]!.pixels[0] = "#00FF00"; remote.replace(resource(changed, 2));
    await local.sync.retry();
    expect(remote.sendOperation.mock.calls.map(([operation]) => operation.operation_id)).toEqual([id, id]);
    expect(remote.current.revision).toBe(2); expect(local.document.layers[0]!.pixels[0]).toBe("#00FF00"); local.sync.dispose();
  });

  it("deduplicates an accepted replacement even after a later remote resize", async () => {
    const remote = server(); const send = remote.transport.sendOperation; let lost = true;
    remote.transport.sendOperation = async (operation) => { const result = await send(operation); if (lost) { lost = false; throw new Error("ACK lost"); } return result; };
    const local = client(memoryStore().store, remote.transport); await local.sync.start(remote.current);
    await local.sync.schedule(createPixelArtDocument(3, 3), { forceReplace: true }); await local.sync.flush();
    remote.replace(resource(createPixelArtDocument(4, 4), 2)); await local.sync.retry();
    expect(remote.sendOperation).toHaveBeenCalledTimes(2); expect(local.sync.hasPendingChanges.value).toBe(false); expect(local.document.width).toBe(4); local.sync.dispose();
  });
  it.each(["layer-add", "layer-remove"])("deduplicates accepted %s after a lost ACK without blocking on overlay conflicts", async (kind) => {
    const remote = server(); const send = remote.transport.sendOperation; let lost = true;
    remote.transport.sendOperation = async (operation) => { const result = await send(operation); if (lost) { lost = false; throw new Error("ACK lost"); } return result; };
    const local = client(memoryStore().store, remote.transport); const initial = baseDocument(); initial.layers.push(createPixelLayer(2, 2, { id: "existing" })); remote.replace(resource(initial)); await local.sync.start(remote.current);
    const drawing = local.document;
    if (kind === "layer-add") drawing.layers.push(createPixelLayer(2, 2, { id: "new" })); else drawing.layers.pop();
    await local.sync.schedule(drawing); await local.sync.flush();
    const changed = clonePixelArtDocument(remote.current.data.pixel_art as PixelArtDocumentV2);
    if (kind === "layer-add") changed.layers.at(-1)!.pixels[0] = "#00FF00";
    else changed.layers[0]!.pixels[1] = "#00FF00";
    remote.replace(resource(changed, 2)); await local.sync.retry();
    expect(local.sync.hasPendingChanges.value).toBe(false); expect(local.document).toEqual(changed); expect(remote.sendOperation).toHaveBeenCalledTimes(2); local.sync.dispose();
  });

  it("safely rebases a queued resize after its own earlier pixel operation", async () => {
    const remote = server(); const local = client(memoryStore().store, remote.transport); await local.sync.start(remote.current);
    const drawing = local.document; drawing.layers[0]!.pixels[0] = "#FF0000";
    await local.sync.schedule(drawing);
    const resized = createPixelArtDocument(3, 3, { layers: [createPixelLayer(3, 3, { id: "layer", pixels: ["#FF0000"] })] });
    await local.sync.schedule(resized); await local.sync.flush();
    expect(local.sync.status.value).toBe("saved"); expect(remote.current.revision).toBe(2);
    expect(remote.sendOperation.mock.calls[1]![0].base_revision).toBe(1); local.sync.dispose();
  });

  it("never authorizes a queued replacement over an unseen remote pixel", async () => {
    const remote = server(); const onConflict = vi.fn(); const local = client(memoryStore().store, remote.transport, { onConflict }); await local.sync.start(remote.current);
    await local.sync.schedule(createPixelArtDocument(3, 3));
    const changed = baseDocument(); changed.layers[0]!.pixels[1] = "#00FF00"; remote.replace(resource(changed, 1));
    await local.sync.flush(); expect(remote.sendOperation).not.toHaveBeenCalled(); expect(local.sync.hasPendingChanges.value).toBe(true); expect(onConflict).toHaveBeenCalled(); local.sync.dispose();
  });
  it("a valid conditional no-op ACK corrects the optimistic UI without erasing the remote pixel", async () => {
    const remote = server(); const red = baseDocument(); red.layers[0]!.pixels[0] = "#FF0000"; remote.replace(resource(red, 1));
    const send = remote.transport.sendOperation;
    remote.transport.sendOperation = async (operation) => {
      const green = clonePixelArtDocument(red); green.layers[0]!.pixels[0] = "#00FF00"; remote.replace(resource(green, 2));
      return send(operation);
    };
    const local = client(memoryStore().store, remote.transport); await local.sync.start(remote.current);
    await local.sync.schedule(baseDocument(), { conditional: true }); await local.sync.flush();
    expect(remote.sendOperation.mock.calls[0]![0].actions).toEqual([{ type: "pixels", layer_id: "layer", changes: [[0, null, "#FF0000"]] }]);
    expect(local.document.layers[0]!.pixels[0]).toBe("#00FF00"); expect(local.sync.status.value).toBe("saved"); expect(local.sync.hasPendingChanges.value).toBe(false); local.sync.dispose();
  });
  it("deduplicates accepted pixels after the remote target layer is deleted", async () => {
    const remote = server(); const initial = baseDocument(); initial.layers.push(createPixelLayer(2, 2, { id: "other" })); remote.replace(resource(initial));
    const send = remote.transport.sendOperation; let lost = true;
    remote.transport.sendOperation = async (operation) => { const acknowledgement = await send(operation); if (lost) { lost = false; throw new Error("ACK lost"); } return acknowledgement; };
    const local = client(memoryStore().store, remote.transport); await local.sync.start(remote.current);
    const drawing = local.document; drawing.layers[0]!.pixels[0] = "#FF0000"; await local.sync.schedule(drawing); await local.sync.flush();
    const changed = clonePixelArtDocument(remote.current.data.pixel_art as PixelArtDocumentV2); changed.layers.shift(); remote.replace(resource(changed, 2));
    await local.sync.retry(); expect(local.sync.hasPendingChanges.value).toBe(false); expect(local.document).toEqual(changed); local.sync.dispose();
  });

  it.each(["wrong-id", "wrong-resource", "invalid-revision", "invalid-document"])("malformed ACK %s never removes the durable operation", async (fault) => {
    const remote = server(); remote.transport.sendOperation = vi.fn(async (operation) => {
      const result = { operation_id: operation.operation_id, applied_revision: 1, resource: resource(baseDocument(), 1) };
      if (fault === "wrong-id") result.operation_id = "unrelated";
      if (fault === "wrong-resource") result.resource.id = "other";
      if (fault === "invalid-revision") result.applied_revision = 2;
      if (fault === "invalid-document") result.resource.data = { pixel_art: { version: 2, width: 2, height: 2, layers: [] } };
      return result;
    });
    const disk = memoryStore(); const local = client(disk.store, remote.transport); await local.sync.start(remote.current);
    const drawing = local.document; drawing.layers[0]!.pixels[0] = "#FF0000";
    await local.sync.schedule(drawing); await local.sync.flush();
    expect(disk.saved?.operations).toHaveLength(1); expect(local.sync.hasPendingChanges.value).toBe(true); expect(local.sync.lastSavedAt.value).toBeNull(); local.sync.dispose();
  });

  it("ignores a stale GET response after a newer canonical broadcast", async () => {
    const remote = server(); const delayed = deferred<ProjectResourceDetail>(); remote.transport.fetchResource = vi.fn(() => delayed.promise);
    const local = client(memoryStore().store, remote.transport); await local.sync.start(remote.current);
    const refreshing = local.sync.refresh(); await settle();
    const changed = baseDocument(); changed.layers[0]!.pixels[1] = "#00FF00"; await local.sync.acceptResource(resource(changed, 2));
    delayed.resolve(resource(baseDocument(), 1)); await refreshing;
    expect(local.document.layers[0]!.pixels[1]).toBe("#00FF00"); local.sync.dispose();
  });

  it("keeps new local pending pixels optimistic when an earlier ACK arrives", async () => {
    const remote = server(); const send = remote.transport.sendOperation; const gate = deferred<void>(); let first = true;
    remote.transport.sendOperation = async (operation) => { const result = await send(operation); if (first) { first = false; await gate.promise; } return result; };
    const local = client(memoryStore().store, remote.transport); await local.sync.start(remote.current);
    const left = local.document; left.layers[0]!.pixels[0] = "#FF0000"; await local.sync.schedule(left);
    const flushing = local.sync.flush(); await settle();
    const both = clonePixelArtDocument(left); both.layers[0]!.pixels[1] = "#00FF00"; await local.sync.schedule(both);
    gate.resolve(); await flushing;
    expect(local.document.layers[0]!.pixels).toEqual(["#FF0000", "#00FF00", null, null]); expect(local.sync.hasPendingChanges.value).toBe(false); local.sync.dispose();
  });

  it("delays remote callbacks during gestures and merges after the local gesture is recorded", async () => {
    const remote = server(); const local = client(memoryStore().store, remote.transport); await local.sync.start(remote.current);
    local.sync.setInteractionActive(true);
    const changed = baseDocument(); changed.layers[0]!.pixels[1] = "#00FF00"; await local.sync.acceptResource(resource(changed, 1));
    expect(local.document.layers[0]!.pixels[1]).toBeNull();
    const gesture = local.document; gesture.layers[0]!.pixels[0] = "#FF0000"; await local.sync.schedule(gesture);
    local.sync.setInteractionActive(false);
    expect(local.document.layers[0]!.pixels).toEqual(["#FF0000", "#00FF00", null, null]); local.sync.dispose();
  });

  it("protects unreadable recovery queues from being overwritten", async () => {
    const remote = server(); const disk = memoryStore(); disk.store.read = vi.fn(async () => { throw new Error("Read failed"); });
    const local = client(disk.store, remote.transport); await local.sync.start(remote.current);
    const drawing = local.document; drawing.layers[0]!.pixels[0] = "#FF0000"; await local.sync.schedule(drawing); await local.sync.retry();
    expect(disk.store.write).not.toHaveBeenCalled(); expect(remote.sendOperation).not.toHaveBeenCalled(); expect(local.sync.hasPendingChanges.value).toBe(true); local.sync.dispose();
  });

  it("refuses cross-account sends and explicitly discards only after a fresh load", async () => {
    const remote = server(); const disk = memoryStore(); let account = "user"; const local = client(disk.store, remote.transport, { userId: () => account }); await local.sync.start(remote.current);
    const drawing = local.document; drawing.layers[0]!.pixels[0] = "#FF0000"; await local.sync.schedule(drawing);
    account = "other"; await local.sync.flush(); expect(remote.sendOperation).not.toHaveBeenCalled(); expect(local.sync.hasPendingChanges.value).toBe(true);
    account = "user"; await local.sync.discardPending(); expect(disk.saved?.operations).toEqual([]); expect(local.document).toEqual(baseDocument()); local.sync.dispose();
  });
});

describe("semantic resize and authoritative shared history", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("uses one POST and zero state GETs per healthy shared Undo or Redo", async () => {
    const remote = sharedServer(); const local = client(memoryStore().store, remote.transport); await local.sync.start(remote.current);
    const red = local.document; red.layers[0]!.pixels[0] = "#FF0000"; await local.sync.schedule(red); await local.sync.flush();
    vi.mocked(remote.transport.fetchState!).mockClear(); remote.sendOperation.mockClear();
    expect(await local.sync.undo()).toBe(true); expect(remote.transport.fetchState).not.toHaveBeenCalled(); expect(remote.sendOperation).toHaveBeenCalledOnce(); expect(remote.sendOperation.mock.calls[0]![0].actions).toEqual([{ type: "undo" }]);
    remote.sendOperation.mockClear();
    expect(await local.sync.redo()).toBe(true); expect(remote.transport.fetchState).not.toHaveBeenCalled(); expect(remote.sendOperation).toHaveBeenCalledOnce(); expect(remote.sendOperation.mock.calls[0]![0].actions).toEqual([{ type: "redo" }]);
    expect(local.document).toEqual(red); local.sync.dispose();
  });
  it("Undo waits only for its POST latency instead of two preceding network GETs", async () => {
    const remote = sharedServer(); const local = client(memoryStore().store, remote.transport); await local.sync.start(remote.current);
    const red = local.document; red.layers[0]!.pixels[0] = "#FF0000"; await local.sync.schedule(red); await local.sync.flush();
    const fetch = remote.transport.fetchState!; const send = remote.transport.sendOperation;
    remote.transport.fetchState = vi.fn(async (since) => { await new Promise((resolve) => setTimeout(resolve, 120)); return fetch(since); });
    remote.transport.sendOperation = vi.fn(async (operation) => { await new Promise((resolve) => setTimeout(resolve, 40)); return send(operation); });
    const started = Date.now(); const undoing = local.sync.undo(); await settle();
    expect(remote.transport.fetchState).not.toHaveBeenCalled(); expect(remote.transport.sendOperation).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(40); expect(await undoing).toBe(true); expect(Date.now() - started).toBe(40); expect(local.document).toEqual(baseDocument()); local.sync.dispose();
  });
  it("Undo targets a remote resize from a stale local coordinate frame without a pre-send GET", async () => {
    const remote = sharedServer(); const local = client(memoryStore().store, remote.transport); const other = client(memoryStore().store, remote.transport); await local.sync.start(remote.current); await other.sync.start(remote.current);
    const red = local.document; red.layers[0]!.pixels[0] = "#FF0000"; await local.sync.schedule(red); await local.sync.flush(); await other.sync.refresh();
    const resize = { width: 3, height: 3, anchor: "bottom-right" as const }; await other.sync.schedule(applyImageActions(other.document, [{ type: "resize", ...resize }]), { resize }); await other.sync.flush();
    expect(local.document.width).toBe(2); vi.mocked(remote.transport.fetchState!).mockClear();
    expect(await local.sync.undo()).toBe(true); expect(remote.transport.fetchState).not.toHaveBeenCalled(); expect(remote.sendOperation.mock.calls.at(-1)![0]).toMatchObject({ base_revision: 1, width: 2, height: 2, actions: [{ type: "undo" }] });
    expect(local.document).toEqual(red); expect(remote.current.data.pixel_art).toEqual(red); expect(local.sync.canRedo.value).toBe(true); local.sync.dispose(); other.sync.dispose();
  });
  it("the server rather than cached history flags decides whether a shared command has work", async () => {
    const remote = sharedServer(); const local = client(memoryStore().store, remote.transport); const other = client(memoryStore().store, remote.transport); await local.sync.start(remote.current); await other.sync.start(remote.current);
    const red = other.document; red.layers[0]!.pixels[0] = "#FF0000"; await other.sync.schedule(red); await other.sync.flush(); expect(local.sync.sharedHistory.value.can_undo).toBe(false);
    vi.mocked(remote.transport.fetchState!).mockClear(); expect(await local.sync.undo()).toBe(true); expect(remote.transport.fetchState).not.toHaveBeenCalled(); expect(remote.current.data.pixel_art).toEqual(baseDocument()); expect(local.sync.canRedo.value).toBe(true); local.sync.dispose(); other.sync.dispose();
  });
  it.each([401, 403, 404])("the authoritative history POST enforces permission HTTP %s without a redundant GET", async (status) => {
    const remote = sharedServer(); const disk = memoryStore(); const onAccessDenied = vi.fn(); const onConflict = vi.fn(); const local = client(disk.store, remote.transport, { onAccessDenied, onConflict }); await local.sync.start(remote.current);
    const red = local.document; red.layers[0]!.pixels[0] = "#FF0000"; await local.sync.schedule(red); await local.sync.flush(); vi.mocked(remote.transport.fetchState!).mockClear();
    remote.transport.sendOperation = vi.fn(async () => { throw new ImageOperationHttpError(status, { message: "Access unavailable" }); });
    expect(await local.sync.undo()).toBe(false); expect(remote.transport.fetchState).not.toHaveBeenCalled(); expect(onAccessDenied).toHaveBeenCalledWith(status); expect(onConflict).not.toHaveBeenCalled(); expect(local.sync.canUndo.value).toBe(false); expect(disk.saved?.operations).toHaveLength(1); expect(disk.saved?.operations[0]?.actions).toEqual([{ type: "undo" }]); expect(local.document).toEqual(red); local.sync.dispose();
  });
  it.each(["offline", "dispose"])("cancels a never-sent history command interrupted during its attempted journal write by %s", async (interruption) => {
    const surface = new EventTarget(); vi.stubGlobal("window", surface); let connected = true;
    const remote = sharedServer(); const disk = memoryStore(); const local = client(disk.store, remote.transport, { isOnline: () => connected }); await local.sync.start(remote.current);
    const red = local.document; red.layers[0]!.pixels[0] = "#FF0000"; await local.sync.schedule(red); await local.sync.flush();
    const write = disk.store.write; const gate = deferred<void>(); let attemptedWriteStarted = false;
    disk.store.write = async (queue) => { if (queue.operations.some((operation) => operation.actions[0]?.type === "undo" && operation._client_attempted)) { attemptedWriteStarted = true; await gate.promise; } await write(queue); };
    const undoing = local.sync.undo(); await settle(); expect(attemptedWriteStarted).toBe(true);
    if (interruption === "offline") { connected = false; surface.dispatchEvent(new Event("offline")); } else local.sync.dispose();
    gate.resolve(); expect(await undoing).toBe(false); await settle(); expect(remote.sendOperation).toHaveBeenCalledOnce(); expect(disk.saved?.operations).toEqual([]); expect(local.sync.isHistoryBusy.value).toBe(false);
    if (interruption === "offline") { connected = true; await local.sync.retry(); expect(remote.sendOperation).toHaveBeenCalledOnce(); local.sync.dispose(); }
  });

  it("acknowledges visual barriers for shared history and structure, including recovered Undo, but not normal pixels", async () => {
    const remote = sharedServer(); const disk = memoryStore(); const onAcknowledged = vi.fn(); const local = client(disk.store, remote.transport, { onAcknowledged }); await local.sync.start(remote.current);
    const red = local.document; red.layers[0]!.pixels[0] = "#FF0000"; await local.sync.schedule(red); await local.sync.flush();
    expect(onAcknowledged).toHaveBeenCalledOnce(); expect(onAcknowledged.mock.calls[0]![0]).not.toHaveProperty("previewBarrier");
    const send = remote.transport.sendOperation; let lost = true;
    remote.transport.sendOperation = async (operation) => { const result = await send(operation); if (operation.actions[0]?.type === "undo" && lost) { lost = false; throw new Error("ACK lost"); } return result; };
    expect(await local.sync.undo()).toBe(false); const undoId = disk.saved!.operations[0]!.operation_id;
    expect(onAcknowledged).toHaveBeenCalledOnce(); expect(disk.saved!.operations[0]!).not.toHaveProperty("previewBarrier"); local.sync.dispose(); await settle();
    const recovered = client(disk.store, remote.transport, { onAcknowledged }); await recovered.sync.start(remote.current); await recovered.sync.retry();
    expect(onAcknowledged.mock.calls[1]![0]).toMatchObject({ operationId: undoId, appliedRevision: 2, previewBarrier: true });
    expect(remote.sendOperation.mock.calls.filter(([operation]) => operation.actions[0]?.type === "undo").map(([operation]) => operation.operation_id)).toEqual([undoId, undoId]);
    expect(await recovered.sync.redo()).toBe(true);
    const imported = createPixelArtDocument(3, 3); await recovered.sync.schedule(imported, { forceReplace: true }); await recovered.sync.flush();
    const resize = { width: 4, height: 4, anchor: "center" as const }; await recovered.sync.schedule(applyImageActions(recovered.document, [{ type: "resize", ...resize }]), { resize }); await recovered.sync.flush();
    await recovered.sync.schedule(createPixelArtDocument(5, 5)); await recovered.sync.flush();
    expect(onAcknowledged).toHaveBeenCalledTimes(6);
    expect(onAcknowledged.mock.calls.slice(1).every(([acknowledgement]) => acknowledgement.previewBarrier === true)).toBe(true);
    expect(remote.sendOperation.mock.calls.every(([operation]) => !("previewBarrier" in operation))).toBe(true); recovered.sync.dispose();
  });
  it("shared Undo undoes another client's latest change and Redo restores it without local snapshots", async () => {
    const remote = sharedServer(); const first = client(memoryStore().store, remote.transport); const second = client(memoryStore().store, remote.transport);
    await first.sync.start(remote.current); await second.sync.start(remote.current);
    const red = first.document; red.layers[0]!.pixels[0] = "#FF0000"; await first.sync.schedule(red, { historyGroupId: "red" }); await first.sync.flush();
    await second.sync.refresh(); const green = second.document; green.layers[0]!.pixels[1] = "#00FF00"; await second.sync.schedule(green, { historyGroupId: "green" }); await second.sync.flush();
    await first.sync.refresh(); expect(first.sync.canUndo.value).toBe(true);
    expect(await first.sync.undo()).toBe(true); expect(first.document.layers[0]!.pixels).toEqual(["#FF0000", null, null, null]); expect(first.sync.canRedo.value).toBe(true);
    expect(await second.sync.redo()).toBe(true); expect(second.document.layers[0]!.pixels).toEqual(["#FF0000", "#00FF00", null, null]);
    expect(remote.sendOperation.mock.calls.at(-1)![0].actions).toEqual([{ type: "redo" }]); first.sync.dispose(); second.sync.dispose();
  });
  it("pending pixels merge across a remote anchored resize without conflict modal and original packets remain immutable", async () => {
    const remote = sharedServer(); let connected = false; const onConflict = vi.fn(); const local = client(memoryStore().store, remote.transport, { isOnline: () => connected, onConflict }); const other = client(memoryStore().store, remote.transport);
    await local.sync.start(remote.current); await other.sync.start(remote.current);
    const red = local.document; red.layers[0]!.pixels[0] = "#FF0000"; await local.sync.schedule(red);
    const resize = { width: 3, height: 3, anchor: "bottom-right" as const }; const resized = applyImageActions(other.document, [{ type: "resize", ...resize }]); await other.sync.schedule(resized, { resize }); await other.sync.flush();
    await local.sync.refresh(); expect(local.document.width).toBe(3); expect(local.document.layers[0]!.pixels[4]).toBe("#FF0000"); expect(onConflict).not.toHaveBeenCalled();
    connected = true; await local.sync.retry();
    const original = remote.sendOperation.mock.calls.at(-1)![0]; expect(original.width).toBe(2); expect(original.base_revision).toBe(0); expect(original.actions).toEqual([{ type: "pixels", layer_id: "layer", changes: [[0, "#FF0000"]] }]);
    expect(local.sync.status.value).toBe("saved"); expect(remote.current.data.pixel_art).toEqual(local.document); local.sync.dispose(); other.sync.dispose();
  });
  it("draws after a locally pending resize using a durable exact coordinate dependency", async () => {
    const remote = sharedServer(); const disk = memoryStore(); let connected = false; const local = client(disk.store, remote.transport, { isOnline: () => connected }); await local.sync.start(remote.current);
    const resize = { width: 3, height: 3, anchor: "center" as const }; const resized = applyImageActions(local.document, [{ type: "resize", ...resize }]); await local.sync.schedule(resized, { resize });
    const resizeId = disk.saved!.operations[0]!.operation_id; const red = clone(resized); red.layers[0]!.pixels[4] = "#FF0000"; await local.sync.schedule(red, { historyGroupId: "stroke" });
    expect(disk.saved!.operations[1]!.coordinate_after_operation_id).toBe(resizeId); connected = true; await local.sync.retry();
    expect(remote.sendOperation.mock.calls[1]![0]).toMatchObject({ coordinate_after_operation_id: resizeId, base_revision: 0, width: 3 });
    expect(remote.current.data.pixel_art).toEqual(red); expect(local.sync.status.value).toBe("saved"); local.sync.dispose();
  });
  it("retains lineages on reload and maps pending pixels through resize→undo ABA", async () => {
    const remote = sharedServer(); const disk = memoryStore(); let connected = false; const local = client(disk.store, remote.transport, { isOnline: () => connected }); const other = client(memoryStore().store, remote.transport);
    await local.sync.start(remote.current); await other.sync.start(remote.current);
    const red = local.document; red.layers[0]!.pixels[3] = "#FF0000"; await local.sync.schedule(red);
    const resize = { width: 1, height: 1, anchor: "top-left" as const }; await other.sync.schedule(applyImageActions(other.document, [{ type: "resize", ...resize }]), { resize }); await other.sync.flush(); await other.sync.undo();
    await local.sync.refresh(); expect(local.document.width).toBe(2); expect(local.document.layers[0]!.pixels[3]).toBeNull(); expect(disk.saved?.transforms).toHaveLength(2);
    local.sync.dispose(); await settle(); const reopened = client(disk.store, remote.transport, { isOnline: () => connected }); await reopened.sync.start(remote.current); connected = true; await reopened.sync.retry();
    expect(reopened.document.layers[0]!.pixels[3]).toBeNull(); expect(reopened.sync.hasPendingChanges.value).toBe(false); reopened.sync.dispose(); other.sync.dispose();
  });
  it("keeps different quick gesture groups separate but merges a long gesture in server history", async () => {
    const remote = sharedServer(); const disk = memoryStore(); const local = client(disk.store, remote.transport); await local.sync.start(remote.current);
    const red = local.document; red.layers[0]!.pixels[0] = "#FF0000"; await local.sync.schedule(red, { historyGroupId: "first" });
    const green = clone(red); green.layers[0]!.pixels[1] = "#00FF00"; await local.sync.schedule(green, { historyGroupId: "second" }); expect(disk.saved?.operations).toHaveLength(2); await local.sync.flush();
    const blue = local.document; blue.layers[0]!.pixels[2] = "#0000FF"; await local.sync.schedule(blue, { historyGroupId: "second" }); await local.sync.flush();
    await local.sync.undo(); expect(local.document.layers[0]!.pixels).toEqual(["#FF0000", null, null, null]); local.sync.dispose();
  });
  it("deduplicates a lost shared Undo ACK and updates current server history flags", async () => {
    const remote = sharedServer(); const disk = memoryStore(); const local = client(disk.store, remote.transport); await local.sync.start(remote.current);
    const red = local.document; red.layers[0]!.pixels[0] = "#FF0000"; await local.sync.schedule(red); await local.sync.flush();
    const send = remote.transport.sendOperation; let lost = true;
    remote.transport.sendOperation = async (operation) => { const result = await send(operation); if (operation.actions[0]?.type === "undo" && lost) { lost = false; throw new TypeError("Failed to fetch"); } return result; };
    expect(await local.sync.undo()).toBe(false); const id = disk.saved!.operations[0]!.operation_id; expect(local.sync.isHistoryBusy.value).toBe(true); await local.sync.retry();
    expect(remote.sendOperation.mock.calls.filter(([operation]) => operation.actions[0]?.type === "undo").map(([operation]) => operation.operation_id)).toEqual([id, id]);
    expect(local.document).toEqual(baseDocument()); expect(local.sync.canUndo.value).toBe(false); expect(local.sync.canRedo.value).toBe(true); expect(local.sync.isHistoryBusy.value).toBe(false); local.sync.dispose();
  });
  it("keeps shared geometry usable after an author's account deletion clears provenance", async () => {
    const remote = sharedServer(); const local = client(memoryStore().store, remote.transport); await local.sync.start(remote.current);
    const resize = { width: 3, height: 3, anchor: "center" as const }; await local.sync.schedule(applyImageActions(local.document, [{ type: "resize", ...resize }]), { resize }); await local.sync.flush();
    const original = remote.transport.fetchState!;
    remote.transport.fetchState = async (since) => { const state = await original(since); state.transforms = state.transforms.map((event) => ({ ...event, user_id: null })); return state; };
    await local.sync.refresh(); expect(local.sync.errorMessage.value).toBe(""); expect(local.sync.status.value).toBe("saved"); expect(local.document.width).toBe(3); local.sync.dispose();
  });
  it("ignores old shared-history flags from a delayed state GET", async () => {
    const remote = sharedServer(); const local = client(memoryStore().store, remote.transport); await local.sync.start(remote.current);
    const red = local.document; red.layers[0]!.pixels[0] = "#FF0000"; await local.sync.schedule(red); await local.sync.flush();
    const original = remote.transport.fetchState!; const delayed = deferred<Awaited<ReturnType<typeof original>>>(); let delay = true;
    remote.transport.fetchState = async (since) => delay ? delayed.promise : original(since);
    const refreshing = local.sync.refresh(); await settle(); delay = false; await local.sync.undo(); expect(local.sync.canRedo.value).toBe(true);
    delayed.resolve({ resource: resource(red, 1), history: { can_undo: true, can_redo: false }, transforms: [] }); await refreshing;
    expect(local.sync.canRedo.value).toBe(true); expect(local.sync.canUndo.value).toBe(false); expect(local.document).toEqual(baseDocument()); local.sync.dispose();
  });
  it("explicit import is shared, mergeable and undoable without a stale replacement guard", async () => {
    const remote = sharedServer(); const local = client(memoryStore().store, remote.transport); const other = client(memoryStore().store, remote.transport); await local.sync.start(remote.current); await other.sync.start(remote.current);
    const green = other.document; green.layers[0]!.pixels[1] = "#00FF00"; await other.sync.schedule(green); await other.sync.flush();
    const imported = createPixelArtDocument(3, 3, { layers: [createPixelLayer(3, 3, { id: "imported", pixels: ["#FF0000"] })] }); await local.sync.schedule(imported, { forceReplace: true }); await local.sync.flush();
    expect(remote.sendOperation.mock.calls.at(-1)![0].actions).toEqual([{ type: "import", document: imported }]); expect(local.sync.status.value).toBe("saved"); await local.sync.undo();
    expect(local.document).toEqual(green); local.sync.dispose(); other.sync.dispose();
  });
  it("shared history buttons react to offline/online and never initiate offline Undo or Redo", async () => {
    const surface = new EventTarget(); vi.stubGlobal("window", surface);
    const remote = sharedServer(); let connected = true; const disk = memoryStore(); const local = client(disk.store, remote.transport, { isOnline: () => connected }); await local.sync.start(remote.current);
    const red = local.document; red.layers[0]!.pixels[0] = "#FF0000"; await local.sync.schedule(red); await local.sync.flush(); expect(local.sync.canUndo.value).toBe(true);
    const calls = remote.sendOperation.mock.calls.length; connected = false; surface.dispatchEvent(new Event("offline"));
    expect(local.sync.canUndo.value).toBe(false); expect(local.sync.canRedo.value).toBe(false); expect(await local.sync.undo()).toBe(false); expect(await local.sync.redo()).toBe(false);
    expect(remote.sendOperation).toHaveBeenCalledTimes(calls); expect(disk.saved?.operations).toEqual([]);
    connected = true; surface.dispatchEvent(new Event("online")); await settle(); expect(local.sync.canUndo.value).toBe(true); local.sync.dispose();
  });
  it("a lost ACK for an own no-op resize uses identity provenance and preserves post-resize coordinates", async () => {
    const remote = sharedServer(); const disk = memoryStore(); let connected = false; const local = client(disk.store, remote.transport, { isOnline: () => connected }); const other = client(memoryStore().store, remote.transport); await local.sync.start(remote.current); await other.sync.start(remote.current);
    const resize = { width: 3, height: 3, anchor: "center" as const }; const resized = applyImageActions(local.document, [{ type: "resize", ...resize }]); await local.sync.schedule(resized, { resize });
    const ownId = disk.saved!.operations[0]!.operation_id; const red = clone(resized); red.layers[0]!.pixels[4] = "#FF0000"; await local.sync.schedule(red);
    await other.sync.schedule(applyImageActions(other.document, [{ type: "resize", ...resize }]), { resize }); await other.sync.flush();
    const send = remote.transport.sendOperation; let lost = true; remote.transport.sendOperation = async (operation) => { const result = await send(operation); if (operation.operation_id === ownId && lost) { lost = false; throw new TypeError("Failed to fetch"); } return result; };
    connected = true; await local.sync.retry(); expect(local.sync.hasPendingChanges.value).toBe(true);
    await other.sync.refresh(); const bigger = { width: 4, height: 4, anchor: "bottom-right" as const }; await other.sync.schedule(applyImageActions(other.document, [{ type: "resize", ...bigger }]), { resize: bigger }); await other.sync.flush();
    await vi.advanceTimersByTimeAsync(1000); await local.sync.refresh();
    expect(local.document.width).toBe(4); expect(local.document.layers[0]!.pixels[10]).toBe("#FF0000"); expect(local.sync.hasPendingChanges.value).toBe(false);
    const retries = remote.sendOperation.mock.calls.filter(([operation]) => operation.operation_id === ownId).map(([operation]) => operation); expect(retries).toHaveLength(2); expect(retries[0]).toEqual(retries[1]); local.sync.dispose(); other.sync.dispose();
  });
  it("a lost same-size import ACK preserves newer remote changes instead of replaying the whole import", async () => {
    const remote = sharedServer(); const disk = memoryStore(); const local = client(disk.store, remote.transport); const other = client(memoryStore().store, remote.transport); await local.sync.start(remote.current); await other.sync.start(remote.current);
    const red = local.document; red.layers[0]!.pixels[0] = "#FF0000"; const send = remote.transport.sendOperation; let lost = true;
    remote.transport.sendOperation = async (operation) => { const result = await send(operation); if (operation.actions[0]?.type === "import" && lost) { lost = false; throw new TypeError("Failed to fetch"); } return result; };
    await local.sync.schedule(red, { forceReplace: true }); await local.sync.flush(); expect(local.sync.hasPendingChanges.value).toBe(true);
    await other.sync.refresh(); const green = other.document; green.layers[0]!.pixels[1] = "#00FF00"; await other.sync.schedule(green); await other.sync.flush();
    await vi.advanceTimersByTimeAsync(1000); await local.sync.refresh(); expect(local.document.layers[0]!.pixels).toEqual(["#FF0000", "#00FF00", null, null]); expect(local.sync.hasPendingChanges.value).toBe(false); local.sync.dispose(); other.sync.dispose();
  });
  it("new strokes after accepted geometry proof use the current frame, not an old pending dependency", async () => {
    const remote = sharedServer(); const disk = memoryStore(); const local = client(disk.store, remote.transport); const other = client(memoryStore().store, remote.transport); await local.sync.start(remote.current); await other.sync.start(remote.current);
    const resize = { width: 3, height: 3, anchor: "center" as const }; const send = remote.transport.sendOperation; let lost = true;
    remote.transport.sendOperation = async (operation) => { const result = await send(operation); if (operation.actions[0]?.type === "resize" && lost) { lost = false; throw new TypeError("Failed to fetch"); } return result; };
    await local.sync.schedule(applyImageActions(local.document, [{ type: "resize", ...resize }]), { resize }); await local.sync.flush();
    await other.sync.refresh(); const bigger = { width: 4, height: 4, anchor: "bottom-right" as const }; await other.sync.schedule(applyImageActions(other.document, [{ type: "resize", ...bigger }]), { resize: bigger }); await other.sync.flush();
    await local.sync.refresh(); const red = local.document; expect(red.width).toBe(4); red.layers[0]!.pixels[10] = "#FF0000"; await local.sync.schedule(red);
    const stroke = disk.saved!.operations.at(-1)!; expect(stroke.coordinate_after_operation_id).toBeUndefined(); expect(stroke.base_revision).toBe(2); expect(stroke.width).toBe(4);
    await local.sync.retry(); expect(local.document.layers[0]!.pixels[10]).toBe("#FF0000"); expect(local.sync.status.value).toBe("saved"); local.sync.dispose(); other.sync.dispose();
  });
  it("records a paused gesture in its observed coordinate revision before a remote resize", async () => {
    const remote = sharedServer(); const disk = memoryStore(); const local = client(disk.store, remote.transport); const other = client(memoryStore().store, remote.transport); await local.sync.start(remote.current); await other.sync.start(remote.current);
    local.sync.setInteractionActive(true); const red = local.document; red.layers[0]!.pixels[0] = "#FF0000";
    const resize = { width: 3, height: 3, anchor: "bottom-right" as const }; await other.sync.schedule(applyImageActions(other.document, [{ type: "resize", ...resize }]), { resize }); await other.sync.flush(); await local.sync.refresh();
    await local.sync.schedule(red); expect(disk.saved!.operations[0]!).toMatchObject({ base_revision: 0, width: 2 }); local.sync.setInteractionActive(false); await local.sync.flush();
    expect(local.document.width).toBe(3); expect(local.document.layers[0]!.pixels[4]).toBe("#FF0000"); expect(local.sync.status.value).toBe("saved"); local.sync.dispose(); other.sync.dispose();
  });
  it.each([401, 403, 404])("reports unavailable access HTTP %s without discarding the durable local queue or opening conflict", async (status) => {
    const remote = sharedServer(); const disk = memoryStore(); const onAccessDenied = vi.fn(); const onConflict = vi.fn(); const local = client(disk.store, remote.transport, { onAccessDenied, onConflict }); await local.sync.start(remote.current);
    remote.transport.sendOperation = async () => { throw new ImageOperationHttpError(status, { message: "Access unavailable" }); };
    const red = local.document; red.layers[0]!.pixels[0] = "#FF0000"; await local.sync.schedule(red); await local.sync.flush();
    expect(onAccessDenied).toHaveBeenCalledWith(status); expect(onConflict).not.toHaveBeenCalled(); expect(disk.saved?.operations).toHaveLength(1); expect(disk.saved?.localDocument).toEqual(red); expect(local.sync.canUndo.value).toBe(false); local.sync.dispose();
  });
  it("state GET permission revocation also preserves the queue and invokes the read-only callback", async () => {
    const remote = sharedServer(); const disk = memoryStore(); const onAccessDenied = vi.fn(); const local = client(disk.store, remote.transport, { onAccessDenied }); await local.sync.start(remote.current);
    const red = local.document; red.layers[0]!.pixels[0] = "#FF0000"; await local.sync.schedule(red);
    remote.transport.fetchState = async () => { throw new ImageOperationHttpError(404, { message: "Project unavailable" }); }; await local.sync.refresh();
    expect(onAccessDenied).toHaveBeenCalledWith(404); expect(disk.saved?.operations).toHaveLength(1); expect(disk.saved?.localDocument).toEqual(red); local.sync.dispose();
  });
  it("healthy shared Undo does not depend on redundant state GETs being available", async () => {
    const remote = sharedServer(); const disk = memoryStore(); const local = client(disk.store, remote.transport); await local.sync.start(remote.current); const red = local.document; red.layers[0]!.pixels[0] = "#FF0000"; await local.sync.schedule(red); await local.sync.flush();
    remote.transport.fetchState = vi.fn(async () => { throw new TypeError("Failed to fetch"); }); expect(await local.sync.undo()).toBe(true);
    expect(remote.transport.fetchState).not.toHaveBeenCalled(); expect(disk.saved?.operations).toEqual([]); expect(remote.sendOperation).toHaveBeenCalledTimes(2); expect(local.document).toEqual(baseDocument()); expect(local.sync.isHistoryBusy.value).toBe(false); local.sync.dispose();
  });
  it("cancels a never-transmitted global Undo when pre-send synchronization fails", async () => {
    const remote = sharedServer(); const disk = memoryStore(); const local = client(disk.store, remote.transport); await local.sync.start(remote.current); const red = local.document; red.layers[0]!.pixels[0] = "#FF0000"; await local.sync.schedule(red); await local.sync.flush();
    remote.transport.fetchState = async () => { throw new TypeError("Failed to fetch"); }; expect(await local.sync.refresh()).toBe(false);
    expect(await local.sync.undo()).toBe(false); expect(disk.saved?.operations).toEqual([]); expect(remote.sendOperation).toHaveBeenCalledOnce(); expect(local.sync.isHistoryBusy.value).toBe(false); local.sync.dispose();
  });
  it("does not send a history command removed by an offline event during its fresh server barrier", async () => {
    const surface = new EventTarget(); vi.stubGlobal("window", surface);
    const remote = sharedServer(); const disk = memoryStore(); let connected = true; const local = client(disk.store, remote.transport, { isOnline: () => connected }); await local.sync.start(remote.current);
    const red = local.document; red.layers[0]!.pixels[0] = "#FF0000"; await local.sync.schedule(red); await local.sync.flush();
    const fetch = remote.transport.fetchState!; remote.transport.fetchState = async () => { throw new TypeError("Failed to fetch"); }; expect(await local.sync.refresh()).toBe(false);
    const gate = deferred<void>(); let requests = 0;
    remote.transport.fetchState = vi.fn(async (since) => { requests += 1; await gate.promise; return fetch(since); });
    const undoing = local.sync.undo(); await settle(); expect(requests).toBe(1);
    connected = false; surface.dispatchEvent(new Event("offline")); gate.resolve();
    expect(await undoing).toBe(false); expect(remote.sendOperation).toHaveBeenCalledOnce();
    expect(disk.saved?.operations).toEqual([]); expect(local.sync.isHistoryBusy.value).toBe(false); local.sync.dispose();
  });
});
