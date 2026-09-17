import type { PixelArtDocumentV2, PixelColor, PixelLayer } from "../types";
import { hasNormalizedPixelArray, registerNormalizedPixelArray } from "./pixelBufferTrust";

export const MIN_IMAGE_DIMENSION = 1;
export const MAX_IMAGE_DIMENSION = 4096;
export const MAX_IMAGE_PIXEL_COUNT = 4_194_304;
export const MAX_IMAGE_DOCUMENT_PIXELS = 16_777_216;

export const isValidImageDimensions = (width: unknown, height: unknown): boolean =>
  typeof width === "number" && typeof height === "number" &&
  Number.isInteger(width) && Number.isInteger(height) &&
  width >= MIN_IMAGE_DIMENSION && width <= MAX_IMAGE_DIMENSION &&
  height >= MIN_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION &&
  width * height <= MAX_IMAGE_PIXEL_COUNT;

export const clampImageDimension = (value: unknown, fallback = 32) => {
  const numericValue = typeof value === "number" ? value : Number(value);
  const safeFallback = Math.min(
    MAX_IMAGE_DIMENSION,
    Math.max(MIN_IMAGE_DIMENSION, Math.round(fallback)),
  );

  if (!Number.isFinite(numericValue)) {
    return safeFallback;
  }

  return Math.min(
    MAX_IMAGE_DIMENSION,
    Math.max(MIN_IMAGE_DIMENSION, Math.round(numericValue)),
  );
};
export const normalizePixelColor = (value: unknown): PixelColor => {
  if (typeof value !== "string") {
    return null;
  }

  const candidate = value.trim().toUpperCase();
  if (/^#[0-9A-F]{6}$/.test(candidate) || /^#[0-9A-F]{8}$/.test(candidate)) {
    return candidate;
  }

  return null;
};

export const normalizePalette = (value: unknown) => {
  if (!Array.isArray(value)) {
    return [];
  }

  const colors: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const color = normalizePixelColor(entry);
    if (color && !seen.has(color)) {
      seen.add(color);
      colors.push(color);
    }
  }

  return colors;
};

export const normalizePixels = (value: unknown, width: number, height: number) => {
  if (width * height > MAX_IMAGE_PIXEL_COUNT) throw new RangeError(`Images may contain at most ${MAX_IMAGE_PIXEL_COUNT} pixels.`);
  const source = Array.isArray(value) ? value : [];
  const count = width * height;
  if (source.length === count && hasNormalizedPixelArray(source)) return registerNormalizedPixelArray(source.slice());
  const colors = new Map<unknown, PixelColor>();
  return registerNormalizedPixelArray(Array.from({ length: count }, (_, index) => {
    const value = source[index];
    if (value === null || value === undefined) return null;
    if (colors.has(value)) return colors.get(value)!;
    const color = normalizePixelColor(value); colors.set(value, color); return color;
  }));
};

export const createLayerId = () => {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  return `layer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

export const createPixelLayer = (
  width: number,
  height: number,
  options: Partial<Omit<PixelLayer, "pixels">> & { pixels?: unknown } = {},
): PixelLayer => ({
  id: typeof options.id === "string" && options.id.trim() ? options.id : createLayerId(),
  name: typeof options.name === "string" && options.name.trim() ? options.name.trim() : "Layer 1",
  visible: options.visible !== false,
  locked: options.locked === true,
  opacity: Math.min(1, Math.max(0, Number.isFinite(options.opacity) ? Number(options.opacity) : 1)),
  pixels: normalizePixels(options.pixels, width, height),
});

export const createPixelArtDocument = (
  width = 32,
  height = 32,
  options: Partial<Pick<PixelArtDocumentV2, "palette" | "layers">> = {},
): PixelArtDocumentV2 => {
  const normalizedWidth = clampImageDimension(width);
  const normalizedHeight = clampImageDimension(height);
  if (!isValidImageDimensions(normalizedWidth, normalizedHeight)) throw new RangeError(`Images may contain at most ${MAX_IMAGE_PIXEL_COUNT} pixels.`);
  if (Array.isArray(options.layers) && normalizedWidth * normalizedHeight * options.layers.length > MAX_IMAGE_DOCUMENT_PIXELS) throw new RangeError(`Images may contain at most ${MAX_IMAGE_DOCUMENT_PIXELS} layer pixels.`);
  const layers = Array.isArray(options.layers)
    ? options.layers
        .map((layer, index) =>
          createPixelLayer(normalizedWidth, normalizedHeight, {
            ...layer,
            name: layer.name || `Layer ${index + 1}`,
          }),
        )
    : [];

  return {
    version: 2,
    width: normalizedWidth,
    height: normalizedHeight,
    palette: normalizePalette(options.palette),
    layers:
      layers.length > 0
        ? ensureUniqueLayerIds(layers)
        : [createPixelLayer(normalizedWidth, normalizedHeight)],
  };
};

export const ensureUniqueLayerIds = (layers: PixelLayer[]) => {
  const usedIds = new Set<string>();

  return layers.map((layer) => {
    let id = layer.id;
    while (!id || usedIds.has(id)) {
      id = createLayerId();
    }
    usedIds.add(id);
    return id === layer.id ? layer : { ...layer, id };
  });
};

export const clonePixelArtDocument = (document: PixelArtDocumentV2): PixelArtDocumentV2 => ({
  version: 2,
  width: document.width,
  height: document.height,
  palette: [...document.palette],
  layers: document.layers.map((layer) => ({ ...layer, pixels: hasNormalizedPixelArray(layer.pixels) ? registerNormalizedPixelArray(layer.pixels.slice()) : [...layer.pixels] })),
});

type RgbaColor = { red: number; green: number; blue: number; alpha: number };

const readRgba = (color: string): RgbaColor => {
  const hex = color.slice(1);
  return {
    red: Number.parseInt(hex.slice(0, 2), 16),
    green: Number.parseInt(hex.slice(2, 4), 16),
    blue: Number.parseInt(hex.slice(4, 6), 16),
    alpha: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
  };
};

const componentToHex = (value: number) =>
  Math.round(Math.min(255, Math.max(0, value)))
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();

const writeRgba = ({ red, green, blue, alpha }: RgbaColor): PixelColor => {
  if (alpha <= 0) {
    return null;
  }

  const rgb = `${componentToHex(red)}${componentToHex(green)}${componentToHex(blue)}`;
  if (alpha >= 0.999) {
    return `#${rgb}`;
  }

  return `#${rgb}${componentToHex(alpha * 255)}`;
};

export const blendPixelColors = (
  background: PixelColor,
  foreground: PixelColor,
  layerOpacity = 1,
): PixelColor => {
  if (!foreground || layerOpacity <= 0) {
    return background;
  }

  const foregroundRgba = readRgba(foreground);
  const foregroundAlpha = foregroundRgba.alpha * Math.min(1, Math.max(0, layerOpacity));
  if (foregroundAlpha <= 0) {
    return background;
  }

  const backgroundRgba = background
    ? readRgba(background)
    : { red: 0, green: 0, blue: 0, alpha: 0 };
  const outputAlpha = foregroundAlpha + backgroundRgba.alpha * (1 - foregroundAlpha);
  if (outputAlpha <= 0) {
    return null;
  }

  return writeRgba({
    red:
      (foregroundRgba.red * foregroundAlpha +
        backgroundRgba.red * backgroundRgba.alpha * (1 - foregroundAlpha)) /
      outputAlpha,
    green:
      (foregroundRgba.green * foregroundAlpha +
        backgroundRgba.green * backgroundRgba.alpha * (1 - foregroundAlpha)) /
      outputAlpha,
    blue:
      (foregroundRgba.blue * foregroundAlpha +
        backgroundRgba.blue * backgroundRgba.alpha * (1 - foregroundAlpha)) /
      outputAlpha,
    alpha: outputAlpha,
  });
};

export const compositeVisibleLayers = (document: PixelArtDocumentV2) => {
  const pixels: PixelColor[] = Array(document.width * document.height).fill(null);

  for (const layer of document.layers) {
    if (!layer.visible || layer.opacity <= 0) {
      continue;
    }

    // Pixel-art usually repeats a small palette. Blend each distinct pair once
    // per layer instead of parsing and formatting HEX colors for every pixel.
    // Keep these caches local: arbitrary imported palettes must not accumulate
    // forever, and documents/pixel buffers remain immutable.
    const solidColors = new Map<string, string>();
    const blends = new Map<PixelColor, Map<string, PixelColor>>();
    const fullyOpaqueLayer = layer.opacity >= 1;
    for (let index = 0; index < pixels.length; index += 1) {
      const foreground = layer.pixels[index];
      if (!foreground) continue;

      if (fullyOpaqueLayer && (foreground.length === 7 || foreground.slice(7).toUpperCase() === "FF")) {
        let solidColor = solidColors.get(foreground);
        if (solidColor === undefined) {
          solidColor = foreground.slice(0, 7).toUpperCase();
          solidColors.set(foreground, solidColor);
        }
        pixels[index] = solidColor;
        continue;
      }

      const background = pixels[index];
      let foregroundBlends = blends.get(background);
      if (!foregroundBlends) {
        foregroundBlends = new Map();
        blends.set(background, foregroundBlends);
      }
      if (foregroundBlends.has(foreground)) {
        pixels[index] = foregroundBlends.get(foreground)!;
      } else {
        const blended = blendPixelColors(background, foreground, layer.opacity);
        foregroundBlends.set(foreground, blended);
        pixels[index] = blended;
      }
    }
  }

  return pixels;
};
