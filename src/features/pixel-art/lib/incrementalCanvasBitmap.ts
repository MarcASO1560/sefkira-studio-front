import type { PixelArtDocumentV2, PixelColor, PixelLayer } from "../types";
import { blendPixelColors, compositeVisibleLayers, isValidImageDimensions, normalizePixelColor } from "./document";
import { writeImageCanvasBitmapPixels } from "./canvasRendering";

type Mutation = {
  before: readonly PixelColor[];
  after: readonly PixelColor[];
  indexes: Set<number>;
};
type LayerSnapshot = Pick<PixelLayer, "id" | "name" | "visible" | "locked" | "opacity"> & {
  pixels: readonly PixelColor[];
};
type BitmapSnapshot = {
  width: number;
  height: number;
  background: PixelColor;
  target: Uint8ClampedArray;
  layers: LayerSnapshot[];
};

const snapshot = (document: PixelArtDocumentV2, background: PixelColor, target: Uint8ClampedArray): BitmapSnapshot => ({
  width: document.width,
  height: document.height,
  background,
  target,
  layers: document.layers.map(({ id, name, visible, locked, opacity, pixels }) => ({ id, name, visible, locked, opacity, pixels })),
});

const sameMetadata = (left: LayerSnapshot, right: PixelLayer) =>
  left.id === right.id && left.name === right.name && left.visible === right.visible &&
  left.locked === right.locked && left.opacity === right.opacity;

/**
 * Render-only cache for immutable, validated documents and a caller-owned bitmap.
 * Register ONLY complete trusted brush/graffiti deltas. Unknown buffers, remote
 * preview arrays, structural edits and broken delta chains always get a full
 * render. The target must not be modified externally between writes.
 */
export const createIncrementalImageCanvasBitmap = () => {
  let previous: BitmapSnapshot | null = null;
  let forceFull = false;
  const pending = new Map<string, Mutation>();

  const invalidatePending = () => {
    forceFull = true;
    pending.clear();
  };

  const registerMutation = ({ layerId, previousPixels, nextPixels, changes }: {
    layerId: string;
    previousPixels: readonly PixelColor[];
    nextPixels: readonly PixelColor[];
    changes: readonly Readonly<{ index: number; before?: PixelColor; after: PixelColor }>[];
  }): void => {
    if (!layerId || previousPixels === nextPixels || previousPixels.length !== nextPixels.length || !changes.length) {
      invalidatePending();
      return;
    }
    const existing = pending.get(layerId);
    if (existing && existing.after !== previousPixels) {
      invalidatePending();
      return;
    }
    const unique = new Map<number, { before: PixelColor; after: PixelColor }>();
    for (const change of changes) {
      if (!Number.isSafeInteger(change.index) || change.index < 0 || change.index >= nextPixels.length) {
        invalidatePending();
        return;
      }
      const prior = unique.get(change.index);
      const before = normalizePixelColor(previousPixels[change.index]);
      if (!prior && change.before !== undefined && normalizePixelColor(change.before) !== before) {
        invalidatePending();
        return;
      }
      unique.set(change.index, { before: prior?.before ?? before, after: normalizePixelColor(change.after) });
    }
    for (const [index, change] of unique) {
      if (normalizePixelColor(nextPixels[index]) !== change.after) {
        invalidatePending();
        return;
      }
    }
    const mutation = existing ?? { before: previousPixels, after: nextPixels, indexes: new Set<number>() };
    mutation.after = nextPixels;
    for (const index of unique.keys()) mutation.indexes.add(index);
    pending.set(layerId, mutation);
  };

  const write = (document: PixelArtDocumentV2, background: PixelColor, target: Uint8ClampedArray): void => {
    const pixelCount = document.width * document.height;
    if (!isValidImageDimensions(document.width, document.height) || target.length !== pixelCount * 4) {
      throw new RangeError("The display bitmap must match a supported logical canvas resolution.");
    }
    let incremental = !forceFull && previous !== null && previous.width === document.width &&
      previous.height === document.height && previous.background === background && previous.target === target &&
      previous.layers.length === document.layers.length;
    const dirty = new Set<number>();
    if (incremental) {
      const presentLayers = new Set<string>();
      for (let index = 0; index < document.layers.length; index += 1) {
        const layer = document.layers[index]!;
        const cached = previous!.layers[index]!;
        presentLayers.add(layer.id);
        const mutation = pending.get(layer.id);
        if (!sameMetadata(cached, layer) || (mutation &&
          (mutation.before !== cached.pixels || mutation.after !== layer.pixels)) ||
          (cached.pixels !== layer.pixels && !mutation)) {
          incremental = false;
          break;
        }
        if (mutation) for (const pixelIndex of mutation.indexes) dirty.add(pixelIndex);
      }
      if (incremental && [...pending.keys()].some((id) => !presentLayers.has(id))) incremental = false;
      // Whole-frame composition has palette caches and is cheaper than doing
      // thousands of independent HEX blends for a bulk mutation.
      const maximumDirty = Math.max(1, Math.min(4096, Math.floor(pixelCount / 128)));
      if (dirty.size > maximumDirty) incremental = false;
    }

    if (!incremental) {
      writeImageCanvasBitmapPixels(compositeVisibleLayers(document), background, target);
    } else if (dirty.size) {
      const indexes = [...dirty];
      const colors: PixelColor[] = Array(indexes.length);
      for (let index = 0; index < indexes.length; index += 1) {
        let color: PixelColor = null;
        for (const layer of document.layers) {
          if (!layer.visible || layer.opacity <= 0) continue;
          // Preserve the original per-layer HEX round trips, including alpha
          // quantization. Never flatten visible ink into the actual document.
          color = blendPixelColors(color, layer.pixels[indexes[index]!], layer.opacity);
        }
        colors[index] = color;
      }
      const bytes = new Uint8ClampedArray(indexes.length * 4);
      writeImageCanvasBitmapPixels(colors, background, bytes);
      for (let index = 0; index < indexes.length; index += 1) {
        const source = index * 4;
        const destination = indexes[index]! * 4;
        target[destination] = bytes[source]!;
        target[destination + 1] = bytes[source + 1]!;
        target[destination + 2] = bytes[source + 2]!;
        target[destination + 3] = bytes[source + 3]!;
      }
    }

    // Release all intermediate stroke arrays. Only the last displayed buffers
    // are retained, and palette-only/container changes do not invalidate ink.
    previous = snapshot(document, background, target);
    pending.clear();
    forceFull = false;
  };

  const clear = () => {
    previous = null;
    forceFull = false;
    pending.clear();
  };
  return { registerMutation, write, clear };
};
