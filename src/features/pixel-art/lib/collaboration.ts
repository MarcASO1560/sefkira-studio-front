import type { ProjectEditorActivity } from "../../../lib/realtime";
import type {
  ImageSelection,
  ImageSelectionKind,
  ImageSelectionMode,
  PixelArtDocumentV2,
  PixelColor,
  PixelLayer,
} from "../types";
import { parsePixelArtResourceData, PixelArtMigrationError } from "./migrations";
import { PIXEL_ART_PASTEL_PALETTE } from "./palette";
import { isValidImageDimensions, MAX_IMAGE_DIMENSION } from "./document";

/** Background documents still synchronize; only an active cursor needs focus. */
export const canSendCollaborativeActivity = (
  kind: ProjectEditorActivity["kind"],
  payload: Record<string, unknown>,
  visibilityState: DocumentVisibilityState,
) => kind !== "cursor" || visibilityState === "visible" || payload.visible === false;

export type CollaborativeCursor = Readonly<{
  height: number;
  tool: string;
  visible: boolean;
  width: number;
  x: number;
  y: number;
}>;

export type CollaborativePixelPatch = Readonly<{
  changes: ReadonlyArray<readonly [number, PixelColor]>;
  height: number;
  layerId: string;
  width: number;
}>;

export type CollaborativeSelectionKind = ImageSelectionKind;

export type CollaborativeSelectionMode = ImageSelectionMode;

export type CollaborativeSelectionBounds = Readonly<
  Pick<ImageSelection, "height" | "width" | "x" | "y">
>;

/**
 * The in-memory mask is one byte per canvas pixel. The realtime wire format
 * bit-packs those values before base64 encoding, keeping a 256 x 256 mask to
 * roughly 11 KB instead of serializing 65,536 JSON numbers.
 */
export type CollaborativeSelectionMask = Readonly<{
  bounds: CollaborativeSelectionBounds;
  data: Uint8Array;
  height: number;
  width: number;
}>;

export type CollaborativeSelection = CollaborativeSelectionBounds &
  Readonly<{
    kind: CollaborativeSelectionKind;
    mask?: CollaborativeSelectionMask;
    mode: CollaborativeSelectionMode;
  }>;

export type CollaborativeSelectionInput = CollaborativeSelectionBounds &
  Readonly<{
    kind?: CollaborativeSelectionKind;
    mask?: Readonly<{
      bounds?: CollaborativeSelectionBounds | null;
      data: ArrayLike<number>;
      height: number;
      width: number;
    }>;
    mode?: CollaborativeSelectionMode;
  }>;

export type SerializedCollaborativeSelection = Readonly<{
  height: number;
  kind: CollaborativeSelectionKind;
  mask?: Readonly<{
    data: string;
    encoding: "bitset-v1";
    height: number;
    width: number;
  }>;
  mode: CollaborativeSelectionMode;
  width: number;
  x: number;
  y: number;
}>;

const COLLABORATIVE_SELECTION_KINDS = new Set<CollaborativeSelectionKind>([
  "rectangle",
  "lasso",
  "wand",
]);
const COLLABORATIVE_SELECTION_MODES = new Set<CollaborativeSelectionMode>([
  "replace",
  "add",
  "subtract",
  "intersect",
]);
// Leave room for editor-activity metadata beneath the smallest Broadcast limit.
// Oversized masks are only simplified on the wire, never in the local editor.
export const MAX_COLLABORATIVE_SELECTION_MASK_BYTES = 200 * 1024;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isDimension = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 1 &&
  value <= MAX_IMAGE_DIMENSION;

const isPixelColor = (value: unknown): value is PixelColor =>
  value === null || (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value));

const isSelectionKind = (value: unknown): value is CollaborativeSelectionKind =>
  typeof value === "string" &&
  COLLABORATIVE_SELECTION_KINDS.has(value as CollaborativeSelectionKind);

const isSelectionMode = (value: unknown): value is CollaborativeSelectionMode =>
  typeof value === "string" &&
  COLLABORATIVE_SELECTION_MODES.has(value as CollaborativeSelectionMode);

const isSelectionBounds = (value: unknown): value is CollaborativeSelectionBounds => {
  if (!isRecord(value) || !isDimension(value.width) || !isDimension(value.height) ||
    !isValidImageDimensions(value.width, value.height)) {
    return false;
  }
  if (
    typeof value.x !== "number" ||
    !Number.isInteger(value.x) ||
    typeof value.y !== "number" ||
    !Number.isInteger(value.y)
  ) {
    return false;
  }

  // Rectangle selections may temporarily straddle a canvas edge while they
  // are moved. They must still overlap some supported canvas.
  return (
    value.x > -value.width &&
    value.x < MAX_IMAGE_DIMENSION &&
    value.y > -value.height &&
    value.y < MAX_IMAGE_DIMENSION
  );
};

const sameSelectionBounds = (
  left: CollaborativeSelectionBounds,
  right: CollaborativeSelectionBounds,
) =>
  left.height === right.height &&
  left.width === right.width &&
  left.x === right.x &&
  left.y === right.y;

const selectedMaskBounds = (
  data: ArrayLike<number>,
  width: number,
  height: number,
  validateValues = false,
): CollaborativeSelectionBounds | null => {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let index = 0; index < data.length; index += 1) {
    if (validateValues && data[index] !== 0 && data[index] !== 1) {
      throw new TypeError("Selection mask values must be either 0 or 1.");
    }
    if (data[index] !== 1) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  return maxX < 0
    ? null
    : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
};

const encodeBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const decodeBase64 = (encoded: string, expectedBytes: number): Uint8Array | null => {
  const expectedLength = Math.ceil(expectedBytes / 3) * 4;
  if (encoded.length !== expectedLength || !BASE64_PATTERN.test(encoded)) return null;

  try {
    const binary = atob(encoded);
    if (binary.length !== expectedBytes) return null;
    const bytes = new Uint8Array(expectedBytes);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    // Reject alternate/non-canonical encodings and hidden data in padding.
    return encodeBase64(bytes) === encoded ? bytes : null;
  } catch {
    return null;
  }
};

const encodeSelectionMask = (
  mask: NonNullable<CollaborativeSelectionInput["mask"]>,
): SerializedCollaborativeSelection["mask"] => {
  if (!isDimension(mask.width) || !isDimension(mask.height) || !isValidImageDimensions(mask.width, mask.height)) {
    throw new RangeError("Selection mask dimensions exceed the supported canvas limits.");
  }

  const pixelCount = mask.width * mask.height;
  if (mask.data.length !== pixelCount) {
    throw new RangeError("Selection mask data must contain one value per canvas pixel.");
  }

  const packed = new Uint8Array(Math.ceil(pixelCount / 8));
  for (let index = 0; index < pixelCount; index += 1) {
    const value = mask.data[index];
    if (value !== 0 && value !== 1) {
      throw new TypeError("Selection mask values must be either 0 or 1.");
    }
    if (value === 1) packed[index >> 3] |= 1 << (index & 7);
  }

  return {
    data: encodeBase64(packed),
    encoding: "bitset-v1",
    height: mask.height,
    width: mask.width,
  };
};

const readSelectionMask = (value: unknown): CollaborativeSelectionMask | null => {
  if (
    !isRecord(value) ||
    value.encoding !== "bitset-v1" ||
    !isDimension(value.width) ||
    !isDimension(value.height) ||
    !isValidImageDimensions(value.width, value.height) ||
    typeof value.data !== "string" ||
    value.data.length > MAX_COLLABORATIVE_SELECTION_MASK_BYTES
  ) {
    return null;
  }

  const pixelCount = value.width * value.height;
  const packed = decodeBase64(value.data, Math.ceil(pixelCount / 8));
  if (!packed) return null;

  const usedBitsInLastByte = pixelCount % 8;
  if (usedBitsInLastByte !== 0) {
    const unusedBitsMask = (0xff << usedBitsInLastByte) & 0xff;
    if ((packed[packed.length - 1]! & unusedBitsMask) !== 0) return null;
  }

  const data = new Uint8Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    data[index] = (packed[index >> 3]! >> (index & 7)) & 1;
  }
  const bounds = selectedMaskBounds(data, value.width, value.height);
  return bounds ? { bounds, data, height: value.height, width: value.width } : null;
};

/**
 * Serializes a local selection without exposing Uint8Array's object-shaped JSON
 * representation. The top-level rectangle intentionally remains on the wire so
 * older clients can continue displaying the selection bounds.
 */
export const serializeCollaborativeSelection = (
  selection: CollaborativeSelectionInput | null,
): SerializedCollaborativeSelection | null => {
  if (selection === null) return null;
  if (!isSelectionBounds(selection)) {
    throw new RangeError("Selection bounds must overlap a supported canvas.");
  }

  const kind = selection.kind ?? "rectangle";
  const mode = selection.mode ?? "replace";
  if (!isSelectionKind(kind)) throw new TypeError("Unknown collaborative selection kind.");
  if (!isSelectionMode(mode)) throw new TypeError("Unknown collaborative selection mode.");

  const serialized: SerializedCollaborativeSelection = {
    height: selection.height,
    kind,
    mode,
    width: selection.width,
    x: selection.x,
    y: selection.y,
  };
  if (!selection.mask) {
    if (kind !== "rectangle") {
      throw new TypeError("Lasso and wand selections require a pixel mask.");
    }
    return serialized;
  }

  const pixelCount = selection.mask.width * selection.mask.height;
  if (!isValidImageDimensions(selection.mask.width, selection.mask.height)) {
    throw new RangeError("Selection mask dimensions exceed the supported canvas limits.");
  }
  if (selection.mask.data.length !== pixelCount) {
    throw new RangeError("Selection mask data must contain one value per canvas pixel.");
  }
  const encodedByteLength = Math.ceil(Math.ceil(pixelCount / 8) / 3) * 4;
  const useBoundsOnly = encodedByteLength > MAX_COLLABORATIVE_SELECTION_MASK_BYTES;
  const mask = useBoundsOnly ? undefined : encodeSelectionMask(selection.mask);
  const bounds = selectedMaskBounds(
    selection.mask.data,
    selection.mask.width,
    selection.mask.height,
    useBoundsOnly,
  );
  if (!bounds || !sameSelectionBounds(bounds, selection)) {
    throw new RangeError("Selection bounds must match the selected pixels in its mask.");
  }
  if (
    selection.mask.bounds !== undefined &&
    (!selection.mask.bounds || !sameSelectionBounds(selection.mask.bounds, bounds))
  ) {
    throw new RangeError("Selection mask bounds must match its selected pixels.");
  }

  return useBoundsOnly ? { ...serialized, kind: "rectangle" } : { ...serialized, mask };
};

export const readCollaborativeCursor = (
  activity: ProjectEditorActivity,
): CollaborativeCursor | null => {
  const payload = activity.payload;
  if (
    activity.kind !== "cursor" ||
    !isDimension(payload.width) ||
    !isDimension(payload.height) ||
    !isValidImageDimensions(payload.width, payload.height) ||
    typeof payload.visible !== "boolean" ||
    typeof payload.tool !== "string"
  ) {
    return null;
  }

  if (!payload.visible) {
    return {
      height: payload.height,
      tool: payload.tool,
      visible: false,
      width: payload.width,
      x: 0,
      y: 0,
    };
  }

  if (
    typeof payload.x !== "number" ||
    !Number.isFinite(payload.x) ||
    typeof payload.y !== "number" ||
    !Number.isFinite(payload.y) ||
    Math.abs(payload.x) > 100000 ||
    Math.abs(payload.y) > 100000
  ) {
    return null;
  }

  return {
    height: payload.height,
    tool: payload.tool,
    visible: true,
    width: payload.width,
    x: payload.x,
    y: payload.y,
  };
};

export const readCollaborativePixelPatch = (
  activity: ProjectEditorActivity,
): CollaborativePixelPatch | null => {
  const payload = activity.payload;
  if (
    activity.kind !== "pixels" ||
    typeof payload.layer_id !== "string" ||
    !payload.layer_id ||
    !isDimension(payload.width) ||
    !isDimension(payload.height) ||
    !isValidImageDimensions(payload.width, payload.height) ||
    !Array.isArray(payload.changes)
  ) {
    return null;
  }

  const pixelCount = payload.width * payload.height;
  const changes: Array<readonly [number, PixelColor]> = [];
  for (const change of payload.changes) {
    if (
      !Array.isArray(change) ||
      change.length !== 2 ||
      typeof change[0] !== "number" ||
      !Number.isInteger(change[0]) ||
      change[0] < 0 ||
      change[0] >= pixelCount ||
      !isPixelColor(change[1])
    ) {
      return null;
    }
    changes.push([change[0], change[1]]);
  }

  return {
    changes,
    height: payload.height,
    layerId: payload.layer_id,
    width: payload.width,
  };
};

export const applyCollaborativePixelPatch = (
  layers: ReadonlyArray<PixelLayer>,
  patch: CollaborativePixelPatch,
  width: number,
  height: number,
): PixelLayer[] | null => {
  if (patch.width !== width || patch.height !== height || patch.changes.length === 0) {
    return null;
  }

  const layerIndex = layers.findIndex((layer) => layer.id === patch.layerId);
  if (layerIndex < 0) return null;

  const layer = layers[layerIndex];
  if (!layer) return null;
  const pixels = [...layer.pixels];
  let changed = false;
  for (const [index, color] of patch.changes) {
    if (pixels[index] === color) continue;
    pixels[index] = color;
    changed = true;
  }
  if (!changed) return null;

  const nextLayers = [...layers];
  nextLayers[layerIndex] = { ...layer, pixels };
  return nextLayers;
};

export const readCollaborativeDocument = (
  activity: ProjectEditorActivity,
): PixelArtDocumentV2 | null => {
  if (activity.kind !== "document" || !isRecord(activity.payload.document)) {
    return null;
  }

  try {
    return parsePixelArtResourceData({ pixel_art: activity.payload.document }).document;
  } catch (error) {
    if (error instanceof PixelArtMigrationError) return null;
    throw error;
  }
};

export const readCollaborativeSelection = (
  activity: ProjectEditorActivity,
): CollaborativeSelection | null | undefined => {
  if (activity.kind !== "selection") return undefined;
  const selection = activity.payload.selection;
  if (selection === null) return null;
  if (!isSelectionBounds(selection)) return undefined;
  const selectionPayload = selection as CollaborativeSelectionBounds & Record<string, unknown>;

  const kindValue = selectionPayload.kind;
  const modeValue = selectionPayload.mode;
  if (kindValue !== undefined && !isSelectionKind(kindValue)) return undefined;
  if (modeValue !== undefined && !isSelectionMode(modeValue)) return undefined;
  const kind = kindValue ?? "rectangle";
  const mode = modeValue ?? "replace";

  if (selectionPayload.mask === undefined) {
    // Legacy peers only sent the rectangular bounds. Defaulting the new fields
    // keeps their selections valid while requiring masks for non-rectangular tools.
    return kind === "rectangle"
      ? {
          height: selection.height,
          kind,
          mode,
          width: selection.width,
          x: selection.x,
          y: selection.y,
        }
      : undefined;
  }

  const mask = readSelectionMask(selectionPayload.mask);
  if (!mask || !sameSelectionBounds(selection, mask.bounds)) return undefined;
  return {
    height: selection.height,
    kind,
    mask,
    mode,
    width: selection.width,
    x: selection.x,
    y: selection.y,
  };
};

export const collaboratorColor = (identity: string) => {
  let hash = 0;
  for (const character of identity) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return (
    PIXEL_ART_PASTEL_PALETTE[hash % PIXEL_ART_PASTEL_PALETTE.length] ||
    PIXEL_ART_PASTEL_PALETTE[0]
  );
};
