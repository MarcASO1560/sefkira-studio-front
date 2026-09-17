import { describe, expect, it } from "vitest";
import type { PixelColor } from "../types";
import { registerNormalizedPixelArray } from "./pixelBufferTrust";
import { floodFillPixelRuns } from "./floodFillRuns";

const referenceFill = (pixels: PixelColor[], width: number, height: number, start: number,
  color: PixelColor, contains = (_index: number) => true) => {
  const result = pixels.slice();
  const target = pixels[start];
  const pending = [start];
  const visited = new Set<number>();
  while (pending.length) {
    const index = pending.pop()!;
    if (visited.has(index) || !contains(index) || pixels[index] !== target) continue;
    visited.add(index); result[index] = color;
    const x = index % width, y = Math.floor(index / width);
    if (x) pending.push(index - 1);
    if (x + 1 < width) pending.push(index + 1);
    if (y) pending.push(index - width);
    if (y + 1 < height) pending.push(index + width);
  }
  return result;
};

describe("compact scanline fill", () => {
  it("captures a complete 1024 canvas in a single range without changing the source", () => {
    const count = 1024 * 1024;
    const source = registerNormalizedPixelArray(Array<PixelColor>(count).fill(null));
    const fill = floodFillPixelRuns({ pixels: source, width: 1024, height: 1024,
      startIndex: count - 1, color: "#aabbcc80" })!;
    expect(fill.runs).toEqual([[0, count]]);
    expect(fill.pixels.every((color) => color === "#AABBCC80")).toBe(true);
    expect(source.every((color) => color === null)).toBe(true);
    expect(JSON.stringify(fill.runs).length).toBeLessThan(32);
  });

  it("preserves disconnected islands and never wraps into the next row", () => {
    const source = [null, "#FFFFFF", null, "#FFFFFF", null, null];
    const fill = floodFillPixelRuns({ pixels: source, width: 3, height: 2,
      startIndex: 2, color: "#112233" })!;
    expect(fill.pixels).toEqual([null, "#FFFFFF", "#112233", "#FFFFFF", "#112233", "#112233"]);
    expect(fill.runs).toEqual([[2, 1], [4, 2]]);
  });

  it("clips the exact fill to a selection, including holes", () => {
    const source = Array<PixelColor>(25).fill(null);
    const contains = (index: number) => index % 5 > 0 && index % 5 < 4 && index !== 12;
    const fill = floodFillPixelRuns({ pixels: source, width: 5, height: 5,
      startIndex: 1, color: "#112233", contains })!;
    expect(fill.pixels).toEqual(referenceFill(source, 5, 5, 1, "#112233", contains));
    expect(fill.pixels[12]).toBeNull();
  });

  it("matches a four-connected reference for random obstacles and selection masks", () => {
    let random = 84723;
    const next = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random; };
    for (let sample = 0; sample < 150; sample += 1) {
      const width = 13, height = 9;
      const source = Array.from({ length: width * height }, (): PixelColor => next() % 5 ? null : "#FFFFFF");
      const mask = source.map(() => next() % 7 !== 0);
      const startIndex = next() % source.length;
      const contains = (index: number) => mask[index]!;
      const fill = floodFillPixelRuns({ pixels: source, width, height, startIndex,
        color: "#12345680", contains });
      if (!contains(startIndex)) { expect(fill).toBeNull(); continue; }
      expect(fill!.pixels).toEqual(referenceFill(source, width, height, startIndex, "#12345680", contains));
      const reconstructed = source.slice();
      let lastEnd = 0;
      for (const [start, length] of fill!.runs) {
        expect(start).toBeGreaterThanOrEqual(lastEnd); lastEnd = start + length;
        reconstructed.fill("#12345680", start, lastEnd);
      }
      expect(reconstructed).toEqual(fill!.pixels);
    }
  });

  it("supports clearing transparent and alpha colors, and skips no-ops", () => {
    expect(floodFillPixelRuns({ pixels: ["#12345680"], width: 1, height: 1,
      startIndex: 0, color: null })!.pixels).toEqual([null]);
    expect(floodFillPixelRuns({ pixels: [null], width: 1, height: 1,
      startIndex: 0, color: null })).toBeNull();
    expect(floodFillPixelRuns({ pixels: [null], width: 1, height: 1,
      startIndex: 5, color: "#123456" })).toBeNull();
  });

  it("validates dimensions and colors before filling", () => {
    expect(() => floodFillPixelRuns({ pixels: [], width: 1024, height: 1024,
      startIndex: 0, color: null })).toThrow(RangeError);
    expect(() => floodFillPixelRuns({ pixels: [null], width: 1, height: 1,
      startIndex: 0, color: "invalid" })).toThrow(RangeError);
  });
});
