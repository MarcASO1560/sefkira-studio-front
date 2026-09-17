import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PixelArtDocumentV2, PixelColor } from "../types";
import { compositeVisibleLayers, createPixelArtDocument, createPixelLayer } from "./document";
import { createLivePixelPreviewOverlay, createLivePixelPreviewSender } from "./livePixelPreview";

const input = (changes: Array<readonly [number, PixelColor]>, layerId = "layer-1") => ({
  width: 4, height: 4, baseRevision: 10, layers: [{ layerId, changes }],
});
const packet = (
  changes: Array<readonly [number, PixelColor, number]>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  preview_protocol: 1, width: 4, height: 4, base_revision: 10,
  layer_id: "layer-1", changes,
  preview_sequence: Math.max(...changes.map((change) => change[2])),
  ...overrides,
});
const document = (): PixelArtDocumentV2 => createPixelArtDocument(4, 4, {
  layers: [createPixelLayer(4, 4, { id: "layer-1" }), createPixelLayer(4, 4, { id: "layer-2" })],
});
const colorAt = (result: PixelArtDocumentV2, index = 0) => result.layers[0]!.pixels[index];

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); });

describe("live pixel preview sender", () => {
  it("sends the first pixel immediately and subsequent changes at the fixed 16 ms deadline", () => {
    const send = vi.fn();
    const sender = createLivePixelPreviewSender(send);
    expect(sender.enqueue(input([[0, "#FF0000"]]))).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4);
    sender.enqueue(input([[1, "#00FF00"]]));
    vi.advanceTimersByTime(8);
    sender.enqueue(input([[2, "#0000FF"]]));
    vi.advanceTimersByTime(3);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0]).toMatchObject({ changes: [[1, "#00FF00", 2], [2, "#0000FF", 3]] });
  });

  it("never waits for a continuous stroke to stop", () => {
    const send = vi.fn();
    const sender = createLivePixelPreviewSender(send);
    for (let index = 0; index < 65; index += 1) {
      sender.enqueue(input([[index % 16, "#FFFFFF"]]));
      vi.advanceTimersByTime(1);
    }
    expect(send).toHaveBeenCalledTimes(5);
    expect(send.mock.calls.map((call) => call[0].preview_sequence)).toEqual([1, 16, 32, 48, 64]);
  });

  it("coalesces the last value per pixel without promoting older pixels to a newer mutation sequence", () => {
    const send = vi.fn();
    const sender = createLivePixelPreviewSender(send);
    sender.enqueue(input([[0, "#111111"]]));
    sender.enqueue(input([[1, "#222222"], [2, "#333333"]]));
    sender.enqueue(input([[1, "#abcdef80"]]));
    vi.advanceTimersByTime(16);
    expect(send.mock.calls[1]![0]).toMatchObject({
      preview_sequence: 3, changes: [[1, "#abcdef80", 3], [2, "#333333", 2]],
    });
  });

  it("batches different layers separately and preserves their exact colors and erasures", () => {
    const send = vi.fn();
    const sender = createLivePixelPreviewSender(send);
    sender.enqueue(input([[0, "#111111"]]));
    sender.enqueue({ ...input([]), layers: [
      { layerId: "layer-1", changes: [[0, null]] },
      { layerId: "layer-2", changes: [[1, "#abcdef80"]] },
    ] });
    sender.flush();
    expect(send.mock.calls.slice(1).map((call) => call[0])).toMatchObject([
      { layer_id: "layer-1", changes: [[0, null, 2]] },
      { layer_id: "layer-2", changes: [[1, "#abcdef80", 2]] },
    ]);
  });

  it("chunks full-canvas changes into at most 1024 triples", () => {
    const send = vi.fn();
    const sender = createLivePixelPreviewSender(send);
    sender.enqueue({ width: 256, height: 256, baseRevision: 0,
      layers: [{ layerId: "layer-1", changes: Array.from({ length: 65_536 }, (_, index) => [index, null] as const) }] });
    expect(send).toHaveBeenCalledTimes(64);
    expect(send.mock.calls.every((call) => call[0].changes.length === 1024)).toBe(true);
    expect(send.mock.calls.at(-1)![0].changes.at(-1)).toEqual([65_535, null, 1]);
  });

  it("never mutates frozen input arrays and does not leak queued references", () => {
    const send = vi.fn();
    const sender = createLivePixelPreviewSender(send);
    sender.enqueue(input([[0, null]]));
    const source = input([[1, "#123456"]]);
    Object.freeze(source.layers[0]!.changes[0]);
    Object.freeze(source.layers[0]!.changes);
    Object.freeze(source.layers[0]);
    Object.freeze(source.layers);
    Object.freeze(source);
    expect(() => sender.enqueue(source)).not.toThrow();
    sender.flush();
    expect(source.layers[0]!.changes).toEqual([[1, "#123456"]]);
  });

  it("clear cancels scheduled pixels but preserves the globally increasing sequence", () => {
    const send = vi.fn();
    const sender = createLivePixelPreviewSender(send);
    sender.enqueue(input([[0, "#111111"]]));
    sender.enqueue(input([[1, "#222222"]]));
    sender.clear();
    vi.advanceTimersByTime(100);
    expect(send).toHaveBeenCalledTimes(1);
    expect(sender.enqueue(input([[2, "#333333"]]))).toBe(3);
    expect(send.mock.calls[1]![0].changes).toEqual([[2, "#333333", 3]]);
  });

  it("dispose stops all sends, including already scheduled callbacks", () => {
    const send = vi.fn();
    const sender = createLivePixelPreviewSender(send);
    sender.enqueue(input([[0, null]]));
    sender.enqueue(input([[1, null]]));
    sender.dispose();
    sender.flush();
    expect(sender.enqueue(input([[2, null]]))).toBe(2);
    vi.advanceTimersByTime(100);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("supports an explicit interval and recovers from unavailable ephemeral transport", () => {
    const send = vi.fn().mockImplementationOnce(() => { throw new Error("offline"); });
    const sender = createLivePixelPreviewSender(send, { intervalMs: 8 });
    expect(() => sender.enqueue(input([[0, null]]))).not.toThrow();
    sender.enqueue(input([[1, null]]));
    vi.advanceTimersByTime(8);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("replaces pending old-resolution pixels instead of broadcasting them on a new canvas", () => {
    const send = vi.fn();
    const sender = createLivePixelPreviewSender(send);
    sender.enqueue(input([[0, null]]));
    sender.enqueue(input([[15, "#FFFFFF"]]));
    sender.enqueue({ ...input([[1, "#000000"]]), width: 2, height: 2, baseRevision: 11 });
    vi.advanceTimersByTime(16);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0]).toMatchObject({ width: 2, height: 2, changes: [[1, "#000000", 3]] });
  });

  it.each([
    { ...input([[0, null]]), width: 257 },
    { ...input([[0, null]]), height: 0 },
    { ...input([[0, null]]), baseRevision: -1 },
    input([[16, null]]), input([[1.5, null]]), input([[0, "red"]]),
    input([[0, "#1234567"]]), input([[0, null]], " "),
    input(Array.from({ length: 65_537 }, () => [0, null] as const)),
  ])("rejects malformed or oversized input atomically %#", (source) => {
    const send = vi.fn();
    const sender = createLivePixelPreviewSender(send);
    expect(sender.enqueue(source)).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("does not send or allocate a sequence for empty no-op input", () => {
    const send = vi.fn();
    const sender = createLivePixelPreviewSender(send);
    expect(sender.enqueue(input([]))).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("live pixel preview visual overlay", () => {
  it("a future history barrier keeps ink until the raw canonical revision catches up, then prevents ghost Undo ink", () => {
    const overlay = createLivePixelPreviewOverlay();
    const blank = document();
    overlay.observeCanonical(blank, 10);
    overlay.receive("client-1", packet([[0, "#FF0000", 1]]));
    expect(overlay.invalidateAt(12)).toBe(false);
    expect(colorAt(overlay.render(blank, 10))).toBe("#FF0000");
    // A local/optimistic renderer revision is not authoritative evidence.
    expect(colorAt(overlay.render(blank, 12))).toBe("#FF0000");
    expect(overlay.observeCanonical(blank, 11)).toBe(false);
    expect(colorAt(overlay.render(blank, 11))).toBe("#FF0000");
    // We deliberately never saw the intermediate committed-red snapshot or
    // its ephemeral pixel ACK: this is the canonical result of shared Undo.
    expect(overlay.observeCanonical(blank, 12)).toBe(true);
    expect(overlay.render(blank, 12)).toBe(blank);
    expect(overlay.receive("client-1", packet([[0, "#FF0000", 1]]))).toBe(false);
    expect(overlay.receive("client-1", packet([[1, "#0000FF", 2]], { base_revision: 12 }))).toBe(true);
    expect(colorAt(overlay.render(blank, 12), 1)).toBe("#0000FF");
    expect(overlay.invalidateAt(12)).toBe(false);
    expect(overlay.invalidateAt(11)).toBe(false);
    expect(colorAt(overlay.render(blank, 12), 1)).toBe("#0000FF");
  });

  it("an already canonical barrier invalidates immediately while preserving the raw snapshot for delayed packets", () => {
    const overlay = createLivePixelPreviewOverlay();
    const committed = document();
    committed.layers[0]!.pixels[0] = "#FF0000";
    overlay.observeCanonical(committed, 13);
    overlay.receive("client-1", packet([[1, "#0000FF", 1]], { base_revision: 12 }));
    expect(overlay.invalidateAt(12)).toBe(true);
    expect(overlay.render(committed, 13)).toBe(committed);
    expect(overlay.receive("client-1", packet([[0, "#FF0000", 2]], { base_revision: 12 }))).toBe(true);
    // Keeping the observed snapshot allows implicit per-pixel retirement.
    const undone = document();
    overlay.observeCanonical(undone, 14);
    expect(overlay.render(undone, 14)).toBe(undone);
    expect(overlay.receive("client-1", packet([[0, "#FF0000", 2]], { base_revision: 12 }))).toBe(false);
  });

  it("keeps one monotonic bounded future barrier and rejects malformed or repeated older hints", () => {
    const overlay = createLivePixelPreviewOverlay();
    const blank = document();
    overlay.observeCanonical(blank, 10);
    overlay.receive("client-1", packet([[0, "#FF0000", 1]]));
    expect(overlay.invalidateAt(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(overlay.invalidateAt(-1)).toBe(false);
    overlay.invalidateAt(14);
    overlay.invalidateAt(12);
    overlay.observeCanonical(blank, 12);
    expect(colorAt(overlay.render(blank, 12))).toBe("#FF0000");
    expect(overlay.observeCanonical(blank, 14)).toBe(true);
    expect(overlay.receive("client-1", packet([[0, "#FF0000", 2]], { base_revision: 13 }))).toBe(false);
    expect(overlay.receive("client-1", packet([[0, "#FF0000", 3]], { base_revision: 14 }))).toBe(true);
    expect(overlay.invalidateAt(13)).toBe(false);
    expect(colorAt(overlay.render(blank, 14))).toBe("#FF0000");
  });

  it("a lost ephemeral ACK cannot repaint committed ink over a later shared Undo", () => {
    const overlay = createLivePixelPreviewOverlay();
    const blank = document();
    const redPacket = packet([[0, "#FF0000", 1]], { base_revision: 0 });
    overlay.observeCanonical(blank, 0);
    overlay.receive("client-1", redPacket);
    expect(colorAt(overlay.render(blank, 0))).toBe("#FF0000");
    const committed = document();
    committed.layers[0]!.pixels[0] = "#FF0000";
    expect(overlay.observeCanonical(committed, 1)).toBe(true);
    expect(overlay.render(committed, 1)).toBe(committed);
    const undone = document();
    overlay.observeCanonical(undone, 2);
    expect(overlay.render(undone, 2)).toBe(undone);
    expect(overlay.receive("client-1", redPacket)).toBe(false);
    expect(overlay.render(undone, 2)).toBe(undone);
    expect(overlay.receive("client-1", packet([[0, "#FF0000", 2]], { base_revision: 2 }))).toBe(true);
    expect(colorAt(overlay.render(undone, 2))).toBe("#FF0000");
  });

  it("canonical observation retires only matching indices, not the rest of an ongoing stroke", () => {
    const overlay = createLivePixelPreviewOverlay();
    overlay.receive("client-1", packet([[0, "#FF0000", 2], [1, "#0000FF", 1]]));
    const committed = document();
    committed.layers[0]!.pixels[0] = "#FF0000";
    overlay.observeCanonical(committed, 11);
    expect(colorAt(overlay.render(committed, 11), 1)).toBe("#0000FF");
    // Retiring sequence 2 at index 0 must not globally suppress a delayed
    // sequence 1 on a different index which is still genuinely in flight.
    expect(overlay.receive("client-1", packet([[2, "#00FF00", 1]]))).toBe(true);
    expect(overlay.receive("client-1", packet([[0, "#FF0000", 2]]))).toBe(false);
    const undone = document();
    overlay.observeCanonical(undone, 12);
    expect(overlay.render(undone, 12).layers[0]!.pixels.slice(0, 3)).toEqual([null, "#0000FF", "#00FF00"]);
    expect(overlay.receive("client-1", packet([[0, "#AAAAAA", 3]]))).toBe(true);
    expect(colorAt(overlay.render(undone, 12))).toBe("#AAAAAA");
  });

  it("a committed erasure stays undone even if its null-colored preview is delivered again", () => {
    const overlay = createLivePixelPreviewOverlay();
    const original = document();
    original.layers[0]!.pixels[0] = "#123456";
    overlay.observeCanonical(original, 10);
    const erasure = packet([[0, null, 1]]);
    overlay.receive("client-1", erasure);
    expect(colorAt(overlay.render(original, 10))).toBeNull();
    const erased = document();
    expect(overlay.observeCanonical(erased, 11)).toBe(true);
    overlay.observeCanonical(original, 12);
    expect(overlay.receive("client-1", erasure)).toBe(false);
    expect(overlay.render(original, 12)).toBe(original);
  });

  it("matches persisted hexadecimal colors case-insensitively without normalizing or mutating source colors", () => {
    const overlay = createLivePixelPreviewOverlay();
    overlay.receive("client-1", packet([[0, "#aabbcc80", 1], [1, "#aabbcc81", 1]]));
    const canonical = document();
    canonical.layers[0]!.pixels[0] = "#AABBCC80";
    canonical.layers[0]!.pixels[1] = "#AABBCC80";
    const frozenCopy = structuredClone(canonical);
    expect(overlay.observeCanonical(canonical, 11)).toBe(true);
    expect(canonical).toEqual(frozenCopy);
    expect(colorAt(overlay.render(canonical, 11))).toBe("#AABBCC80");
    expect(colorAt(overlay.render(canonical, 11), 1)).toBe("#aabbcc81");
    const undone = document();
    overlay.observeCanonical(undone, 12);
    expect(overlay.render(undone, 12).layers[0]!.pixels.slice(0, 2)).toEqual([null, "#aabbcc81"]);
  });

  it("rendering a coincident local pending buffer never masquerades as a server confirmation", () => {
    const overlay = createLivePixelPreviewOverlay();
    const canonical = document();
    overlay.observeCanonical(canonical, 11);
    overlay.receive("client-1", packet([[0, "#FF0000", 1]]));
    const localPending = document();
    localPending.layers[0]!.pixels[0] = "#FF0000";
    expect(overlay.render(localPending, 11)).toBe(localPending);
    expect(colorAt(overlay.render(canonical, 11))).toBe("#FF0000");
    expect(overlay.observeCanonical(localPending, 12)).toBe(true);
    expect(overlay.render(canonical, 12)).toBe(canonical);
  });

  it("retires a delayed preview against an already observed matching canonical snapshot", () => {
    const overlay = createLivePixelPreviewOverlay();
    const committed = document();
    committed.layers[0]!.pixels[0] = "#FF0000";
    overlay.observeCanonical(committed, 11);
    const delayed = packet([[0, "#FF0000", 1]]);
    overlay.receive("client-1", delayed);
    expect(overlay.render(committed, 11)).toBe(committed);
    const undone = document();
    overlay.observeCanonical(undone, 12);
    expect(overlay.receive("client-1", delayed)).toBe(false);
    expect(overlay.render(undone, 12)).toBe(undone);
  });

  it("does not infer persistence from the same base revision or regress to an older canonical observation", () => {
    const overlay = createLivePixelPreviewOverlay();
    const red = document();
    red.layers[0]!.pixels[0] = "#FF0000";
    overlay.receive("client-1", packet([[0, "#FF0000", 1]]));
    expect(overlay.observeCanonical(red, 10)).toBe(false);
    const blank = document();
    overlay.observeCanonical(blank, 11);
    expect(overlay.observeCanonical(red, 10)).toBe(false);
    expect(colorAt(overlay.render(blank, 11))).toBe("#FF0000");
  });

  it("bounds tombstones together with pending pixels per layer, then releases their storage on TTL expiry", () => {
    const overlay = createLivePixelPreviewOverlay();
    const committed = createPixelArtDocument(256, 256, {
      layers: [createPixelLayer(256, 256, { id: "layer-1", pixels: Array(65_536).fill("#111111") })],
    });
    for (let offset = 0; offset < 65_536; offset += 1024) {
      const changes = Array.from({ length: 1024 }, (_, index) => [offset + index, "#111111", 1] as const);
      overlay.receive("client-1", packet(changes, { width: 256, height: 256 }), 0);
    }
    expect(overlay.observeCanonical(committed, 11, 0)).toBe(true);
    expect(overlay.receive("client-2", packet([[0, "#222222", 1]], { width: 256, height: 256 }), 0)).toBe(false);
    expect(overlay.receive("client-1", packet([[0, "#111111", 1]], { width: 256, height: 256 }), 29_999)).toBe(false);
    expect(overlay.receive("client-1", packet([[0, "#333333", 2]], { width: 256, height: 256 }), 29_999)).toBe(true);
    // This client is active, so individual retired entries—not just the whole
    // participant—must expire and stop reserving the layer's memory budget.
    expect(overlay.prune(30_000)).toBe(true);
    expect(overlay.receive("client-2", packet([[1, "#222222", 1]], { width: 256, height: 256 }), 30_000)).toBe(true);
  });

  it("two simulated editors receive ongoing pixel previews within 19 ms despite a 2000 ms durable save", () => {
    const canonicalA = document();
    const canonicalB = document();
    const previewsA = createLivePixelPreviewOverlay();
    const previewsB = createLivePixelPreviewOverlay();
    const enqueuedAt = new Map<number, number>();
    const observedDelays: number[] = [];
    let savesCompleted = false;
    let framesSeenDuringStroke = 0;
    setTimeout(() => { savesCompleted = true; }, 2000);
    const senderA = createLivePixelPreviewSender((payload) => {
      // Controlled 3 ms transport, not a claim about real Internet latency.
      setTimeout(() => {
        previewsB.receive("artist-a", payload);
        framesSeenDuringStroke += 1;
        for (const tuple of payload.changes as Array<[number, PixelColor, number]>) {
          observedDelays.push(Date.now() - enqueuedAt.get(tuple[2])!);
        }
      }, 3);
    });
    const senderB = createLivePixelPreviewSender((payload) => {
      setTimeout(() => previewsA.receive("artist-b", payload), 3);
    });
    senderB.enqueue(input([[15, "#ABCDEF80"]]));
    for (let index = 0; index < 75; index += 1) {
      const nextSequence = index + 1;
      enqueuedAt.set(nextSequence, Date.now());
      senderA.enqueue(input([[index % 15, `#${nextSequence.toString(16).padStart(6, "0")}`]]));
      vi.advanceTimersByTime(4);
      if (index >= 4) {
        expect(savesCompleted).toBe(false);
        expect(previewsB.render(canonicalB, 10)).not.toBe(canonicalB);
      }
    }
    expect(framesSeenDuringStroke).toBeGreaterThan(15);
    expect(observedDelays.length).toBeGreaterThan(60);
    expect(Math.max(...observedDelays)).toBeLessThanOrEqual(19);
    expect(colorAt(previewsA.render(canonicalA, 10), 15)).toBe("#ABCDEF80");
    expect(canonicalA.layers[0]!.pixels.every((color) => color === null)).toBe(true);
    expect(canonicalB.layers[0]!.pixels.every((color) => color === null)).toBe(true);
    expect(savesCompleted).toBe(false);
    vi.advanceTimersByTime(1700);
    expect(savesCompleted).toBe(true);
  });

  it("renders previews immediately while preserving the canonical document and untouched layer references", () => {
    const source = document();
    const original = structuredClone(source);
    Object.freeze(source.layers[0]!.pixels);
    Object.freeze(source.layers[0]);
    Object.freeze(source.layers);
    Object.freeze(source);
    const overlay = createLivePixelPreviewOverlay();
    expect(overlay.receive("client-1", packet([[0, "#abcdef80", 1]]))).toBe(true);
    const result = overlay.render(source, 10);
    expect(colorAt(result)).toBe("#abcdef80");
    expect(source).toEqual(original);
    expect(result).not.toBe(source);
    expect(result.layers[0]).not.toBe(source.layers[0]);
    expect(result.layers[1]).toBe(source.layers[1]);
    expect(result.palette).toBe(source.palette);
  });

  it("preserves erasure, visibility and layer opacity rather than prematurely compositing colors", () => {
    const source = document();
    source.layers[0]!.pixels[0] = "#111111";
    source.layers[0]!.opacity = 0.5;
    source.layers[1]!.visible = false;
    const overlay = createLivePixelPreviewOverlay();
    overlay.receive("client-1", packet([[0, null, 1], [1, "#FFFFFF80", 1]]));
    const result = overlay.render(source, 10);
    expect(colorAt(result)).toBeNull();
    expect(colorAt(result, 1)).toBe("#FFFFFF80");
    expect(result.layers[0]!.opacity).toBe(0.5);
    expect(result.layers[1]!.visible).toBe(false);
    expect(compositeVisibleLayers(result)[1]).toBe("#FFFFFF40");
  });

  it("returns the canonical object for a preview that makes no visible change", () => {
    const source = document();
    const overlay = createLivePixelPreviewOverlay();
    overlay.receive("client-1", packet([[0, null, 1]]));
    expect(overlay.render(source, 10)).toBe(source);
  });

  it("merges independent pixels, ignores duplicate or older updates, and keeps the latest value on the same pixel", () => {
    const overlay = createLivePixelPreviewOverlay();
    overlay.receive("client-1", packet([[0, "#333333", 3]]));
    expect(overlay.receive("client-1", packet([[0, "#111111", 1]]))).toBe(false);
    expect(overlay.receive("client-1", packet([[0, "#333333", 3]]))).toBe(false);
    expect(overlay.receive("client-1", packet([[1, "#222222", 2]]))).toBe(true);
    const result = overlay.render(document(), 10);
    expect(result.layers[0]!.pixels.slice(0, 2)).toEqual(["#333333", "#222222"]);
  });

  it("coalesces out-of-order repeated indices inside a packet without accepting an older tuple", () => {
    const overlay = createLivePixelPreviewOverlay();
    overlay.receive("client-1", packet([[0, "#333333", 3], [0, "#111111", 1]]));
    expect(colorAt(overlay.render(document(), 10))).toBe("#333333");
  });

  it("merges different clients and uses the most recently accepted live value for a colliding pixel", () => {
    const overlay = createLivePixelPreviewOverlay();
    overlay.receive("client-1", packet([[0, "#111111", 1], [1, "#222222", 1]]));
    overlay.receive("client-2", packet([[0, "#333333", 1], [2, "#444444", 1]]));
    const result = overlay.render(document(), 10);
    expect(result.layers[0]!.pixels.slice(0, 3)).toEqual(["#333333", "#222222", "#444444"]);
  });

  it("keeps preview pixels when the ACK arrives before the canonical GET", () => {
    const overlay = createLivePixelPreviewOverlay();
    const source = document();
    overlay.receive("client-1", packet([[0, "#111111", 1]]));
    overlay.confirm("client-1", 1, 11);
    expect(colorAt(overlay.render(source, 10))).toBe("#111111");
    const canonical = document();
    canonical.layers[0]!.pixels[0] = "#111111";
    expect(overlay.render(canonical, 11)).toBe(canonical);
    expect(overlay.receive("client-1", packet([[0, "#222222", 1]]))).toBe(false);
  });

  it("can acknowledge an unseen packet and suppress a late duplicate after canonical synchronization", () => {
    const overlay = createLivePixelPreviewOverlay();
    overlay.confirm("client-1", 3, 11);
    overlay.render(document(), 11);
    expect(overlay.receive("client-1", packet([[0, "#333333", 3]]))).toBe(false);
    expect(overlay.receive("client-1", packet([[1, "#444444", 4]]))).toBe(true);
  });

  it("retires only confirmed tuples in a mixed batch and does not erase newer pixels in flight", () => {
    const overlay = createLivePixelPreviewOverlay();
    overlay.receive("client-1", packet([[0, "#111111", 1], [1, "#222222", 2]]));
    overlay.confirm("client-1", 1, 11);
    const canonical = document();
    canonical.layers[0]!.pixels[0] = "#AAAAAA";
    const result = overlay.render(canonical, 11);
    expect(result.layers[0]!.pixels.slice(0, 2)).toEqual(["#AAAAAA", "#222222"]);
    overlay.receive("client-1", packet([[0, "#333333", 3]], { base_revision: 11 }));
    overlay.confirm("client-1", 2, 12);
    expect(colorAt(overlay.render(canonical, 12))).toBe("#333333");
  });

  it("a delayed ACK never removes a later mutation on the same pixel", () => {
    const overlay = createLivePixelPreviewOverlay();
    overlay.receive("client-1", packet([[0, "#111111", 1]]));
    overlay.receive("client-1", packet([[0, "#222222", 2]]));
    overlay.confirm("client-1", 1, 11);
    expect(colorAt(overlay.render(document(), 11))).toBe("#222222");
  });

  it("applies out-of-order ACKs only at their respective canonical revisions", () => {
    const overlay = createLivePixelPreviewOverlay();
    overlay.receive("client-1", packet([[0, "#111111", 1], [1, "#222222", 2]]));
    overlay.confirm("client-1", 2, 12);
    overlay.confirm("client-1", 1, 11);
    const source = document();
    expect(overlay.render(source, 11).layers[0]!.pixels.slice(0, 2)).toEqual([null, "#222222"]);
    expect(overlay.render(source, 12)).toBe(source);
  });

  it("waits for future-base pixels rather than drawing them on stale canonical data", () => {
    const overlay = createLivePixelPreviewOverlay();
    overlay.receive("client-1", packet([[0, "#111111", 1]], { base_revision: 11 }));
    const source = document();
    expect(overlay.render(source, 10)).toBe(source);
    expect(colorAt(overlay.render(source, 11))).toBe("#111111");
  });

  it("waits for a future resize, drops older geometry, and rejects out-of-order old frame packets", () => {
    const overlay = createLivePixelPreviewOverlay();
    overlay.receive("client-1", packet([[15, "#111111", 1]]));
    overlay.receive("client-1", packet([[0, "#222222", 2]], { width: 2, height: 2, base_revision: 11 }));
    expect(overlay.render(document(), 10)).toEqual(document());
    expect(overlay.receive("client-1", packet([[15, "#333333", 1]]))).toBe(false);
    const resized = createPixelArtDocument(2, 2, { layers: [createPixelLayer(2, 2, { id: "layer-1" })] });
    expect(colorAt(overlay.render(resized, 11))).toBe("#222222");
    expect(overlay.render(document(), 12)).toEqual(document());
    expect(overlay.render(resized, 13)).toBe(resized);
  });

  it("revision floors survive clear and prevent stale previews reappearing when undo restores old dimensions", () => {
    const overlay = createLivePixelPreviewOverlay();
    overlay.receive("client-1", packet([[0, "#111111", 1]]));
    overlay.clear(11);
    overlay.clear(5);
    expect(overlay.receive("client-1", packet([[0, "#222222", 2]]))).toBe(false);
    expect(overlay.receive("client-1", packet([[0, "#333333", 3]], { base_revision: 11 }))).toBe(true);
    expect(colorAt(overlay.render(document(), 11))).toBe("#333333");
  });

  it("drops deleted layers, but retains previews for future newly created layers until canonical arrives", () => {
    const overlay = createLivePixelPreviewOverlay();
    overlay.receive("client-1", packet([[0, "#111111", 1]], { layer_id: "layer-2" }));
    const source = document();
    source.layers.pop();
    expect(overlay.render(source, 11)).toBe(source);
    expect(overlay.render(document(), 12)).toEqual(document());
    overlay.receive("client-1", packet([[0, "#222222", 2]], { layer_id: "layer-3", base_revision: 13 }));
    expect(overlay.render(source, 12)).toBe(source);
    source.layers.push(createPixelLayer(4, 4, { id: "layer-3" }));
    expect(overlay.render(source, 13).layers[1]!.pixels[0]).toBe("#222222");
  });

  it("expires individual stale pixels even if the client continues painting elsewhere", () => {
    const overlay = createLivePixelPreviewOverlay();
    overlay.receive("client-1", packet([[0, "#111111", 1]]), 0);
    overlay.receive("client-1", packet([[1, "#222222", 2]]), 20_000);
    expect(overlay.prune(30_000)).toBe(true);
    expect(overlay.render(document(), 10, 30_000).layers[0]!.pixels.slice(0, 2)).toEqual([null, "#222222"]);
    expect(overlay.prune(50_000)).toBe(true);
    const source = document();
    expect(overlay.render(source, 10, 50_000)).toBe(source);
  });

  it("duplicate packets do not extend a preview's lifetime", () => {
    const overlay = createLivePixelPreviewOverlay();
    const payload = packet([[0, "#111111", 1]]);
    overlay.receive("client-1", payload, 0);
    expect(overlay.receive("client-1", payload, 29_999)).toBe(false);
    expect(overlay.prune(30_000)).toBe(true);
  });

  it("removes a departed client without altering other participants", () => {
    const overlay = createLivePixelPreviewOverlay();
    overlay.receive("client-1", packet([[0, "#111111", 1]]));
    overlay.receive("client-2", packet([[1, "#222222", 1]]));
    expect(overlay.removeClient("client-1")).toBe(true);
    expect(overlay.removeClient("missing")).toBe(false);
    expect(overlay.render(document(), 10).layers[0]!.pixels.slice(0, 2)).toEqual([null, "#222222"]);
    overlay.clear();
    expect(overlay.render(document(), 10)).toEqual(document());
  });

  it("bounds the number of clients and admits fresh participants after stale clients expire", () => {
    const overlay = createLivePixelPreviewOverlay();
    for (let index = 0; index < 50; index += 1) {
      expect(overlay.receive(`client-${index}`, packet([[index % 16, "#111111", 1]]), 0)).toBe(true);
    }
    expect(overlay.receive("client-51", packet([[0, "#111111", 1]]), 0)).toBe(false);
    expect(overlay.receive("client-51", packet([[0, "#111111", 1]]), 30_000)).toBe(true);
  });

  it("caps total pending pixels per layer across all clients", () => {
    const overlay = createLivePixelPreviewOverlay();
    for (let offset = 0; offset < 65_536; offset += 1024) {
      const changes = Array.from({ length: 1024 }, (_, index) => [offset + index, "#111111", 1] as const);
      expect(overlay.receive("client-1", packet(changes, { width: 256, height: 256 }))).toBe(true);
    }
    expect(overlay.receive("client-2", packet([[0, "#222222", 1]], { width: 256, height: 256 }))).toBe(false);
    expect(overlay.receive("client-1", packet([[0, "#333333", 2]], { width: 256, height: 256 }))).toBe(true);
  });

  it.each([
    { preview_protocol: 2 }, { preview_protocol: "1" }, { width: 257 }, { height: 0 },
    { base_revision: -1 }, { base_revision: Number.MAX_SAFE_INTEGER + 1 },
    { layer_id: " " }, { layer_id: "x".repeat(201) }, { preview_sequence: 0 },
    { changes: [] }, { changes: [[16, null, 1]] }, { changes: [[0.5, null, 1]] },
    { changes: [[0, "red", 1]] }, { changes: [[0, "#12345", 1]] },
    { changes: [[0, null, -1]] }, { changes: [[0, null, 2]] },
    { changes: [[0, null, 1, "hidden"]] }, { changes: Array.from({ length: 1025 }, () => [0, null, 1]) },
  ])("rejects invalid payload atomically %#", (overrides) => {
    const overlay = createLivePixelPreviewOverlay();
    expect(overlay.receive("client-1", packet([[0, "#111111", 1]], overrides))).toBe(false);
    const source = document();
    expect(overlay.render(source, 10)).toBe(source);
  });

  it("rejects inherited fields, malformed clients and mutation sequences outside safe integers", () => {
    const overlay = createLivePixelPreviewOverlay();
    expect(overlay.receive("client-1", Object.create(packet([[0, "#111111", 1]])))).toBe(false);
    expect(overlay.receive("x".repeat(201), packet([[0, "#111111", 1]]))).toBe(false);
    expect(overlay.receive("", packet([[0, "#111111", 1]]))).toBe(false);
    expect(overlay.receive("client-1", packet([[0, null, Number.MAX_SAFE_INTEGER + 1]]))).toBe(false);
  });
});
