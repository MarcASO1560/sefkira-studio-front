import type { PixelArtDocumentV2, PixelColor, PixelLayer } from "../types";
import { clonePixelArtDocument, normalizePixelColor } from "./document";
import { parsePixelArtResourceData } from "./migrations";

export type ImagePixelChange = [number, PixelColor] | [number, PixelColor, PixelColor];
export type ImageLayerFields = Partial<Pick<PixelLayer, "name" | "visible" | "locked" | "opacity">>;
export type ImageOperationAction =
  | { type: "pixels"; layer_id: string; changes: ImagePixelChange[] }
  | { type: "layer-add"; layer: PixelLayer; after_id: string | null }
  | { type: "layer-remove"; layer_id: string; expected_layer?: PixelLayer }
  | { type: "layer-update"; layer_id: string; fields: ImageLayerFields; expected?: ImageLayerFields }
  | { type: "layer-order"; layer_ids: string[]; expected_layer_ids?: string[] }
  | { type: "replace"; document: PixelArtDocumentV2 };

export type ImageOperation = {
  operation_id: string;
  base_revision: number;
  width: number;
  height: number;
  actions: ImageOperationAction[];
  /** Local journal metadata; never included in HTTP packets. */
  _client_expected_document?: PixelArtDocumentV2;
  _client_attempted?: boolean;
};

export class ImageOperationConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageOperationConflict";
  }
}

const fields = ["name", "visible", "locked", "opacity"] as const;
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const color = (value: PixelColor) => value === null ? null : normalizePixelColor(value);

/** Only the local change is encoded; unchanged remote pixels never enter a save. */
export const diffImageDocuments = (
  before: PixelArtDocumentV2,
  after: PixelArtDocumentV2,
  options: { conditional?: boolean; replace?: boolean } = {},
): ImageOperationAction[] => {
  parsePixelArtResourceData({ pixel_art: before });
  parsePixelArtResourceData({ pixel_art: after });
  if (options.replace || before.width !== after.width || before.height !== after.height) {
    return equal(before, after) ? [] : [{ type: "replace", document: clonePixelArtDocument(after) }];
  }
  const actions: ImageOperationAction[] = [];
  const previous = new Map(before.layers.map((layer) => [layer.id, layer]));
  const nextIds = new Set(after.layers.map((layer) => layer.id));
  for (const [index, layer] of after.layers.entries()) {
    const old = previous.get(layer.id);
    if (!old) {
      actions.push({ type: "layer-add", layer: { ...layer, pixels: [...layer.pixels] }, after_id: after.layers[index - 1]?.id ?? null });
      continue;
    }
    const changedFields: ImageLayerFields = {};
    const expected: ImageLayerFields = {};
    for (const field of fields) {
      if (old[field] !== layer[field]) {
        Object.assign(changedFields, { [field]: layer[field] });
        Object.assign(expected, { [field]: old[field] });
      }
    }
    if (Object.keys(changedFields).length) {
      actions.push({ type: "layer-update", layer_id: layer.id, fields: changedFields, ...(options.conditional ? { expected } : {}) });
    }
    const changes: ImagePixelChange[] = [];
    for (let pixel = 0; pixel < layer.pixels.length; pixel += 1) {
      if (color(old.pixels[pixel]!) === color(layer.pixels[pixel]!)) continue;
      changes.push(options.conditional
        ? [pixel, color(layer.pixels[pixel]!), color(old.pixels[pixel]!)]
        : [pixel, color(layer.pixels[pixel]!)]);
    }
    if (changes.length) actions.push({ type: "pixels", layer_id: layer.id, changes });
  }
  // Add replacements first, so even a one-layer swap never removes the last layer.
  for (const layer of before.layers) {
    if (!nextIds.has(layer.id)) actions.push({ type: "layer-remove", layer_id: layer.id, ...(options.conditional ? { expected_layer: { ...layer, pixels: [...layer.pixels] } } : {}) });
  }
  const beforeOrder = before.layers.filter((layer) => nextIds.has(layer.id)).map((layer) => layer.id);
  const afterOrder = after.layers.filter((layer) => previous.has(layer.id)).map((layer) => layer.id);
  if (!equal(beforeOrder, afterOrder)) actions.push({ type: "layer-order", layer_ids: after.layers.map((layer) => layer.id), ...(options.conditional ? { expected_layer_ids: applyImageActions(before, actions).layers.map((layer) => layer.id) } : {}) });
  return actions;
};

/** Matches the server's atomic merge semantics, including conditional undo. */
export const applyImageActions = (
  source: PixelArtDocumentV2,
  actions: readonly ImageOperationAction[],
  dimensions: { width: number; height: number } = source,
): PixelArtDocumentV2 => {
  let document = clonePixelArtDocument(source);
  if (actions.length === 1 && actions[0]?.type === "replace") {
    return clonePixelArtDocument(parsePixelArtResourceData({ pixel_art: actions[0].document }).document);
  }
  if (source.width !== dimensions.width || source.height !== dimensions.height) {
    throw new ImageOperationConflict("The canvas dimensions changed. Your pending changes have been preserved.");
  }
  for (const action of actions) {
    if (action.type === "replace") throw new ImageOperationConflict("A canvas replacement cannot be combined with pixel edits.");
    if (action.type === "layer-add") {
      const existing = document.layers.find((layer) => layer.id === action.layer.id);
      if (existing) {
        if (!equal(existing, action.layer)) throw new ImageOperationConflict("The new layer's identifier already exists. Your changes have been preserved.");
        continue;
      }
      const after = action.after_id === null ? -1 : document.layers.findIndex((layer) => layer.id === action.after_id);
      document.layers.splice(after + 1, 0, { ...action.layer, pixels: [...action.layer.pixels] });
      continue;
    }
    if (action.type === "layer-order") {
      if (action.expected_layer_ids && !equal(document.layers.map((layer) => layer.id), action.expected_layer_ids)) continue;
      // Reorder only known slots. Concurrently created layers are never deleted.
      const wanted = new Set(action.layer_ids);
      const ordered = action.layer_ids.map((id) => document.layers.find((layer) => layer.id === id)).filter((layer): layer is PixelLayer => Boolean(layer));
      let index = 0;
      document.layers = document.layers.map((layer) => wanted.has(layer.id) ? ordered[index++]! : layer);
      continue;
    }
    const index = document.layers.findIndex((layer) => layer.id === action.layer_id);
    if (action.type === "layer-remove") {
      if (action.expected_layer && index >= 0 && !equal(document.layers[index], action.expected_layer)) continue;
      if (index >= 0) document.layers.splice(index, 1);
      continue;
    }
    if (index < 0) throw new ImageOperationConflict("A layer used by your pending changes was removed. Your changes have been preserved.");
    const layer = document.layers[index]!;
    if (action.type === "layer-update") {
      for (const field of fields) {
        if (!(field in action.fields)) continue;
        if (action.expected && field in action.expected && layer[field] !== action.expected[field]) continue;
        Object.assign(layer, { [field]: action.fields[field] });
      }
      continue;
    }
    for (const change of action.changes) {
      if (change.length === 3 && color(layer.pixels[change[0]]!) !== color(change[2])) continue;
      layer.pixels[change[0]] = color(change[1]);
    }
  }
  if (!document.layers.length) throw new ImageOperationConflict("Removing every layer is not allowed. Your changes have been preserved.");
  return parsePixelArtResourceData({ pixel_art: document }).document;
};

export const validateImageOperation = (value: unknown): value is ImageOperation => {
  if (!value || typeof value !== "object") return false;
  const operation = value as ImageOperation;
  if (typeof operation.operation_id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(operation.operation_id) || !Number.isSafeInteger(operation.base_revision) || operation.base_revision < 0 || !Number.isInteger(operation.width) || operation.width < 1 || operation.width > 256 || !Number.isInteger(operation.height) || operation.height < 1 || operation.height > 256 || !Array.isArray(operation.actions) || !operation.actions.length || operation.actions.length > 256 || operation.actions.reduce((count, action) => count + (action?.type === "pixels" && Array.isArray(action.changes) ? action.changes.length : 0), 0) > 262144) return false;
  try {
    for (const action of operation.actions) {
      if (!action || typeof action !== "object") return false;
      if (action.type === "replace") {
        if (operation.actions.length !== 1) return false;
        parsePixelArtResourceData({ pixel_art: action.document });
        if (action.document.layers.length > 128) return false;
      } else if (action.type === "pixels") {
        if (!action.layer_id || !Array.isArray(action.changes) || !action.changes.length || action.changes.length > 65536 || !action.changes.every((change) => Array.isArray(change) && (change.length === 2 || change.length === 3) && Number.isInteger(change[0]) && change[0] >= 0 && change[0] < operation.width * operation.height && change.slice(1).every((entry) => entry === null || typeof entry === "string" && normalizePixelColor(entry) !== null))) return false;
      } else if (action.type === "layer-add") {
        parsePixelArtResourceData({ pixel_art: { version: 2, width: operation.width, height: operation.height, palette: [], layers: [action.layer] } });
        if (action.after_id !== null && typeof action.after_id !== "string") return false;
      } else if (action.type === "layer-remove") {
        if (typeof action.layer_id !== "string" || !action.layer_id.trim()) return false;
        if (action.expected_layer) parsePixelArtResourceData({ pixel_art: { version: 2, width: operation.width, height: operation.height, palette: [], layers: [action.expected_layer] } });
      } else if (action.type === "layer-update") {
        if (!action.layer_id || !action.fields || typeof action.fields !== "object" || !Object.keys(action.fields).length || Object.keys(action.fields).some((field) => !fields.includes(field as typeof fields[number]))) return false;
        if (action.expected && (typeof action.expected !== "object" || Array.isArray(action.expected) || !Object.keys(action.expected).length || Object.keys(action.expected).some((field) => !fields.includes(field as typeof fields[number])))) return false;
        for (const field of fields) {
          for (const values of [action.fields, action.expected]) {
            if (!values || !(field in values)) continue;
            const entry = values[field];
            if (field === "name" ? typeof entry !== "string" || !entry.trim() : field === "opacity" ? typeof entry !== "number" || !Number.isFinite(entry) || entry < 0 || entry > 1 : typeof entry !== "boolean") return false;
          }
        }
      } else if (action.type === "layer-order") {
        if (!Array.isArray(action.layer_ids) || !action.layer_ids.length || action.layer_ids.length > 128 || new Set(action.layer_ids).size !== action.layer_ids.length || action.layer_ids.some((id) => typeof id !== "string" || !id.trim())) return false;
        if (action.expected_layer_ids && (!Array.isArray(action.expected_layer_ids) || new Set(action.expected_layer_ids).size !== action.expected_layer_ids.length || action.expected_layer_ids.some((id) => typeof id !== "string" || !id.trim()))) return false;
      } else return false;
    }
    return true;
  } catch { return false; }
};

/** Bounded packets preserve operation order and fit the authoritative endpoint. */
export const splitImageActionBatches = (actions: ImageOperationAction[]): ImageOperationAction[][] => {
  if (!actions.length) return [];
  const batches: ImageOperationAction[][] = [];
  let batch: ImageOperationAction[] = [];
  let changes = 0;
  let bytes = 0;
  for (const action of actions) {
    const actionBytes = new TextEncoder().encode(JSON.stringify(action)).byteLength;
    const pixelChanges = action.type === "pixels" ? action.changes.length : 0;
    // The public proxy's request-body ceiling is lower than the backend's 8MiB
    // bound. Leave ample headroom for UTF-8 identifiers and packet metadata.
    if (actionBytes > 3 * 1024 * 1024 - 1024) throw new ImageOperationConflict("This image replacement is too large to synchronize safely. Keep the tab open and export your local copy.");
    if (batch.length && (batch.length >= 256 || changes + pixelChanges > 262144 || bytes + actionBytes > 3 * 1024 * 1024 - 1024)) {
      batches.push(batch); batch = []; changes = 0; bytes = 0;
    }
    batch.push(action); changes += pixelChanges; bytes += actionBytes;
  }
  if (batch.length) batches.push(batch);
  return batches;
};
