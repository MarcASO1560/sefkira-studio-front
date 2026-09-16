import { ref } from "vue";
import type { ProjectResourceDetail } from "../../../lib/api";
import type { PixelArtDocumentV2, SaveStatus } from "../types";
import { clonePixelArtDocument } from "../lib/document";
import { parsePixelArtResourceData } from "../lib/migrations";
import { applyImageActions, diffImageDocuments, ImageOperationConflict, splitImageActionBatches, validateImageOperation, type ImageOperation } from "../lib/imageOperations";
import { claimImageOperationSession, createImageOperationId, createIndexedDbImageOperationStore, type ImageOperationStore, type StoredImageOperationQueue } from "../lib/imageOperationStore";
import { createImageOperationTransport, ImageOperationHttpError, normalizeImageOperationResource, validateImageOperationAcknowledgement, type ImageOperationTransport } from "../lib/imageOperationsApi";

export type ImageOperationDocumentContext = {
  resource: ProjectResourceDetail;
  previousDocument: PixelArtDocumentV2 | null;
  source: "remote" | "ack" | "recovery";
  pendingCount: number;
};
export type ImageOperationSyncOptions = {
  projectId: string;
  resourceId: string;
  userId: string | (() => string | null | undefined);
  onDocument: (document: PixelArtDocumentV2, context: ImageOperationDocumentContext) => void;
  onConflict?: (error: Error) => void;
  store?: ImageOperationStore;
  transport?: ImageOperationTransport;
  debounceMs?: number;
  isOnline?: () => boolean;
};
type PendingEntry = { operation: ImageOperation; durable: boolean; acknowledgedRevision?: number };
const resourceDocument = (resource: ProjectResourceDetail) => resource.data.pixel_art as PixelArtDocumentV2;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const sameDocumentContent = (left: PixelArtDocumentV2, right: PixelArtDocumentV2) => JSON.stringify({ ...left, palette: [] }) === JSON.stringify({ ...right, palette: [] });
const message = (error: unknown) => error instanceof Error ? error.message : "Unable to synchronize changes. Your pending operations have been retained.";

/** A single writer per tab. An operation leaves the queue only after a valid ACK. */
export const useImageOperationSync = (options: ImageOperationSyncOptions) => {
  const status = ref<SaveStatus>("saved");
  const errorMessage = ref("");
  const hasPendingChanges = ref(false);
  const lastSavedAt = ref<number | null>(null);
  const isReady = ref(false);
  const pendingCount = ref(0);
  const transport = options.transport ?? createImageOperationTransport(options.projectId, options.resourceId);
  const online = options.isOnline ?? (() => typeof navigator === "undefined" || navigator.onLine !== false);
  const debounceMs = options.debounceMs ?? 420;
  let canonical: ProjectResourceDetail | null = null;
  let observed: PixelArtDocumentV2 | null = null;
  let entries: PendingEntry[] = [];
  let store: ImageOperationStore | null = options.store ?? null;
  let releaseSession: (() => void) | null = null;
  let scopeUserId: string | null = null;
  let storeInitialization: Promise<void> | null = null;
  let persistence: Promise<void> = Promise.resolve();
  let persistenceActive: Promise<void> | null = null;
  let persistenceVersion = 0;
  let active: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let interactionActive = false;
  let deferredSource: ImageOperationDocumentContext["source"] | null = null;
  let recoveryFailed = false;
  let dirtyWrites = 0;
  let unencodableLocalChanges = false;
  let retryableFailure = false;
  let retryFailures = 0;
  let retryAfter = 0;
  let discarding = false;

  const userId = () => typeof options.userId === "function" ? options.userId() : options.userId;
  const verifyScope = () => {
    if (!scopeUserId || userId() !== scopeUserId) throw new Error("The signed-in account changed. Pending changes remain attached to the original account.");
  };
  const initializeStore = () => {
    if (!storeInitialization) storeInitialization = (async () => {
      const currentUser = userId();
      if (!currentUser) throw new Error("Sign in before synchronizing image changes.");
      scopeUserId = currentUser;
      if (!store) {
        const session = await claimImageOperationSession();
        releaseSession = session.release;
        store = createIndexedDbImageOperationStore({ userId: currentUser, projectId: options.projectId, resourceId: options.resourceId, sessionId: session.id });
      }
    })();
    return storeInitialization;
  };
  const syncPending = () => {
    pendingCount.value = entries.length;
    hasPendingChanges.value = entries.length > 0 || dirtyWrites > 0 || unencodableLocalChanges;
  };
  const report = (error: unknown, transportFailure = false) => {
    errorMessage.value = message(error);
    status.value = online() ? "error" : "offline";
    retryableFailure = transportFailure && (error instanceof ImageOperationHttpError
      ? error.status >= 500 || [408, 429].includes(error.status)
      : error instanceof TypeError || error instanceof Error && /network|connection|fetch|socket|timed?\s*out|ack\s+lost/i.test(error.message));
    if (retryableFailure) { retryFailures += 1; retryAfter = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(retryFailures - 1, 5)); }
    if (error instanceof ImageOperationConflict || error instanceof ImageOperationHttpError && error.status === 409) options.onConflict?.(error);
  };
  const persist = () => {
    persistenceVersion += 1;
    dirtyWrites = 1;
    syncPending();
    if (persistenceActive) return persistenceActive;
    const operation = (async () => {
      await initializeStore();
      verifyScope();
      if (recoveryFailed) throw new Error("Pending-change recovery failed. Keep this tab open; no existing local queue will be overwritten.");
      let writtenVersion = -1;
      do {
        writtenVersion = persistenceVersion;
        // Capture at execution, not scheduling time; serialize every commit.
        const acknowledgedIds = new Set(entries.filter((entry) => entry.acknowledgedRevision !== undefined).map((entry) => entry.operation.operation_id));
        const pending = entries.filter((entry) => !acknowledgedIds.has(entry.operation.operation_id)).map((entry) => copy(entry.operation));
        const savedPayloads = new Map(pending.map((operation) => [operation.operation_id, JSON.stringify(operation)]));
        await store!.write({ version: 1, resource: canonical ? copy(canonical) : null, operations: pending, ...((pending.length || unencodableLocalChanges) && observed ? { localDocument: clonePixelArtDocument(observed), localDocumentUnencodable: unencodableLocalChanges } : {}) });
        entries = entries.filter((entry) => !acknowledgedIds.has(entry.operation.operation_id));
        for (const entry of entries) if (savedPayloads.get(entry.operation.operation_id) === JSON.stringify(entry.operation)) entry.durable = true;
        // Mousemove bursts coalesce while a transaction is in flight, without
        // resolving durability until the newest queued edit has been committed.
      } while (writtenVersion !== persistenceVersion);
    })();
    persistenceActive = operation;
    persistence = operation;
    void operation.then(() => { if (persistenceActive === operation) { persistenceActive = null; dirtyWrites = 0; } syncPending(); }, (error) => { if (persistenceActive === operation) { persistenceActive = null; dirtyWrites = 0; } syncPending(); report(error); });
    return operation;
  };
  const overlay = () => {
    if (!canonical) return null;
    let document = clonePixelArtDocument(resourceDocument(canonical));
    for (const entry of entries) {
      if (entry.acknowledgedRevision !== undefined && entry.acknowledgedRevision <= canonical.revision) continue;
      const operation = entry.operation;
      if (operation.actions[0]?.type === "replace" && canonical.revision !== operation.base_revision && !(operation._client_expected_document && sameDocumentContent(document, operation._client_expected_document))) throw new ImageOperationConflict("The remote image changed before your canvas replacement was confirmed. Your local copy is preserved.");
      document = applyImageActions(document, operation.actions, operation);
    }
    return document;
  };
  const publish = (source: ImageOperationDocumentContext["source"]) => {
    if (!canonical || disposed) return;
    if (unencodableLocalChanges) { deferredSource = source; return; }
    if (interactionActive) { deferredSource = source; return; }
    try {
      const document = overlay()!;
      const previousDocument = observed ? clonePixelArtDocument(observed) : null;
      observed = clonePixelArtDocument(document);
      options.onDocument(document, { resource: canonical, previousDocument, source, pendingCount: entries.length });
    } catch (error) { report(error); }
  };
  const accept = (resource: ProjectResourceDetail, source: ImageOperationDocumentContext["source"]) => {
    const normalized = normalizeImageOperationResource(resource, options.projectId, options.resourceId);
    if (canonical && normalized.revision < canonical.revision) return false;
    canonical = normalized;
    publish(source);
    return true;
  };
  const clearTimer = () => { if (timer !== null) clearTimeout(timer); timer = null; };

  const start = async (initialResource: ProjectResourceDetail) => {
    if (disposed) return;
    const normalized = normalizeImageOperationResource(initialResource, options.projectId, options.resourceId);
    await initializeStore();
    verifyScope();
    let recovered: StoredImageOperationQueue | null;
    try {
      recovered = await store!.read();
      if (recovered && (recovered.version !== 1 || !Array.isArray(recovered.operations) || !recovered.operations.every(validateImageOperation))) throw new Error("Your saved pending-change queue is invalid. It has been preserved for recovery.");
      if (recovered?.localDocument) parsePixelArtResourceData({ pixel_art: recovered.localDocument });
    } catch (error) {
      recoveryFailed = true;
      // Editing may continue in memory, but never overwrite an unreadable draft.
      canonical = normalized;
      observed = clonePixelArtDocument(resourceDocument(normalized));
      isReady.value = true;
      report(error);
      return;
    }
    entries = (recovered?.operations ?? []).map((operation) => ({ operation: copy(operation), durable: true }));
    canonical = normalized;
    if (recovered?.resource) {
      const cached = normalizeImageOperationResource(recovered.resource, options.projectId, options.resourceId);
      if (cached.revision > normalized.revision) canonical = cached;
    }
    syncPending();
    isReady.value = true;
    if (recovered?.localDocument) {
      unencodableLocalChanges = recovered.localDocumentUnencodable === true || recovered.localDocumentUnencodable === undefined && !entries.length;
      observed = clonePixelArtDocument(recovered.localDocument);
      options.onDocument(clonePixelArtDocument(observed), { resource: canonical, previousDocument: null, source: "recovery", pendingCount: entries.length });
      syncPending();
      if (unencodableLocalChanges) {
        report(new ImageOperationConflict("A local image copy could not be synchronized and has been recovered. Export it before resolving the conflict."));
        return;
      }
    }
    status.value = online() ? entries.length ? "dirty" : "saved" : "offline";
    publish("recovery");
    if (entries.length && online() && ((status.value as SaveStatus) !== "error" || entries[0]?.operation._client_attempted)) scheduleTimer();
  };

  const fetchCanonical = async () => {
    verifyScope();
    const resource = await transport.fetchResource();
    if (!disposed && !discarding) accept(resource, "remote");
  };
  const process = async () => {
    let transportFailure = false;
    try {
      await persistence;
      if (disposed || discarding || !online() || !entries.length) return;
      // A new connection/retry starts from current server state, not stale cache.
      transportFailure = true;
      await fetchCanonical();
      transportFailure = false;
      while (!disposed && !discarding && online() && entries.length) {
        status.value = "saving";
        errorMessage.value = "";
        await persist();
        if (!entries.length) break;
        const entry = entries[0]!;
        if (!entry.durable) throw new Error("Changes must be stored on this device before they can be sent.");
        const operation = entry.operation;
        if (operation.actions[0]?.type === "replace" && !operation._client_attempted) {
          if (!operation._client_expected_document || !sameDocumentContent(resourceDocument(canonical!), operation._client_expected_document)) throw new ImageOperationConflict("The remote image changed before your canvas replacement was confirmed. Export your local copy before resolving this conflict.");
          operation.base_revision = canonical!.revision;
          operation.width = resourceDocument(canonical!).width;
          operation.height = resourceDocument(canonical!).height;
        }
        // Persist attempted state before transmission: lost ACKs must retry the
        // identical packet, including when the server has since resized a canvas.
        operation._client_attempted = true;
        await persist();
        const packet: ImageOperation = { operation_id: operation.operation_id, base_revision: operation.base_revision, width: operation.width, height: operation.height, actions: copy(operation.actions) };
        transportFailure = true;
        const response = await transport.sendOperation(packet);
        transportFailure = false;
        const acknowledgement = validateImageOperationAcknowledgement(response, operation, options.projectId, options.resourceId);
        if (disposed) return; // The durable queue survives a late response after navigation.
        entry.acknowledgedRevision = acknowledgement.applied_revision;
        accept(acknowledgement.resource, "ack");
        await persist();
        lastSavedAt.value = Date.now();
        retryableFailure = false;
        retryFailures = 0;
      }
      if (!disposed) {
        status.value = online() ? unencodableLocalChanges ? "error" : entries.length ? "dirty" : "saved" : "offline";
        if (!entries.length && !unencodableLocalChanges) errorMessage.value = "";
      }
    } catch (error) { report(error, transportFailure); }
    finally { syncPending(); }
  };
  const run = () => {
    clearTimer();
    if (active) return active;
    if (discarding) return Promise.resolve();
    const operation = process();
    active = operation;
    void operation.finally(() => {
      if (active === operation) active = null;
      if (!disposed && entries.length && status.value === "dirty") scheduleTimer();
    });
    return operation;
  };
  function scheduleTimer() {
    clearTimer();
    timer = setTimeout(() => { timer = null; void run(); }, debounceMs);
  }

  const schedule = async (document: PixelArtDocumentV2, settings: { conditional?: boolean; forceReplace?: boolean } = {}) => {
    if (disposed || !isReady.value || !canonical || !observed) return Promise.resolve();
    let actions;
    try { verifyScope(); actions = diffImageDocuments(observed, document, { conditional: settings.conditional, replace: settings.forceReplace }); }
    catch (error) { report(error); return Promise.resolve(); }
    const before = observed;
    observed = clonePixelArtDocument(document);
    if (!actions.length) return Promise.resolve();
    const isNormalPixels = (value: ImageOperation) => value.actions.every((action) => action.type === "pixels" && action.changes.every((change) => change.length === 2));
    let batches;
    try { batches = splitImageActionBatches(actions); }
    catch (error) { unencodableLocalChanges = true; syncPending(); report(error); await persist().catch(() => undefined); return; }
    for (const actions of batches) {
      const operation: ImageOperation = { operation_id: createImageOperationId(), base_revision: canonical.revision, width: before.width, height: before.height, actions, ...(actions[0]?.type === "replace" ? { _client_expected_document: clonePixelArtDocument(before) } : {}) };
      if (!validateImageOperation(operation)) { unencodableLocalChanges = true; syncPending(); report(new Error("The local edit cannot be encoded safely. Keep this tab open and export your local image.")); await persist().catch(() => undefined); return; }
      const last = entries.at(-1);
      if (last && !last.operation._client_attempted && last.acknowledgedRevision === undefined && last.operation.width === operation.width && last.operation.height === operation.height && isNormalPixels(last.operation) && isNormalPixels(operation)) {
      // Mousemove previews collapse into a durable stroke-sized packet. Once a
      // packet may have reached the server its payload is immutable forever.
      const combined = new Map<string, Map<number, [number, import("../types").PixelColor]>>();
      for (const action of [...last.operation.actions, ...operation.actions]) {
        if (action.type !== "pixels") continue;
        const changes = combined.get(action.layer_id) ?? new Map();
        for (const [index, value] of action.changes) changes.set(index, [index, value]);
        combined.set(action.layer_id, changes);
      }
        const combinedActions = [...combined].map(([layer_id, changes]) => ({ type: "pixels" as const, layer_id, changes: [...changes.values()] }));
        if (validateImageOperation({ ...last.operation, actions: combinedActions }) && splitImageActionBatches(combinedActions).length === 1) { last.operation.actions = combinedActions; last.durable = false; }
        else entries.push({ operation, durable: false });
      } else entries.push({ operation, durable: false });
    }
    syncPending();
    status.value = online() ? active ? "saving" : "dirty" : "offline";
    errorMessage.value = "";
    const stored = persist();
    if (online() && !active) scheduleTimer();
    // Pointer handlers need not await: state/queue were updated synchronously.
    return stored.catch(() => undefined);
  };
  const flush = async () => {
    clearTimer();
    await persistence.catch(() => undefined);
    if (!disposed && online() && entries.length) await run();
  };
  const refresh = async () => {
    if (disposed || discarding || !isReady.value) return;
    const resumeRetry = retryableFailure;
    let transportFailure = false;
    try {
      await persistence;
      transportFailure = true;
      await fetchCanonical();
      transportFailure = false;
      if (discarding || disposed) return;
      await persist();
      if (!entries.length && !unencodableLocalChanges && !recoveryFailed) {
        status.value = online() ? "saved" : "offline";
        errorMessage.value = "";
        retryableFailure = false;
        retryFailures = 0;
      } else if ((retryableFailure || resumeRetry && entries[0]?.operation._client_attempted) && online() && !active && Date.now() >= retryAfter) await run();
    }
    catch (error) { report(error, transportFailure); }
  };
  const retry = async () => {
    if (disposed || !online()) { status.value = "offline"; return; }
    if (recoveryFailed) { report(new Error("Your previous pending changes could not be recovered. Keep this tab open and export the image before reloading.")); return; }
    errorMessage.value = "";
    try { await persist(); if (entries.length) await flush(); else await refresh(); } catch (error) { report(error); }
  };
  const acceptResource = async (resource: ProjectResourceDetail) => {
    if (!isReady.value || disposed || discarding) return;
    try { if (accept(resource, "remote")) await persist(); } catch (error) { report(error); }
  };
  const discardPending = async () => {
    discarding = true;
    clearTimer();
    try {
      if (active) await active;
      await persistence.catch(() => undefined);
      if (recoveryFailed) throw new Error("The unreadable local queue cannot safely be discarded automatically.");
      verifyScope();
      // Never discard before the user-requested replacement can actually load.
      const latest = normalizeImageOperationResource(await transport.fetchResource(), options.projectId, options.resourceId);
      verifyScope();
      await persistence.catch(() => undefined);
      await store!.write({ version: 1, resource: copy(latest), operations: [] });
      entries = [];
      unencodableLocalChanges = false;
      canonical = latest;
      retryableFailure = false;
      retryFailures = 0;
      syncPending();
      publish("remote");
      status.value = "saved";
      errorMessage.value = "";
    } finally { discarding = false; clearTimer(); }
  };
  const setInteractionActive = (value: boolean) => {
    interactionActive = value;
    if (!value && deferredSource) { const source = deferredSource; deferredSource = null; publish(source); }
  };
  const getCachedResource = async () => {
    await initializeStore();
    verifyScope();
    const cached = await store!.read();
    return cached?.resource ? normalizeImageOperationResource(cached.resource, options.projectId, options.resourceId) : null;
  };
  const handleOnline = () => { void retry(); };
  const handleOffline = () => { clearTimer(); status.value = "offline"; };
  if (typeof window !== "undefined") {
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
  }
  const dispose = () => {
    disposed = true;
    clearTimer();
    if (typeof window !== "undefined") { window.removeEventListener("online", handleOnline); window.removeEventListener("offline", handleOffline); }
    // Let the last local write finish before releasing the tab's ownership.
    void persistence.catch(() => undefined).finally(() => { store?.dispose?.(); releaseSession?.(); });
  };
  return { status, errorMessage, hasPendingChanges, lastSavedAt, isReady, pendingCount, start, schedule, flush, refresh, retry, acceptResource, discardPending, setInteractionActive, getCachedResource, dispose };
};
