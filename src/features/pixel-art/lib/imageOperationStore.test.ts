import { afterEach, describe, expect, it, vi } from "vitest";
import { claimImageOperationSession, createIndexedDbImageOperationStore, type StoredImageOperationQueue } from "./imageOperationStore";

const queue = (id = "op"): StoredImageOperationQueue => ({ version: 1, resource: null, operations: [{ operation_id: id, base_revision: 0, width: 2, height: 2, actions: [{ type: "pixels", layer_id: "layer", changes: [[0, "#FF0000"]] }] }] });
const clone = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value));

/** Small asynchronous IDB model: writes commit only on transaction completion. */
const fakeIndexedDb = () => {
  const records = new Map<string, StoredImageOperationQueue>();
  const database = {
    objectStoreNames: { contains: () => true },
    close: vi.fn(),
    transaction(_name: string, mode: string) {
      const snapshot = new Map(records);
      let pending = 0;
      let aborted = false;
      let completeScheduled = false;
      const transaction: Record<string, any> = {
        error: null,
        abort() { aborted = true; queueMicrotask(() => transaction.onabort?.()); },
      };
      const complete = () => {
        if (completeScheduled || pending || aborted) return;
        completeScheduled = true;
        queueMicrotask(() => {
          completeScheduled = false;
          if (pending || aborted) return;
          if (mode === "readwrite") { records.clear(); for (const [key, value] of snapshot) records.set(key, value); }
          transaction.oncomplete?.();
        });
      };
      const request = (run: () => any) => {
        const result: Record<string, any> = {};
        pending += 1;
        queueMicrotask(() => {
          if (!aborted) { result.result = run(); result.onsuccess?.(); }
          pending -= 1;
          complete();
        });
        return result;
      };
      transaction.objectStore = () => ({
        get: (key: string) => request(() => clone(snapshot.get(key))),
        put: (value: StoredImageOperationQueue, key: string) => request(() => { snapshot.set(key, clone(value)); return key; }),
        delete: (key: string) => request(() => { snapshot.delete(key); }),
        openCursor() {
          const all = [...snapshot.entries()];
          const cursorRequest: Record<string, any> = {};
          let index = 0;
          const next = () => {
            pending += 1;
            queueMicrotask(() => {
              const entry = all[index++];
              cursorRequest.result = entry ? { key: entry[0], value: clone(entry[1]), continue: next } : null;
              cursorRequest.onsuccess?.();
              pending -= 1;
              complete();
            });
          };
          next();
          return cursorRequest;
        },
      });
      return transaction;
    },
  };
  vi.stubGlobal("indexedDB", { open: () => {
    const result: Record<string, any> = {};
    queueMicrotask(() => { result.result = database; result.onsuccess?.(); });
    return result;
  } });
  return records;
};
const fakeLocks = () => {
  const held = new Set<string>();
  vi.stubGlobal("navigator", { locks: { request: vi.fn(async (name: string, _options: unknown, callback: (lock: unknown) => Promise<void>) => {
    if (held.has(name)) { await callback(null); return; }
    held.add(name);
    try { await callback({ name }); } finally { held.delete(name); }
  }) } });
  return held;
};
const scope = (sessionId: string, userId = "user", resourceId = "resource") => ({ userId, projectId: "project", resourceId, sessionId });
const key = (session: string, user = "user", resource = "resource") => JSON.stringify([user, "project", resource, session]);

describe("durable image operation storage", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it("writes and recovers the same tab's queue", async () => {
    const records = fakeIndexedDb(); fakeLocks();
    const store = createIndexedDbImageOperationStore(scope("tab"));
    await store.write(queue()); expect(records.get(key("tab"))).toEqual(queue());
    expect(await store.read()).toEqual(queue()); store.dispose?.();
  });
  it("recovers a closed tab into a new session with an atomic move", async () => {
    const records = fakeIndexedDb(); fakeLocks(); records.set(key("closed-tab"), queue());
    const store = createIndexedDbImageOperationStore(scope("new-tab"));
    expect(await store.read()).toEqual(queue());
    expect(records.has(key("closed-tab"))).toBe(false); expect(records.get(key("new-tab"))).toEqual(queue()); store.dispose?.();
  });
  it("does not steal a live tab's pending edits or adopt another user/resource", async () => {
    const records = fakeIndexedDb(); const held = fakeLocks();
    held.add("sefkirastudio-image-tab:live"); records.set(key("live"), queue("live")); records.set(key("other-user", "other"), queue("other")); records.set(key("other-resource", "user", "other"), queue("resource"));
    const store = createIndexedDbImageOperationStore(scope("new-tab"));
    expect(await store.read()).toBeNull(); expect(records.size).toBe(3); store.dispose?.();
  });
  it("adopts one inactive queue without silently deleting other orphan queues", async () => {
    const records = fakeIndexedDb(); fakeLocks(); records.set(key("closed-one"), queue("one")); records.set(key("closed-two"), queue("two"));
    const store = createIndexedDbImageOperationStore(scope("new-tab"));
    expect((await store.read())?.operations[0]?.operation_id).toBe("one");
    expect(records.get(key("closed-two"))).toEqual(queue("two")); expect(records.size).toBe(2); store.dispose?.();
  });
  it("an invalid orphan queue aborts adoption and remains recoverable", async () => {
    const records = fakeIndexedDb(); fakeLocks(); const bad = queue(); bad.operations[0]!.operation_id = ""; records.set(key("closed"), bad);
    const store = createIndexedDbImageOperationStore(scope("new-tab"));
    await expect(store.read()).rejects.toThrow("invalid"); expect(records.has(key("closed"))).toBe(true); expect(records.has(key("new-tab"))).toBe(false); store.dispose?.();
  });
  it("does not overwrite an invalid own queue while adopting an orphan", async () => {
    const records = fakeIndexedDb(); fakeLocks(); const invalid = { ...queue(), operations: undefined } as unknown as StoredImageOperationQueue;
    records.set(key("new-tab"), invalid); records.set(key("closed"), queue());
    const store = createIndexedDbImageOperationStore(scope("new-tab"));
    await expect(store.read()).rejects.toThrow("invalid"); expect(records.get(key("new-tab"))).toEqual(invalid); expect(records.has(key("closed"))).toBe(true); store.dispose?.();
  });
  it("duplicated tabs fork inherited session IDs and lock the new identity", async () => {
    const held = fakeLocks(); const values = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { getItem: (name: string) => values.get(name) ?? null, setItem: (name: string, value: string) => values.set(name, value) });
    const first = await claimImageOperationSession(); const duplicated = await claimImageOperationSession();
    expect(duplicated.id).not.toBe(first.id); expect(held.has(`sefkirastudio-image-tab:${duplicated.id}`)).toBe(true);
    first.release(); duplicated.release();
  });
});
