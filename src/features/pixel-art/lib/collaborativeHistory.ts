import { clonePixelArtDocument } from "./document";
import { deriveUsedPaletteColors } from "./palette";
import type { PixelArtDocumentV2, PixelLayer } from "../types";

/** External edits must survive local undo/redo; our acknowledged edits are already in the overlay. */
export const rebaseImageHistoryDocument = (
  snapshot: PixelArtDocumentV2,
  previousOverlay: PixelArtDocumentV2,
  nextOverlay: PixelArtDocumentV2,
): PixelArtDocumentV2 => {
  if (
    snapshot.width !== nextOverlay.width || snapshot.height !== nextOverlay.height ||
    previousOverlay.width !== nextOverlay.width || previousOverlay.height !== nextOverlay.height
  ) return clonePixelArtDocument(nextOverlay);

  const before = new Map(previousOverlay.layers.map((layer) => [layer.id, layer]));
  const after = new Map(nextOverlay.layers.map((layer) => [layer.id, layer]));
  let layers: PixelLayer[] = snapshot.layers
    .filter((layer) => !before.has(layer.id) || after.has(layer.id))
    .map((layer) => {
      const oldLayer = before.get(layer.id);
      const newLayer = after.get(layer.id);
      if (!oldLayer || !newLayer) return layer;
      const pixels = [...layer.pixels];
      for (let index = 0; index < pixels.length; index += 1) {
        if (oldLayer.pixels[index] !== newLayer.pixels[index]) pixels[index] = newLayer.pixels[index] ?? null;
      }
      return {
        ...layer,
        name: oldLayer.name !== newLayer.name ? newLayer.name : layer.name,
        visible: oldLayer.visible !== newLayer.visible ? newLayer.visible : layer.visible,
        locked: oldLayer.locked !== newLayer.locked ? newLayer.locked : layer.locked,
        opacity: oldLayer.opacity !== newLayer.opacity ? newLayer.opacity : layer.opacity,
        pixels,
      };
    });

  for (const [index, layer] of nextOverlay.layers.entries()) {
    if (layers.some((candidate) => candidate.id === layer.id)) continue;
    const oldLayer = before.get(layer.id);
    if (oldLayer && oldLayer.name === layer.name && oldLayer.visible === layer.visible &&
      oldLayer.locked === layer.locked && oldLayer.opacity === layer.opacity &&
      oldLayer.pixels.every((pixel, pixelIndex) => pixel === layer.pixels[pixelIndex])) continue;
    // An external edit on our new layer makes it shared work. Undoing its
    // creation must no longer remove that layer from an older snapshot.
    const precedingIds = new Set(nextOverlay.layers.slice(0, index).map((candidate) => candidate.id));
    let insertionIndex = 0;
    for (const [candidateIndex, candidate] of layers.entries()) {
      if (precedingIds.has(candidate.id)) insertionIndex = candidateIndex + 1;
    }
    layers.splice(insertionIndex, 0, { ...layer, pixels: [...layer.pixels] });
  }

  const oldOrder = previousOverlay.layers.filter((layer) => after.has(layer.id)).map((layer) => layer.id);
  const newOrder = nextOverlay.layers.filter((layer) => before.has(layer.id)).map((layer) => layer.id);
  if (oldOrder.join("\0") !== newOrder.join("\0")) {
    const order = new Map(nextOverlay.layers.map((layer, index) => [layer.id, index]));
    const sortedKnown = layers.filter((layer) => order.has(layer.id)).sort(
      (left, right) => order.get(left.id)! - order.get(right.id)!,
    );
    let index = 0;
    layers = layers.map((layer) => order.has(layer.id) ? sortedKnown[index++]! : layer);
  }
  if (layers.length === 0) return clonePixelArtDocument(nextOverlay);
  return { ...snapshot, palette: deriveUsedPaletteColors(layers), layers };
};
