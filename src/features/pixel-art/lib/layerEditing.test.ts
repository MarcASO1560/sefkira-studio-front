import { describe, expect, it } from "vitest";

import type { ImageTool, PixelLayer } from "../types";
import {
  canMutateImageLayerPixels,
  isImagePixelMutationTool,
  reorderImageLayersByDisplayDrop,
  resolveImageActiveLayerAfterHistory,
} from "./layerEditing";

const PIXEL_PAINTING_TOOLS: ImageTool[] = [
  "pencil",
  "erase",
  "fill",
  "graffiti",
  "line",
  "rectangle",
  "ellipse",
  "move",
  "rotate",
];

const NON_MUTATING_TOOLS: ImageTool[] = ["picker", "select"];
const makeLayer = (id: string): PixelLayer => ({
  id,
  name: id,
  visible: true,
  locked: false,
  opacity: 1,
  pixels: [],
});

describe("image layer painting policy", () => {
  it.each(PIXEL_PAINTING_TOOLS)("classifies %s as a pixel mutation tool", (tool) => {
    expect(isImagePixelMutationTool(tool)).toBe(true);
  });

  it.each(NON_MUTATING_TOOLS)("keeps %s available without pixel mutation", (tool) => {
    expect(isImagePixelMutationTool(tool)).toBe(false);
  });

  it.each(PIXEL_PAINTING_TOOLS)(
    "prevents %s from painting an invisible active layer",
    () => {
      expect(canMutateImageLayerPixels({ visible: false, locked: false })).toBe(false);
    },
  );

  it.each(PIXEL_PAINTING_TOOLS)(
    "allows %s on a visible, unlocked active layer",
    () => {
      expect(canMutateImageLayerPixels({ visible: true, locked: false })).toBe(true);
    },
  );

  it("also prevents painting a locked layer, regardless of visibility", () => {
    expect(canMutateImageLayerPixels({ visible: true, locked: true })).toBe(false);
    expect(canMutateImageLayerPixels({ visible: false, locked: true })).toBe(false);
  });

  it("fails closed when there is no active layer", () => {
    expect(canMutateImageLayerPixels(null)).toBe(false);
    expect(canMutateImageLayerPixels(undefined)).toBe(false);
  });

  it("does not require mutating a hidden layer before it can become paintable", () => {
    const layer = { visible: false, locked: false };

    expect(canMutateImageLayerPixels(layer)).toBe(false);

    // Selecting the layer and toggling its panel control remain separate actions.
    const madeVisible = { ...layer, visible: true };
    expect(canMutateImageLayerPixels(madeVisible)).toBe(true);
  });
});

describe("image layer drag ordering", () => {
  const bottomToTop = [makeLayer("bottom"), makeLayer("middle"), makeLayer("top")];

  it("moves a displayed top layer below its drop target", () => {
    expect(
      reorderImageLayersByDisplayDrop(bottomToTop, "top", "middle", "after").map(
        (layer) => layer.id,
      ),
    ).toEqual(["bottom", "top", "middle"]);
  });

  it("moves a displayed bottom layer above its drop target", () => {
    expect(
      reorderImageLayersByDisplayDrop(bottomToTop, "bottom", "middle", "before").map(
        (layer) => layer.id,
      ),
    ).toEqual(["middle", "bottom", "top"]);
  });

  it("keeps the original array when a drop does not change the order", () => {
    expect(
      reorderImageLayersByDisplayDrop(bottomToTop, "top", "middle", "before"),
    ).toBe(bottomToTop);
  });

  it("ignores missing and self-referential drop targets", () => {
    expect(
      reorderImageLayersByDisplayDrop(bottomToTop, "missing", "middle", "before"),
    ).toBe(bottomToTop);
    expect(
      reorderImageLayersByDisplayDrop(bottomToTop, "top", "top", "after"),
    ).toBe(bottomToTop);
  });
});

describe("image layer selection after history navigation", () => {
  const layers = [makeLayer("background"), makeLayer("details")];

  it("keeps the layer currently selected when undo restores an older snapshot", () => {
    expect(
      resolveImageActiveLayerAfterHistory(layers, "details", "background"),
    ).toBe("details");
  });

  it("uses the snapshot layer only when the current layer was removed", () => {
    expect(
      resolveImageActiveLayerAfterHistory([makeLayer("background")], "details", "background"),
    ).toBe("background");
  });

  it("falls back safely when neither remembered layer exists", () => {
    expect(resolveImageActiveLayerAfterHistory(layers, "missing", "also-missing")).toBe(
      "details",
    );
    expect(resolveImageActiveLayerAfterHistory([], "missing", "also-missing")).toBe("");
  });
});
