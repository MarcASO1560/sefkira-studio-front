import { Unzlib, zlibSync } from "fflate";
import type { PixelArtDocumentV2, PixelColor, PixelLayer } from "../types";
import { MAX_IMAGE_PIXEL_COUNT, normalizePixelColor } from "./document";
import { hasNormalizedPixelArray, registerNormalizedPixelArray } from "./pixelBufferTrust";

export type CompactPixelData = { encoding: "indexed-deflate-v1"; colors: PixelColor[]; index_bytes: 1 | 2 | 4; data: string };
export type CompactPixelLayer = Omit<PixelLayer, "pixels"> & { pixels: PixelColor[] | CompactPixelData };
export type CompactPixelArtDocument = Omit<PixelArtDocumentV2, "layers"> & { layers: CompactPixelLayer[] };
const COMPACT_THRESHOLD = 65_536;
const colorPattern = /^#[\da-f]{6}(?:[\da-f]{2})?$/i;
const base64Characters = /^[A-Za-z0-9+/]*={0,2}$/;
const cache = new WeakMap<readonly PixelColor[], CompactPixelData>();
const encodeBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  return btoa(binary);
};
const fail = (): never => { throw new RangeError("The compact pixel data is invalid."); };

/** Decode bounded chunks; never ask an inflater to allocate an unbounded image. */
export const decodeCompactPixels = (value: unknown, pixelCount: number): PixelColor[] => {
  if (!Number.isInteger(pixelCount) || pixelCount < 1 || pixelCount > MAX_IMAGE_PIXEL_COUNT || !value || typeof value !== "object" || Array.isArray(value)) return fail();
  const data = value as CompactPixelData;
  if (Object.keys(data).some((key) => !["encoding", "colors", "index_bytes", "data"].includes(key)) || data.encoding !== "indexed-deflate-v1" || !Array.isArray(data.colors) || !data.colors.length || data.colors.length > pixelCount + 1 || data.colors[0] !== null || ![1, 2, 4].includes(data.index_bytes) || typeof data.data !== "string") return fail();
  const width = data.colors.length <= 256 ? 1 : data.colors.length <= 65_536 ? 2 : 4;
  if (data.index_bytes !== width) return fail();
  const seen = new Set<PixelColor>();
  const colors: PixelColor[] = [];
  for (const value of data.colors) {
    if (seen.has(value) || value !== null && (typeof value !== "string" || !colorPattern.test(value))) return fail();
    seen.add(value); colors.push(value === null ? null : normalizePixelColor(value));
  }
  const expectedBytes = pixelCount * width;
  const maximumCompressedBytes = expectedBytes * 2 + 1024;
  if (!data.data.length || data.data.length > Math.ceil(maximumCompressedBytes / 3) * 4 || data.data.length % 4 || !base64Characters.test(data.data)) return fail();
  let binary: string;
  try { binary = atob(data.data); } catch { return fail(); }
  if (binary.length < 6 || binary.length > maximumCompressedBytes) return fail();
  const compressed = Uint8Array.from(binary, (value) => value.charCodeAt(0));
  const decoded = new Uint8Array(expectedBytes);
  let written = 0; let finished = false; let adlerA = 1; let adlerB = 0;
  const stream = new Unzlib((chunk, final) => {
    if (written + chunk.length > expectedBytes) return fail();
    decoded.set(chunk, written); written += chunk.length;
    for (let offset = 0; offset < chunk.length; offset += 5552) {
      const end = Math.min(chunk.length, offset + 5552);
      for (let index = offset; index < end; index += 1) { adlerA += chunk[index]!; adlerB += adlerA; }
      adlerA %= 65_521; adlerB %= 65_521;
    }
    if (final) finished = true;
  });
  try {
    for (let offset = 0; offset < compressed.length; offset += 1024) stream.push(compressed.subarray(offset, offset + 1024), offset + 1024 >= compressed.length);
  } catch { return fail(); }
  const checksum = new DataView(compressed.buffer, compressed.byteOffset, compressed.byteLength).getUint32(compressed.length - 4);
  if (!finished || written !== expectedBytes || ((adlerB << 16 | adlerA) >>> 0) !== checksum) return fail();
  const pixels: PixelColor[] = Array(pixelCount);
  const view = new DataView(decoded.buffer);
  for (let index = 0; index < pixelCount; index += 1) {
    const colorIndex = width === 1 ? decoded[index]! : width === 2 ? view.getUint16(index * 2, true) : view.getUint32(index * 4, true);
    if (colorIndex >= colors.length) return fail();
    pixels[index] = colors[colorIndex]!;
  }
  return registerNormalizedPixelArray(pixels);
};

export const compactPixelLayer = (layer: PixelLayer, width: number, height: number): CompactPixelLayer => {
  const count = width * height;
  if (!Number.isInteger(count) || count < 1 || count > MAX_IMAGE_PIXEL_COUNT || layer.pixels.length !== count) return fail();
  if (count <= COMPACT_THRESHOLD) return layer;
  const trusted = hasNormalizedPixelArray(layer.pixels);
  const previous = trusted ? cache.get(layer.pixels) : undefined;
  if (previous) return { ...layer, pixels: previous };
  const colors: PixelColor[] = [null]; const colorIndexes = new Map<PixelColor, number>([[null, 0]]);
  const indexes = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) {
    const color = layer.pixels[index];
    let colorIndex = colorIndexes.get(color!);
    if (colorIndex === undefined) {
      if (!trusted && (typeof color !== "string" || !colorPattern.test(color))) return fail();
      colorIndex = colors.length; colors.push(color!); colorIndexes.set(color!, colorIndex);
    }
    indexes[index] = colorIndex;
  }
  const indexBytes = colors.length <= 256 ? 1 : colors.length <= 65_536 ? 2 : 4;
  const bytes = new Uint8Array(count * indexBytes); const view = new DataView(bytes.buffer);
  for (let index = 0; index < count; index += 1) {
    if (indexBytes === 1) bytes[index] = indexes[index]!;
    else if (indexBytes === 2) view.setUint16(index * 2, indexes[index]!, true);
    else view.setUint32(index * 4, indexes[index]!, true);
  }
  const pixels: CompactPixelData = { encoding: "indexed-deflate-v1", colors, index_bytes: indexBytes, data: encodeBase64(zlibSync(bytes, { level: 1 })) };
  if (trusted) cache.set(layer.pixels, pixels);
  return { ...layer, pixels };
};

export const compactPixelArtDocument = (document: PixelArtDocumentV2): CompactPixelArtDocument => ({
  ...document, palette: [...document.palette], layers: document.layers.map((layer) => compactPixelLayer(layer, document.width, document.height)),
});
