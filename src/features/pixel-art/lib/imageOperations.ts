import type { ImageResizeAnchor, PixelArtDocumentV2, PixelColor, PixelLayer } from "../types";
import { clonePixelArtDocument, isValidImageDimensions, MAX_IMAGE_DOCUMENT_PIXELS, MAX_IMAGE_PIXEL_COUNT, normalizePixelColor } from "./document";
import { parsePixelArtResourceData } from "./migrations";
import { resizePixelArtDocument } from "./resize";
import { compactPixelArtDocument, compactPixelLayer, type CompactPixelArtDocument, type CompactPixelLayer } from "./compactPixels";

export type ImageResizeOperation = { width: number; height: number; anchor: ImageResizeAnchor };
export type ImageOperationTransform = {
  revision: number;
  from_width: number;
  from_height: number;
  to_width: number;
  to_height: number;
  offset_x: number;
  offset_y: number;
  operation_id?: string;
  user_id?: string | null;
};
export type SharedImageHistory = { can_undo: boolean; can_redo: boolean };

export type ImagePixelChange = [number, PixelColor] | [number, PixelColor, PixelColor];
export type ImagePixelRun = [number, number];
export type ImageLayerFields = Partial<Pick<PixelLayer, "name" | "visible" | "locked" | "opacity">>;
export type ImageOperationAction =
  | { type: "pixels"; layer_id: string; changes: ImagePixelChange[] }
  | { type: "pixel-runs"; layer_id: string; color: PixelColor; runs: ImagePixelRun[] }
  | { type: "layer-add"; layer: PixelLayer; after_id: string | null }
  | { type: "layer-remove"; layer_id: string; expected_layer?: PixelLayer }
  | { type: "layer-update"; layer_id: string; fields: ImageLayerFields; expected?: ImageLayerFields }
  | { type: "layer-order"; layer_ids: string[]; expected_layer_ids?: string[] }
  | ({ type: "resize" } & ImageResizeOperation)
  | { type: "undo" }
  | { type: "redo" }
  | { type: "import"; document: PixelArtDocumentV2 }
  | { type: "replace"; document: PixelArtDocumentV2 };

export type ImageOperation = {
  operation_id: string;
  base_revision: number;
  width: number;
  height: number;
  actions: ImageOperationAction[];
  history_group_id?: string;
  coordinate_after_operation_id?: string;
  /** Local journal metadata; never included in HTTP packets. */
  _client_expected_document?: PixelArtDocumentV2;
  _client_attempted?: boolean;
  _client_frame_dependency?: string;
  _client_dependency_revision?: number;
};

export type ImageOperationWireAction = Exclude<ImageOperationAction, { type: "layer-add" | "layer-remove" | "import" | "replace" }>
  | { type: "layer-add"; layer: CompactPixelLayer; after_id: string | null }
  | { type: "layer-remove"; layer_id: string; expected_layer?: CompactPixelLayer }
  | { type: "import" | "replace"; document: CompactPixelArtDocument };
const toWireAction = (action: ImageOperationAction): ImageOperationWireAction => {
  if (action.type === "import" || action.type === "replace") return { ...action, document: compactPixelArtDocument(action.document) };
  if (action.type === "layer-add") return { ...action, layer: compactPixelLayer(action.layer, action.layer.pixels.length, 1) };
  if (action.type === "layer-remove" && action.expected_layer) return { ...action, expected_layer: compactPixelLayer(action.expected_layer, action.expected_layer.pixels.length, 1) };
  return action;
};
/** Client journal/dependency metadata never leaves this boundary. */
export const toImageOperationPacket = (operation: ImageOperation) => ({
  operation_id: operation.operation_id, base_revision: operation.base_revision,
  width: operation.width, height: operation.height, actions: operation.actions.map(toWireAction),
  ...(operation.history_group_id ? { history_group_id: operation.history_group_id } : {}),
  ...(operation.coordinate_after_operation_id ? { coordinate_after_operation_id: operation.coordinate_after_operation_id } : {}),
});

export class ImageOperationConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageOperationConflict";
  }
}

const fields = ["name", "visible", "locked", "opacity"] as const;
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const color = (value: PixelColor) => value === null ? null : normalizePixelColor(value);
const anchors = new Set<ImageResizeAnchor>(["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"]);

/** External spans are sorted, disjoint and bounded without enumerating pixels. */
export const validateImagePixelRuns = (value: unknown, pixelCount: number): value is ImagePixelRun[] => {
  if (!Number.isSafeInteger(pixelCount) || pixelCount < 1 || pixelCount > MAX_IMAGE_PIXEL_COUNT || !Array.isArray(value) || !value.length || value.length > 65_536) return false;
  let end = 0;
  for (const run of value) {
    if (!Array.isArray(run) || run.length !== 2 || !Number.isSafeInteger(run[0]) || !Number.isSafeInteger(run[1]) || run[0] < end || run[1] < 1 || run[0] + run[1] > pixelCount) return false;
    end = run[0] + run[1];
  }
  return true;
};
const appendRun = (runs: ImagePixelRun[], start: number, length: number) => {
  const last = runs.at(-1);
  if (last && last[0] + last[1] === start) last[1] += length;
  else runs.push([start, length]);
};

/** Only the local change is encoded; unchanged remote pixels never enter a save. */
export const diffImageDocuments = (
  before: PixelArtDocumentV2,
  after: PixelArtDocumentV2,
  options: { conditional?: boolean; replace?: boolean; resize?: ImageResizeOperation } = {},
): ImageOperationAction[] => {
  parsePixelArtResourceData({ pixel_art: before });
  parsePixelArtResourceData({ pixel_art: after });
  if (options.resize) return before.width === options.resize.width && before.height === options.resize.height ? [] : [{ type: "resize", ...options.resize }];
  if (options.replace) return equal(before, after) ? [] : [{ type: "import", document: clonePixelArtDocument(after) }];
  if (before.width !== after.width || before.height !== after.height) {
    // Legacy callers retain a guarded replacement; new resize UI supplies its
    // semantic anchor explicitly so collaborators' pixels are never replaced.
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
    const runs: ImagePixelRun[] = [];
    let uniformColor: PixelColor | undefined;
    let uniform = !options.conditional;
    let changedCount = 0;
    const normalizedColors = new Map<PixelColor, PixelColor>();
    const cachedColor = (raw: PixelColor) => {
      if (!normalizedColors.has(raw)) normalizedColors.set(raw, color(raw));
      return normalizedColors.get(raw)!;
    };
    for (let pixel = 0; pixel < layer.pixels.length; pixel += 1) {
      const previousColor = cachedColor(old.pixels[pixel]!);
      const nextColor = cachedColor(layer.pixels[pixel]!);
      if (previousColor === nextColor) continue;
      changedCount += 1;
      if (uniformColor === undefined) uniformColor = nextColor;
      if (uniform && nextColor !== uniformColor) {
        uniform = false;
        for (const [start, length] of runs) for (let index = start; index < start + length; index += 1) changes.push([index, uniformColor!]);
        runs.length = 0;
      }
      if (uniform) appendRun(runs, pixel, 1);
      else changes.push(options.conditional ? [pixel, nextColor, previousColor] : [pixel, nextColor]);
    }
    if (uniform && changedCount >= 4096 && runs.length <= 65_536) actions.push({ type: "pixel-runs", layer_id: layer.id, color: uniformColor!, runs });
    else {
      if (uniform) for (const [start, length] of runs) for (let index = start; index < start + length; index += 1) changes.push([index, uniformColor!]);
      if (changes.length) actions.push({ type: "pixels", layer_id: layer.id, changes });
    }
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
  if (actions.length === 1 && actions[0]?.type === "resize") return resizePixelArtDocument(source, actions[0].width, actions[0].height, actions[0].anchor);
  if (actions.length === 1 && (actions[0]?.type === "undo" || actions[0]?.type === "redo")) return clonePixelArtDocument(source);
  if (actions.length === 1 && (actions[0]?.type === "replace" || actions[0]?.type === "import")) {
    return clonePixelArtDocument(parsePixelArtResourceData({ pixel_art: actions[0].document }).document);
  }
  const ids = new Set(source.layers.map((layer) => layer.id));
  for (const action of actions) {
    if (action.type === "layer-add") ids.add(action.layer.id);
    if (action.type === "layer-remove" && !action.expected_layer && ids.size > 1) ids.delete(action.layer_id);
    if (source.width * source.height * ids.size > MAX_IMAGE_DOCUMENT_PIXELS) throw new ImageOperationConflict("The image exceeds the total layer-pixel limit. Your changes have been preserved.");
  }
  let document = clonePixelArtDocument(source);
  if (source.width !== dimensions.width || source.height !== dimensions.height) {
    throw new ImageOperationConflict("The canvas dimensions changed. Your pending changes have been preserved.");
  }
  for (const action of actions) {
    if (action.type === "replace" || action.type === "import") throw new ImageOperationConflict("A canvas replacement cannot be combined with pixel edits.");
    if (action.type === "resize" || action.type === "undo" || action.type === "redo") throw new ImageOperationConflict("Resize and shared-history actions must be submitted separately.");
    if (action.type === "layer-add") {
      const existing = document.layers.find((layer) => layer.id === action.layer.id);
      if (existing) {
        if (!equal(existing, action.layer)) throw new ImageOperationConflict("The new layer's identifier already exists. Your changes have been preserved.");
        continue;
      }
      const after = action.after_id === null ? -1 : document.layers.findIndex((layer) => layer.id === action.after_id);
      if (after === -1 && action.after_id !== null) { document.layers.push({ ...action.layer, pixels: [...action.layer.pixels] }); continue; }
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
      if (index >= 0 && document.layers.length > 1) document.layers.splice(index, 1);
      continue;
    }
    if (index < 0) continue; // A concurrently removed layer is a safe no-op.
    const layer = document.layers[index]!;
    if (action.type === "layer-update") {
      for (const field of fields) {
        if (!(field in action.fields)) continue;
        if (action.expected && field in action.expected && layer[field] !== action.expected[field]) continue;
        Object.assign(layer, { [field]: action.fields[field] });
      }
      continue;
    }
    if (action.type === "pixel-runs") {
      const nextColor = color(action.color);
      for (const [start, length] of action.runs) layer.pixels.fill(nextColor, start, start + length);
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
  if (typeof operation.operation_id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(operation.operation_id) || !Number.isSafeInteger(operation.base_revision) || operation.base_revision < 0 || !isValidImageDimensions(operation.width, operation.height) || !Array.isArray(operation.actions) || !operation.actions.length || operation.actions.length > 256 || operation.actions.reduce((count, action) => count + (action?.type === "pixels" && Array.isArray(action.changes) ? action.changes.length : 0), 0) > 262144) return false;
  try {
    let coverage = operation.actions.reduce((count, action) => count + (action?.type === "pixels" && Array.isArray(action.changes) ? action.changes.length : 0), 0);
    if (operation.history_group_id !== undefined && !/^[A-Za-z0-9_-]{1,80}$/.test(operation.history_group_id)) return false;
    if (operation.coordinate_after_operation_id !== undefined && !/^[A-Za-z0-9_-]{1,80}$/.test(operation.coordinate_after_operation_id)) return false;
    for (const action of operation.actions) {
      if (!action || typeof action !== "object") return false;
      if (action.type === "resize") {
        if (operation.actions.length !== 1 || !isValidImageDimensions(action.width, action.height) || !anchors.has(action.anchor)) return false;
      } else if (action.type === "undo" || action.type === "redo") {
        if (operation.actions.length !== 1) return false;
      } else if (action.type === "replace" || action.type === "import") {
        if (operation.actions.length !== 1) return false;
        parsePixelArtResourceData({ pixel_art: action.document });
        if (action.document.layers.length > 128) return false;
      } else if (action.type === "pixels") {
        if (!action.layer_id || !Array.isArray(action.changes) || !action.changes.length || action.changes.length > 65536 || !action.changes.every((change) => Array.isArray(change) && (change.length === 2 || change.length === 3) && Number.isInteger(change[0]) && change[0] >= 0 && change[0] < operation.width * operation.height && change.slice(1).every((entry) => entry === null || typeof entry === "string" && normalizePixelColor(entry) !== null))) return false;
      } else if (action.type === "pixel-runs") {
        if (typeof action.layer_id !== "string" || !action.layer_id.trim() || action.color !== null && (typeof action.color !== "string" || normalizePixelColor(action.color) === null) || !validateImagePixelRuns(action.runs, operation.width * operation.height)) return false;
        coverage += action.runs.reduce((count, run) => count + run[1], 0);
        if (coverage > MAX_IMAGE_PIXEL_COUNT) return false;
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

/** Immutable original packets are mapped only for the optimistic local view. */
export const rebaseImageOperationActions = (
  operation: ImageOperation,
  transforms: readonly ImageOperationTransform[],
  userId?: string,
): { actions: ImageOperationAction[]; width: number; height: number } => {
  const dependency = operation.coordinate_after_operation_id ?? operation._client_frame_dependency;
  const dependencyEvent = dependency ? transforms.find((event) => event.operation_id === dependency && (!userId || event.user_id === userId)) : undefined;
  const sinceRevision = dependencyEvent?.revision ?? operation._client_dependency_revision ?? operation.base_revision;
  const events = [...transforms].filter((event) => event.revision > sinceRevision).sort((left, right) => left.revision - right.revision);
  const applicable = dependency && !dependencyEvent && operation._client_dependency_revision === undefined ? [] : events;
  let width = operation.width;
  let height = operation.height;
  for (const event of applicable) {
    if (event.from_width !== width || event.from_height !== height) throw new ImageOperationConflict("The shared coordinate history is incomplete. Your pending changes remain protected while reconnecting.");
    width = event.to_width; height = event.to_height;
  }
  const mapIndex = (index: number) => {
    let currentWidth = operation.width;
    let x = index % currentWidth;
    let y = Math.floor(index / currentWidth);
    for (const event of applicable) {
      x += event.offset_x; y += event.offset_y;
      if (x < 0 || y < 0 || x >= event.to_width || y >= event.to_height) return null;
      currentWidth = event.to_width;
    }
    return y * width + x;
  };
  const mapLayer = (layer: PixelLayer): PixelLayer => {
    const pixels: PixelColor[] = Array(width * height).fill(null);
    for (const [index, value] of layer.pixels.entries()) { const mapped = mapIndex(index); if (mapped !== null) pixels[mapped] = value; }
    return { ...layer, pixels };
  };
  const actions = operation.actions.map((action): ImageOperationAction => {
    if (action.type === "pixels") {
      const changes: ImagePixelChange[] = [];
      for (const change of action.changes) { const mapped = mapIndex(change[0]); if (mapped !== null) changes.push(change.length === 3 ? [mapped, change[1], change[2]] : [mapped, change[1]]); }
      return { ...action, changes };
    }
    if (action.type === "pixel-runs") {
      let runs = action.runs.map(([start, length]): ImagePixelRun => [start, length]);
      let currentWidth = operation.width;
      for (const event of applicable) {
        const mapped: ImagePixelRun[] = [];
        for (const [start, length] of runs) {
          const end = start + length;
          for (let cursor = start; cursor < end;) {
            const x = cursor % currentWidth;
            const rowLength = Math.min(end - cursor, currentWidth - x);
            const y = Math.floor(cursor / currentWidth) + event.offset_y;
            const left = Math.max(0, x + event.offset_x);
            const right = Math.min(event.to_width, x + rowLength + event.offset_x);
            if (y >= 0 && y < event.to_height && right > left) appendRun(mapped, y * event.to_width + left, right - left);
            cursor += rowLength;
          }
        }
        runs = mapped;
        currentWidth = event.to_width;
      }
      return { ...action, runs };
    }
    if (action.type === "layer-add") return { ...action, layer: mapLayer(action.layer) };
    if (action.type === "layer-remove" && action.expected_layer) return { ...action, expected_layer: mapLayer(action.expected_layer) };
    return action;
  });
  return { actions, width, height };
};

/** Bounded packets preserve operation order and fit the authoritative endpoint. */
export const splitImageActionBatches = (actions: ImageOperationAction[]): ImageOperationAction[][] => {
  if (!actions.length) return [];
  const batches: ImageOperationAction[][] = [];
  let batch: ImageOperationAction[] = [];
  let changes = 0;
  let coverage = 0;
  let bytes = 0;
  const boundedActions = actions.flatMap((action) => action.type === "pixels" && action.changes.length > 65_536
    ? Array.from({ length: Math.ceil(action.changes.length / 65_536) }, (_, index): ImageOperationAction => ({ ...action, changes: action.changes.slice(index * 65_536, (index + 1) * 65_536) })) : [action]);
  for (const action of boundedActions) {
    const actionBytes = new TextEncoder().encode(JSON.stringify(toWireAction(action))).byteLength;
    const pixelChanges = action.type === "pixels" ? action.changes.length : 0;
    const actionCoverage = action.type === "pixel-runs" ? action.runs.reduce((count, run) => count + run[1], 0) : pixelChanges;
    // The public proxy's request-body ceiling is lower than the backend's 8MiB
    // bound. Leave ample headroom for UTF-8 identifiers and packet metadata.
    if (actionBytes > 3 * 1024 * 1024 - 1024) throw new ImageOperationConflict("This image replacement is too large to synchronize safely. Keep the tab open and export your local copy.");
    if (batch.length && (batch.length >= 256 || changes + pixelChanges > 262144 || coverage + actionCoverage > MAX_IMAGE_PIXEL_COUNT || bytes + actionBytes > 3 * 1024 * 1024 - 1024)) {
      batches.push(batch); batch = []; changes = 0; bytes = 0; coverage = 0;
    }
    batch.push(action); changes += pixelChanges; bytes += actionBytes; coverage += actionCoverage;
  }
  if (batch.length) batches.push(batch);
  return batches;
};
