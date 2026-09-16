import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectResourceDetail } from "../../../lib/api";
import { clonePixelArtDocument, createPixelArtDocument, createPixelLayer } from "../lib/document";
import { applyImageActions, type ImageOperation } from "../lib/imageOperations";
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
const client = (store: ImageOperationStore, transport: ImageOperationTransport, extra: Partial<Parameters<typeof useImageOperationSync>[0]> = {}) => {
  let document = baseDocument();
  const onDocument = vi.fn((value: PixelArtDocumentV2) => { document = clonePixelArtDocument(value); });
  const sync = useImageOperationSync({ projectId: "project", resourceId: "resource", userId: "user", store, transport, onDocument, ...extra });
  return { sync, onDocument, get document() { return clonePixelArtDocument(document); } };
};

describe("durable image operation synchronization", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

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
    expect(disk.saved?.localDocument).toEqual(drawing); expect(disk.saved?.localDocumentUnencodable).toBe(false);
    expect(disk.saved?.resource?.revision).toBe(1); local.sync.dispose(); await settle();
    const reopened = client(disk.store, remote.transport, { isOnline: () => false }); await reopened.sync.start(remote.current);
    expect(reopened.document).toEqual(drawing); expect(reopened.sync.hasPendingChanges.value).toBe(true); expect(disk.saved?.operations).toHaveLength(1);
    expect(reopened.sync.errorMessage.value).toMatch(/dimensions changed|removed/); reopened.sync.dispose();
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
