import type { PixelColor, PixelLayer } from "../types";
import { normalizePixelColor } from "./document";

type PaletteLayer = Readonly<Pick<PixelLayer, "id" | "pixels">>;
type PalettePixelChange = Readonly<{ index: number; before?: PixelColor; after: PixelColor }>;
type ColorUsage = { indexes: Set<number>; heap: number[] };
type LayerIndex = {
  pixels: readonly PixelColor[];
  colors: Map<string, ColorUsage>;
  heapEntries: number;
  orderedColors: string[];
  dirty: boolean;
};

const siftDown = (heap: number[], start: number) => {
  let index = start;
  while (index * 2 + 1 < heap.length) {
    const left = index * 2 + 1;
    const right = left + 1;
    const smallest = right < heap.length && heap[right]! < heap[left]! ? right : left;
    if (heap[index]! <= heap[smallest]!) break;
    [heap[index], heap[smallest]] = [heap[smallest]!, heap[index]!];
    index = smallest;
  }
};

const heapPush = (heap: number[], value: number) => {
  heap.push(value);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (heap[parent]! <= heap[index]!) break;
    [heap[parent], heap[index]] = [heap[index]!, heap[parent]!];
    index = parent;
  }
};

const minimumIndex = (layer: LayerIndex, usage: ColorUsage) => {
  while (usage.heap.length && !usage.indexes.has(usage.heap[0]!)) {
    const last = usage.heap.pop()!;
    layer.heapEntries -= 1;
    if (usage.heap.length) {
      usage.heap[0] = last;
      siftDown(usage.heap, 0);
    }
  }
  return usage.heap[0]!;
};

const compactHeaps = (layer: LayerIndex) => {
  // Lazy deletions (including remove/re-add of the same index) cannot grow
  // indefinitely over long strokes. Rebuilds are amortized across N updates.
  if (layer.heapEntries <= layer.pixels.length * 2 + 64) return;
  layer.heapEntries = 0;
  for (const usage of layer.colors.values()) {
    usage.heap = [...usage.indexes];
    for (let index = Math.floor(usage.heap.length / 2) - 1; index >= 0; index -= 1) {
      siftDown(usage.heap, index);
    }
    layer.heapEntries += usage.heap.length;
  }
};

const createLayerIndex = (pixels: readonly PixelColor[]): LayerIndex => {
  const colors = new Map<string, ColorUsage>();
  let heapEntries = 0;
  for (let index = 0; index < pixels.length; index += 1) {
    const color = normalizePixelColor(pixels[index]);
    if (!color) continue;
    let usage = colors.get(color);
    if (!usage) colors.set(color, usage = { indexes: new Set(), heap: [] });
    usage.indexes.add(index);
    // Initial pixel order is increasing, so this is already a valid min-heap.
    usage.heap.push(index);
    heapEntries += 1;
  }
  return { pixels, colors, heapEntries, orderedColors: [...colors.keys()], dirty: false };
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
          .map(([color, usage]) => ({ color, firstIndex: minimumIndex(indexed!, usage) }))
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
    for (const [index, change] of unique) {
      if (normalizePixelColor(nextPixels[index]) !== change.after) return false;
    }

    for (const [index, change] of unique) {
      if (change.before === change.after) continue;
      if (change.before) {
        const usage = indexed.colors.get(change.before)!;
        usage.indexes.delete(index);
        if (!usage.indexes.size) {
          indexed.heapEntries -= usage.heap.length;
          indexed.colors.delete(change.before);
        }
      }
      if (change.after) {
        let usage = indexed.colors.get(change.after);
        if (!usage) indexed.colors.set(change.after, usage = { indexes: new Set(), heap: [] });
        usage.indexes.add(index);
        heapPush(usage.heap, index);
        indexed.heapEntries += 1;
      }
      indexed.dirty = true;
    }
    indexed.pixels = nextPixels;
    compactHeaps(indexed);
    return true;
  };

  return { derive, registerMutation, clear: () => layersById.clear() };
};
