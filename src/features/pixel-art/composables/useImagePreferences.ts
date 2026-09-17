import { reactive } from "vue";

import type { ImageResizeAnchor } from "../types";
import { MIN_IMAGE_ZOOM, MAX_IMAGE_ZOOM } from "../lib/zoomLimits";
import {
  IMAGE_GRID_LINE_STYLES,
  type ImageGridLineStyle,
} from "../lib/gridOverlay";

export type { ImageGridLineStyle } from "../lib/gridOverlay";
export type ImageGridGap = 1 | 2 | 3;
export type ImageSubdivisionThickness = 1 | 2 | 3;

export type ImagePreferences = {
  background: string;
  gridVisible: boolean;
  gridColor: string;
  gridLineStyle: ImageGridLineStyle;
  gridOpacity: number;
  gridGap: ImageGridGap;
  subdivision: number;
  subdivisionColor: string;
  subdivisionThickness: ImageSubdivisionThickness;
  resizeAnchor: ImageResizeAnchor;
  zoom?: number;
};

export type ImagePreferencesStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

export type UseImagePreferencesOptions = {
  userId: string;
  resourceId: string;
  defaults?: Partial<ImagePreferences>;
  storage?: ImagePreferencesStorage | null;
};

type StoredImagePreferences = {
  version: typeof IMAGE_PREFERENCES_VERSION;
  preferences: ImagePreferences;
};

export const IMAGE_PREFERENCES_VERSION = 1;
export const IMAGE_PREFERENCES_STORAGE_PREFIX = "sefkira:image-preferences";

export const DEFAULT_IMAGE_PREFERENCES: Readonly<ImagePreferences> = Object.freeze({
  background: "#101111",
  gridVisible: true,
  gridColor: "#F7F1E7",
  gridLineStyle: "solid",
  gridOpacity: 0.18,
  gridGap: 1,
  subdivision: 1,
  subdivisionColor: "#FF4D4D",
  subdivisionThickness: 1,
  resizeAnchor: "center",
});

const MIN_ZOOM = MIN_IMAGE_ZOOM;
const MAX_ZOOM = MAX_IMAGE_ZOOM;
const MIN_SUBDIVISION = 1;
const MAX_SUBDIVISION = 64;
const IMAGE_GRID_LINE_STYLE_SET: ReadonlySet<string> = new Set(IMAGE_GRID_LINE_STYLES);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeColor = (value: unknown, fallback: string) => {
  if (typeof value !== "string") {
    return fallback;
  }

  const color = value.trim().toUpperCase();
  return /^#[0-9A-F]{6}$/.test(color) ? color : fallback;
};

const numericValue = (value: unknown) => {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    return Number(value);
  }

  return Number.NaN;
};

const clampNumber = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  integer = false,
) => {
  const parsed = numericValue(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const normalized = integer ? Math.round(parsed) : parsed;
  return Math.min(maximum, Math.max(minimum, normalized));
};

const normalizeGridLineStyle = (
  value: unknown,
  fallback: ImageGridLineStyle,
): ImageGridLineStyle =>
  typeof value === "string" && IMAGE_GRID_LINE_STYLE_SET.has(value)
    ? (value as ImageGridLineStyle)
    : fallback;

const normalizeOptionalZoom = (value: unknown, fallback: number | undefined) => {
  if (value === undefined) {
    return fallback;
  }

  const parsed = numericValue(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, parsed));
};

const IMAGE_RESIZE_ANCHORS: ReadonlySet<ImageResizeAnchor> = new Set([
  "top-left",
  "top",
  "top-right",
  "left",
  "center",
  "right",
  "bottom-left",
  "bottom",
  "bottom-right",
]);

export const normalizeImagePreferences = (
  value: unknown,
  fallback: ImagePreferences = DEFAULT_IMAGE_PREFERENCES,
): ImagePreferences => {
  const source = isRecord(value) ? value : {};
  const normalized: ImagePreferences = {
    background: normalizeColor(source.background, fallback.background),
    gridVisible:
      typeof source.gridVisible === "boolean" ? source.gridVisible : fallback.gridVisible,
    gridColor: normalizeColor(source.gridColor, fallback.gridColor),
    gridLineStyle: normalizeGridLineStyle(source.gridLineStyle, fallback.gridLineStyle),
    gridOpacity: clampNumber(source.gridOpacity, fallback.gridOpacity, 0, 1),
    gridGap: clampNumber(source.gridGap, fallback.gridGap, 1, 3, true) as ImageGridGap,
    subdivision: clampNumber(
      source.subdivision,
      fallback.subdivision,
      MIN_SUBDIVISION,
      MAX_SUBDIVISION,
      true,
    ),
    subdivisionColor: normalizeColor(source.subdivisionColor, fallback.subdivisionColor),
    subdivisionThickness: clampNumber(
      source.subdivisionThickness,
      fallback.subdivisionThickness,
      1,
      3,
      true,
    ) as ImageSubdivisionThickness,
    resizeAnchor: IMAGE_RESIZE_ANCHORS.has(source.resizeAnchor as ImageResizeAnchor)
      ? (source.resizeAnchor as ImageResizeAnchor)
      : fallback.resizeAnchor,
  };
  const zoom = normalizeOptionalZoom(source.zoom, fallback.zoom);

  if (zoom !== undefined) {
    normalized.zoom = zoom;
  }

  return normalized;
};

export const imagePreferencesStorageKey = (userId: string, resourceId: string) =>
  `${IMAGE_PREFERENCES_STORAGE_PREFIX}:v${IMAGE_PREFERENCES_VERSION}:${encodeURIComponent(
    userId,
  )}:${encodeURIComponent(resourceId)}`;

const defaultStorage = (): ImagePreferencesStorage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

const readStoredPreferences = (
  storage: ImagePreferencesStorage | null,
  key: string,
  fallback: ImagePreferences,
) => {
  if (!storage) {
    return fallback;
  }

  try {
    const serialized = storage.getItem(key);
    if (!serialized) {
      return fallback;
    }

    const stored = JSON.parse(serialized) as unknown;
    if (
      !isRecord(stored) ||
      stored.version !== IMAGE_PREFERENCES_VERSION ||
      !("preferences" in stored)
    ) {
      return fallback;
    }

    return normalizeImagePreferences(stored.preferences, fallback);
  } catch {
    return fallback;
  }
};

export const useImagePreferences = ({
  userId,
  resourceId,
  defaults,
  storage = defaultStorage(),
}: UseImagePreferencesOptions) => {
  const key = imagePreferencesStorageKey(userId, resourceId);
  const normalizedDefaults = normalizeImagePreferences(
    { ...DEFAULT_IMAGE_PREFERENCES, ...defaults },
    DEFAULT_IMAGE_PREFERENCES,
  );
  const preferences = reactive<ImagePreferences>({
    ...readStoredPreferences(storage, key, normalizedDefaults),
  });

  const replacePreferences = (nextPreferences: ImagePreferences) => {
    for (const property of Object.keys(preferences) as Array<keyof ImagePreferences>) {
      if (!(property in nextPreferences)) {
        delete preferences[property];
      }
    }

    Object.assign(preferences, nextPreferences);
  };

  const save = (updates: Partial<ImagePreferences> = {}) => {
    const normalized = normalizeImagePreferences(
      { ...preferences, ...updates },
      normalizedDefaults,
    );
    replacePreferences(normalized);

    if (!storage) {
      return false;
    }

    const stored: StoredImagePreferences = {
      version: IMAGE_PREFERENCES_VERSION,
      preferences: normalized,
    };

    try {
      storage.setItem(key, JSON.stringify(stored));
      return true;
    } catch {
      return false;
    }
  };

  const reset = () => {
    replacePreferences({ ...normalizedDefaults });

    if (!storage) {
      return false;
    }

    try {
      storage.removeItem(key);
      return true;
    } catch {
      return false;
    }
  };

  return {
    key,
    preferences,
    reset,
    save,
  };
};
