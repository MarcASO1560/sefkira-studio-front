import type { PixelColor } from "../types";
import { isValidImageDimensions, normalizePixelColor, normalizePixels } from "./document";

export type FloodFillRun = [start: number, length: number];
export type FloodFillResult = { pixels: PixelColor[]; color: PixelColor; runs: FloodFillRun[] };

/** Capture the exact local region. Other sessions must not recompute it on a newer image. */
export const floodFillPixelRuns = ({
  pixels, width, height, startIndex, color, contains,
}: {
  pixels: readonly PixelColor[];
  width: number;
  height: number;
  startIndex: number;
  color: PixelColor;
  contains?: (index: number) => boolean;
}): FloodFillResult | null => {
  if (!isValidImageDimensions(width, height) || pixels.length !== width * height) {
    throw new RangeError("The fill requires a valid, complete pixel buffer.");
  }
  if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex >= pixels.length ||
      contains && !contains(startIndex)) return null;
  const replacement = normalizePixelColor(color);
  if (color !== null && replacement === null) throw new RangeError("The fill color is invalid.");
  const target = normalizePixelColor(pixels[startIndex]);
  if (target === replacement) return null;
  const nextPixels = normalizePixels(pixels, width, height);
  const pending = [startIndex];
  const spans: FloodFillRun[] = [];
  const matches = (index: number) => nextPixels[index] === target && (!contains || contains(index));

  // Scan whole horizontal spans. Changed pixels are their own visited marker:
  // no Set of a million indexes, four-neighbor stack, or per-pixel wire tuples.
  while (pending.length) {
    const seed = pending.pop()!;
    if (!matches(seed)) continue;
    const rowStart = Math.floor(seed / width) * width;
    const rowEnd = rowStart + width;
    let start = seed;
    let end = seed + 1;
    while (start > rowStart && matches(start - 1)) start -= 1;
    while (end < rowEnd && matches(end)) end += 1;
    nextPixels.fill(replacement, start, end);
    spans.push([start, end - start]);
    for (const offset of [-width, width]) {
      if (start + offset < 0 || end + offset > nextPixels.length) continue;
      let insideSpan = false;
      for (let index = start + offset; index < end + offset; index += 1) {
        const match = matches(index);
        if (match && !insideSpan) pending.push(index);
        insideSpan = match;
      }
    }
  }
  spans.sort((left, right) => left[0] - right[0]);
  const runs: FloodFillRun[] = [];
  for (const [start, length] of spans) {
    const previous = runs[runs.length - 1];
    if (previous && previous[0] + previous[1] === start) previous[1] += length;
    else runs.push([start, length]);
  }
  return { pixels: nextPixels, color: replacement, runs };
};
