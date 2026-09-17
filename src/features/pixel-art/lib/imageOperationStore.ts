import type { ProjectResourceDetail } from "../../../lib/api";
import { validateImageOperation, type ImageOperation, type ImageOperationTransform, type SharedImageHistory } from "./imageOperations";
import type { PixelArtDocumentV2 } from "../types";

export type StoredImageOperationQueue = {
  version: 1;
  resource: ProjectResourceDetail | null;
  operations: ImageOperation[];
  /** Exceptional oversized local copy retained for explicit export/recovery. */
  localDocument?: PixelArtDocumentV2;
  localDocumentUnencodable?: boolean;
  localDocumentRevision?: number;
  transforms?: ImageOperationTransform[];
  history?: SharedImageHistory;
};

export type ImageOperationStore = {
  read: () => Promise<StoredImageOperationQueue | null>;
  write: (queue: StoredImageOperationQueue) => Promise<void>;
  dispose?: () => void;
};

export const createImageOperationId = () => globalThis.crypto?.randomUUID?.()
  ?? `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

const SESSION_KEY = "sefkirastudio.image-operation-session.v1";
const DATABASE_NAME = "sefkirastudio-image-operations";
const STORE_NAME = "queues";

/** sessionStorage survives reload, but unlike localStorage isolates different tabs. */
export const getImageOperationSessionId = () => {
  if (typeof sessionStorage === "undefined") return createImageOperationId();
  try {
    const previous = sessionStorage.getItem(SESSION_KEY);
    if (previous) return previous;
    const id = createImageOperationId();
    sessionStorage.setItem(SESSION_KEY, id);
    return id;
  } catch { return createImageOperationId(); }
};

/** Web Locks also separates duplicated tabs, which inherit sessionStorage. */
const tryClaimSession = async (id: string): Promise<(() => void) | null> => {
  if (typeof navigator === "undefined" || !navigator.locks) return null;
  let release!: () => void;
  const lifetime = new Promise<void>((resolve) => { release = resolve; });
  let acquired!: (available: boolean) => void;
  const result = new Promise<boolean>((resolve) => { acquired = resolve; });
  void navigator.locks.request(`sefkirastudio-image-tab:${id}`, { ifAvailable: true }, async (lock) => {
    acquired(Boolean(lock));
    if (lock) await lifetime;
  }).catch(() => acquired(false));
  return await result ? release : null;
};

export const claimImageOperationSession = async (): Promise<{ id: string; release: () => void }> => {
  let id = getImageOperationSessionId();
  if (typeof navigator === "undefined" || !navigator.locks) return { id, release: () => undefined };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const release = await tryClaimSession(id);
    if (release) return { id, release };
    id = createImageOperationId();
    try { sessionStorage.setItem(SESSION_KEY, id); } catch { /* Keep the queue isolated even when session storage is denied. */ }
  }
  throw new Error("Unable to establish exclusive ownership of this tab's pending changes.");
};

/** Resolves only after transaction completion, never merely after put success. */
export const createIndexedDbImageOperationStore = (scope: {
  userId: string; projectId: string; resourceId: string; sessionId: string;
}): ImageOperationStore => {
  const key = JSON.stringify([scope.userId, scope.projectId, scope.resourceId, scope.sessionId]);
  let database: Promise<IDBDatabase> | null = null;
  let closed = false;
  const open = () => {
    if (closed) return Promise.reject(new Error("The pending-change store is closed."));
    if (!database) {
      database = new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === "undefined") { reject(new Error("Local durable storage is unavailable. Keep this tab open to protect your changes.")); return; }
        const request = indexedDB.open(DATABASE_NAME, 1);
        request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME); };
        request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
        request.onerror = () => reject(request.error ?? new Error("Unable to open local pending-change storage."));
        request.onblocked = () => reject(new Error("Local storage is blocked by another tab. Keep this tab open."));
      });
      void database.catch(() => { database = null; });
    }
    return database;
  };
  return {
    async read() {
      const db = await open();
      const own = await new Promise<StoredImageOperationQueue | null>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, "readonly");
        const request = transaction.objectStore(STORE_NAME).get(key);
        let value: StoredImageOperationQueue | null = null;
        request.onsuccess = () => { value = request.result ?? null; };
        transaction.oncomplete = () => resolve(value);
        transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error("Unable to recover your pending changes."));
      });
      if (own && (own.version !== 1 || !Array.isArray(own.operations) || !own.operations.every(validateImageOperation))) throw new Error("Your local pending-change queue is invalid and has been preserved.");
      if (own?.operations?.length || own?.localDocument || typeof navigator === "undefined" || !navigator.locks) return own;
      const candidates = await new Promise<Array<{ key: string; value: StoredImageOperationQueue }>>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, "readonly");
        const request = transaction.objectStore(STORE_NAME).openCursor();
        const found: Array<{ key: string; value: StoredImageOperationQueue }> = [];
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          try {
            const parts = typeof cursor.key === "string" ? JSON.parse(cursor.key) : null;
            if (Array.isArray(parts) && parts.length === 4 && parts[0] === scope.userId && parts[1] === scope.projectId && parts[2] === scope.resourceId && parts[3] !== scope.sessionId && (cursor.value?.operations?.length || cursor.value?.localDocument)) found.push({ key: cursor.key as string, value: cursor.value });
          } catch { /* Ignore unrelated non-scope keys. */ }
          cursor.continue();
        };
        transaction.oncomplete = () => resolve(found);
        transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error("Unable to discover recoverable local changes."));
      });
      for (const candidate of candidates) {
        const sessionId = JSON.parse(candidate.key)[3] as string;
        const release = await tryClaimSession(sessionId);
        if (!release) continue; // A live tab owns this queue; never steal it.
        try {
          const adopted = await new Promise<StoredImageOperationQueue | null>((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, "readwrite");
            const records = transaction.objectStore(STORE_NAME);
            const request = records.get(candidate.key);
            let recovered: StoredImageOperationQueue | null = null;
            request.onsuccess = () => {
              const value = request.result as StoredImageOperationQueue | undefined;
              if (!value?.operations?.length && !value?.localDocument) return;
              if (value.version !== 1 || !value.operations.every(validateImageOperation)) { transaction.abort(); return; }
              const destination = records.get(key);
              destination.onsuccess = () => {
                const existing = destination.result as StoredImageOperationQueue | undefined;
                if (existing && (existing.version !== 1 || !Array.isArray(existing.operations) || !existing.operations.every(validateImageOperation))) { transaction.abort(); return; }
                if (existing?.operations.length || existing?.localDocument) { recovered = existing; return; }
                recovered = value;
                // Crash-safe move: source removal and destination commit together.
                records.put(value, key);
                records.delete(candidate.key);
              };
            };
            transaction.oncomplete = () => resolve(recovered);
            transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error("The recoverable local queue is invalid. It has not been discarded."));
          });
          if (adopted) return adopted;
        } finally { release(); }
      }
      return own;
    },
    async write(queue) {
      const db = await open();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).put(queue, key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error("Unable to protect pending changes on this device. Keep this tab open."));
      });
    },
    dispose() { closed = true; if (database) void database.then((db) => db.close(), () => undefined); },
  };
};
