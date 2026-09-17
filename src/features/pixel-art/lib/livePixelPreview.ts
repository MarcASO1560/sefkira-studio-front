import type { PixelArtDocumentV2, PixelColor } from "../types";
import { isValidImageDimensions } from "./document";
import { registerNormalizedPixelArray } from "./pixelBufferTrust";

const MAX_PACKET_CHANGES = 1024;
const MAX_LAYER_PIXELS = 65_536;
const MAX_LAYERS = 128;
const MAX_CLIENTS = 50;
const MAX_ID_LENGTH = 200;
const PREVIEW_TTL_MS = 30_000;
const MAX_RUNS = 65_536;
const MAX_RUN_PACKET_BYTES = 200 * 1024;
const MAX_RETAINED_RUN_BYTES = 8 * 1024 * 1024;

type PreviewInput = {
  width: number;
  height: number;
  baseRevision: number;
  layers: Array<{ layerId: string; changes: Array<readonly [number, PixelColor]> }>;
};
export type LivePixelRunInput = {
  width: number;
  height: number;
  baseRevision: number;
  layerId: string;
  color: PixelColor;
  runs: ReadonlyArray<readonly [number, number]>;
};
type Span = { start: number; end: number };
type Retirement = { origin: number; bits: Uint8Array; retiredAt: number };
type PreviewRun = Span & PreviewPixel & {
  retiredAll?: boolean;
  retiredAt?: number;
  retirement?: Retirement;
  pendingExpired?: boolean;
  lastObservedRevision?: number;
};
type Mutation = { color: PixelColor; sequence: number };
type PendingFrame = {
  width: number;
  height: number;
  baseRevision: number;
  layers: Map<string, Map<number, Mutation>>;
};
type PreviewPixel = Mutation & { baseRevision: number; receivedAt: number; order: number };
type RetiredPixel = { sequence: number; retiredAt: number };
type ClientPreview = {
  width: number;
  height: number;
  frameSequence: number;
  frameBaseRevision: number;
  confirmedSequence: number;
  acknowledgements: Map<number, number>;
  layers: Map<string, Map<number, PreviewPixel>>;
  retiredLayers: Map<string, Map<number, RetiredPixel>>;
  runLayers: Map<string, PreviewRun[]>;
  touchedAt: number;
};

const safeInteger = (value: unknown, minimum = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length <= MAX_ID_LENGTH && value.trim().length > 0;
const pixelColor = (value: unknown): value is PixelColor =>
  value === null || (typeof value === "string" && /^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(value));
const samePixelColor = (left: PixelColor | undefined, right: PixelColor): boolean =>
  left === right || (typeof left === "string" && typeof right === "string" &&
    left.toUpperCase() === right.toUpperCase());
const ownRecord = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const clock = (nowMs?: number) =>
  typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : Date.now();

const validRuns = (value: unknown, count: number): value is ReadonlyArray<readonly [number, number]> => {
  if (!Array.isArray(value) || !value.length || value.length > MAX_RUNS) return false;
  let end = 0;
  for (const run of value) {
    if (!Array.isArray(run) || run.length !== 2 || !safeInteger(run[0]) ||
      !safeInteger(run[1], 1) || run[0] < end || run[0] + run[1] > count) return false;
    end = run[0] + run[1];
  }
  return true;
};
const packetFits = (payload: Record<string, unknown>): boolean => {
  try { return new TextEncoder().encode(JSON.stringify(payload)).byteLength <= MAX_RUN_PACKET_BYTES; }
  catch { return false; }
};
const mergeSpans = (spans: Span[]): Span[] => {
  spans.sort((left, right) => left.start - right.start);
  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && last.end >= span.start) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
};
/** Linear interval subtraction, never one object per covered pixel. */
const subtractSpans = <T extends Span>(source: readonly T[], cuts: readonly Span[]): T[] | undefined => {
  const result: T[] = [];
  let cutIndex = 0;
  for (const span of source) {
    let start = span.start;
    while (cutIndex < cuts.length && cuts[cutIndex]!.end <= start) cutIndex += 1;
    let currentCut = cutIndex;
    while (currentCut < cuts.length && cuts[currentCut]!.start < span.end) {
      const cut = cuts[currentCut++]!;
      if (cut.start > start) result.push({ ...span, start, end: Math.min(cut.start, span.end) });
      start = Math.max(start, cut.end);
      if (result.length > MAX_RUNS) return undefined;
      if (start >= span.end) break;
    }
    if (start < span.end) result.push({ ...span, start });
    if (result.length > MAX_RUNS) return undefined;
  }
  return result;
};
const runAt = (runs: readonly PreviewRun[] | undefined, index: number): PreviewRun | undefined => {
  if (!runs) return undefined;
  let low = 0; let high = runs.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const run = runs[middle]!;
    if (index < run.start) high = middle - 1;
    else if (index >= run.end) low = middle + 1;
    else return run;
  }
  return undefined;
};
const retiredAtIndex = (run: PreviewRun, index: number): boolean => {
  if (run.retiredAll) return true;
  if (!run.retirement) return false;
  const offset = index - run.retirement.origin;
  return !!(run.retirement.bits[offset >>> 3]! & (1 << (offset & 7)));
};
const runBlocksIndex = (run: PreviewRun, index: number): boolean =>
  !run.pendingExpired || retiredAtIndex(run, index);
const indexInSpans = (spans: readonly Span[], index: number): boolean => {
  let low = 0; let high = spans.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1; const span = spans[middle]!;
    if (index < span.start) high = middle - 1;
    else if (index >= span.end) low = middle + 1;
    else return true;
  }
  return false;
};

/** Ephemeral previews are deliberately separate from the durable operation queue. */
export const createLivePixelPreviewSender = (
  send: (payload: Record<string, unknown>) => void,
  { intervalMs = 16 }: { intervalMs?: number } = {},
) => {
  const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 16;
  let sequence = 0;
  let pending: PendingFrame | null = null;
  let lastSentAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const cancelTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const flush = () => {
    cancelTimer();
    if (!pending || disposed) return;
    const frame = pending;
    pending = null;
    lastSentAt = Date.now();
    for (const [layerId, mutations] of frame.layers) {
      const changes = Array.from(mutations, ([index, mutation]) =>
        [index, mutation.color, mutation.sequence] as const);
      for (let offset = 0; offset < changes.length; offset += MAX_PACKET_CHANGES) {
        if (disposed) return;
        const chunk = changes.slice(offset, offset + MAX_PACKET_CHANGES);
        try {
          send({
            preview_protocol: 1,
            width: frame.width,
            height: frame.height,
            base_revision: frame.baseRevision,
            layer_id: layerId,
            changes: chunk,
            preview_sequence: Math.max(...chunk.map((change) => change[2])),
          });
        } catch {
          // Drawing and safe saving must not depend on this best-effort channel.
        }
      }
    }
  };

  const enqueue = (input: PreviewInput): number => {
    if (
      disposed || sequence === Number.MAX_SAFE_INTEGER || !ownRecord(input) ||
      !isValidImageDimensions(input.width, input.height) ||
      !safeInteger(input.baseRevision) || !Array.isArray(input.layers) ||
      input.layers.length > MAX_LAYERS
    ) return sequence;
    let changeCount = 0;
    for (const layer of input.layers) {
      if (!ownRecord(layer) || !identifier(layer.layerId) || !Array.isArray(layer.changes) ||
        layer.changes.length > MAX_LAYER_PIXELS) return sequence;
      changeCount += layer.changes.length;
      if (changeCount > MAX_LAYER_PIXELS) return sequence;
      for (const change of layer.changes) {
        if (!Array.isArray(change) || change.length !== 2 || !safeInteger(change[0]) ||
          change[0] >= input.width * input.height || !pixelColor(change[1])) return sequence;
      }
    }
    if (!changeCount) return sequence;
    if (pending && pending.width === input.width && pending.height === input.height) {
      const layerIds = new Set([...pending.layers.keys(), ...input.layers.map((layer) => layer.layerId)]);
      if (layerIds.size > MAX_LAYERS) return sequence;
    }
    sequence += 1;
    if (pending && (pending.width !== input.width || pending.height !== input.height)) {
      pending = null;
      lastSentAt = null;
      cancelTimer();
    }
    pending ??= {
      width: input.width,
      height: input.height,
      baseRevision: input.baseRevision,
      layers: new Map(),
    };
    pending.baseRevision = Math.max(pending.baseRevision, input.baseRevision);
    for (const layer of input.layers) {
      if (!layer.changes.length) continue;
      let mutations = pending.layers.get(layer.layerId);
      if (!mutations) pending.layers.set(layer.layerId, mutations = new Map());
      for (const [index, color] of layer.changes) mutations.set(index, { color, sequence });
    }
    const remaining = lastSentAt === null ? 0 : interval - (Date.now() - lastSentAt);
    if (remaining <= 0) flush();
    else if (timer === undefined) timer = setTimeout(flush, remaining);
    return sequence;
  };

  // A bulk fill is one atomic ephemeral packet, never thousands of triples.
  // Rejection is explicit: callers must not ACK an unrelated previous sequence.
  const enqueueRuns = (input: LivePixelRunInput): number | undefined => {
    if (disposed || sequence === Number.MAX_SAFE_INTEGER || !ownRecord(input) ||
      !isValidImageDimensions(input.width, input.height) || !safeInteger(input.baseRevision) ||
      !identifier(input.layerId) || !pixelColor(input.color) ||
      !validRuns(input.runs, input.width * input.height)) return undefined;
    const payload = {
      preview_protocol: 2, width: input.width, height: input.height,
      base_revision: input.baseRevision, layer_id: input.layerId,
      color: input.color, runs: input.runs, preview_sequence: sequence + 1,
    };
    if (!packetFits(payload)) return undefined;
    // Flush older brush ink first so arrival order agrees with local chronology.
    if (pending && (pending.width !== input.width || pending.height !== input.height)) {
      pending = null; cancelTimer();
    } else flush();
    sequence += 1;
    try { send({ ...payload, runs: input.runs.map((run) => [run[0], run[1]]) }); }
    catch { /* Safe persistence is independent of best-effort preview delivery. */ }
    lastSentAt = Date.now();
    return sequence;
  };

  const clear = () => {
    cancelTimer();
    pending = null;
    lastSentAt = null;
  };
  return {
    enqueue,
    enqueueRuns,
    flush,
    clear,
    dispose: () => { clear(); disposed = true; },
  };
};

/**
 * A visual-only overlay. Explicit ACKs wait for their canonical revision; lost
 * ACKs can be recovered by observing individual pixels in the raw server state.
 * Local render buffers never constitute a persistence or history confirmation.
 */
export const createLivePixelPreviewOverlay = () => {
  const clients = new Map<string, ClientPreview>();
  let arrivalOrder = 0;
  let minimumBaseRevision = 0;
  let canonicalRevision = -1;
  let observedCanonicalRevision = -1;
  let observedCanonicalDocument: PixelArtDocumentV2 | null = null;
  let pendingBarrierRevision = 0;
  let generation = 0;
  let renderCache: { input: PixelArtDocumentV2; result: PixelArtDocumentV2; revision: number; generation: number } | null = null;
  const changedState = () => { generation += 1; renderCache = null; };

  // Reserve the worst-case retirement bitset on receipt. Canonical observations
  // can then retire checkerboard-shaped pieces without a million tombstones.
  const runsFitBudget = (clientId: string, layerId: string, candidate: readonly PreviewRun[], differentFrame = false): boolean => {
    let nodes = 0; let bytes = 0;
    const masks = new Set<Retirement>();
    const count = (runs: readonly PreviewRun[]) => {
      nodes += runs.length;
      for (const run of runs) {
        bytes += 128;
        if (run.retirement) {
          if (!masks.has(run.retirement)) { masks.add(run.retirement); bytes += run.retirement.bits.byteLength; }
        } else if (!run.retiredAll) bytes += Math.ceil((run.end - run.start) / 8);
      }
    };
    for (const [id, client] of clients) {
      if (id === clientId && differentFrame) continue;
      for (const [knownLayerId, runs] of client.runLayers) {
        if (id === clientId && knownLayerId === layerId) continue;
        count(runs);
      }
    }
    count(candidate);
    return nodes <= MAX_RUNS && bytes <= MAX_RETAINED_RUN_BYTES;
  };

  const applyCanonicalBarrier = (): boolean => {
    if (!pendingBarrierRevision || observedCanonicalRevision < pendingBarrierRevision) return false;
    const changed = clients.size > 0;
    minimumBaseRevision = Math.max(minimumBaseRevision, pendingBarrierRevision);
    pendingBarrierRevision = 0;
    clients.clear();
    changedState();
    return changed;
  };

  /** A hint cannot discard ink before that history/frame barrier is canonical. */
  const invalidateAt = (revision: number): boolean => {
    if (!safeInteger(revision) || revision <= minimumBaseRevision) return false;
    pendingBarrierRevision = Math.max(pendingBarrierRevision, revision);
    return applyCanonicalBarrier();
  };

  const newClient = (now: number): ClientPreview => ({
    width: 0,
    height: 0,
    frameSequence: 0,
    frameBaseRevision: 0,
    confirmedSequence: 0,
    acknowledgements: new Map(),
    layers: new Map(),
    retiredLayers: new Map(),
    runLayers: new Map(),
    touchedAt: now,
  });

  const retireConfirmed = (client: ClientPreview) => {
    let changed = false;
    for (const [revision, sequence] of client.acknowledgements) {
      if (revision > canonicalRevision) continue;
      client.confirmedSequence = Math.max(client.confirmedSequence, sequence);
      client.acknowledgements.delete(revision);
    }
    for (const [layerId, pixels] of client.layers) {
      for (const [index, pixel] of pixels) {
        if (pixel.sequence <= client.confirmedSequence) {
          pixels.delete(index);
          changed = true;
        }
      }
      if (!pixels.size) client.layers.delete(layerId);
    }
    for (const [layerId, pixels] of client.retiredLayers) {
      for (const [index, pixel] of pixels) {
        if (pixel.sequence <= client.confirmedSequence) pixels.delete(index);
      }
      if (!pixels.size) client.retiredLayers.delete(layerId);
    }
    for (const [layerId, runs] of client.runLayers) {
      const remaining = runs.filter((run) => run.sequence > client.confirmedSequence);
      if (remaining.length !== runs.length) { changed = true; client.runLayers.set(layerId, remaining); }
      if (!remaining.length) client.runLayers.delete(layerId);
    }
    if (changed) changedState();
    return changed;
  };

  const retireObservedPixel = (
    client: ClientPreview,
    layerId: string,
    pixels: Map<number, PreviewPixel>,
    index: number,
    pixel: PreviewPixel,
    now: number,
  ) => {
    let retired = client.retiredLayers.get(layerId);
    if (!retired) client.retiredLayers.set(layerId, retired = new Map());
    retired.set(index, { sequence: pixel.sequence, retiredAt: now });
    pixels.delete(index);
    client.touchedAt = now;
  };

  const retireObserved = (client: ClientPreview, now: number): boolean => {
    const document = observedCanonicalDocument;
    if (!document || document.width !== client.width || document.height !== client.height) return false;
    let changed = false;
    const canonicalLayers = new Map(document.layers.map((layer) => [layer.id, layer]));
    for (const [layerId, pixels] of client.layers) {
      const canonicalLayer = canonicalLayers.get(layerId);
      for (const [index, pixel] of pixels) {
        if (observedCanonicalRevision <= pixel.baseRevision) continue;
        // Observation is per-index, never a global sequence ACK: the rest
        // of an ongoing stroke may not have reached the server yet.
        if (canonicalLayer && !samePixelColor(canonicalLayer.pixels[index], pixel.color)) continue;
        retireObservedPixel(client, layerId, pixels, index, pixel, now);
        changed = true;
      }
      if (!pixels.size) client.layers.delete(layerId);
    }
    for (const [layerId, runs] of client.runLayers) {
      const layer = canonicalLayers.get(layerId);
      for (const run of runs) {
        if (run.retiredAll || run.pendingExpired || observedCanonicalRevision <= run.baseRevision ||
          run.lastObservedRevision === observedCanonicalRevision) continue;
        run.lastObservedRevision = observedCanonicalRevision;
        let matches = 0;
        for (let index = run.start; index < run.end; index += 1) {
          if (retiredAtIndex(run, index) || !layer || samePixelColor(layer.pixels[index], run.color)) matches += 1;
        }
        if (matches === run.end - run.start) {
          run.retiredAll = true; run.retiredAt = now; run.retirement = undefined;
          changed = true;
        } else if (matches) {
          const retirement = run.retirement ?? {
            origin: run.start, bits: new Uint8Array(Math.ceil((run.end - run.start) / 8)), retiredAt: now,
          };
          let newlyRetired = false;
          for (let index = run.start; index < run.end; index += 1) {
            if (retiredAtIndex(run, index) || (layer && !samePixelColor(layer.pixels[index], run.color))) continue;
            const offset = index - retirement.origin;
            retirement.bits[offset >>> 3] = retirement.bits[offset >>> 3]! | (1 << (offset & 7));
            newlyRetired = true;
          }
          run.retirement = retirement;
          if (newlyRetired) { retirement.retiredAt = now; changed = true; }
        }
      }
    }
    if (changed) { client.touchedAt = now; changedState(); }
    return changed;
  };

  const prune = (nowMs?: number): boolean => {
    const now = clock(nowMs);
    let changed = false;
    for (const [clientId, client] of clients) {
      if (now - client.touchedAt >= PREVIEW_TTL_MS) {
        clients.delete(clientId);
        changed = true;
        continue;
      }
      for (const [layerId, pixels] of client.layers) {
        for (const [index, pixel] of pixels) {
          if (now - pixel.receivedAt >= PREVIEW_TTL_MS) {
            pixels.delete(index);
            changed = true;
          }
        }
        if (!pixels.size) client.layers.delete(layerId);
      }
      for (const [layerId, pixels] of client.retiredLayers) {
        for (const [index, pixel] of pixels) {
          if (now - pixel.retiredAt >= PREVIEW_TTL_MS) {
            pixels.delete(index);
            changed = true;
          }
        }
        if (!pixels.size) client.retiredLayers.delete(layerId);
      }
      for (const [layerId, runs] of client.runLayers) {
        const remaining: PreviewRun[] = [];
        for (const run of runs) {
          const pendingExpired = now - run.receivedAt >= PREVIEW_TTL_MS;
          const retirementExpired = run.retiredAll
            ? now - (run.retiredAt ?? run.receivedAt) >= PREVIEW_TTL_MS
            : run.retirement && now - run.retirement.retiredAt >= PREVIEW_TTL_MS;
          if (retirementExpired) {
            run.retiredAll = false; run.retirement = undefined; run.retiredAt = undefined;
            changed = true;
          }
          if (pendingExpired && !run.pendingExpired) { run.pendingExpired = true; changed = true; }
          if (pendingExpired && !run.retiredAll && !run.retirement) { changed = true; continue; }
          remaining.push(run);
        }
        if (remaining.length) client.runLayers.set(layerId, remaining);
        else client.runLayers.delete(layerId);
      }
    }
    if (changed) changedState();
    return changed;
  };

  const receiveRuns = (clientId: string, payload: Record<string, unknown>, now: number): boolean => {
    const keys = ["preview_protocol", "width", "height", "base_revision", "layer_id", "color", "runs", "preview_sequence"];
    if (keys.some((key) => !Object.hasOwn(payload, key)) ||
      Object.keys(payload).some((key) => !keys.includes(key)) ||
      typeof payload.width !== "number" || typeof payload.height !== "number" ||
      !isValidImageDimensions(payload.width, payload.height) || !safeInteger(payload.base_revision) ||
      payload.base_revision < minimumBaseRevision || !identifier(payload.layer_id) ||
      !safeInteger(payload.preview_sequence, 1) || !pixelColor(payload.color) ||
      !validRuns(payload.runs, payload.width * payload.height) || !packetFits(payload)) return false;
    prune(now);
    let client = clients.get(clientId);
    if (!client && clients.size >= MAX_CLIENTS) return false;
    client ??= newClient(now);
    retireConfirmed(client);
    const sequence = payload.preview_sequence;
    if (sequence <= client.confirmedSequence) return false;
    const differentFrame = client.width !== payload.width || client.height !== payload.height;
    if (differentFrame && client.frameSequence > 0 && sequence <= client.frameSequence) return false;
    const previousRuns = differentFrame ? [] : client.runLayers.get(payload.layer_id) ?? [];
    const blockers: Span[] = [];
    for (const run of previousRuns) {
      if (run.sequence < sequence) continue;
      if (!run.pendingExpired || run.retiredAll) blockers.push({ start: run.start, end: run.end });
      else {
        let start = -1;
        for (let index = run.start; index <= run.end; index += 1) {
          const blocked = index < run.end && retiredAtIndex(run, index);
          if (blocked && start < 0) start = index;
          if (!blocked && start >= 0) { blockers.push({ start, end: index }); start = -1; }
          if (blockers.length > MAX_RUNS) return false;
        }
      }
    }
    if (!differentFrame) {
      for (const [index, pixel] of client.layers.get(payload.layer_id) ?? []) {
        if (pixel.sequence >= sequence) blockers.push({ start: index, end: index + 1 });
      }
      for (const [index, pixel] of client.retiredLayers.get(payload.layer_id) ?? []) {
        if (pixel.sequence >= sequence) blockers.push({ start: index, end: index + 1 });
      }
    }
    const source = payload.runs.map(([start, length]) => ({ start, end: start + length }));
    const accepted = subtractSpans(source, mergeSpans(blockers));
    if (!accepted?.length) return false;
    const remaining = subtractSpans(previousRuns, accepted);
    if (!remaining) return false;
    const order = arrivalOrder + 1;
    const incoming = accepted.map((span): PreviewRun => ({
      ...span, color: payload.color as PixelColor, sequence, baseRevision: payload.base_revision as number,
      receivedAt: now, order,
    }));
    const candidate = [...remaining, ...incoming].sort((left, right) => left.start - right.start);
    if (!runsFitBudget(clientId, payload.layer_id, candidate, differentFrame)) return false;
    const knownLayers = new Set<string>();
    for (const [id, other] of clients) {
      if (differentFrame && id === clientId) continue;
      for (const layerId of [...other.layers.keys(), ...other.retiredLayers.keys(), ...other.runLayers.keys()]) knownLayers.add(layerId);
    }
    if (!knownLayers.has(payload.layer_id) && knownLayers.size >= MAX_LAYERS) return false;
    if (differentFrame) { client.layers.clear(); client.retiredLayers.clear(); client.runLayers.clear(); }
    else {
      for (const pixels of [client.layers.get(payload.layer_id), client.retiredLayers.get(payload.layer_id)]) {
        if (!pixels) continue;
        for (const index of pixels.keys()) if (indexInSpans(accepted, index)) pixels.delete(index);
      }
    }
    client.width = payload.width; client.height = payload.height;
    client.frameSequence = Math.max(client.frameSequence, sequence);
    client.frameBaseRevision = Math.max(client.frameBaseRevision, payload.base_revision);
    client.runLayers.set(payload.layer_id, candidate); client.touchedAt = now;
    arrivalOrder = order; clients.set(clientId, client); changedState();
    retireObserved(client, now);
    return true;
  };

  const receive = (clientId: string, payload: Record<string, unknown>, nowMs?: number): boolean => {
    if (!identifier(clientId) || !ownRecord(payload)) return false;
    if (payload.preview_protocol === 2) return receiveRuns(clientId, payload, clock(nowMs));
    const keys = ["preview_protocol", "width", "height", "base_revision", "layer_id", "changes", "preview_sequence"];
    if (keys.some((key) => !Object.hasOwn(payload, key)) || payload.preview_protocol !== 1 ||
      typeof payload.width !== "number" || typeof payload.height !== "number" || !isValidImageDimensions(payload.width, payload.height) ||
      !safeInteger(payload.base_revision) || payload.base_revision < minimumBaseRevision ||
      !identifier(payload.layer_id) || !safeInteger(payload.preview_sequence, 1) ||
      !Array.isArray(payload.changes) || !payload.changes.length ||
      payload.changes.length > MAX_PACKET_CHANGES) return false;
    const changes = new Map<number, Mutation>();
    for (const change of payload.changes) {
      if (!Array.isArray(change) || change.length !== 3 || !safeInteger(change[0]) ||
        change[0] >= payload.width * payload.height || !pixelColor(change[1]) ||
        !safeInteger(change[2], 1) || change[2] > payload.preview_sequence) return false;
      const previous = changes.get(change[0]);
      if (!previous || change[2] > previous.sequence) {
        changes.set(change[0], { color: change[1], sequence: change[2] });
      }
    }
    const now = clock(nowMs);
    prune(now);
    let client = clients.get(clientId);
    if (!client && clients.size >= MAX_CLIENTS) return false;
    client ??= newClient(now);
    retireConfirmed(client);
    const differentFrame = client.width !== payload.width || client.height !== payload.height;
    if (differentFrame && client.frameSequence > 0 && payload.preview_sequence <= client.frameSequence) return false;
    const existing = differentFrame ? undefined : client.layers.get(payload.layer_id);
    const retired = differentFrame ? undefined : client.retiredLayers.get(payload.layer_id);
    const runs = differentFrame ? [] : client.runLayers.get(payload.layer_id) ?? [];
    let added = 0;
    for (const [index, mutation] of changes) {
      if (mutation.sequence > client.confirmedSequence && !existing?.has(index) &&
        !retired?.has(index)) added += 1;
    }
    let totalLayerPixels = 0;
    const knownLayers = new Set<string>();
    for (const [otherId, other] of clients) {
      if (differentFrame && otherId === clientId) continue;
      totalLayerPixels += other.layers.get(payload.layer_id)?.size ?? 0;
      totalLayerPixels += other.retiredLayers.get(payload.layer_id)?.size ?? 0;
      for (const layerId of other.layers.keys()) knownLayers.add(layerId);
      for (const layerId of other.retiredLayers.keys()) knownLayers.add(layerId);
      for (const layerId of other.runLayers.keys()) knownLayers.add(layerId);
    }
    if (totalLayerPixels + added > MAX_LAYER_PIXELS ||
      (!knownLayers.has(payload.layer_id) && knownLayers.size >= MAX_LAYERS)) return false;
    const acceptedChanges = [...changes].filter(([index, mutation]) => {
      const run = runAt(runs, index);
      return mutation.sequence > client.confirmedSequence &&
        mutation.sequence > (existing?.get(index)?.sequence ?? 0) &&
        mutation.sequence > (retired?.get(index)?.sequence ?? 0) &&
        !(run && runBlocksIndex(run, index) && mutation.sequence <= run.sequence);
    });
    if (!acceptedChanges.length) return false;
    const acceptedIndexes = mergeSpans(acceptedChanges.map(([index]) => ({ start: index, end: index + 1 })));
    const remainingRuns = subtractSpans(runs, acceptedIndexes);
    if (!remainingRuns || !runsFitBudget(clientId, payload.layer_id, remainingRuns, differentFrame)) return false;
    if (differentFrame) {
      client.layers.clear();
      client.retiredLayers.clear();
      client.runLayers.clear();
    }
    client.width = payload.width;
    client.height = payload.height;
    client.frameSequence = Math.max(client.frameSequence, payload.preview_sequence);
    client.frameBaseRevision = Math.max(client.frameBaseRevision, payload.base_revision);
    let pixels = client.layers.get(payload.layer_id);
    if (!pixels) client.layers.set(payload.layer_id, pixels = new Map());
    let changed = false;
    for (const [index, mutation] of acceptedChanges) {
      retired?.delete(index);
      pixels.set(index, {
        ...mutation,
        baseRevision: payload.base_revision,
        receivedAt: now,
        order: ++arrivalOrder,
      });
      changed = true;
    }
    if (runs.length) {
      if (remainingRuns.length) client.runLayers.set(payload.layer_id, remainingRuns);
      else client.runLayers.delete(payload.layer_id);
    }
    if (!pixels.size) client.layers.delete(payload.layer_id);
    if (retired && !retired.size) client.retiredLayers.delete(payload.layer_id);
    if (changed) { client.touchedAt = now; changedState(); }
    clients.set(clientId, client);
    // A delayed packet can arrive after its persisted snapshot. Retire it
    // against the actual last server document, not any local render buffer.
    retireObserved(client, now);
    return changed;
  };

  const confirm = (clientId: string, sequence: number, revision: number): void => {
    if (!identifier(clientId) || !safeInteger(sequence) || !safeInteger(revision)) return;
    let client = clients.get(clientId);
    if (!client && clients.size >= MAX_CLIENTS) return;
    client ??= newClient(Date.now());
    if (sequence <= client.confirmedSequence) return;
    // Drop dominated confirmations; keep a bounded set of future revisions.
    for (const [otherRevision, otherSequence] of client.acknowledgements) {
      if (otherRevision <= revision && otherSequence >= sequence) return;
      if (otherRevision >= revision && otherSequence <= sequence) {
        client.acknowledgements.delete(otherRevision);
      }
    }
    if (client.acknowledgements.size < MAX_LAYERS || client.acknowledgements.has(revision)) {
      client.acknowledgements.set(revision, Math.max(sequence, client.acknowledgements.get(revision) ?? 0));
    }
    retireConfirmed(client);
    clients.set(clientId, client);
  };

  /** Only pass the raw authoritative server document, never a local overlay. */
  const observeCanonical = (
    document: PixelArtDocumentV2,
    revision: number,
    nowMs?: number,
  ): boolean => {
    if (!safeInteger(revision) || revision < observedCanonicalRevision || revision < minimumBaseRevision) return false;
    const now = clock(nowMs);
    let changed = prune(now);
    if (observedCanonicalDocument !== document || observedCanonicalRevision !== revision) changedState();
    observedCanonicalDocument = document;
    observedCanonicalRevision = revision;
    canonicalRevision = Math.max(canonicalRevision, revision);
    changed = applyCanonicalBarrier() || changed;
    for (const client of clients.values()) {
      changed = retireConfirmed(client) || changed;
      changed = retireObserved(client, now) || changed;
    }
    return changed;
  };

  const render = (
    document: PixelArtDocumentV2,
    revision: number,
    nowMs?: number,
  ): PixelArtDocumentV2 => {
    const now = clock(nowMs);
    prune(now);
    if (!safeInteger(revision)) return document;
    canonicalRevision = revision;
    for (const client of clients.values()) retireConfirmed(client);
    const sameRenderInput = (previous: PixelArtDocumentV2): boolean =>
      previous.version === document.version && previous.width === document.width && previous.height === document.height &&
      (previous.palette === document.palette || (previous.palette.length === document.palette.length &&
        previous.palette.every((color, index) => color === document.palette[index]))) && previous.layers.length === document.layers.length &&
      previous.layers.every((layer, index) => {
        const next = document.layers[index]!;
        return layer.id === next.id && layer.name === next.name && layer.visible === next.visible &&
          layer.locked === next.locked && layer.opacity === next.opacity && layer.pixels === next.pixels;
      });
    if (renderCache && renderCache.generation === generation && renderCache.revision === revision && sameRenderInput(renderCache.input)) {
      return renderCache.result === renderCache.input ? document : renderCache.result;
    }
    const layerIds = new Set(document.layers.map((layer) => layer.id));
    type Command = { order: number; pixel?: readonly [number, PreviewPixel]; run?: PreviewRun };
    const commands = new Map<string, Command[]>();
    const append = (layerId: string, command: Command) => {
      const entries = commands.get(layerId) ?? [];
      entries.push(command); commands.set(layerId, entries);
    };
    for (const client of clients.values()) {
      if (client.width !== document.width || client.height !== document.height) {
        if (client.frameBaseRevision <= revision) {
          client.layers.clear();
          client.retiredLayers.clear();
          client.runLayers.clear();
          changedState();
        }
        continue;
      }
      for (const [layerId, pixels] of client.layers) {
        for (const [index, pixel] of pixels) {
          if (pixel.baseRevision > revision) continue;
          if (!layerIds.has(layerId)) { pixels.delete(index); changedState(); continue; }
          append(layerId, { order: pixel.order, pixel: [index, pixel] });
        }
        if (!pixels.size) client.layers.delete(layerId);
      }
      for (const [layerId, runs] of client.runLayers) {
        if (!layerIds.has(layerId)) {
          const future = runs.filter((run) => run.baseRevision > revision);
          if (future.length !== runs.length) { client.runLayers.set(layerId, future); changedState(); }
          if (!future.length) client.runLayers.delete(layerId);
          continue;
        }
        for (const run of runs) {
          if (run.baseRevision <= revision && !run.retiredAll && !run.pendingExpired) append(layerId, { order: run.order, run });
        }
      }
    }
    let changed = false;
    const authoritativeLayers = observedCanonicalDocument && observedCanonicalRevision === revision &&
      observedCanonicalDocument.width === document.width && observedCanonicalDocument.height === document.height
      ? new Map(observedCanonicalDocument.layers.map((layer) => [layer.id, layer])) : null;
    const layers = document.layers.map((layer) => {
      const mutations = commands.get(layer.id);
      if (!mutations) return layer;
      let pixels: PixelColor[] | undefined;
      const authoritativePixels = authoritativeLayers?.get(layer.id)?.pixels;
      const localPendingPixels = authoritativePixels && authoritativePixels !== layer.pixels ? authoritativePixels : undefined;
      mutations.sort((left, right) => left.order - right.order);
      for (const command of mutations) {
        if (command.pixel) {
          const [index, pixel] = command.pixel;
          if (localPendingPixels && !samePixelColor(layer.pixels[index], localPendingPixels[index]!)) continue;
          if ((pixels ?? layer.pixels)[index] === pixel.color) continue;
          pixels ??= layer.pixels.slice(); pixels[index] = pixel.color;
        } else if (command.run) {
          const run = command.run;
          let start = -1;
          const apply = (from: number, to: number) => {
            // Avoid allocating a clone for an already-identical canonical run.
            let differs = false;
            for (let index = from; index < to && !differs; index += 1) differs = (pixels ?? layer.pixels)[index] !== run.color;
            if (!differs) return;
            pixels ??= layer.pixels.slice(); pixels.fill(run.color, from, to);
          };
          if (!run.retirement) apply(run.start, run.end);
          else for (let index = run.start; index <= run.end; index += 1) {
            const active = index < run.end && !retiredAtIndex(run, index);
            if (active && start < 0) start = index;
            if (!active && start >= 0) { apply(start, index); start = -1; }
          }
        }
      }
      if (!pixels) return layer;
      // Optimistic local edits remain visible over unconfirmed remote ink.
      // Only raw server observations retire previews, never this render input.
      if (localPendingPixels) {
        for (let index = 0; index < pixels.length; index += 1) {
          if (!samePixelColor(layer.pixels[index], localPendingPixels[index]!)) pixels[index] = layer.pixels[index]!;
        }
      }
      changed = true;
      return { ...layer, pixels: registerNormalizedPixelArray(pixels) };
    });
    const result = changed ? { ...document, layers } : document;
    renderCache = { input: document, result, revision, generation };
    return result;
  };

  return {
    receive,
    confirm,
    observeCanonical,
    invalidateAt,
    render,
    removeClient: (clientId: string): boolean => {
      const removed = clients.delete(clientId); if (removed) changedState(); return removed;
    },
    clear: (floor?: number) => {
      clients.clear();
      changedState();
      observedCanonicalDocument = null;
      observedCanonicalRevision = -1;
      if (safeInteger(floor)) minimumBaseRevision = Math.max(minimumBaseRevision, floor);
      if (pendingBarrierRevision <= minimumBaseRevision) pendingBarrierRevision = 0;
    },
    prune,
  };
};
