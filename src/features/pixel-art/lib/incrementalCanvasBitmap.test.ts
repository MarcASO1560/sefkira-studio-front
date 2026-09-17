import { describe, expect, it } from "vitest";

import type { PixelArtDocumentV2, PixelColor } from "../types";
import { compositeVisibleLayers, createPixelArtDocument } from "./document";
import { writeImageCanvasBitmapPixels } from "./canvasRendering";
import { createIncrementalImageCanvasBitmap } from "./incrementalCanvasBitmap";

const fullBitmap = (document: PixelArtDocumentV2, background: PixelColor) =>
  writeImageCanvasBitmapPixels(compositeVisibleLayers(document), background,
    new Uint8ClampedArray(document.width * document.height * 4));

const replacePixels = (document: PixelArtDocumentV2, layerId: string, pixels: PixelColor[]): PixelArtDocumentV2 => ({
  ...document, layers: document.layers.map((layer) => layer.id === layerId ? { ...layer, pixels } : layer),
});

const baseDocument = () => createPixelArtDocument(64, 64, {
  layers: [
    { id: "a", name: "A", visible: true, locked: false, opacity: 1, pixels: Array(4096).fill("#123456") },
    { id: "b", name: "B", visible: true, locked: false, opacity: 0.5, pixels: Array(4096).fill("#FFDDEE80") },
    { id: "c", name: "C", visible: false, locked: true, opacity: 1, pixels: Array(4096).fill("#FFFFFF") },
  ],
});

describe("createIncrementalImageCanvasBitmap", () => {
  it("matches a full render initially without mutating frozen documents", () => {
    const document = baseDocument();
    for (const layer of document.layers) { Object.freeze(layer.pixels); Object.freeze(layer); }
    Object.freeze(document.layers);
    Object.freeze(document);
    const renderer = createIncrementalImageCanvasBitmap();
    const target = new Uint8ClampedArray(4096 * 4);
    renderer.write(document, "#101111", target);
    expect(target).toEqual(fullBitmap(document, "#101111"));
    expect(document.layers[0]!.pixels[0]).toBe("#123456");
  });

  it("recomposes only dirty indices for a trusted 1024 × 1024 mutation", () => {
    const pixels = Array<PixelColor>(1024 * 1024).fill("#AABBCC");
    let reads = 0;
    const previous = new Proxy(pixels, { get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
      return Reflect.get(target, key, receiver);
    } });
    const document: PixelArtDocumentV2 = { version: 2, width: 1024, height: 1024, palette: [], layers: [
      { id: "a", name: "A", visible: true, locked: false, opacity: 1, pixels: previous },
    ] };
    const renderer = createIncrementalImageCanvasBitmap();
    const target = new Uint8ClampedArray(1024 * 1024 * 4);
    renderer.write(document, "#000000", target);
    const next = pixels.slice();
    next[600000] = "#FFFFFF80";
    reads = 0;
    renderer.registerMutation({ layerId: "a", previousPixels: previous, nextPixels: next,
      changes: [{ index: 600000, before: "#AABBCC", after: "#FFFFFF80" }] });
    expect(reads).toBe(1);
    let nextReads = 0;
    const oldDescriptor = Object.getOwnPropertyDescriptor(next, "600000")!;
    // The registered buffer identity must remain intact. Count one touched
    // index through an accessor, not a new Proxy identity unknown to the cache.
    Object.defineProperty(next, "600000", { configurable: true, enumerable: true,
      get: () => { nextReads += 1; return oldDescriptor.value as PixelColor; } });
    renderer.write(replacePixels(document, "a", next), "#000000", target);
    expect(nextReads).toBe(1);
    expect([...target.slice(600000 * 4, 600000 * 4 + 4)]).toEqual([128, 128, 128, 255]);
    expect([...target.slice(0, 4)]).toEqual([170, 187, 204, 255]);
  });

  it("does not rescan unchanged image data or palette-only container changes", () => {
    const document = baseDocument();
    let reads = 0;
    document.layers[0]!.pixels = new Proxy(document.layers[0]!.pixels, { get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
      return Reflect.get(target, key, receiver);
    } });
    const renderer = createIncrementalImageCanvasBitmap();
    const target = new Uint8ClampedArray(4096 * 4);
    renderer.write(document, null, target);
    reads = 0;
    renderer.write({ ...document, palette: ["#FFFFFF"], layers: document.layers.map((layer) => ({ ...layer })) }, null, target);
    expect(reads).toBe(0);
  });

  it.each([null, "#101111", "#11223380"])("preserves exact per-layer alpha and erasure over background %s", (background) => {
    const document = baseDocument();
    const renderer = createIncrementalImageCanvasBitmap();
    const target = new Uint8ClampedArray(4096 * 4);
    renderer.write(document, background, target);
    const nextA = document.layers[0]!.pixels.slice();
    const nextB = document.layers[1]!.pixels.slice();
    nextA[100] = null;
    nextA[101] = "#11223300";
    nextA[102] = "#112233FE";
    nextB[100] = null;
    nextB[101] = "#AABBCC01";
    nextB[102] = "#DDEEFF80";
    for (const [layerIndex, next] of [[0, nextA], [1, nextB]] as const) {
      renderer.registerMutation({ layerId: document.layers[layerIndex]!.id,
        previousPixels: document.layers[layerIndex]!.pixels, nextPixels: next,
        changes: [100, 101, 102].map((index) => ({ index, after: next[index]! })) });
    }
    const updated = replacePixels(replacePixels(document, "a", nextA), "b", nextB);
    renderer.write(updated, background, target);
    expect(target).toEqual(fullBitmap(updated, background));
  });

  it("accumulates several mutations and duplicate indices before the next frame", () => {
    const document = baseDocument();
    const renderer = createIncrementalImageCanvasBitmap();
    const target = new Uint8ClampedArray(4096 * 4);
    renderer.write(document, "#000000", target);
    const first = document.layers[0]!.pixels.slice();
    first[100] = "#FFFFFF";
    renderer.registerMutation({ layerId: "a", previousPixels: document.layers[0]!.pixels, nextPixels: first,
      changes: [{ index: 100, after: "#FFFFFF" }] });
    const second = first.slice();
    second[100] = "#000000";
    second[200] = "#FFFFFF80";
    renderer.registerMutation({ layerId: "a", previousPixels: first, nextPixels: second,
      changes: [{ index: 100, before: "#FFFFFF", after: "#AAAAAA" },
        { index: 100, before: "#AAAAAA", after: "#000000" }, { index: 200, after: "#FFFFFF80" }] });
    const updated = replacePixels(document, "a", second);
    renderer.write(updated, "#000000", target);
    expect(target).toEqual(fullBitmap(updated, "#000000"));
    const third = second.slice();
    third[300] = null;
    renderer.registerMutation({ layerId: "a", previousPixels: second, nextPixels: third,
      changes: [{ index: 300, after: null }] });
    const final = replacePixels(updated, "a", third);
    renderer.write(final, "#000000", target);
    expect(target).toEqual(fullBitmap(final, "#000000"));
  });

  it.each(["name", "visible", "locked", "opacity", "order", "remove", "add"])("falls back safely after a layer %s change", (kind) => {
    const document = baseDocument();
    const renderer = createIncrementalImageCanvasBitmap();
    const target = new Uint8ClampedArray(4096 * 4);
    renderer.write(document, "#101111", target);
    const layers = document.layers.map((layer) => ({ ...layer }));
    if (kind === "name") layers[0]!.name = "Renamed";
    if (kind === "visible") layers[0]!.visible = false;
    if (kind === "locked") layers[0]!.locked = true;
    if (kind === "opacity") layers[0]!.opacity = 0.25;
    if (kind === "order") layers.reverse();
    if (kind === "remove") layers.pop();
    if (kind === "add") layers.push({ ...layers[0]!, id: "new", pixels: Array(4096).fill("#FFFF0040") });
    const updated = { ...document, layers };
    renderer.write(updated, "#101111", target);
    expect(target).toEqual(fullBitmap(updated, "#101111"));
  });

  it("falls back for unknown remote preview buffers and restores canonical ink after preview removal", () => {
    const document = baseDocument();
    const renderer = createIncrementalImageCanvasBitmap();
    const target = new Uint8ClampedArray(4096 * 4);
    renderer.write(document, "#101111", target);
    const remotePixels = document.layers[0]!.pixels.slice();
    remotePixels[0] = "#FF0000";
    remotePixels[500] = "#FFFFFF";
    const remote = replacePixels(document, "a", remotePixels);
    renderer.write(remote, "#101111", target);
    expect(target).toEqual(fullBitmap(remote, "#101111"));
    renderer.write(document, "#101111", target);
    expect(target).toEqual(fullBitmap(document, "#101111"));
  });

  it("falls back for an unknown replacement even if another layer has a complete local delta", () => {
    const document = baseDocument();
    const renderer = createIncrementalImageCanvasBitmap();
    const target = new Uint8ClampedArray(4096 * 4);
    renderer.write(document, null, target);
    const nextA = document.layers[0]!.pixels.slice();
    nextA[0] = null;
    renderer.registerMutation({ layerId: "a", previousPixels: document.layers[0]!.pixels, nextPixels: nextA,
      changes: [{ index: 0, after: null }] });
    const nextB = document.layers[1]!.pixels.slice();
    nextB[2000] = "#FF0000";
    const updated = replacePixels(replacePixels(document, "a", nextA), "b", nextB);
    renderer.write(updated, null, target);
    expect(target).toEqual(fullBitmap(updated, null));
  });

  it.each(["missing-chain", "wrong-before", "wrong-after", "invalid-index", "unknown-layer", "empty", "in-place"])
    ("falls back after invalid registration: %s", (kind) => {
      const document = baseDocument();
      const renderer = createIncrementalImageCanvasBitmap();
      const target = new Uint8ClampedArray(4096 * 4);
      renderer.write(document, "#000000", target);
      const previous = document.layers[0]!.pixels;
      const next = previous.slice();
      next[100] = "#FFFFFF";
      next[200] = "#000000";
      if (kind === "missing-chain") {
        renderer.registerMutation({ layerId: "a", previousPixels: previous, nextPixels: next,
          changes: [{ index: 100, after: "#FFFFFF" }, { index: 200, after: "#000000" }] });
        renderer.registerMutation({ layerId: "a", previousPixels: previous.slice(), nextPixels: next,
          changes: [{ index: 100, after: "#FFFFFF" }] });
      } else {
        renderer.registerMutation({ layerId: kind === "unknown-layer" ? "unknown" : "a",
          previousPixels: previous, nextPixels: kind === "in-place" ? previous : next,
          changes: kind === "empty" ? [] : [{ index: kind === "invalid-index" ? -1 : 100,
            before: kind === "wrong-before" ? null : "#123456", after: kind === "wrong-after" ? null : "#FFFFFF" }] });
      }
      const updated = replacePixels(document, "a", next);
      renderer.write(updated, "#000000", target);
      expect(target).toEqual(fullBitmap(updated, "#000000"));
    });

  it("falls back for changed bitmap, background, dimensions and explicit clear", () => {
    const document = baseDocument();
    const renderer = createIncrementalImageCanvasBitmap();
    const target = new Uint8ClampedArray(4096 * 4);
    renderer.write(document, null, target);
    const another = new Uint8ClampedArray(4096 * 4);
    renderer.write(document, null, another);
    expect(another).toEqual(fullBitmap(document, null));
    renderer.write(document, "#FFFFFF", target);
    expect(target).toEqual(fullBitmap(document, "#FFFFFF"));
    const resized = createPixelArtDocument(128, 64);
    const resizeTarget = new Uint8ClampedArray(128 * 64 * 4);
    renderer.write(resized, "#FFFFFF", resizeTarget);
    expect(resizeTarget).toEqual(fullBitmap(resized, "#FFFFFF"));
    renderer.clear();
    renderer.write(document, null, target);
    expect(target).toEqual(fullBitmap(document, null));
  });

  it("uses the full palette-cached renderer for large bulk mutations", () => {
    const document = baseDocument();
    const renderer = createIncrementalImageCanvasBitmap();
    const target = new Uint8ClampedArray(4096 * 4);
    renderer.write(document, "#000000", target);
    const next = Array<PixelColor>(4096).fill("#FFFFFF80");
    renderer.registerMutation({ layerId: "a", previousPixels: document.layers[0]!.pixels, nextPixels: next,
      changes: next.map((after, index) => ({ index, after })) });
    const updated = replacePixels(document, "a", next);
    renderer.write(updated, "#000000", target);
    expect(target).toEqual(fullBitmap(updated, "#000000"));
  });

  it("rejects invalid resolutions and target lengths before rendering", () => {
    const renderer = createIncrementalImageCanvasBitmap();
    const document = baseDocument();
    expect(() => renderer.write(document, null, new Uint8ClampedArray(0))).toThrow(RangeError);
    expect(() => renderer.write({ ...document, width: 4096, height: 4096 }, null, new Uint8ClampedArray(0))).toThrow(RangeError);
  });
});
