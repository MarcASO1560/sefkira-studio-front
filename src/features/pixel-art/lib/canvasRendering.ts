import type { PixelColor } from "../types";

export type ImageCanvasRenderPlan = {
  bitmapHeight: number;
  bitmapWidth: number;
  cellSize: number;
  cellStride: number;
  cssHeight: number;
  cssWidth: number;
};

export const createImageCanvasRenderPlan = ({
  cellSize,
  gridHeight,
  gridWidth,
}: {
  cellSize: number;
  gridHeight: number;
  gridWidth: number;
}): ImageCanvasRenderPlan => {
  return {
    bitmapHeight: gridHeight,
    bitmapWidth: gridWidth,
    cellSize: 1,
    cellStride: 1,
    cssHeight: gridHeight * cellSize,
    cssWidth: gridWidth * cellSize,
  };
};

type RgbaBytes = readonly [red: number, green: number, blue: number, alpha: number];

const parseBitmapColor = (color: PixelColor): RgbaBytes => {
  if (!color || !/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(color)) return [0, 0, 0, 0];
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
    color.length === 9 ? Number.parseInt(color.slice(7, 9), 16) : 255,
  ];
};

/**
 * Writes a logical-resolution bitmap in one pass for a single putImageData.
 * This is display-only: background/alpha must never enter saved layer pixels.
 * The caller may reuse its ImageData while the resolution stays unchanged.
 */
export const writeImageCanvasBitmapPixels = (
  pixels: readonly PixelColor[],
  backgroundColor: PixelColor,
  target: Uint8ClampedArray,
): Uint8ClampedArray => {
  if (target.length !== pixels.length * 4) {
    throw new RangeError("The bitmap byte length must match the logical pixel count.");
  }

  const background = parseBitmapColor(backgroundColor);
  const backgroundAlpha = background[3] / 255;
  const colors = new Map<PixelColor, RgbaBytes>([[null, background]]);
  for (let index = 0; index < pixels.length; index += 1) {
    const color = pixels[index] ?? null;
    let bytes = colors.get(color);
    if (!bytes) {
      const foreground = parseBitmapColor(color);
      const foregroundAlpha = foreground[3] / 255;
      const outputAlpha = foregroundAlpha + backgroundAlpha * (1 - foregroundAlpha);
      if (foreground[3] === 255) {
        bytes = foreground;
      } else if (foreground[3] === 0 || outputAlpha === 0) {
        bytes = background;
      } else {
        const backgroundWeight = backgroundAlpha * (1 - foregroundAlpha);
        bytes = [
          Math.round((foreground[0] * foregroundAlpha + background[0] * backgroundWeight) / outputAlpha),
          Math.round((foreground[1] * foregroundAlpha + background[1] * backgroundWeight) / outputAlpha),
          Math.round((foreground[2] * foregroundAlpha + background[2] * backgroundWeight) / outputAlpha),
          Math.round(outputAlpha * 255),
        ];
      }
      colors.set(color, bytes);
    }
    const offset = index * 4;
    target[offset] = bytes[0];
    target[offset + 1] = bytes[1];
    target[offset + 2] = bytes[2];
    target[offset + 3] = bytes[3];
  }
  return target;
};
