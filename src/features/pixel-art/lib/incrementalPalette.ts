import type { PixelColor, PixelLayer } from "../types";
import { normalizePixelColor } from "./document";

type PaletteLayer = Readonly<Pick<PixelLayer, "id" | "pixels">>;
type PalettePixelChange = Readonly<{ index: number; before?: PixelColor; after: PixelColor }>;
type ColorUsage = { count: number; firstIndex: number };
type LayerIndex = {
  pixels: readonly PixelColor[];
  colors: Map<string, ColorUsage>;
  orderedColors: string[];
  dirty: boolean;
};

const cachedNormalizer = () => {
  const cache = new Map<PixelColor | undefined, PixelColor>();
  return (raw: PixelColor | undefined) => {
    if (!cache.has(raw)) cache.set(raw, normalizePixelColor(raw));
    return cache.get(raw)!;
  };
};

const createLayerIndex = (pixels: readonly PixelColor[]): LayerIndex => {
  const colors = new Map<string, ColorUsage>();
  const normalize = cachedNormalizer();
  for (let index = 0; index < pixels.length; index += 1) {
    const color = normalize(pixels[index]);
    if (!color) continue;
    let usage = colors.get(color);
    if (!usage) colors.set(color, usage = { count: 0, firstIndex: index });
    usage.count += 1;
  }
  return { pixels, colors, orderedColors: [...colors.keys()], dirty: false };
};

/**
 * Palette indexing for immutable editor pixel buffers. Derivation preserves
 * layer order and each color's first pixel occurrence, including hidden layers.
 *
 * registerMutation is ONLY for complete, trusted local mutations (brush and
 * graffiti). Do not pass partial broadcasts or untrusted/imported snapshots:
 * derive handles arbitrary replacement buffers with a fresh scan instead.
 * Untouched indices are intentionally not scanned to validate a trusted delta.
 */
export const createIncrementalUsedPaletteColors = () => {
  // Retain only the current buffers by layer id, never an unbounded history of
  // old pixel arrays or color-position indexes.
  const layersById = new Map<string, LayerIndex>();

  const derive = (layers: readonly PaletteLayer[]): string[] => {
    const present = new Set<string>();
    const seen = new Set<string>();
    const colors: string[] = [];
    for (const layer of layers) {
      present.add(layer.id);
      let indexed = layersById.get(layer.id);
      if (!indexed || indexed.pixels !== layer.pixels) {
        indexed = createLayerIndex(layer.pixels);
        layersById.set(layer.id, indexed);
      }
      if (indexed.dirty) {
        indexed.orderedColors = [...indexed.colors]
          .map(([color, usage]) => ({ color, firstIndex: usage.firstIndex }))
          .sort((left, right) => left.firstIndex - right.firstIndex)
          .map(({ color }) => color);
        indexed.dirty = false;
      }
      for (const color of indexed.orderedColors) {
        if (seen.has(color)) continue;
        seen.add(color);
        colors.push(color);
      }
    }
    for (const layerId of layersById.keys()) {
      if (!present.has(layerId)) layersById.delete(layerId);
    }
    return colors;
  };

  const registerMutation = ({
    layerId,
    previousPixels,
    nextPixels,
    changes,
  }: {
    layerId: string;
    previousPixels: readonly PixelColor[];
    nextPixels: readonly PixelColor[];
    changes: readonly PalettePixelChange[];
  }): boolean => {
    const indexed = layersById.get(layerId);
    if (!indexed || indexed.pixels !== previousPixels || previousPixels.length !== nextPixels.length ||
      !changes.length || previousPixels === nextPixels) return false;

    // Validate the whole supplied delta before changing the index. Duplicate
    // indices keep the original before value and the last after value.
    const unique = new Map<number, { before: PixelColor; after: PixelColor }>();
    for (const change of changes) {
      if (!Number.isSafeInteger(change.index) || change.index < 0 || change.index >= previousPixels.length) return false;
      const existing = unique.get(change.index);
      const actualBefore = normalizePixelColor(previousPixels[change.index]);
      if (!existing && change.before !== undefined && normalizePixelColor(change.before) !== actualBefore) return false;
      unique.set(change.index, { before: existing?.before ?? actualBefore, after: normalizePixelColor(change.after) });
    }
    const refreshFirstOccurrence = new Set<string>();
    for (const [index, change] of unique) {
      if (normalizePixelColor(nextPixels[index]) !== change.after) return false;
    }

    for (const [index, change] of unique) {
      if (change.before === change.after) continue;
      if (change.before) {
        const usage = indexed.colors.get(change.before)!;
        usage.count -= 1;
        if (usage.firstIndex === index) refreshFirstOccurrence.add(change.before);
        if (!usage.count) indexed.colors.delete(change.before);
      }
      if (change.after) {
        let usage = indexed.colors.get(change.after);
        if (!usage) indexed.colors.set(change.after, usage = { count: 0, firstIndex: index });
        usage.count += 1;
        usage.firstIndex = Math.min(usage.firstIndex, index);
      }
      indexed.dirty = true;
    }
    // Keep O(colors), not one Set entry plus heap entry per painted pixel.
    // Only erasing a color's first occurrence needs a forward scan. Common
    // dense colors find their next pixel immediately; deleting the last
    // occurrence needs no scan, and normal brush updates remain O(changes).
    const normalize = cachedNormalizer();
    for (const color of refreshFirstOccurrence) {
      const usage = indexed.colors.get(color);
      if (!usage || normalize(nextPixels[usage.firstIndex]) === color) continue;
      for (let index = usage.firstIndex + 1; index < nextPixels.length; index += 1) {
        if (normalize(nextPixels[index]) !== color) continue;
        usage.firstIndex = index;
        break;
      }
    }
    indexed.pixels = nextPixels;
    return true;
  };

  return { derive, registerMutation, clear: () => layersById.clear() };
};
