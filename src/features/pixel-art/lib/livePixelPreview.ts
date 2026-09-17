import type { PixelArtDocumentV2, PixelColor } from "../types";

const MAX_DIMENSION = 256;
const MAX_PACKET_CHANGES = 1024;
const MAX_LAYER_PIXELS = 65_536;
const MAX_LAYERS = 128;
const MAX_CLIENTS = 50;
const MAX_ID_LENGTH = 200;
const PREVIEW_TTL_MS = 30_000;

type PreviewInput = {
  width: number;
  height: number;
  baseRevision: number;
  layers: Array<{ layerId: string; changes: Array<readonly [number, PixelColor]> }>;
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
  touchedAt: number;
};

const safeInteger = (value: unknown, minimum = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const dimension = (value: unknown): value is number =>
  safeInteger(value, 1) && value <= MAX_DIMENSION;
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
      !dimension(input.width) || !dimension(input.height) ||
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

  const clear = () => {
    cancelTimer();
    pending = null;
    lastSentAt = null;
  };
  return {
    enqueue,
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

  const applyCanonicalBarrier = (): boolean => {
    if (!pendingBarrierRevision || observedCanonicalRevision < pendingBarrierRevision) return false;
    const changed = clients.size > 0;
    minimumBaseRevision = Math.max(minimumBaseRevision, pendingBarrierRevision);
    pendingBarrierRevision = 0;
    clients.clear();
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
    }
    return changed;
  };

  const receive = (clientId: string, payload: Record<string, unknown>, nowMs?: number): boolean => {
    if (!identifier(clientId) || !ownRecord(payload)) return false;
    const keys = ["preview_protocol", "width", "height", "base_revision", "layer_id", "changes", "preview_sequence"];
    if (keys.some((key) => !Object.hasOwn(payload, key)) || payload.preview_protocol !== 1 ||
      !dimension(payload.width) || !dimension(payload.height) ||
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
    }
    if (totalLayerPixels + added > MAX_LAYER_PIXELS ||
      (!knownLayers.has(payload.layer_id) && knownLayers.size >= MAX_LAYERS)) return false;
    if (differentFrame) {
      client.layers.clear();
      client.retiredLayers.clear();
    }
    client.width = payload.width;
    client.height = payload.height;
    client.frameSequence = Math.max(client.frameSequence, payload.preview_sequence);
    client.frameBaseRevision = Math.max(client.frameBaseRevision, payload.base_revision);
    let pixels = client.layers.get(payload.layer_id);
    if (!pixels) client.layers.set(payload.layer_id, pixels = new Map());
    let changed = false;
    for (const [index, mutation] of changes) {
      if (mutation.sequence <= client.confirmedSequence ||
        mutation.sequence <= (pixels.get(index)?.sequence ?? 0) ||
        mutation.sequence <= (retired?.get(index)?.sequence ?? 0)) continue;
      retired?.delete(index);
      pixels.set(index, {
        ...mutation,
        baseRevision: payload.base_revision,
        receivedAt: now,
        order: ++arrivalOrder,
      });
      changed = true;
    }
    if (!pixels.size) client.layers.delete(payload.layer_id);
    if (retired && !retired.size) client.retiredLayers.delete(payload.layer_id);
    if (changed) client.touchedAt = now;
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
    const layerIds = new Set(document.layers.map((layer) => layer.id));
    const winners = new Map<string, Map<number, PreviewPixel>>();
    for (const client of clients.values()) {
      retireConfirmed(client);
      if (client.width !== document.width || client.height !== document.height) {
        if (client.frameBaseRevision <= revision) {
          client.layers.clear();
          client.retiredLayers.clear();
        }
        continue;
      }
      for (const [layerId, pixels] of client.layers) {
        for (const [index, pixel] of pixels) {
          if (pixel.baseRevision > revision) continue;
          if (!layerIds.has(layerId)) { pixels.delete(index); continue; }
          let layerWinners = winners.get(layerId);
          if (!layerWinners) winners.set(layerId, layerWinners = new Map());
          const previous = layerWinners.get(index);
          if (!previous || pixel.order > previous.order) layerWinners.set(index, pixel);
        }
        if (!pixels.size) client.layers.delete(layerId);
      }
    }
    let changed = false;
    const layers = document.layers.map((layer) => {
      const mutations = winners.get(layer.id);
      if (!mutations) return layer;
      let pixels: PixelColor[] | undefined;
      for (const [index, pixel] of mutations) {
        if (layer.pixels[index] === pixel.color) continue;
        pixels ??= [...layer.pixels];
        pixels[index] = pixel.color;
      }
      if (!pixels) return layer;
      changed = true;
      return { ...layer, pixels };
    });
    return changed ? { ...document, layers } : document;
  };

  return {
    receive,
    confirm,
    observeCanonical,
    invalidateAt,
    render,
    removeClient: (clientId: string): boolean => clients.delete(clientId),
    clear: (floor?: number) => {
      clients.clear();
      observedCanonicalDocument = null;
      observedCanonicalRevision = -1;
      if (safeInteger(floor)) minimumBaseRevision = Math.max(minimumBaseRevision, floor);
      if (pendingBarrierRevision <= minimumBaseRevision) pendingBarrierRevision = 0;
    },
    prune,
  };
};
