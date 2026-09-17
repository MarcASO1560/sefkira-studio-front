import { describe, expect, it } from "vitest";

import {
  blendPixelColors,
  compositeVisibleLayers,
  createPixelArtDocument,
  normalizePalette,
  normalizePixelColor,
} from "./document";
import type { PixelArtDocumentV2, PixelColor } from "../types";

const referenceComposite = (document: PixelArtDocumentV2) => {
  const pixels: PixelColor[] = Array(document.width * document.height).fill(null);
  for (const layer of document.layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    for (let index = 0; index < pixels.length; index += 1) {
      pixels[index] = blendPixelColors(pixels[index], layer.pixels[index], layer.opacity);
    }
  }
  return pixels;
};

describe("pixel-art document", () => {
  it("creates a valid document with one transparent layer", () => {
    const document = createPixelArtDocument(4, 3);

    expect(document.version).toBe(2);
    expect(document.layers).toHaveLength(1);
    expect(document.layers[0]?.pixels).toEqual(Array(12).fill(null));
  });

  it("preserves every supplied layer without an artificial layer cap", () => {
    const layers = Array.from({ length: 65 }, (_, index) => ({
      id: `layer-${index + 1}`,
      name: `Layer ${index + 1}`,
      visible: true,
      locked: false,
      opacity: 1,
      pixels: [null],
    }));

    expect(createPixelArtDocument(1, 1, { layers }).layers).toHaveLength(65);
  });

  it("normalizes RGB and RGBA colors and removes palette duplicates", () => {
    expect(normalizePixelColor("#aabbcc80")).toBe("#AABBCC80");
    expect(normalizePixelColor("red")).toBeNull();
    expect(normalizePalette(["#ffffff", "#FFFFFF", "bad", "#00000080"])).toEqual([
      "#FFFFFF",
      "#00000080",
    ]);
  });

  it("keeps first-occurrence order and exact RGB/RGBA deduplication for frozen mixed input", () => {
    const input = Object.freeze([
      null, " #aabbcc ", "#11223380", "#AABBCC", undefined,
      "#aabbccFF", "#11223380", "invalid", 42, "#ffffff00", "#FFFFFF00",
    ]);
    const reference: string[] = [];
    for (const entry of input) {
      const color = normalizePixelColor(entry);
      if (color && !reference.includes(color)) reference.push(color);
    }
    expect(normalizePalette(input)).toEqual(reference);
    expect(normalizePalette(input)).toEqual(["#AABBCC", "#11223380", "#AABBCCFF", "#FFFFFF00"]);
    expect(input[1]).toBe(" #aabbcc ");
    expect(normalizePalette(null)).toEqual([]);
    expect(normalizePalette({ colors: input })).toEqual([]);
  });

  it("normalizes all 65536 unique colors in stable order without a palette cap", () => {
    const unique = Array.from({ length: 65536 }, (_, index) =>
      `#${index.toString(16).padStart(6, "0").toUpperCase()}`);
    const input = Object.freeze([...unique, unique[65535]!.toLowerCase(), unique[0]!, "invalid"]);
    expect(normalizePalette(input)).toEqual(unique);
  });

  it("alpha-composites visible layers in their stored order", () => {
    const document = createPixelArtDocument(1, 1, {
      layers: [
        {
          id: "background",
          name: "Background",
          visible: true,
          locked: false,
          opacity: 1,
          pixels: ["#000000"],
        },
        {
          id: "foreground",
          name: "Foreground",
          visible: true,
          locked: false,
          opacity: 1,
          pixels: ["#FFFFFF80"],
        },
      ],
    });

    expect(blendPixelColors("#000000", "#FFFFFF80")).toBe("#808080");
    expect(compositeVisibleLayers(document)).toEqual(["#808080"]);

    document.layers[1]!.visible = false;
    expect(compositeVisibleLayers(document)).toEqual(["#000000"]);
  });

  it.each([0, 0.125, 0.5, 0.999, 1])("matches the former compositor exactly at opacity %s", (opacity) => {
    const colors: PixelColor[] = [null, "#000000", "#FFFFFF", "#CCAA12", "#12345600", "#FFFFFF01", "#abcdef80", "#112233FE", "#fedcbaFF"];
    const pixels = colors.flatMap((background) => colors.map(() => background));
    const foreground = colors.flatMap(() => colors);
    const document = createPixelArtDocument(9, 9, {
      layers: [
        { id: "base", name: "Base", visible: true, locked: false, opacity: 1, pixels },
        { id: "overlay", name: "Overlay", visible: true, locked: false, opacity, pixels: foreground },
      ],
    });
    // Include trusted but non-normalized lowercase input to cover the fast path.
    document.layers[1]!.pixels[80] = "#fedcbaFF";
    expect(compositeVisibleLayers(document)).toEqual(referenceComposite(document));
  });

  it("preserves quantized alpha across multiple visible, hidden and transparent layers", () => {
    const colors: PixelColor[] = [null, "#3A149B", "#07F18080", "#DDEEFF00", "#FFFDEFFE", "#EEEEEE01"];
    const document = createPixelArtDocument(64, 64, {
      layers: Array.from({ length: 8 }, (_, layerIndex) => ({
        id: `layer-${layerIndex}`,
        name: `Layer ${layerIndex}`,
        visible: layerIndex !== 3,
        locked: layerIndex % 2 === 0,
        opacity: [0, 0.125, 0.5, 1][layerIndex % 4]!,
        pixels: Array.from({ length: 4096 }, (_, index) => colors[(index * 17 + layerIndex) % colors.length]!),
      })),
    });
    expect(compositeVisibleLayers(document)).toEqual(referenceComposite(document));
  });

  it("does not mutate frozen document inputs and does not reuse stale palette caches", () => {
    const document = createPixelArtDocument(2, 1);
    document.layers[0]!.pixels = ["#aabbcc", "#FFFFFF80"];
    Object.freeze(document.layers[0]!.pixels);
    Object.freeze(document.layers[0]);
    Object.freeze(document.layers);
    Object.freeze(document.palette);
    Object.freeze(document);
    expect(compositeVisibleLayers(document)).toEqual(["#AABBCC", "#FFFFFF80"]);
    expect(document.layers[0]!.pixels).toEqual(["#aabbcc", "#FFFFFF80"]);

    const next = { ...document, layers: [{ ...document.layers[0]!, opacity: 0.5 }] };
    expect(compositeVisibleLayers(next)).toEqual(referenceComposite(next));
  });

  it("matches the reference for a fully populated 256 × 256 three-layer document", () => {
    const colors = ["#AA1122", "#11BB33", "#1234CC", "#F0EEDD"];
    const document = createPixelArtDocument(256, 256, {
      layers: Array.from({ length: 3 }, (_, layerIndex) => ({
        id: `layer-${layerIndex}`,
        name: `Layer ${layerIndex}`,
        visible: true,
        locked: false,
        opacity: 1,
        pixels: Array.from({ length: 65536 }, (_, index) => colors[(index + layerIndex) % colors.length]!),
      })),
    });
    expect(compositeVisibleLayers(document)).toEqual(referenceComposite(document));
  });
});
