import { describe, expect, it } from "vitest";

import { createImageCanvasRenderPlan, writeImageCanvasBitmapPixels } from "./canvasRendering";

describe("createImageCanvasRenderPlan", () => {
  it("renders at logical resolution while preserving a fractional CSS zoom", () => {
    expect(
      createImageCanvasRenderPlan({
        cellSize: 33.06545903847264,
        gridHeight: 32,
        gridWidth: 16,
      }),
    ).toEqual({
      bitmapHeight: 32,
      bitmapWidth: 16,
      cellSize: 1,
      cellStride: 1,
      cssHeight: 1058.0946892311244,
      cssWidth: 529.0473446155622,
    });
  });

  it("derives the canvas size only from the document dimensions and zoom", () => {
    expect(
      createImageCanvasRenderPlan({
        cellSize: 24,
        gridHeight: 3,
        gridWidth: 4,
      }),
    ).toEqual({
      bitmapHeight: 3,
      bitmapWidth: 4,
      cellSize: 1,
      cellStride: 1,
      cssHeight: 72,
      cssWidth: 96,
    });
  });
});

describe("writeImageCanvasBitmapPixels", () => {
  it("writes opaque HEX6 and HEX8 pixels over a display-only background", () => {
    const pixels = Object.freeze([null, "#abcdef", "#FEDCBAFF", "#00000000"]);
    const target = new Uint8ClampedArray(16);
    expect(writeImageCanvasBitmapPixels(pixels, "#101111", target)).toBe(target);
    expect([...target]).toEqual([
      16, 17, 17, 255,
      171, 205, 239, 255,
      254, 220, 186, 255,
      16, 17, 17, 255,
    ]);
    expect(pixels).toEqual([null, "#abcdef", "#FEDCBAFF", "#00000000"]);
  });

  it("alpha-composites pixels over opaque and transparent backgrounds", () => {
    const pixels = ["#FFFFFF80", "#FF000040", null];
    expect([...writeImageCanvasBitmapPixels(pixels, "#000000", new Uint8ClampedArray(12))]).toEqual([
      128, 128, 128, 255,
      64, 0, 0, 255,
      0, 0, 0, 255,
    ]);
    expect([...writeImageCanvasBitmapPixels(pixels, null, new Uint8ClampedArray(12))]).toEqual([
      255, 255, 255, 128,
      255, 0, 0, 64,
      0, 0, 0, 0,
    ]);
  });

  it("keeps RGBA output and erasure correct with a translucent background", () => {
    const target = new Uint8ClampedArray(8);
    writeImageCanvasBitmapPixels(["#FF000080", "#ABCDEF00"], "#0000FF80", target);
    expect([...target]).toEqual([170, 0, 85, 192, 0, 0, 255, 128]);
    writeImageCanvasBitmapPixels([null, "#00FF00"], "#000000", target);
    expect([...target]).toEqual([0, 0, 0, 255, 0, 255, 0, 255]);
  });

  it("normalizes transparent and invalid colors without leaking former bytes", () => {
    const target = new Uint8ClampedArray(12).fill(255);
    writeImageCanvasBitmapPixels([null, "invalid", "#FFFFFF00"], null, target);
    expect([...target]).toEqual(Array(12).fill(0));
  });

  it("handles non-square logical bitmap lengths and repeated colors", () => {
    const target = new Uint8ClampedArray(24);
    writeImageCanvasBitmapPixels(["#FFFFFF", null, "#FFFFFF", "#00000080", null, "#FFFFFF"], "#204060", target);
    expect([...target.slice(12, 16)]).toEqual([16, 32, 48, 255]);
    expect([...target.slice(20, 24)]).toEqual([255, 255, 255, 255]);
  });

  it("rejects a resolution-mismatched output buffer", () => {
    expect(() => writeImageCanvasBitmapPixels(["#FFFFFF"], null, new Uint8ClampedArray(8))).toThrow(RangeError);
    expect(() => writeImageCanvasBitmapPixels(["#FFFFFF"], null, new Uint8ClampedArray(0))).toThrow(RangeError);
  });
});
