import { describe, expect, it } from "vitest";
import type { ImageSelection, PixelColor } from "../types";
import { createPointSelectionMask } from "./selectionMask";
import {
  getPixelRotationDelta,
  getPixelRotationPivot,
  rotateImagePixelSelection,
  snapPixelRotationDegrees,
} from "./selectionRotation";

const source = (width = 5, height = 5) => ({
  width, height, pixels: Array<PixelColor>(width * height).fill(null),
});
const irregularSelection = (points: { x: number; y: number }[]): ImageSelection => {
  const mask = createPointSelectionMask(points, { width: 5, height: 5 });
  return { ...mask.bounds!, kind: "lasso", mask };
};

describe("arbitrary pixel rotation", () => {
  it.each([0, 360, -360, Number.NaN, Number.POSITIVE_INFINITY])(
    "leaves pixels and a legacy selection unchanged at %s degrees",
    (degrees) => {
      const buffer = source();
      buffer.pixels[6] = "#abcdef";
      const selection = { x: 1, y: 1, width: 2, height: 2 };
      const result = rotateImagePixelSelection(buffer, selection, degrees);
      expect(result).toEqual({ pixels: buffer.pixels, selection });
      expect(result.pixels).not.toBe(buffer.pixels);
      expect(result.selection).not.toBe(selection);
    },
  );

  it("turns a rectangular selection clockwise about its center", () => {
    const buffer = source(4, 4);
    buffer.pixels[5] = "A";
    buffer.pixels[6] = "B";
    buffer.pixels[9] = "C";
    buffer.pixels[10] = "D";
    buffer.pixels[0] = "outside";
    const result = rotateImagePixelSelection(buffer, { x: 1, y: 1, width: 2, height: 2 }, 90);
    expect([5, 6, 9, 10].map((index) => result.pixels[index])).toEqual(["C", "A", "D", "B"]);
    expect(result.pixels[0]).toBe("outside");
    expect(result.selection).toMatchObject({ x: 1, y: 1, width: 2, height: 2 });
    expect(buffer.pixels[5]).toBe("A");
  });

  it("rotates an irregular mask without picking up pixels in its holes", () => {
    const buffer = source();
    const selection = irregularSelection([{ x: 1, y: 1 }, { x: 3, y: 1 }, { x: 1, y: 3 }]);
    buffer.pixels[6] = "A";
    buffer.pixels[8] = "B";
    buffer.pixels[16] = "C";
    buffer.pixels[12] = "hole";
    const result = rotateImagePixelSelection(buffer, selection, 90);
    expect(result.pixels[8]).toBe("A");
    expect(result.pixels[18]).toBe("B");
    expect(result.pixels[6]).toBe("C");
    expect(result.pixels[16]).toBeNull();
    expect(result.pixels[12]).toBe("hole");
    expect(result.selection?.mask?.data[12]).toBe(0);
    expect(result.selection?.mask?.data[16]).toBe(0);
    expect(result.selection?.kind).toBe("lasso");
    expect([...selection.mask!.data].filter(Boolean)).toHaveLength(3);
    expect(selection.mask!.data[16]).toBe(1);
  });

  it("preserves unrelated destination pixels under transparent selected pixels", () => {
    const buffer = source();
    buffer.pixels[7] = "background";
    buffer.pixels[12] = "center";
    buffer.pixels[13] = "right";
    const result = rotateImagePixelSelection(buffer, { x: 1, y: 2, width: 3, height: 1 }, 90);
    expect(result.pixels[7]).toBe("background");
    expect(result.selection?.mask?.data[7]).toBe(1);
    expect(result.pixels[12]).toBe("center");
    expect(result.pixels[17]).toBe("right");
    expect(result.pixels[13]).toBeNull();
    expect(result.selection).toMatchObject({ x: 2, y: 1, width: 1, height: 3 });
  });

  it("uses only exact source colors at fractional angles, never antialiasing", () => {
    const buffer = source();
    buffer.pixels.fill("#12345680");
    buffer.pixels[12] = "#abcdef";
    const before = [...buffer.pixels];
    const result = rotateImagePixelSelection(buffer, null, 37.25);
    expect(new Set(result.pixels)).toEqual(new Set([null, "#12345680", "#abcdef"]));
    expect(result.selection).toBeNull();
    expect(buffer.pixels).toEqual(before);
  });

  it("clips a rotated non-square canvas without resizing or wrapping", () => {
    const buffer = source(5, 3);
    buffer.pixels[0] = "clipped";
    buffer.pixels[7] = "center";
    const result = rotateImagePixelSelection(buffer, null, 90);
    expect(result.pixels).toHaveLength(15);
    expect(result.pixels).not.toContain("clipped");
    expect(result.pixels[7]).toBe("center");
    expect(result.selection).toBeNull();
  });

  it("normalizes negative and multiple-turn angles", () => {
    const buffer = source();
    buffer.pixels[6] = "A";
    expect(rotateImagePixelSelection(buffer, null, -90)).toEqual(rotateImagePixelSelection(buffer, null, 270));
    expect(rotateImagePixelSelection(buffer, null, 450)).toEqual(rotateImagePixelSelection(buffer, null, 90));
  });

  it("does not rotate any pixels for an empty selection", () => {
    const buffer = source();
    buffer.pixels[6] = "untouched";
    const result = rotateImagePixelSelection(buffer, { x: 1, y: 1, width: 0, height: 0 }, 45);
    expect(result.pixels).toEqual(buffer.pixels);
    expect(result.selection).toBeNull();
  });

  it("derives the pivot from the tight mask, or the full canvas without a selection", () => {
    expect(getPixelRotationPivot({ width: 5, height: 5 }, irregularSelection([
      { x: 1, y: 1 }, { x: 3, y: 2 },
    ]))).toEqual({ x: 2.5, y: 2 });
    expect(getPixelRotationPivot({ width: 8, height: 6 }, null)).toEqual({ x: 4, y: 3 });
  });

  it("returns the original pixels when a preview is dragged back to zero", () => {
    const buffer = source();
    buffer.pixels[6] = "A";
    const selection = irregularSelection([{ x: 1, y: 1 }, { x: 3, y: 3 }]);
    rotateImagePixelSelection(buffer, selection, 43);
    const result = rotateImagePixelSelection(buffer, selection, 0);
    expect(result.pixels).toEqual(buffer.pixels);
    expect(result.selection).toEqual(selection);
    expect(result.selection?.mask?.data).not.toBe(selection.mask!.data);
  });

  it("keeps the center hole of a ring at an oblique angle", () => {
    const buffer = source();
    const selection = irregularSelection([
      { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 },
      { x: 1, y: 2 }, { x: 3, y: 2 },
      { x: 1, y: 3 }, { x: 2, y: 3 }, { x: 3, y: 3 },
    ]);
    buffer.pixels[12] = "hole";
    const result = rotateImagePixelSelection(buffer, selection, 45);
    expect(result.selection?.mask?.data[12]).toBe(0);
    expect(result.pixels[12]).toBe("hole");
  });
});

describe("pixel rotation drag angles", () => {
  it("crosses the signed angle boundary without jumping", () => {
    expect(getPixelRotationDelta(179, -179)).toBe(2);
    expect(getPixelRotationDelta(-179, 179)).toBe(-2);
    expect(getPixelRotationDelta(10, 45)).toBe(35);
  });
  it("snaps both directions to 15-degree steps only when requested", () => {
    expect(snapPixelRotationDegrees(23.25, false)).toBe(23.25);
    expect(snapPixelRotationDegrees(23.25, true)).toBe(30);
    expect(snapPixelRotationDegrees(-23.25, true)).toBe(-30);
  });
});
