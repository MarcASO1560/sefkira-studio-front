import type { ImageTool, PixelLayer } from "../types";

export type ImageLayerPixelState = Pick<PixelLayer, "locked" | "visible">;
export type ImageLayerDropPosition = "before" | "after";

const IMAGE_PIXEL_MUTATION_TOOLS: ReadonlySet<ImageTool> = new Set([
  "pencil",
  "graffiti",
  "erase",
  "fill",
  "line",
  "rectangle",
  "ellipse",
  "move",
  "rotate",
]);

export const isImagePixelMutationTool = (tool: ImageTool) =>
  IMAGE_PIXEL_MUTATION_TOOLS.has(tool);

/**
 * Pixel-producing tools may only mutate a layer that the user can currently see.
 *
 * Layer-panel actions deliberately do not use this guard: a hidden layer must
 * remain selectable so the user can make it visible again.
 */
export const canMutateImageLayerPixels = (
  layer: ImageLayerPixelState | null | undefined,
): boolean => Boolean(layer?.visible && !layer.locked);

/**
 * Undo and redo restore document content, but the selected layer is editor UI
 * state. Keep the layer the user is currently working in whenever it still
 * exists; only fall back to snapshot context when a history step removes it.
 */
export const resolveImageActiveLayerAfterHistory = (
  layers: ReadonlyArray<Pick<PixelLayer, "id">>,
  currentActiveLayerId: string,
  snapshotActiveLayerId: string,
): string => {
  if (layers.some((layer) => layer.id === currentActiveLayerId)) {
    return currentActiveLayerId;
  }
  if (layers.some((layer) => layer.id === snapshotActiveLayerId)) {
    return snapshotActiveLayerId;
  }
  return layers[layers.length - 1]?.id || "";
};

/**
 * Reorders bottom-to-top document layers from a drop described in the
 * top-to-bottom order shown by the layer panel.
 */
export const reorderImageLayersByDisplayDrop = (
  layers: PixelLayer[],
  draggedLayerId: string,
  targetLayerId: string,
  position: ImageLayerDropPosition,
): PixelLayer[] => {
  if (draggedLayerId === targetLayerId) return layers;

  const displayedLayers = [...layers].reverse();
  const draggedIndex = displayedLayers.findIndex((layer) => layer.id === draggedLayerId);
  if (draggedIndex < 0) return layers;

  const [draggedLayer] = displayedLayers.splice(draggedIndex, 1);
  const targetIndex = displayedLayers.findIndex((layer) => layer.id === targetLayerId);
  if (!draggedLayer || targetIndex < 0) return layers;

  displayedLayers.splice(targetIndex + (position === "after" ? 1 : 0), 0, draggedLayer);
  const reorderedLayers = displayedLayers.reverse();
  return reorderedLayers.every((layer, index) => layer === layers[index])
    ? layers
    : reorderedLayers;
};
