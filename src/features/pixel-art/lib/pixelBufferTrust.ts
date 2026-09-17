import type { PixelColor } from "../types";

// The editor treats pixel buffers as immutable. A WeakSet remembers validation
// without retaining abandoned snapshots, queue history or arrays from old tabs.
const normalizedPixelArrays = new WeakSet<readonly PixelColor[]>();

/**
 * Producer assertion, NOT an external-data validator. Call only after building
 * a dense array of PixelColor values or copying such an immutable array.
 * Never register unvalidated wire data, sparse arrays or in-place mutable data.
 */
export const registerNormalizedPixelArray = <T extends readonly PixelColor[]>(pixels: T): T => {
  normalizedPixelArrays.add(pixels);
  return pixels;
};

export const hasNormalizedPixelArray = (pixels: readonly PixelColor[]): boolean =>
  normalizedPixelArrays.has(pixels);
