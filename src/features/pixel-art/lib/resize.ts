import { clampImageDimension, clonePixelArtDocument, isValidImageDimensions, MAX_IMAGE_PIXEL_COUNT, MAX_IMAGE_DOCUMENT_PIXELS } from "./document";
import type { ImageResizeAnchor, PixelArtDocumentV2, PixelColor } from "../types";
import { hasNormalizedPixelArray, registerNormalizedPixelArray } from "./pixelBufferTrust";

const anchorAlignment = (anchor: ImageResizeAnchor) => {
  const [vertical, horizontal] = anchor.includes("-") ? anchor.split("-") : [anchor, anchor];
  const row = vertical === "top" ? 0 : vertical === "bottom" ? 1 : 0.5;
  const column = horizontal === "left" ? 0 : horizontal === "right" ? 1 : 0.5;

  if (anchor === "left" || anchor === "right") {
    return { row: 0.5, column: anchor === "left" ? 0 : 1 };
  }
  if (anchor === "top" || anchor === "bottom") {
    return { row: anchor === "top" ? 0 : 1, column: 0.5 };
  }
  if (anchor === "center") {
    return { row: 0.5, column: 0.5 };
  }

  return { row, column };
};
const resizeOffset = (previousSize: number, nextSize: number, alignment: number) =>
  Math.round((nextSize - previousSize) * alignment);

export const resizePixelArray = (
  pixels: PixelColor[],
  previousWidth: number,
  previousHeight: number,
  nextWidth: number,
  nextHeight: number,
  anchor: ImageResizeAnchor,
) => {
  if (!isValidImageDimensions(nextWidth, nextHeight)) throw new RangeError(`Images may contain at most ${MAX_IMAGE_PIXEL_COUNT} pixels.`);
  const nextPixels: PixelColor[] = Array(nextWidth * nextHeight).fill(null);
  const alignment = anchorAlignment(anchor);
  const rowOffset = resizeOffset(previousHeight, nextHeight, alignment.row);
  const columnOffset = resizeOffset(previousWidth, nextWidth, alignment.column);

  for (let row = 0; row < previousHeight; row += 1) {
    const nextRow = row + rowOffset;
    if (nextRow < 0 || nextRow >= nextHeight) continue;

    for (let column = 0; column < previousWidth; column += 1) {
      const nextColumn = column + columnOffset;
      if (nextColumn < 0 || nextColumn >= nextWidth) continue;
      nextPixels[nextRow * nextWidth + nextColumn] =
        pixels[row * previousWidth + column] ?? null;
    }
  }

  return hasNormalizedPixelArray(pixels) ? registerNormalizedPixelArray(nextPixels) : nextPixels;
};

export const resizePixelArtDocument = (
  source: PixelArtDocumentV2,
  width: number,
  height: number,
  anchor: ImageResizeAnchor,
) => {
  const nextWidth = clampImageDimension(width, source.width);
  const nextHeight = clampImageDimension(height, source.height);
  if (!isValidImageDimensions(nextWidth, nextHeight)) throw new RangeError(`Images may contain at most ${MAX_IMAGE_PIXEL_COUNT} pixels.`);
  if (nextWidth * nextHeight * source.layers.length > MAX_IMAGE_DOCUMENT_PIXELS) throw new RangeError(`Images may contain at most ${MAX_IMAGE_DOCUMENT_PIXELS} layer pixels.`);
  if (nextWidth === source.width && nextHeight === source.height) {
    return clonePixelArtDocument(source);
  }

  return {
    ...source,
    palette: [...source.palette],
    width: nextWidth,
    height: nextHeight,
    layers: source.layers.map((layer) => ({
      ...layer,
      pixels: resizePixelArray(
        layer.pixels,
        source.width,
        source.height,
        nextWidth,
        nextHeight,
        anchor,
      ),
    })),
  } satisfies PixelArtDocumentV2;
};
