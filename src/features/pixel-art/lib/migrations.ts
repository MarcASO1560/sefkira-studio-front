import {
  createPixelArtDocument,
  createPixelLayer,
  MAX_IMAGE_DIMENSION,
  MIN_IMAGE_DIMENSION,
  normalizePixelColor,
  normalizePalette,
} from "./document";
import type { PixelArtDocumentV2, PixelColor, PixelLayer } from "../types";

export type PixelArtParseResult = {
  document: PixelArtDocumentV2;
  migrated: boolean;
  warnings: string[];
};

export type PixelArtMigrationErrorCode =
  | "invalid-document"
  | "unsupported-version";

/**
 * Signals resource data that cannot be migrated without risking data loss.
 * Callers should stop editing and surface this error instead of substituting a
 * blank document.
 */
export class PixelArtMigrationError extends Error {
  readonly code: PixelArtMigrationErrorCode;
  readonly version: unknown;

  constructor(
    code: PixelArtMigrationErrorCode,
    message: string,
    options: { version?: unknown } = {},
  ) {
    super(message);
    this.name = "PixelArtMigrationError";
    this.code = code;
    this.version = options.version;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const hasOwn = (value: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

const readPayload = (value: unknown) => {
  if (!isRecord(value)) {
    return {};
  }

  if (!hasOwn(value, "pixel_art")) {
    return value;
  }

  if (!isRecord(value.pixel_art)) {
    throw new PixelArtMigrationError(
      "invalid-document",
      "Stored pixel-art data must be an object.",
    );
  }

  return value.pixel_art;
};

const isValidDimension = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= MIN_IMAGE_DIMENSION &&
  value <= MAX_IMAGE_DIMENSION;

/** Validate every external value while constructing each normalized layer once. */
const parseV2Document = (payload: Record<string, unknown>): PixelArtDocumentV2 => {
  if (!isValidDimension(payload.width) || !isValidDimension(payload.height)) {
    throw new PixelArtMigrationError(
      "invalid-document",
      `Stored pixel-art v2 dimensions must be integers between ${MIN_IMAGE_DIMENSION} and ${MAX_IMAGE_DIMENSION}.`,
      { version: 2 },
    );
  }

  const normalizedColors = new Map<string, string>();
  const normalizeCachedColor = (value: string): PixelColor => {
    const cached = normalizedColors.get(value);
    if (cached !== undefined) return cached;
    const normalized = normalizePixelColor(value);
    if (normalized !== null) normalizedColors.set(value, normalized);
    return normalized;
  };
  const invalidPalette = () => new PixelArtMigrationError(
    "invalid-document",
    "Stored pixel-art v2 palette is invalid.",
    { version: 2 },
  );
  if (!Array.isArray(payload.palette)) {
    throw invalidPalette();
  }
  const palette: string[] = [];
  const paletteColors = new Set<string>();
  for (let index = 0; index < payload.palette.length; index += 1) {
    // Array.every previously skipped holes, but rejected explicit undefined.
    // Preserve that legacy distinction while returning a dense normalized list.
    if (!(index in payload.palette)) continue;
    const value = payload.palette[index];
    const normalized = typeof value === "string" ? normalizeCachedColor(value) : null;
    if (normalized === null) throw invalidPalette();
    if (!paletteColors.has(normalized)) { paletteColors.add(normalized); palette.push(normalized); }
  }

  if (
    !Array.isArray(payload.layers) ||
    payload.layers.length < 1
  ) {
    throw new PixelArtMigrationError(
      "invalid-document",
      "Stored pixel-art v2 must contain at least 1 layer.",
      { version: 2 },
    );
  }

  const expectedPixelCount = payload.width * payload.height;
  const layerIds = new Set<string>();
  const layers: PixelLayer[] = [];
  for (const [index, layer] of payload.layers.entries()) {
    if (!isRecord(layer)) {
      throw new PixelArtMigrationError(
        "invalid-document",
        `Stored pixel-art v2 layer ${index + 1} must be an object.`,
        { version: 2 },
      );
    }

    if (
      typeof layer.id !== "string" ||
      !layer.id.trim() ||
      layerIds.has(layer.id) ||
      typeof layer.name !== "string" ||
      !layer.name.trim() ||
      typeof layer.visible !== "boolean" ||
      typeof layer.locked !== "boolean" ||
      typeof layer.opacity !== "number" ||
      !Number.isFinite(layer.opacity) ||
      layer.opacity < 0 ||
      layer.opacity > 1 ||
      !Array.isArray(layer.pixels) ||
      layer.pixels.length !== expectedPixelCount
    ) {
      throw new PixelArtMigrationError(
        "invalid-document",
        `Stored pixel-art v2 layer ${index + 1} is invalid.`,
        { version: 2 },
      );
    }

    const pixels: PixelColor[] = Array(expectedPixelCount);
    for (let pixel = 0; pixel < expectedPixelCount; pixel += 1) {
      if (!(pixel in layer.pixels)) { pixels[pixel] = null; continue; }
      const value = layer.pixels[pixel];
      const normalized = value === null ? null : typeof value === "string" ? normalizeCachedColor(value) : undefined;
      if (normalized === undefined || value !== null && normalized === null) {
        throw new PixelArtMigrationError(
          "invalid-document",
          `Stored pixel-art v2 layer ${index + 1} is invalid.`,
          { version: 2 },
        );
      }
      pixels[pixel] = normalized;
    }
    layerIds.add(layer.id);
    layers.push({ id: layer.id, name: layer.name.trim(), visible: layer.visible, locked: layer.locked, opacity: Math.max(0, layer.opacity), pixels });
  }
  return { version: 2, width: payload.width, height: payload.height, palette, layers };
};

export const parsePixelArtResourceData = (value: unknown): PixelArtParseResult => {
  const payload = readPayload(value);
  const warnings: string[] = [];

  if (payload.version !== undefined && payload.version !== 1 && payload.version !== 2) {
    throw new PixelArtMigrationError(
      "unsupported-version",
      `Unsupported stored pixel-art version: ${String(payload.version)}.`,
      { version: payload.version },
    );
  }

  if (payload.version === 2) {
    return { document: parseV2Document(payload), migrated: false, warnings };
  }

  const width = Number(payload.width ?? payload.size);
  const height = Number(payload.height ?? payload.size);
  const document = createPixelArtDocument(width, height, {
    palette: normalizePalette(payload.palette),
    layers: [
      createPixelLayer(width, height, {
        name: "Layer 1",
        pixels: payload.pixels,
      }),
    ],
  });

  if (Object.keys(payload).length > 0) {
    warnings.push("Legacy pixel-art data was migrated in memory.");
  }

  return { document, migrated: true, warnings };
};

export const serializePixelArtResourceData = (
  existingData: Record<string, unknown>,
  document: PixelArtDocumentV2,
) => ({
  ...existingData,
  pixel_art: {
    version: 2 as const,
    width: document.width,
    height: document.height,
    palette: [...document.palette],
    layers: document.layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      visible: layer.visible,
      locked: layer.locked,
      opacity: layer.opacity,
      pixels: [...layer.pixels],
    })),
  },
});
