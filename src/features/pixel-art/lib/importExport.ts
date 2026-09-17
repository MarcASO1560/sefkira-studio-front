import type { PixelArtDocumentV2, PixelColor } from "../types";
import {
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXEL_COUNT,
  isValidImageDimensions,
  compositeVisibleLayers,
  createPixelArtDocument,
  createPixelLayer,
  normalizePixelColor,
} from "./document";
import {
  parsePixelArtResourceData,
  PixelArtMigrationError,
  serializePixelArtResourceData,
} from "./migrations";

export const PIXEL_ART_JSON_MIME_TYPE = "application/json";
export const PIXEL_ART_PNG_MIME_TYPE = "image/png";
export const PNG_EXPORT_SCALES = [1, 2, 4, 8, 16] as const;
// Preserve the largest formerly supported export (256 px × 16) while avoiding
// a 1 GB canvas when a larger document is exported at an unsuitable scale.
export const MAX_PNG_EXPORT_PIXEL_COUNT = 16_777_216;
export const MAX_PNG_EXPORT_DIMENSION = 8192;

export type PngExportScale = (typeof PNG_EXPORT_SCALES)[number];
export type RasterImageMimeType = "image/jpeg" | "image/png" | "image/webp";
export type PixelArtImportErrorCode =
  | "canvas-unavailable"
  | "decode-failed"
  | "image-too-large"
  | "invalid-document"
  | "invalid-json"
  | "unsupported-file-type"
  | "unsupported-json";

export class PixelArtImportError extends Error {
  readonly code: PixelArtImportErrorCode;

  constructor(code: PixelArtImportErrorCode, message: string) {
    super(message);
    this.name = "PixelArtImportError";
    this.code = code;
  }
}

export class RasterImageTooLargeError extends PixelArtImportError {
  readonly width: number;
  readonly height: number;
  readonly maxDimension: number;

  constructor(width: number, height: number, maxDimension = MAX_IMAGE_DIMENSION) {
    super(
      "image-too-large",
      `Image dimensions ${width}x${height} exceed ${maxDimension} pixels per axis or ${MAX_IMAGE_PIXEL_COUNT} total pixels.`,
    );
    this.name = "RasterImageTooLargeError";
    this.width = width;
    this.height = height;
    this.maxDimension = maxDimension;
  }
}

export type DecodedRasterImage = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

export type RasterFitDimensions = {
  width: number;
  height: number;
  scale: number;
};

export type RasterImageDecoder = (source: Blob) => Promise<DecodedRasterImage>;

export type RasterImportOptions = {
  decoder?: RasterImageDecoder;
  layerName?: string;
};

export type PngExportOptions = {
  backgroundColor?: string | null;
  scale?: PngExportScale;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const hasOwn = (value: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

const normalizeFileNamePart = (value: unknown) => {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .trim()
    .replace(/\.(?:jpe?g|json|png|webp)$/iu, "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "-")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[. -]+|[. -]+$/g, "")
    .toLocaleLowerCase()
    .slice(0, 100)
    .replace(/[. -]+$/g, "");
};

const WINDOWS_RESERVED_FILE_NAMES = /^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])(?:\.|$)/i;

export const sanitizeImageFileName = (value: unknown, fallback = "pixel-art") => {
  const normalizedFallback = normalizeFileNamePart(fallback) || "pixel-art";
  let fileName = normalizeFileNamePart(value) || normalizedFallback;

  if (WINDOWS_RESERVED_FILE_NAMES.test(fileName)) {
    fileName = `${fileName}-image`;
  }

  return fileName;
};

const assertDimension = (value: unknown, label: string) => {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > MAX_IMAGE_DIMENSION) {
    throw new PixelArtImportError(
      "invalid-document",
      `${label} must be an integer between 1 and ${MAX_IMAGE_DIMENSION}.`,
    );
  }

  return Number(value);
};

const assertColor = (value: unknown, location: string) => {
  if (value === null) {
    return;
  }

  if (typeof value !== "string" || !/^#[0-9A-F]{6}(?:[0-9A-F]{2})?$/i.test(value.trim())) {
    throw new PixelArtImportError(
      "invalid-document",
      `${location} must be null, #RRGGBB, or #RRGGBBAA.`,
    );
  }
};

const assertPalette = (value: unknown, required: boolean) => {
  if (value === undefined && !required) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new PixelArtImportError("invalid-document", "Pixel-art palette must be an array.");
  }

  value.forEach((color, index) => {
    if (color === null) {
      throw new PixelArtImportError(
        "invalid-document",
        `Pixel-art palette entry ${index} must be a color.`,
      );
    }
    assertColor(color, `Pixel-art palette entry ${index}`);
  });
};

const assertPixels = (value: unknown, width: number, height: number, location: string) => {
  if (!Array.isArray(value) || value.length !== width * height) {
    throw new PixelArtImportError(
      "invalid-document",
      `${location} must contain exactly ${width * height} pixels.`,
    );
  }

  value.forEach((color, index) => assertColor(color, `${location}[${index}]`));
};

const readLegacyDimensions = (payload: Record<string, unknown>) => {
  const width = assertDimension(payload.width ?? payload.size, "Pixel-art width");
  const height = assertDimension(payload.height ?? payload.size, "Pixel-art height");
  if (!isValidImageDimensions(width, height)) {
    throw new PixelArtImportError("invalid-document", `Pixel art may contain at most ${MAX_IMAGE_PIXEL_COUNT} pixels.`);
  }
  return { height, width };
};

const assertLegacyDocument = (payload: Record<string, unknown>) => {
  const { height, width } = readLegacyDimensions(payload);
  assertPalette(payload.palette, false);
  assertPixels(payload.pixels, width, height, "Pixel-art pixels");
  return {
    ...payload,
    height,
    width,
  };
};

const extractPixelArtPayload = (value: unknown) => {
  if (!isRecord(value)) {
    throw new PixelArtImportError("unsupported-json", "JSON does not contain pixel-art data.");
  }

  if (isRecord(value.data) && hasOwn(value.data, "pixel_art")) {
    if (!isRecord(value.data.pixel_art)) {
      throw new PixelArtImportError("invalid-document", "data.pixel_art must be an object.");
    }
    return value.data.pixel_art;
  }

  if (hasOwn(value, "pixel_art")) {
    if (!isRecord(value.pixel_art)) {
      throw new PixelArtImportError("invalid-document", "pixel_art must be an object.");
    }
    return value.pixel_art;
  }

  if (value.version === 1 || value.version === 2) {
    return value;
  }

  throw new PixelArtImportError("unsupported-json", "JSON does not contain pixel-art data.");
};

export const parsePixelArtJsonValue = (value: unknown): PixelArtDocumentV2 => {
  const payload = extractPixelArtPayload(value);
  let migrationPayload: Record<string, unknown>;

  if (payload.version === 1) {
    migrationPayload = assertLegacyDocument(payload);
  } else if (payload.version === 2) {
    // The strict canonical parser validates dimensions, metadata and every
    // pixel once, including supported compact encodings. Do not bypass that
    // validation or redundantly scan million-pixel dense imports beforehand.
    migrationPayload = payload;
  } else {
    throw new PixelArtImportError(
      "unsupported-json",
      `Unsupported pixel-art version: ${String(payload.version)}.`,
    );
  }

  try {
    return parsePixelArtResourceData({ pixel_art: migrationPayload }).document;
  } catch (error) {
    if (error instanceof PixelArtMigrationError || error instanceof RangeError) {
      throw new PixelArtImportError("invalid-document", error.message);
    }
    throw error;
  }
};

export const parsePixelArtJson = (source: string): PixelArtDocumentV2 => {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new PixelArtImportError("invalid-json", "The selected file is not valid JSON.");
  }

  return parsePixelArtJsonValue(value);
};

export const importPixelArtJson = async (source: Blob | string) =>
  parsePixelArtJson(typeof source === "string" ? source : await source.text());

export const exportPixelArtJson = (
  document: PixelArtDocumentV2,
  options: { pretty?: boolean } = {},
) => {
  const validatedDocument = parsePixelArtJsonValue(document);
  return JSON.stringify(
    serializePixelArtResourceData({}, validatedDocument),
    null,
    options.pretty === false ? undefined : 2,
  );
};

export const exportPixelArtJsonBlob = (
  document: PixelArtDocumentV2,
  options: { pretty?: boolean } = {},
) =>
  new Blob([exportPixelArtJson(document, options)], {
    type: PIXEL_ART_JSON_MIME_TYPE,
  });

const componentToHex = (value: number) =>
  Math.min(255, Math.max(0, Math.round(value))).toString(16).padStart(2, "0").toUpperCase();

export const rgbaBytesToPixelColors = (
  data: ArrayLike<number>,
  width: number,
  height: number,
): PixelColor[] => {
  assertRasterDimensions(width, height);
  const expectedLength = width * height * 4;
  if (data.length !== expectedLength) {
    throw new PixelArtImportError(
      "decode-failed",
      `Decoded raster contains ${data.length} color values; expected ${expectedLength}.`,
    );
  }

  const pixels: PixelColor[] = [];
  for (let offset = 0; offset < data.length; offset += 4) {
    const alpha = data[offset + 3];
    if (alpha <= 0) {
      pixels.push(null);
      continue;
    }

    const rgb = `${componentToHex(data[offset])}${componentToHex(data[offset + 1])}${componentToHex(
      data[offset + 2],
    )}`;
    pixels.push(alpha >= 255 ? `#${rgb}` : `#${rgb}${componentToHex(alpha)}`);
  }

  return pixels;
};

const assertPositiveRasterDimensions = (width: number, height: number) => {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new PixelArtImportError("decode-failed", "The raster image has invalid dimensions.");
  }
};

const assertRasterDimensions = (width: number, height: number) => {
  assertPositiveRasterDimensions(width, height);
  if (!isValidImageDimensions(width, height)) {
    throw new RasterImageTooLargeError(width, height);
  }
};

export const calculateRasterFitDimensions = (
  width: number,
  height: number,
  maxDimension = MAX_IMAGE_DIMENSION,
): RasterFitDimensions => {
  assertPositiveRasterDimensions(width, height);
  if (!Number.isInteger(maxDimension) || maxDimension < 1 || maxDimension > MAX_IMAGE_DIMENSION) {
    throw new RangeError(`Maximum raster dimension must be an integer between 1 and ${MAX_IMAGE_DIMENSION}.`);
  }

  const scale = Math.min(1, maxDimension / width, maxDimension / height, Math.sqrt(MAX_IMAGE_PIXEL_COUNT / (width * height)));
  let fitWidth = Math.max(1, Math.min(maxDimension, Math.round(width * scale)));
  let fitHeight = Math.max(1, Math.min(maxDimension, Math.round(height * scale)));
  // Rounding both axes upward can exceed the area budget by a few pixels.
  if (fitWidth * fitHeight > MAX_IMAGE_PIXEL_COUNT) {
    if (fitWidth >= fitHeight) fitWidth = Math.floor(MAX_IMAGE_PIXEL_COUNT / fitHeight);
    else fitHeight = Math.floor(MAX_IMAGE_PIXEL_COUNT / fitWidth);
  }
  return {
    width: fitWidth,
    height: fitHeight,
    scale,
  };
};

export const resizeDecodedRasterNearestNeighbor = (
  source: DecodedRasterImage,
  maxDimension = MAX_IMAGE_DIMENSION,
): DecodedRasterImage => {
  const fit = calculateRasterFitDimensions(source.width, source.height, maxDimension);
  const expectedLength = source.width * source.height * 4;
  if (source.data.length !== expectedLength) {
    throw new PixelArtImportError(
      "decode-failed",
      `Decoded raster contains ${source.data.length} color values; expected ${expectedLength}.`,
    );
  }

  if (fit.width === source.width && fit.height === source.height) {
    return source;
  }

  const data = new Uint8ClampedArray(fit.width * fit.height * 4);
  for (let targetY = 0; targetY < fit.height; targetY += 1) {
    const sourceY = Math.min(
      source.height - 1,
      Math.floor((targetY * source.height) / fit.height),
    );

    for (let targetX = 0; targetX < fit.width; targetX += 1) {
      const sourceX = Math.min(
        source.width - 1,
        Math.floor((targetX * source.width) / fit.width),
      );
      const sourceOffset = (sourceY * source.width + sourceX) * 4;
      const targetOffset = (targetY * fit.width + targetX) * 4;

      data[targetOffset] = source.data[sourceOffset];
      data[targetOffset + 1] = source.data[sourceOffset + 1];
      data[targetOffset + 2] = source.data[sourceOffset + 2];
      data[targetOffset + 3] = source.data[sourceOffset + 3];
    }
  }

  return { data, height: fit.height, width: fit.width };
};

const createBrowserCanvas = (width: number, height: number) => {
  if (typeof globalThis.document?.createElement !== "function") {
    throw new PixelArtImportError(
      "canvas-unavailable",
      "Canvas APIs are not available in this environment.",
    );
  }

  const canvas = globalThis.document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

const readCanvasPixels = (source: CanvasImageSource, width: number, height: number) => {
  assertPositiveRasterDimensions(width, height);
  const canvas = createBrowserCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new PixelArtImportError("canvas-unavailable", "Could not create a 2D canvas context.");
  }

  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, width, height);
  context.drawImage(source, 0, 0, width, height);

  try {
    return new Uint8ClampedArray(context.getImageData(0, 0, width, height).data);
  } catch {
    throw new PixelArtImportError("decode-failed", "Could not read pixels from the raster image.");
  }
};

const readDecodedCanvasSource = (
  source: CanvasImageSource,
  width: number,
  height: number,
  resizeToFit: boolean,
): DecodedRasterImage => {
  if (!resizeToFit) {
    assertRasterDimensions(width, height);
  }

  const dimensions = resizeToFit
    ? calculateRasterFitDimensions(width, height)
    : { height, scale: 1, width };
  return {
    data: readCanvasPixels(source, dimensions.width, dimensions.height),
    height: dimensions.height,
    width: dimensions.width,
  };
};

const decodeRasterWithImageElement = async (
  source: Blob,
  resizeToFit = false,
): Promise<DecodedRasterImage> => {
  if (
    typeof globalThis.Image !== "function" ||
    typeof globalThis.URL?.createObjectURL !== "function"
  ) {
    throw new PixelArtImportError(
      "canvas-unavailable",
      "Browser image decoding APIs are not available in this environment.",
    );
  }

  const objectUrl = globalThis.URL.createObjectURL(source);
  const image = new globalThis.Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Image decode failed"));
      image.src = objectUrl;
    });

    const width = image.naturalWidth;
    const height = image.naturalHeight;
    return readDecodedCanvasSource(image, width, height, resizeToFit);
  } catch (error) {
    if (error instanceof PixelArtImportError) {
      throw error;
    }
    throw new PixelArtImportError("decode-failed", "The raster image could not be decoded.");
  } finally {
    globalThis.URL.revokeObjectURL(objectUrl);
  }
};

const decodeRasterWithBrowser = async (
  source: Blob,
  resizeToFit = false,
): Promise<DecodedRasterImage> => {
  if (typeof globalThis.createImageBitmap !== "function") {
    return decodeRasterWithImageElement(source, resizeToFit);
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await globalThis.createImageBitmap(source);
  } catch {
    throw new PixelArtImportError("decode-failed", "The raster image could not be decoded.");
  }

  try {
    return readDecodedCanvasSource(bitmap, bitmap.width, bitmap.height, resizeToFit);
  } finally {
    bitmap.close?.();
  }
};

const fileNameFromBlob = (source: Blob) => {
  const name = (source as Blob & { name?: unknown }).name;
  return typeof name === "string" ? name : "";
};

const rasterMimeTypeFromBlob = (source: Blob): RasterImageMimeType | null => {
  const mimeType = source.type.trim().toLocaleLowerCase();
  if (mimeType === "image/png" || mimeType === "image/webp") {
    return mimeType;
  }
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") {
    return "image/jpeg";
  }
  if (mimeType) {
    return null;
  }

  const fileName = fileNameFromBlob(source);
  if (/\.png$/i.test(fileName)) return "image/png";
  if (/\.webp$/i.test(fileName)) return "image/webp";
  if (/\.jpe?g$/i.test(fileName)) return "image/jpeg";
  return null;
};

const assertSupportedRasterFile = (source: Blob) => {
  if (!rasterMimeTypeFromBlob(source)) {
    throw new PixelArtImportError(
      "unsupported-file-type",
      "Only PNG, JPEG, and WebP images can be imported.",
    );
  }
};

const rasterDocumentFromDecoded = (
  decoded: DecodedRasterImage,
  layerName: string | undefined,
) => {
  assertRasterDimensions(decoded.width, decoded.height);
  const pixels = rgbaBytesToPixelColors(decoded.data, decoded.width, decoded.height);

  return createPixelArtDocument(decoded.width, decoded.height, {
    layers: [
      createPixelLayer(decoded.width, decoded.height, {
        name: layerName?.trim() || "Layer 1",
        pixels,
      }),
    ],
  });
};

export const importRasterImage = async (
  source: Blob,
  options: RasterImportOptions = {},
): Promise<PixelArtDocumentV2> => {
  assertSupportedRasterFile(source);

  const decoded = await (options.decoder ?? decodeRasterWithBrowser)(source);
  return rasterDocumentFromDecoded(decoded, options.layerName);
};

export const importRasterImageReduced = async (
  source: Blob,
  options: RasterImportOptions = {},
): Promise<PixelArtDocumentV2> => {
  assertSupportedRasterFile(source);

  const decoded = options.decoder
    ? resizeDecodedRasterNearestNeighbor(await options.decoder(source))
    : await decodeRasterWithBrowser(source, true);
  return rasterDocumentFromDecoded(decoded, options.layerName);
};

const normalizePngBackground = (value: string | null | undefined) => {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = normalizePixelColor(value);
  if (!normalized || !/^#[0-9A-F]{6}$/.test(normalized)) {
    throw new RangeError("PNG background color must use #RRGGBB.");
  }
  return normalized;
};

const canvasToPngBlob = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("The browser could not encode the PNG image."));
      }
    }, PIXEL_ART_PNG_MIME_TYPE);
  });

export const exportPixelArtPng = async (
  document: PixelArtDocumentV2,
  options: PngExportOptions = {},
) => {
  const scale = options.scale ?? 1;
  if (!PNG_EXPORT_SCALES.includes(scale)) {
    throw new RangeError(`PNG scale must be one of ${PNG_EXPORT_SCALES.join(", ")}.`);
  }

  const validatedDocument = parsePixelArtJsonValue(document);
  const backgroundColor = normalizePngBackground(options.backgroundColor);
  const exportWidth = validatedDocument.width * scale;
  const exportHeight = validatedDocument.height * scale;
  if (exportWidth > MAX_PNG_EXPORT_DIMENSION || exportHeight > MAX_PNG_EXPORT_DIMENSION ||
    exportWidth * exportHeight > MAX_PNG_EXPORT_PIXEL_COUNT) {
    throw new RangeError("This PNG export is too large. Choose a smaller export scale.");
  }
  const canvas = createBrowserCanvas(
    exportWidth,
    exportHeight,
  );
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not create a 2D canvas context for PNG export.");
  }

  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (backgroundColor) {
    context.fillStyle = backgroundColor;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }

  const pixels = compositeVisibleLayers(validatedDocument);
  pixels.forEach((color, index) => {
    if (!color) {
      return;
    }

    context.fillStyle = color;
    context.fillRect(
      (index % validatedDocument.width) * scale,
      Math.floor(index / validatedDocument.width) * scale,
      scale,
      scale,
    );
  });

  return canvasToPngBlob(canvas);
};
