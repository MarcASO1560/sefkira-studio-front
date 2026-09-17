import { computed, ref } from "vue";
import type { ProjectResourceDetail } from "../../../lib/api";
import type { PixelArtDocumentV2, PixelColor, SaveStatus } from "../types";
import { clonePixelArtDocument, isValidImageDimensions, normalizePixelColor, MAX_IMAGE_PIXEL_COUNT } from "../lib/document";
import { compactPixelArtDocument } from "../lib/compactPixels";
import { registerNormalizedPixelArray } from "../lib/pixelBufferTrust";
import { parsePixelArtResourceData } from "../lib/migrations";
import { applyImageActions, diffImageDocuments, ImageOperationConflict, rebaseImageOperationActions, splitImageActionBatches, validateImageOperation, type ImageOperation, type ImageOperationTransform, type ImageResizeOperation, type SharedImageHistory } from "../lib/imageOperations";
import { claimImageOperationSession, createImageOperationId, createIndexedDbImageOperationStore, type ImageOperationStore, type StoredImageOperationQueue } from "../lib/imageOperationStore";
import { createImageOperationTransport, ImageOperationHttpError, normalizeImageOperationResource, validateImageOperationAcknowledgement, validateImageOperationState, validateImageOperationTransforms, validateSharedImageHistory, type ImageOperationTransport } from "../lib/imageOperationsApi";

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
  onAccessDenied?: (status: number) => void;
  onAcknowledged?: (acknowledgement: { operationId: string; appliedRevision: number; previewSequence?: number; previewBarrier?: boolean }) => void;
  store?: ImageOperationStore;
  transport?: ImageOperationTransport;
  debounceMs?: number;
  isOnline?: () => boolean;
};
export type ImageOperationScheduleSettings = { conditional?: boolean; forceReplace?: boolean; resize?: ImageResizeOperation; historyGroupId?: string; previewSequence?: number };
export type ImageOperationPixelChange = Readonly<{ index: number; after: PixelColor; before?: PixelColor }>;
export type ImageOperationPixelScheduleSettings = Pick<ImageOperationScheduleSettings, "conditional" | "historyGroupId" | "previewSequence">;
type PendingEntry = { operation: ImageOperation; durable: boolean; acknowledgedRevision?: number; previewSequence?: number; historySendStarted?: boolean };
const resourceDocument = (resource: ProjectResourceDetail) => resource.data.pixel_art as PixelArtDocumentV2;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const sameDocumentContent = (left: PixelArtDocumentV2, right: PixelArtDocumentV2) => JSON.stringify({ ...left, palette: [] }) === JSON.stringify({ ...right, palette: [] });
const message = (error: unknown) => error instanceof Error ? error.message : "Unable to synchronize changes. Your pending operations have been retained.";
const isSharedHistoryOperation = (operation: ImageOperation) => operation.actions.some((action) => action.type === "undo" || action.type === "redo");

/** A single writer per tab. An operation leaves the queue only after a valid ACK. */
export const useImageOperationSync = (options: ImageOperationSyncOptions) => {
  const status = ref<SaveStatus>("saved");
  const errorMessage = ref("");
  const hasPendingChanges = ref(false);
  const lastSavedAt = ref<number | null>(null);
  const isReady = ref(false);
  const pendingCount = ref(0);
  const online = options.isOnline ?? (() => typeof navigator === "undefined" || navigator.onLine !== false);
  const connectionOnline = ref(online());
  const accessDenied = ref(false);
  const sharedHistory = ref<SharedImageHistory>({ can_undo: false, can_redo: false });
  const isHistoryBusy = ref(false);
  const hasPendingEdits = ref(false);
  const canUndo = computed(() => !accessDenied.value && connectionOnline.value && isReady.value && !isHistoryBusy.value && (sharedHistory.value.can_undo || hasPendingEdits.value));
  const canRedo = computed(() => !accessDenied.value && connectionOnline.value && isReady.value && !isHistoryBusy.value && !hasPendingEdits.value && sharedHistory.value.can_redo);
  const transport = options.transport ?? createImageOperationTransport(options.projectId, options.resourceId);
  const debounceMs = options.debounceMs ?? 100;
  let canonical: ProjectResourceDetail | null = null;
  let journalCanonical: { source: ProjectResourceDetail; snapshot: ProjectResourceDetail } | null = null;
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
  let transforms: ImageOperationTransform[] = [];
  let historyRequestActive = false;
  let observedCanonicalRevision = 0;
  let canonicalRequest: { promise: Promise<void>; since: number } | null = null;
  let resyncVersion = 0;
  let synchronizedVersion = 0;
  const persistenceCheckpoints = new Set<{ ready: () => boolean; resolve: () => void; reject: (error: unknown) => void }>();

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
    hasPendingEdits.value = entries.some((entry) => entry.operation.actions.some((action) => action.type !== "undo" && action.type !== "redo"));
    isHistoryBusy.value = historyRequestActive || entries.some((entry) => entry.operation.actions.some((action) => action.type === "undo" || action.type === "redo"));
  };
  const report = (error: unknown, transportFailure = false) => {
    if (transportFailure) resyncVersion += 1;
    errorMessage.value = message(error);
    status.value = online() ? "error" : "offline";
    retryableFailure = transportFailure && (error instanceof ImageOperationHttpError
      ? error.status >= 500 || [408, 429].includes(error.status)
      : error instanceof TypeError || error instanceof Error && /network|connection|fetch|socket|timed?\s*out|ack\s+lost/i.test(error.message));
    if (retryableFailure) { retryFailures += 1; retryAfter = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(retryFailures - 1, 5)); }
    if (error instanceof ImageOperationHttpError && [401, 403, 404].includes(error.status)) {
      const notify = !accessDenied.value;
      accessDenied.value = true;
      if (notify) options.onAccessDenied?.(error.status);
    }
    if (error instanceof ImageOperationConflict || error instanceof ImageOperationHttpError && error.status === 409) options.onConflict?.(error);
  };
  const canonicalForJournal = () => {
    if (!canonical) return null;
    // The canonical resource is replaced, never edited by this synchronizer.
    // Keep a private snapshot detached from the resource exposed to UI callbacks
    // and copy it once per accepted snapshot, not once per pointer frame.
    if (journalCanonical?.source !== canonical) {
      const snapshot = copy({ ...canonical, data: { ...canonical.data, pixel_art: null } }) as ProjectResourceDetail;
      snapshot.data.pixel_art = compactPixelArtDocument(resourceDocument(canonical));
      journalCanonical = { source: canonical, snapshot };
    }
    return journalCanonical.snapshot;
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
        // observed is private and updated by copy-on-write. A store's asynchronous
        // transaction may safely retain this exact frame while later pointers
        // create another one; it still stores the complete recoverable local copy.
        await store!.write({ version: 1, resource: canonicalForJournal(), operations: pending, transforms: copy(transforms), history: copy(sharedHistory.value), ...((pending.length || unencodableLocalChanges) && observed ? { localDocument: compactPixelArtDocument(observed), localDocumentUnencodable: unencodableLocalChanges, localDocumentRevision: observedCanonicalRevision } : {}) });
        entries = entries.filter((entry) => !acknowledgedIds.has(entry.operation.operation_id));
        for (const entry of entries) if (savedPayloads.get(entry.operation.operation_id) === JSON.stringify(entry.operation)) entry.durable = true;
        for (const checkpoint of persistenceCheckpoints) {
          if (checkpoint.ready()) { persistenceCheckpoints.delete(checkpoint); checkpoint.resolve(); }
        }
        // Mousemove bursts coalesce while a transaction is in flight, without
        // resolving durability until the newest queued edit has been committed.
      } while (writtenVersion !== persistenceVersion);
      // Checkpoint continuations may enqueue the next packet before a promise's
      // .then cleanup runs. Release ownership synchronously with the last write.
      persistenceActive = null;
      dirtyWrites = 0;
      syncPending();
    })();
    persistenceActive = operation;
    persistence = operation;
    void operation.then(() => { if (persistenceActive === operation) { persistenceActive = null; dirtyWrites = 0; } syncPending(); }, (error) => {
      if (persistenceActive === operation) { persistenceActive = null; dirtyWrites = 0; }
      for (const checkpoint of persistenceCheckpoints) { persistenceCheckpoints.delete(checkpoint); checkpoint.reject(error); }
      syncPending(); report(error);
    });
    return operation;
  };
  const persistUntil = (ready: () => boolean) => {
    if (ready()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const checkpoint = { ready, resolve, reject };
      persistenceCheckpoints.add(checkpoint);
      // The writer rejects only outstanding checkpoints on failure. Do not
      // retain one promise listener per packet until an endless stroke stops.
      void persist();
    });
  };
  const overlay = () => {
    if (!canonical) return null;
    let document = clonePixelArtDocument(resourceDocument(canonical));
    for (const entry of entries) {
      if (entry.acknowledgedRevision !== undefined && entry.acknowledgedRevision <= canonical.revision) continue;
      const operation = entry.operation;
      if ((operation.actions[0]?.type === "resize" || operation.actions[0]?.type === "import") && transforms.some((event) => event.operation_id === operation.operation_id && event.user_id === scopeUserId && event.revision <= canonical!.revision)) continue;
      if (operation.actions[0]?.type === "replace" && canonical.revision !== operation.base_revision && !(operation._client_expected_document && sameDocumentContent(document, operation._client_expected_document))) throw new ImageOperationConflict("The remote image changed before your canvas replacement was confirmed. Your local copy is preserved.");
      if (operation.actions[0]?.type === "resize" || operation.actions[0]?.type === "undo" || operation.actions[0]?.type === "redo" || operation.actions[0]?.type === "replace" || operation.actions[0]?.type === "import") document = applyImageActions(document, operation.actions, operation);
      else {
        const rebased = rebaseImageOperationActions(operation, transforms, scopeUserId ?? undefined);
        document = applyImageActions(document, rebased.actions, rebased);
      }
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
      observedCanonicalRevision = canonical.revision;
      options.onDocument(document, { resource: canonical, previousDocument, source, pendingCount: entries.length });
    } catch (error) { report(error); }
  };
  const acceptNormalized = (normalized: ProjectResourceDetail, source: ImageOperationDocumentContext["source"]) => {
    if (canonical && normalized.revision < canonical.revision) return false;
    canonical = normalized;
    publish(source);
    return true;
  };
  const accept = (resource: ProjectResourceDetail, source: ImageOperationDocumentContext["source"]) =>
    acceptNormalized(normalizeImageOperationResource(resource, options.projectId, options.resourceId), source);
  const mergeState = (revision: number, history?: SharedImageHistory, events?: ImageOperationTransform[]) => {
    if (events) {
      const byRevision = new Map(transforms.map((event) => [event.revision, event]));
      for (const event of events) {
        const existing = byRevision.get(event.revision);
        if (existing) {
          const immutable = ["revision", "from_width", "from_height", "to_width", "to_height", "offset_x", "offset_y"] as const;
          if (immutable.some((field) => existing[field] !== event[field]) || existing.operation_id && event.operation_id && existing.operation_id !== event.operation_id || existing.user_id && event.user_id && existing.user_id !== event.user_id) throw new Error("The server returned inconsistent shared coordinate history.");
          // Geometry survives account deletion; its nullable provenance may be
          // cleared by ON DELETE SET NULL without invalidating pixel mappings.
          byRevision.set(event.revision, { ...existing, ...event, operation_id: event.operation_id ?? existing.operation_id, user_id: event.user_id === undefined ? existing.user_id : event.user_id });
        } else byRevision.set(event.revision, event);
      }
      transforms = [...byRevision.values()].sort((left, right) => left.revision - right.revision);
    }
    if (history && (!canonical || revision >= canonical.revision)) sharedHistory.value = history;
  };
  const clearTimer = () => { if (timer !== null) clearTimeout(timer); timer = null; };

  const start = async (initialResource: ProjectResourceDetail) => {
    if (disposed) return;
    connectionOnline.value = online();
    const normalized = normalizeImageOperationResource(initialResource, options.projectId, options.resourceId);
    await initializeStore();
    verifyScope();
    let recovered: StoredImageOperationQueue | null;
    let recoveredDocument: PixelArtDocumentV2 | null = null;
    try {
      recovered = await store!.read();
      if (recovered && (recovered.version !== 1 || !Array.isArray(recovered.operations) || !recovered.operations.every(validateImageOperation))) throw new Error("Your saved pending-change queue is invalid. It has been preserved for recovery.");
      if (recovered?.localDocument) recoveredDocument = parsePixelArtResourceData({ pixel_art: recovered.localDocument }).document;
      if (recovered?.transforms) validateImageOperationTransforms(recovered.transforms);
      if (recovered?.history) validateSharedImageHistory(recovered.history);
    } catch (error) {
      recoveryFailed = true;
      // Editing may continue in memory, but never overwrite an unreadable draft.
      canonical = normalized;
      observed = clonePixelArtDocument(resourceDocument(normalized));
      observedCanonicalRevision = normalized.revision;
      isReady.value = true;
      report(error);
      return;
    }
    entries = (recovered?.operations ?? []).map((operation) => ({ operation: copy(operation), durable: true }));
    if (entries.length || !online()) resyncVersion += 1;
    transforms = copy(recovered?.transforms ?? []);
    if (recovered?.history) sharedHistory.value = recovered.history;
    canonical = normalized;
    if (recovered?.resource) {
      const cached = normalizeImageOperationResource(recovered.resource, options.projectId, options.resourceId);
      if (cached.revision > normalized.revision) canonical = cached;
    }
    syncPending();
    isReady.value = true;
    if (recovered?.localDocument) {
      unencodableLocalChanges = recovered.localDocumentUnencodable === true || recovered.localDocumentUnencodable === undefined && !entries.length;
      observed = clonePixelArtDocument(recoveredDocument!);
      observedCanonicalRevision = recovered.localDocumentRevision ?? (entries.length ? Math.min(...entries.map((entry) => entry.operation.base_revision)) : canonical.revision);
      options.onDocument(clonePixelArtDocument(observed), { resource: canonical, previousDocument: null, source: "recovery", pendingCount: entries.length });
      syncPending();
      if (unencodableLocalChanges) {
        report(new ImageOperationConflict("A local image copy could not be synchronized and has been recovered. Export it before resolving the conflict."));
        return;
      }
    }
    status.value = online() ? entries.length ? "dirty" : "saved" : "offline";
    if (online() && transport.fetchState) {
      try { await fetchCanonical(); } catch (error) { report(error, true); }
    }
    publish("recovery");
    if (entries.length && online() && ((status.value as SaveStatus) !== "error" || entries[0]?.operation._client_attempted)) scheduleTimer();
  };

  const fetchCanonical = async (requireFresh = false): Promise<void> => {
    verifyScope();
    const since = entries.length ? Math.min(...entries.map((entry) => entry.operation.base_revision)) : canonical?.revision ?? 0;
    if (canonicalRequest && !requireFresh) {
      // A shared request must include every queued operation's coordinate frame.
      if (canonicalRequest.since <= since || !transport.fetchState) return canonicalRequest.promise;
      return canonicalRequest.promise.then(() => fetchCanonical());
    }
    const requestedResyncVersion = resyncVersion;
    const promise = (async () => {
      if (transport.fetchState) {
        const state = validateImageOperationState(await transport.fetchState(since), options.projectId, options.resourceId);
        if (!disposed && !discarding) {
          mergeState(state.resource.revision, state.history, state.transforms);
          acceptNormalized(state.resource, "remote");
        }
      } else {
        const resource = await transport.fetchResource();
        if (!disposed && !discarding) accept(resource, "remote");
      }
      synchronizedVersion = Math.max(synchronizedVersion, requestedResyncVersion);
    })();
    canonicalRequest = { promise, since };
    void promise.then(() => { if (canonicalRequest?.promise === promise) canonicalRequest = null; }, () => { if (canonicalRequest?.promise === promise) canonicalRequest = null; });
    return promise;
  };
  const process = async () => {
    let transportFailure = false;
    try {
      if (disposed || discarding || !online() || !entries.length) return;
      verifyScope();
      while (!disposed && !discarding && online() && entries.length) {
        status.value = "saving";
        errorMessage.value = "";
        const entry = entries[0]!;
        const operation = entry.operation;
        const normalDelta = operation.actions.every((action) => action.type === "pixels" || action.type === "layer-update");
        const sharedHistoryCommand = isSharedHistoryOperation(operation);
        if (!normalDelta && !sharedHistoryCommand || operation._client_attempted || resyncVersion > synchronizedVersion) {
          // Reconnect/retry and structural edits retain a fresh server barrier.
          // History commands select the global head under the server's row lock,
          // independent of the cached canvas frame; a pre-send GET cannot make
          // that selection more current and only adds another round trip.
          transportFailure = true;
          await fetchCanonical(!normalDelta || operation._client_attempted === true);
          transportFailure = false;
        }
        if (disposed || discarding || !online() || !entries.includes(entry)) return;
        if (operation.actions[0]?.type === "replace" && !operation._client_attempted) {
          if (!operation._client_expected_document || !sameDocumentContent(resourceDocument(canonical!), operation._client_expected_document)) throw new ImageOperationConflict("The remote image changed before your canvas replacement was confirmed. Export your local copy before resolving this conflict.");
          operation.base_revision = canonical!.revision;
          operation.width = resourceDocument(canonical!).width;
          operation.height = resourceDocument(canonical!).height;
          entry.durable = false;
        }
        // Persist attempted state before transmission: lost ACKs must retry the
        // identical packet, including when the server has since resized a canvas.
        const alreadyAttempted = operation._client_attempted === true;
        operation._client_attempted = true;
        if (!alreadyAttempted) entry.durable = false;
        // Freeze this packet before waiting for its transaction. New pointer
        // frames use a different entry and cannot postpone this packet's write.
        try { await persistUntil(() => entry.durable || !entries.includes(entry)); } catch (error) { if (!alreadyAttempted) operation._client_attempted = false; throw error; }
        if (disposed || discarding || !online() || !entries.includes(entry)) return;
        verifyScope();
        const packet: ImageOperation = { operation_id: operation.operation_id, base_revision: operation.base_revision, width: operation.width, height: operation.height, actions: copy(operation.actions), ...(operation.history_group_id ? { history_group_id: operation.history_group_id } : {}), ...(operation.coordinate_after_operation_id ? { coordinate_after_operation_id: operation.coordinate_after_operation_id } : {}) };
        transportFailure = true;
        if (sharedHistoryCommand) entry.historySendStarted = true;
        const response = await transport.sendOperation(packet);
        transportFailure = false;
        const acknowledgement = validateImageOperationAcknowledgement(response, operation, options.projectId, options.resourceId);
        if (disposed) return; // The durable queue survives a late response after navigation.
        entry.acknowledgedRevision = acknowledgement.applied_revision;
        for (const pending of entries) if (pending.operation.coordinate_after_operation_id === operation.operation_id || pending.operation._client_frame_dependency === operation.operation_id) pending.operation._client_dependency_revision = acknowledgement.applied_revision;
        mergeState(acknowledgement.resource.revision, acknowledgement.history, acknowledgement.transforms);
        acceptNormalized(acknowledgement.resource, "ack");
        options.onAcknowledged?.({
          operationId: operation.operation_id,
          appliedRevision: acknowledgement.applied_revision,
          ...(entry.previewSequence !== undefined ? { previewSequence: entry.previewSequence } : {}),
          ...(packet.actions.some((action) => action.type === "undo" || action.type === "redo" || action.type === "import" || action.type === "resize" || action.type === "replace") ? { previewBarrier: true } : {}),
        });
        await persistUntil(() => !entries.includes(entry));
        lastSavedAt.value = Date.now();
        retryableFailure = false;
        retryFailures = 0;
      }
      if (!disposed) {
        status.value = online() ? unencodableLocalChanges ? "error" : entries.length ? "dirty" : "saved" : "offline";
        if (!entries.length && !unencodableLocalChanges) errorMessage.value = "";
      }
    } catch (error) {
      // A never-transmitted history command must not become a future Undo
      // against an unseen head after a failed pre-send synchronization request.
      const head = entries[0];
      if (transportFailure && head && !head.operation._client_attempted && head.operation.actions.some((action) => action.type === "undo" || action.type === "redo")) {
        const retained = entries;
        entries = entries.filter((entry) => entry !== head);
        try { await persist(); } catch { entries = retained; }
      }
      report(error, transportFailure);
    }
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
    if (timer !== null) return;
    timer = setTimeout(() => { timer = null; void run(); }, debounceMs);
  }

  const queueActions = async (before: PixelArtDocumentV2, actions: Parameters<typeof splitImageActionBatches>[0], settings: ImageOperationScheduleSettings) => {
    if (!actions.length) return;
    const isNormalPixels = (value: ImageOperation) => value.actions.every((action) => action.type === "pixels" && action.changes.every((change) => change.length === 2));
    let batches;
    try { batches = splitImageActionBatches(actions); }
    catch (error) { unencodableLocalChanges = true; syncPending(); report(error); await persist().catch(() => undefined); return; }
    for (const [batchIndex, actions] of batches.entries()) {
      const previewSequence = batchIndex === batches.length - 1 ? settings.previewSequence : undefined;
      const dependency = [...entries].reverse().find((entry) => entry.acknowledgedRevision === undefined && !transforms.some((event) => event.operation_id === entry.operation.operation_id && event.user_id === scopeUserId && event.revision <= observedCanonicalRevision) && (entry.operation.actions[0]?.type === "resize" || entry.operation.actions[0]?.type === "import" || entry.operation.actions[0]?.type === "replace" && entry.operation._client_expected_document && (entry.operation.actions[0].document.width !== entry.operation._client_expected_document.width || entry.operation.actions[0].document.height !== entry.operation._client_expected_document.height)));
      const operation: ImageOperation = { operation_id: createImageOperationId(), base_revision: observedCanonicalRevision, width: before.width, height: before.height, actions, ...(actions[0]?.type === "replace" ? { _client_expected_document: clonePixelArtDocument(before) } : {}), ...(settings.historyGroupId ? { history_group_id: settings.historyGroupId } : {}), ...(dependency ? { coordinate_after_operation_id: dependency.operation.operation_id } : {}) };
      if (!validateImageOperation(operation)) { unencodableLocalChanges = true; syncPending(); report(new Error("The local edit cannot be encoded safely. Keep this tab open and export your local image.")); await persist().catch(() => undefined); return; }
      const last = entries.at(-1);
      if (last && !last.operation._client_attempted && last.acknowledgedRevision === undefined && last.operation.width === operation.width && last.operation.height === operation.height && last.operation.base_revision === operation.base_revision && last.operation.coordinate_after_operation_id === operation.coordinate_after_operation_id && last.operation.history_group_id === operation.history_group_id && isNormalPixels(last.operation) && isNormalPixels(operation)) {
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
        if (validateImageOperation({ ...last.operation, actions: combinedActions }) && splitImageActionBatches(combinedActions).length === 1) { last.operation.actions = combinedActions; last.durable = false; if (previewSequence !== undefined) last.previewSequence = previewSequence; }
        else entries.push({ operation, durable: false, ...(previewSequence !== undefined ? { previewSequence } : {}) });
      } else entries.push({ operation, durable: false, ...(previewSequence !== undefined ? { previewSequence } : {}) });
    }
    syncPending();
    status.value = online() ? active ? "saving" : "dirty" : "offline";
    errorMessage.value = "";
    const stored = persist();
    if (online() && !active) scheduleTimer();
    // Pointer handlers need not await: state/queue were updated synchronously.
    return stored.catch(() => undefined);
  };
  const schedule = async (document: PixelArtDocumentV2, settings: ImageOperationScheduleSettings = {}) => {
    if (disposed || !isReady.value || !canonical || !observed) return;
    let actions;
    try { verifyScope(); actions = diffImageDocuments(observed, document, { conditional: settings.conditional, replace: settings.forceReplace, resize: settings.resize }); }
    catch (error) { report(error); return; }
    const before = observed;
    observed = clonePixelArtDocument(document);
    return queueActions(before, actions, settings);
  };
  /** A brush submits exact sparse deltas, never a trusted replacement document. */
  const schedulePixels = async (width: number, height: number, layerId: string, changes: readonly ImageOperationPixelChange[], settings: ImageOperationPixelScheduleSettings = {}) => {
    if (disposed || !isReady.value || !canonical || !observed) return;
    try {
      verifyScope();
      if (!isValidImageDimensions(width, height) || width !== observed.width || height !== observed.height) throw new Error("The pixel changes do not match this tab's observed canvas dimensions.");
      const layerIndex = observed.layers.findIndex((layer) => layer.id === layerId);
      if (typeof layerId !== "string" || !layerId.trim() || layerIndex < 0) throw new Error("The pixel changes do not match an observed image layer.");
      if (!Array.isArray(changes) || changes.length > MAX_IMAGE_PIXEL_COUNT) throw new Error("The local pixel changes are invalid.");
      const layer = observed.layers[layerIndex]!;
      const desired = new Map<number, PixelColor>();
      for (const change of changes) {
        if (!change || typeof change !== "object" || !Number.isInteger(change.index) || change.index < 0 || change.index >= width * height) throw new Error("The local pixel changes contain an invalid index.");
        const after = change.after === null ? null : normalizePixelColor(change.after);
        if (change.after !== null && after === null) throw new Error("The local pixel changes contain an invalid color.");
        if (change.before !== undefined) {
          const before = change.before === null ? null : normalizePixelColor(change.before);
          if (change.before !== null && before === null) throw new Error("The local pixel changes contain an invalid previous color.");
          if (before !== layer.pixels[change.index] && before !== desired.get(change.index)) throw new Error("The local pixel changes do not match this tab's observed pixels.");
        }
        desired.set(change.index, after);
      }
      const tuples: import("../lib/imageOperations").ImagePixelChange[] = [];
      for (const [index, after] of desired) {
        const before = layer.pixels[index]!;
        if (before === after) continue;
        tuples.push(settings.conditional ? [index, after, before] : [index, after]);
      }
      if (!tuples.length) return;
      tuples.sort((left, right) => left[0] - right[0]);
      const before = observed;
      const pixels = registerNormalizedPixelArray(layer.pixels.slice());
      for (const [index, after] of tuples) pixels[index] = after;
      const layers = observed.layers.slice();
      layers[layerIndex] = { ...layer, pixels };
      observed = { ...observed, layers };
      return queueActions(before, [{ type: "pixels", layer_id: layerId, changes: tuples }], settings);
    } catch (error) { report(error); }
  };
  const flush = async () => {
    clearTimer();
    if (!disposed && online() && entries.length) await run();
    else await persistence.catch(() => undefined);
  };
  const refresh = async (requireFresh = false) => {
    connectionOnline.value = online();
    if (disposed || discarding || !isReady.value) return false;
    const resumeRetry = retryableFailure;
    let transportFailure = false;
    try {
      transportFailure = true;
      await fetchCanonical(requireFresh);
      transportFailure = false;
      if (discarding || disposed) return false;
      await persist();
      if (!entries.length && !unencodableLocalChanges && !recoveryFailed) {
        status.value = online() ? "saved" : "offline";
        errorMessage.value = "";
        retryableFailure = false;
        retryFailures = 0;
      } else if ((retryableFailure || resumeRetry && entries[0]?.operation._client_attempted) && online() && !active && Date.now() >= retryAfter) await run();
      return true;
    }
    catch (error) { report(error, transportFailure); return false; }
  };
  const retry = async () => {
    connectionOnline.value = online();
    resyncVersion += 1;
    if (disposed || !online()) { status.value = "offline"; return; }
    if (recoveryFailed) { report(new Error("Your previous pending changes could not be recovered. Keep this tab open and export the image before reloading.")); return; }
    errorMessage.value = "";
    try { await persist(); if (entries.length) await flush(); else await refresh(); } catch (error) { report(error); }
  };
  const acceptResource = async (resource: ProjectResourceDetail) => {
    if (!isReady.value || disposed || discarding) return;
    try { if (transport.fetchState) { await fetchCanonical(); await persist(); } else if (accept(resource, "remote")) await persist(); } catch (error) { report(error); }
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
      const state = transport.fetchState ? validateImageOperationState(await transport.fetchState(canonical?.revision ?? 0), options.projectId, options.resourceId) : null;
      const latest = state?.resource ?? normalizeImageOperationResource(await transport.fetchResource(), options.projectId, options.resourceId);
      verifyScope();
      await persistence.catch(() => undefined);
      await store!.write({ version: 1, resource: copy(latest), operations: [], history: state?.history ?? sharedHistory.value, transforms: state?.transforms ?? transforms });
      entries = [];
      unencodableLocalChanges = false;
      canonical = latest;
      transforms = state?.transforms ?? transforms;
      if (state) sharedHistory.value = state.history;
      retryableFailure = false;
      retryFailures = 0;
      syncPending();
      publish("remote");
      status.value = "saved";
      errorMessage.value = "";
    } finally { discarding = false; clearTimer(); }
  };
  const changeSharedHistory = async (kind: "undo" | "redo") => {
    connectionOnline.value = online();
    if (!connectionOnline.value) return false;
    if (disposed || !isReady.value || !canonical || accessDenied.value || isHistoryBusy.value || recoveryFailed || unencodableLocalChanges) return false;
    historyRequestActive = true;
    syncPending();
    try {
      // The button acts on the visible shared server order, after this tab's
      // pending stroke(s). Never initiate a new global history action offline.
      await flush();
      if (entries.length || disposed || !online()) return false;
      verifyScope();
      const operation: ImageOperation = { operation_id: createImageOperationId(), base_revision: canonical.revision, width: resourceDocument(canonical).width, height: resourceDocument(canonical).height, actions: [{ type: kind }] };
      // Do not veto a command using stale cached history flags. The server may
      // have received another editor's change or Undo since the last snapshot.
      const entry: PendingEntry = { operation, durable: false, historySendStarted: false };
      entries.push(entry);
      syncPending();
      status.value = online() ? "dirty" : "offline";
      await persist();
      if (online()) await flush();
      return entry.acknowledgedRevision !== undefined && !entries.includes(entry);
    } catch (error) { report(error); return false; }
    finally { historyRequestActive = false; syncPending(); }
  };
  const undo = () => changeSharedHistory("undo");
  const redo = () => changeSharedHistory("redo");
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
  const handleOnline = () => { connectionOnline.value = true; void retry(); };
  const handleOffline = () => {
    resyncVersion += 1;
    connectionOnline.value = false;
    clearTimer();
    status.value = "offline";
    // Marking a packet attempted in the journal precedes its actual send. A
    // command interrupted during that disk write is known never to have reached
    // the server and must not become an unrelated global Undo on reconnection.
    // Recovered attempted packets have unknown send state and remain retryable.
    const retained = entries.filter((entry) => !isSharedHistoryOperation(entry.operation) || entry.operation._client_attempted && entry.historySendStarted !== false);
    if (retained.length !== entries.length) { entries = retained; syncPending(); void persist().catch(() => undefined); }
  };
  if (typeof window !== "undefined") {
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
  }
  const dispose = () => {
    disposed = true;
    clearTimer();
    if (typeof window !== "undefined") { window.removeEventListener("online", handleOnline); window.removeEventListener("offline", handleOffline); }
    const retained = entries.filter((entry) => !isSharedHistoryOperation(entry.operation) || entry.historySendStarted !== false);
    if (retained.length !== entries.length) { entries = retained; syncPending(); void persist().catch(() => undefined); }
    // Let the last local write finish before releasing the tab's ownership.
    void persistence.catch(() => undefined).finally(() => { store?.dispose?.(); releaseSession?.(); });
  };
  return { status, errorMessage, hasPendingChanges, lastSavedAt, isReady, pendingCount, sharedHistory, canUndo, canRedo, isHistoryBusy, undo, redo, start, schedule, schedulePixels, flush, refresh, retry, acceptResource, discardPending, setInteractionActive, getCachedResource, dispose };
};
