import { describe, expect, it } from "vitest";

import type { PixelColor, PixelLayer } from "../types";
import { createIncrementalUsedPaletteColors } from "./incrementalPalette";
import { deriveUsedPaletteColors } from "./palette";

const layer = (id: string, pixels: PixelColor[]): PixelLayer => ({
  id, name: id, pixels, visible: true, locked: false, opacity: 1,
});

describe("createIncrementalUsedPaletteColors", () => {
  it("derives every stored color with the same normalization and stable order", () => {
    const layers = [layer("a", [null, "#aabbcc", "invalid", "#AABBCC", "#AABBCCFF"]),
      layer("b", ["#12345680", "#aabbcc", "#abcdef"])];
    const palette = createIncrementalUsedPaletteColors();
    expect(palette.derive(layers)).toEqual(deriveUsedPaletteColors(layers));
    expect(palette.derive(layers)).toEqual(["#AABBCC", "#AABBCCFF", "#12345680", "#ABCDEF"]);
  });

  it("updates before the outer layer assignment for a complete brush mutation", () => {
    const palette = createIncrementalUsedPaletteColors();
    const previous = [null, "#112233", null];
    palette.derive([layer("a", previous)]);
    const next = ["#ABCDEF", "#112233", null];
    expect(palette.registerMutation({
      layerId: "a", previousPixels: previous, nextPixels: next,
      changes: [{ index: 0, before: null, after: "#ABCDEF" }],
    })).toBe(true);
    expect(palette.derive([layer("a", next)])).toEqual(["#ABCDEF", "#112233"]);
  });

  it("supports graffiti deltas without before values", () => {
    const palette = createIncrementalUsedPaletteColors();
    const previous = ["#AAAAAA", "#BBBBBB", null];
    palette.derive([layer("a", previous)]);
    const next = ["#FFFFFF", "#000000", null];
    expect(palette.registerMutation({ layerId: "a", previousPixels: previous, nextPixels: next,
      changes: [{ index: 0, after: "#FFFFFF" }, { index: 1, after: "#000000" }] })).toBe(true);
    expect(palette.derive([layer("a", next)])).toEqual(deriveUsedPaletteColors([layer("a", next)]));
  });

  it("uses the last duplicate after value and the original before value", () => {
    const palette = createIncrementalUsedPaletteColors();
    const previous = [null, "#AAAAAA"];
    palette.derive([layer("a", previous)]);
    const next = ["#BBBBBB", "#CCCCCC"];
    expect(palette.registerMutation({ layerId: "a", previousPixels: previous, nextPixels: next,
      changes: [
        { index: 0, before: null, after: "#FFFFFF" },
        { index: 1, before: "#AAAAAA", after: "#CCCCCC" },
        { index: 0, before: "#FFFFFF", after: "#BBBBBB" },
      ] })).toBe(true);
    expect(palette.derive([layer("a", next)])).toEqual(["#BBBBBB", "#CCCCCC"]);
  });

  it("removes a color when its last pixel is erased, including across layers", () => {
    const palette = createIncrementalUsedPaletteColors();
    const previous = ["#FFFFFF", "#000000"];
    const unchanged = layer("b", ["#000000", "#FFFFFF"]);
    palette.derive([layer("a", previous), unchanged]);
    const next = [null, "#000000"];
    palette.registerMutation({ layerId: "a", previousPixels: previous, nextPixels: next,
      changes: [{ index: 0, after: null }] });
    expect(palette.derive([layer("a", next), unchanged])).toEqual(["#000000", "#FFFFFF"]);
    expect(palette.derive([layer("a", next)])).toEqual(["#000000"]);
  });

  it("moves a color's first occurrence and reorders the palette accordingly", () => {
    const palette = createIncrementalUsedPaletteColors();
    const previous = ["#FFFFFF", "#000000", "#FFFFFF", "#000000"];
    palette.derive([layer("a", previous)]);
    const next = [null, "#000000", "#FFFFFF", "#000000"];
    palette.registerMutation({ layerId: "a", previousPixels: previous, nextPixels: next,
      changes: [{ index: 0, before: "#FFFFFF", after: null }] });
    expect(palette.derive([layer("a", next)])).toEqual(["#000000", "#FFFFFF"]);
  });

  it("preserves layer reordering, hidden colors, lock and zero opacity", () => {
    const palette = createIncrementalUsedPaletteColors();
    const first = { ...layer("a", ["#FFFFFF", "#AAAAAA"]), visible: false, opacity: 0, locked: true };
    const second = layer("b", ["#000000", "#FFFFFF"]);
    expect(palette.derive([first, second])).toEqual(["#FFFFFF", "#AAAAAA", "#000000"]);
    expect(palette.derive([second, first])).toEqual(["#000000", "#FFFFFF", "#AAAAAA"]);
    expect(palette.derive([{ ...first, visible: true, opacity: 0.5 }, second]))
      .toEqual(deriveUsedPaletteColors([first, second]));
  });

  it("does not scan unchanged buffers while deriving repeatedly or updating another layer", () => {
    let reads = 0;
    const untouched = new Proxy<PixelColor[]>(["#123456", "#FFFFFF"], {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const palette = createIncrementalUsedPaletteColors();
    const previous = [null, null];
    palette.derive([layer("a", previous), layer("b", untouched)]);
    reads = 0;
    const next = ["#FFFFFF", null];
    palette.registerMutation({ layerId: "a", previousPixels: previous, nextPixels: next,
      changes: [{ index: 0, after: "#FFFFFF" }] });
    palette.derive([layer("a", next), layer("b", untouched)]);
    palette.derive([layer("b", untouched), layer("a", next)]);
    expect(reads).toBe(0);
  });

  it("reads only touched indices for a trusted complete delta at 256 × 256", () => {
    const pixels = Array<PixelColor>(65536).fill("#112233");
    let reads = 0;
    const previous = new Proxy(pixels, { get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
      return Reflect.get(target, key, receiver);
    } });
    const next = pixels.slice();
    next[50000] = "#FFFFFF";
    const palette = createIncrementalUsedPaletteColors();
    palette.derive([layer("a", previous)]);
    reads = 0;
    expect(palette.registerMutation({ layerId: "a", previousPixels: previous, nextPixels: next,
      changes: [{ index: 50000, after: "#FFFFFF" }] })).toBe(true);
    expect(palette.derive([layer("a", next)])).toEqual(["#112233", "#FFFFFF"]);
    expect(reads).toBe(1);
  });

  it.each([-1, 3, 0.5, Number.NaN])("falls back safely for an invalid index %s", (index) => {
    const palette = createIncrementalUsedPaletteColors();
    const previous = ["#AAAAAA", null, null];
    palette.derive([layer("a", previous)]);
    const next = [null, "#FFFFFF", "#000000"];
    expect(palette.registerMutation({ layerId: "a", previousPixels: previous, nextPixels: next,
      changes: [{ index, after: "#FFFFFF" }] })).toBe(false);
    expect(palette.derive([layer("a", next)])).toEqual(deriveUsedPaletteColors([layer("a", next)]));
  });

  it("rejects the whole delta before updating when a before/after guard fails", () => {
    const palette = createIncrementalUsedPaletteColors();
    const previous = ["#AAAAAA", "#BBBBBB"];
    palette.derive([layer("a", previous)]);
    const next = ["#FFFFFF", "#000000"];
    expect(palette.registerMutation({ layerId: "a", previousPixels: previous, nextPixels: next,
      changes: [{ index: 0, before: "#CCCCCC", after: "#FFFFFF" }] })).toBe(false);
    expect(palette.registerMutation({ layerId: "a", previousPixels: previous, nextPixels: next,
      changes: [{ index: 0, after: "#FFFFFF" }, { index: 1, after: "#FFFF00" }] })).toBe(false);
    expect(palette.derive([layer("a", previous)])).toEqual(["#AAAAAA", "#BBBBBB"]);
    expect(palette.derive([layer("a", next)])).toEqual(["#FFFFFF", "#000000"]);
  });

  it("falls back on unknown ids, buffer identity, resolution changes and unknown replacement deltas", () => {
    const palette = createIncrementalUsedPaletteColors();
    const previous = ["#FFFFFF", null];
    palette.derive([layer("a", previous)]);
    const next = ["#000000", null];
    expect(palette.registerMutation({ layerId: "unknown", previousPixels: previous, nextPixels: next,
      changes: [{ index: 0, after: "#000000" }] })).toBe(false);
    expect(palette.registerMutation({ layerId: "a", previousPixels: previous.slice(), nextPixels: next,
      changes: [{ index: 0, after: "#000000" }] })).toBe(false);
    expect(palette.registerMutation({ layerId: "a", previousPixels: previous, nextPixels: ["#000000"],
      changes: [{ index: 0, after: "#000000" }] })).toBe(false);
    expect(palette.registerMutation({ layerId: "a", previousPixels: previous, nextPixels: next, changes: [] })).toBe(false);
    expect(palette.derive([layer("a", next)])).toEqual(["#000000"]);
  });

  it("handles Undo, remote replacement, import and subsequent brush deltas", () => {
    const palette = createIncrementalUsedPaletteColors();
    const original = ["#FFFFFF", "#000000", null];
    palette.derive([layer("a", original)]);
    const edited = ["#AAAAAA", "#000000", null];
    palette.registerMutation({ layerId: "a", previousPixels: original, nextPixels: edited,
      changes: [{ index: 0, after: "#AAAAAA" }] });
    expect(palette.derive([layer("a", edited)])).toEqual(["#AAAAAA", "#000000"]);
    expect(palette.derive([layer("a", original)])).toEqual(["#FFFFFF", "#000000"]);
    const imported: PixelColor[] = ["#12345680", "#654321", "#654321"];
    expect(palette.derive([layer("a", imported)])).toEqual(["#12345680", "#654321"]);
    const next = imported.slice();
    next[0] = null;
    expect(palette.registerMutation({ layerId: "a", previousPixels: imported, nextPixels: next,
      changes: [{ index: 0, after: null }] })).toBe(true);
    expect(palette.derive([layer("a", next)])).toEqual(["#654321"]);
  });

  it("clears deleted layers and does not mutate frozen inputs or previous palette results", () => {
    const palette = createIncrementalUsedPaletteColors();
    const previous = ["#FFFFFF", "#000000"];
    Object.freeze(previous);
    const firstResult = palette.derive([layer("a", previous)]);
    const next = [null, "#000000"];
    Object.freeze(next);
    const changes = Object.freeze([{ index: 0, before: "#FFFFFF", after: null }]);
    palette.registerMutation({ layerId: "a", previousPixels: previous, nextPixels: next, changes });
    expect(palette.derive([layer("a", next)])).toEqual(["#000000"]);
    expect(firstResult).toEqual(["#FFFFFF", "#000000"]);
    expect(previous).toEqual(["#FFFFFF", "#000000"]);
    palette.derive([]);
    expect(palette.registerMutation({ layerId: "a", previousPixels: next, nextPixels: previous,
      changes: [{ index: 0, after: "#FFFFFF" }] })).toBe(false);
    palette.clear();
    expect(palette.derive([layer("a", previous)])).toEqual(firstResult);
  });

  it("keeps long remove/re-add strokes and changing first occurrences correct", () => {
    const palette = createIncrementalUsedPaletteColors();
    const colors: PixelColor[] = [null, "#FFFFFF", "#000000", "#12345680"];
    let pixels = Array.from({ length: 128 }, (_, index) => colors[index % colors.length]!);
    palette.derive([layer("a", pixels)]);
    for (let step = 0; step < 20000; step += 1) {
      const index = (step * 17) % pixels.length;
      const next = pixels.slice();
      next[index] = colors[(Math.floor(step / pixels.length) + step + 1) % colors.length]!;
      expect(palette.registerMutation({ layerId: "a", previousPixels: pixels, nextPixels: next,
        changes: [{ index, before: pixels[index]!, after: next[index]! }] })).toBe(true);
      pixels = next;
      if (step % 127 === 0) {
        expect(palette.derive([layer("a", pixels)])).toEqual(deriveUsedPaletteColors([layer("a", pixels)]));
      }
    }
    expect(palette.derive([layer("a", pixels)])).toEqual(deriveUsedPaletteColors([layer("a", pixels)]));
  });
});
