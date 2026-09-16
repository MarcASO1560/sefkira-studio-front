import type { ImageSelection, PixelColor } from "../types";
import {
  createPixelSelectionMask,
  createRectangleSelectionMask,
  type PixelSelectionDimensions,
  type PixelSelectionPoint,
  type PixelSelectionSource,
} from "./selectionMask";

const selectionMask = (dimensions: PixelSelectionDimensions, selection: ImageSelection) =>
  selection.width <= 0 || selection.height <= 0
    ? createPixelSelectionMask(dimensions)
    : selection.mask?.width === dimensions.width &&
  selection.mask.height === dimensions.height &&
  selection.mask.data.length === dimensions.width * dimensions.height
    ? createPixelSelectionMask(dimensions, selection.mask.data)
    : createRectangleSelectionMask(
        { x: selection.x, y: selection.y },
        { x: selection.x + selection.width - 1, y: selection.y + selection.height - 1 },
        dimensions,
      );

export const getPixelRotationPivot = (
  dimensions: PixelSelectionDimensions,
  selection: ImageSelection | null,
): PixelSelectionPoint => {
  const bounds = selection ? selectionMask(dimensions, selection).bounds : null;
  return bounds
    ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
    : { x: dimensions.width / 2, y: dimensions.height / 2 };
};

/** Signed incremental turn, including crossing the -180/180 degree boundary. */
export const getPixelRotationDelta = (previous: number, next: number) =>
  ((next - previous + 540) % 360) - 180;

export const snapPixelRotationDegrees = (degrees: number, snap: boolean) =>
  snap ? Math.round(degrees / 15) * 15 : degrees;

/** Rotate from an immutable source, sampling pixel centers without interpolation.
 * Destination pixels outside the canvas are clipped. Transparent selected pixels
 * do not erase unrelated destination pixels, matching the Move tool.
 */
export const rotateImagePixelSelection = (
  source: PixelSelectionSource,
  selection: ImageSelection | null,
  degrees: number,
): { pixels: PixelColor[]; selection: ImageSelection | null } => {
  const pixels = [...source.pixels];
  const normalized = Number.isFinite(degrees) ? ((degrees % 360) + 360) % 360 : 0;
  if (normalized === 0) {
    return {
      pixels,
      selection: selection
        ? { ...selection, ...(selection.mask ? { mask: { ...selection.mask, data: selection.mask.data.slice() } } : {}) }
        : null,
    };
  }
  const mask = selection
    ? selectionMask(source, selection)
    : createPixelSelectionMask(source, new Uint8Array(source.width * source.height).fill(1));
  if (!mask.bounds) return { pixels, selection: null };
  const pivot = getPixelRotationPivot(source, selection);
  const radians = normalized * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const rotatedMask = new Uint8Array(mask.data.length);
  for (let index = 0; index < mask.data.length; index += 1) {
    if (mask.data[index]) pixels[index] = null;
  }
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const dx = x + 0.5 - pivot.x;
      const dy = y + 0.5 - pivot.y;
      // The epsilon makes exact quarter turns stable at cell boundaries.
      const sourceX = Math.floor(pivot.x + cosine * dx + sine * dy + 1e-9);
      const sourceY = Math.floor(pivot.y - sine * dx + cosine * dy + 1e-9);
      if (sourceX < 0 || sourceX >= source.width || sourceY < 0 || sourceY >= source.height) continue;
      const sourceIndex = sourceY * source.width + sourceX;
      if (!mask.data[sourceIndex]) continue;
      const index = y * source.width + x;
      rotatedMask[index] = 1;
      const color = source.pixels[sourceIndex];
      if (color != null) pixels[index] = color;
    }
  }
  const resultMask = createPixelSelectionMask(source, rotatedMask);
  return {
    pixels,
    selection: selection && resultMask.bounds
      ? {
          ...resultMask.bounds,
          kind: selection.kind,
          mask: { width: source.width, height: source.height, data: resultMask.data },
        }
      : null,
  };
};
