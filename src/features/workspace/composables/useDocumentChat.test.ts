import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref } from "vue";
import {
  DocumentChatHttpError,
  getDocumentChatMessages,
  postDocumentChatMessage,
  type DocumentChatAuthor,
  type DocumentChatMessagePublic,
  type DocumentChatPage,
} from "../../../lib/api";
import { useDocumentChat } from "./useDocumentChat";

vi.mock("../../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/api")>();
  return { ...actual, getDocumentChatMessages: vi.fn(), postDocumentChatMessage: vi.fn() };
});

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const ownUser: DocumentChatAuthor = { id: "owner", username: "Owner", avatar_url: null, avatar_pixel_art: null };
const otherUser: DocumentChatAuthor = { id: "editor", username: "Editor", avatar_url: null, avatar_pixel_art: null };
const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const message = (id: number, extra: Partial<DocumentChatMessagePublic> = {}): DocumentChatMessagePublic => ({
  id,
  project_id: "project",
  resource_id: "resource",
  client_message_id: uuid(id),
  author: otherUser,
  body: `Message ${id}`,
  created_at: `2026-09-18T12:00:${String(id % 60).padStart(2, "0")}Z`,
  ...extra,
});
const page = (messages: DocumentChatMessagePublic[] = [], hasMore = false): DocumentChatPage => ({
  messages,
  has_more: hasMore,
  next_before_id: messages[0]?.id ?? null,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => {
  for (let index = 0; index < 25; index += 1) await Promise.resolve();
  await nextTick();
};

describe("document chat synchronization", () => {
  let storage: MemoryStorage;
  let fakeWindow: EventTarget;
  let fakeDocument: EventTarget & { visibilityState: string; hidden: boolean };
  let sequence: number;
  const cleanups: Array<() => void> = [];
  const startChat = async (chat: ReturnType<typeof useDocumentChat>) => {
    chat.start();
    await settle();
  };
  const makeClient = (resourceId = ref("resource"), user = ref<DocumentChatAuthor | null>(ownUser)) => {
    const scope = effectScope();
    const chat = scope.run(() => useDocumentChat({ projectId: "project", resourceId, user }))!;
    cleanups.push(() => { chat.dispose(); scope.stop(); });
    return { chat, scope, resourceId, user };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    storage = new MemoryStorage();
    sequence = 100;
    fakeWindow = Object.assign(new EventTarget(), {
      localStorage: storage,
      sessionStorage: new MemoryStorage(),
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    });
    fakeDocument = Object.assign(new EventTarget(), { visibilityState: "visible", hidden: false });
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("document", fakeDocument);
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => uuid(sequence++)) });
    vi.mocked(getDocumentChatMessages).mockResolvedValue(page());
    vi.mocked(postDocumentChatMessage).mockImplementation(async (_projectId, resourceId, payload) => message(sequence++, {
      resource_id: resourceId,
      client_message_id: payload.client_message_id,
      body: payload.body,
      author: ownUser,
    }));
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("loads chronological initial history without treating old messages as unread", async () => {
    vi.mocked(getDocumentChatMessages).mockResolvedValueOnce(page([message(1), message(2)], true));
    const { chat } = makeClient();
    await startChat(chat);
    expect(chat.messages.value.map((entry) => entry.id)).toEqual([1, 2]);
    expect(chat.messages.value.every((entry) => entry.status === "sent")).toBe(true);
    expect(chat.hasOlder.value).toBe(true);
    expect(chat.unreadCount.value).toBe(0);
    expect(chat.loading.value).toBe(false);
  });

  it("shows an optimistic send and deduplicates an echo arriving before the HTTP confirmation", async () => {
    const gate = deferred<DocumentChatMessagePublic>();
    vi.mocked(postDocumentChatMessage).mockReturnValueOnce(gate.promise);
    const { chat } = makeClient();
    await startChat(chat);
    const sending = chat.sendMessage("  Hello from owner  ");
    await settle();
    expect(chat.messages.value).toHaveLength(1);
    expect(chat.messages.value[0]).toMatchObject({ body: "Hello from owner", status: "pending", author: ownUser });
    const pendingId = chat.messages.value[0]!.client_message_id;
    const confirmed = message(5, { author: ownUser, client_message_id: pendingId, body: "Hello from owner" });
    chat.receiveRealtime({ project_id: "project", resource_id: "resource", message: confirmed });
    gate.resolve(confirmed);
    await sending;
    await settle();
    expect(chat.messages.value).toHaveLength(1);
    expect(chat.messages.value[0]).toMatchObject({ id: 5, status: "sent", client_message_id: pendingId });
    expect(chat.unreadCount.value).toBe(0);
    expect(chat.sending.value).toBe(false);
  });

  it("does not conflate different authors who reuse the same client message UUID", async () => {
    const { chat } = makeClient();
    await startChat(chat);
    chat.receiveRealtime({ project_id: "project", resource_id: "resource", message: message(1, { author: ownUser, client_message_id: uuid(9) }) });
    chat.receiveRealtime({ project_id: "project", resource_id: "resource", message: message(2, { author: otherUser, client_message_id: uuid(9) }) });
    await settle();
    expect(chat.messages.value.map((entry) => entry.author.id)).toEqual(["owner", "editor"]);
  });

  it("counts only unseen other-user messages and marks them read when opened", async () => {
    const { chat } = makeClient();
    await startChat(chat);
    const remote = message(1);
    chat.receiveRealtime({ project_id: "project", resource_id: "resource", message: remote });
    chat.receiveRealtime({ project_id: "project", resource_id: "resource", message: remote });
    chat.receiveRealtime({ project_id: "project", resource_id: "resource", message: message(2, { author: ownUser }) });
    expect(chat.unreadCount.value).toBe(1);
    chat.setOpen(true);
    expect(chat.isOpen.value).toBe(true);
    expect(chat.unreadCount.value).toBe(0);
    chat.receiveRealtime({ project_id: "project", resource_id: "resource", message: message(3) });
    expect(chat.unreadCount.value).toBe(0);
    chat.setOpen(false);
    chat.receiveRealtime({ project_id: "other-project", resource_id: "resource", message: message(4, { project_id: "other-project" }) });
    chat.receiveRealtime({ project_id: "project", resource_id: "other-resource", message: message(5, { resource_id: "other-resource" }) });
    expect(chat.messages.value.map((entry) => entry.id)).toEqual([1, 2, 3]);
  });

  it("retries a failed message with the same UUID rather than creating another local message", async () => {
    vi.mocked(postDocumentChatMessage).mockRejectedValueOnce(new TypeError("Network unavailable"));
    const { chat } = makeClient();
    await startChat(chat);
    await chat.sendMessage("Keep this pending");
    const failed = chat.messages.value[0]!;
    expect(failed.status).toBe("failed");
    expect(failed.body).toBe("Keep this pending");
    const originalId = failed.client_message_id;
    await chat.retryMessage(originalId);
    expect(postDocumentChatMessage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(postDocumentChatMessage).mock.calls.map((call) => call[2].client_message_id)).toEqual([originalId, originalId]);
    expect(chat.messages.value).toHaveLength(1);
    expect(chat.messages.value[0]).toMatchObject({ status: "sent", body: "Keep this pending", client_message_id: originalId });
  });

  it("restores a pending message after disposal and reuses its original receipt identifier", async () => {
    vi.mocked(postDocumentChatMessage).mockRejectedValueOnce(new TypeError("Connection lost before ACK"));
    const original = makeClient();
    await startChat(original.chat);
    await original.chat.sendMessage("Recover after reopening");
    const originalId = original.chat.messages.value[0]!.client_message_id;
    expect([...storage.values.values()].some((value) => value.includes(originalId))).toBe(true);
    original.chat.dispose();
    original.scope.stop();
    vi.mocked(postDocumentChatMessage).mockClear();
    const recovered = makeClient();
    await startChat(recovered.chat);
    await settle();
    expect(postDocumentChatMessage).toHaveBeenCalledOnce();
    expect(vi.mocked(postDocumentChatMessage).mock.calls[0]?.[2]).toEqual({
      client_message_id: originalId,
      body: "Recover after reopening",
    });
    expect(recovered.chat.messages.value).toHaveLength(1);
    expect(recovered.chat.messages.value[0]).toMatchObject({ client_message_id: originalId, status: "sent" });
  });

  it("scopes recovered pending messages to the signed-in author and document", async () => {
    vi.mocked(postDocumentChatMessage).mockRejectedValueOnce(new TypeError("Offline"));
    const original = makeClient();
    await startChat(original.chat);
    await original.chat.sendMessage("Private pending message");
    original.chat.dispose();
    original.scope.stop();
    vi.mocked(postDocumentChatMessage).mockClear();
    const anotherAuthor = makeClient(ref("resource"), ref<DocumentChatAuthor | null>(otherUser));
    const anotherDocument = makeClient(ref("another-resource"));
    await startChat(anotherAuthor.chat);
    await startChat(anotherDocument.chat);
    await settle();
    expect(postDocumentChatMessage).not.toHaveBeenCalled();
    expect(anotherAuthor.chat.messages.value).toEqual([]);
    expect(anotherDocument.chat.messages.value).toEqual([]);
  });

  it("cannot erase another tab's pending receipt when its own message is acknowledged", async () => {
    const firstTab = makeClient();
    const secondTab = makeClient();
    await startChat(firstTab.chat);
    await startChat(secondTab.chat);
    vi.mocked(postDocumentChatMessage)
      .mockRejectedValueOnce(new TypeError("First tab offline"))
      .mockRejectedValueOnce(new TypeError("Second tab offline"));
    await firstTab.chat.sendMessage("Still pending in the first tab");
    await secondTab.chat.sendMessage("Second tab message");
    const firstId = firstTab.chat.messages.value[0]!.client_message_id;
    const secondId = secondTab.chat.messages.value[0]!.client_message_id;
    expect(firstId).not.toBe(secondId);
    expect([...storage.values.values()].some((value) => value.includes(firstId))).toBe(true);
    expect([...storage.values.values()].some((value) => value.includes(secondId))).toBe(true);
    await secondTab.chat.retryMessage(secondId);
    expect(secondTab.chat.messages.value[0]?.status).toBe("sent");
    expect([...storage.values.values()].some((value) => value.includes(firstId))).toBe(true);
    expect([...storage.values.values()].some((value) => value.includes(secondId))).toBe(false);
    secondTab.chat.dispose();
    secondTab.scope.stop();
    expect([...storage.values.values()].some((value) => value.includes(firstId))).toBe(true);
    firstTab.chat.dispose();
    firstTab.scope.stop();
    vi.mocked(postDocumentChatMessage).mockClear();
    const reopened = makeClient();
    await startChat(reopened.chat);
    expect(postDocumentChatMessage).toHaveBeenCalledOnce();
    expect(vi.mocked(postDocumentChatMessage).mock.calls[0]?.[2]).toEqual({
      client_message_id: firstId,
      body: "Still pending in the first tab",
    });
    expect(reopened.chat.messages.value).toHaveLength(1);
    expect(reopened.chat.messages.value[0]).toMatchObject({ client_message_id: firstId, status: "sent" });
  });

  it("fills every missing page from its confirmed fetch cursor even when a later live event arrives first", async () => {
    vi.mocked(getDocumentChatMessages).mockResolvedValueOnce(page([message(1)]));
    const { chat } = makeClient();
    await startChat(chat);
    vi.mocked(getDocumentChatMessages).mockClear();
    vi.mocked(getDocumentChatMessages).mockImplementation(async (_projectId, _resourceId, options) => {
      if (options?.afterId === 1) return page([message(2), message(3)], true);
      if (options?.afterId === 3) return page([message(4), message(5)]);
      return page();
    });
    chat.receiveRealtime({ project_id: "project", resource_id: "resource", message: message(4) });
    await chat.catchUp();
    await settle();
    expect(chat.messages.value.map((entry) => entry.id)).toEqual([1, 2, 3, 4, 5]);
    expect(vi.mocked(getDocumentChatMessages).mock.calls.map((call) => call[2]?.afterId).slice(0, 2)).toEqual([1, 3]);
    expect(chat.unreadCount.value).toBe(4);
  });

  it("prepends older history without unread counts or duplication", async () => {
    vi.mocked(getDocumentChatMessages).mockResolvedValueOnce(page([message(3), message(4)], true));
    const { chat } = makeClient();
    await startChat(chat);
    vi.mocked(getDocumentChatMessages).mockResolvedValueOnce(page([message(1), message(2)]));
    await chat.loadOlder();
    expect(vi.mocked(getDocumentChatMessages).mock.calls[1]?.[2]?.beforeId).toBe(3);
    expect(chat.messages.value.map((entry) => entry.id)).toEqual([1, 2, 3, 4]);
    expect(chat.hasOlder.value).toBe(false);
    expect(chat.unreadCount.value).toBe(0);
  });

  it("acknowledges a recovered pending message from history without posting it again", async () => {
    vi.mocked(postDocumentChatMessage).mockRejectedValueOnce(new TypeError("ACK lost"));
    const original = makeClient();
    await startChat(original.chat);
    await original.chat.sendMessage("Already accepted by the server");
    const originalId = original.chat.messages.value[0]!.client_message_id;
    original.chat.dispose();
    original.scope.stop();
    vi.mocked(postDocumentChatMessage).mockClear();
    vi.mocked(getDocumentChatMessages).mockResolvedValueOnce(page([
      message(11, { author: ownUser, body: "Already accepted by the server", client_message_id: originalId }),
    ]));
    const recovered = makeClient();
    await startChat(recovered.chat);
    expect(postDocumentChatMessage).not.toHaveBeenCalled();
    expect(recovered.chat.messages.value).toHaveLength(1);
    expect(recovered.chat.messages.value[0]).toMatchObject({ id: 11, status: "sent", client_message_id: originalId });
    expect([...storage.values.values()].some((value) => value.includes(originalId))).toBe(false);
  });

  it("keeps the document open and avoids refetching history when only the author's profile changes", async () => {
    const { chat, user } = makeClient();
    await startChat(chat);
    chat.setOpen(true);
    await settle();
    chat.receiveRealtime({ project_id: "project", resource_id: "resource", message: message(1) });
    await settle();
    vi.mocked(getDocumentChatMessages).mockClear();
    user.value = { ...ownUser, username: "New display name", avatar_url: "https://example.com/avatar.png" };
    await settle();
    expect(chat.isOpen.value).toBe(true);
    expect(chat.messages.value.map((entry) => entry.id)).toEqual([1]);
    expect(getDocumentChatMessages).not.toHaveBeenCalled();
    await chat.sendMessage("With refreshed identity");
    expect(vi.mocked(postDocumentChatMessage).mock.calls[0]?.[2]?.body).toBe("With refreshed identity");
  });

  it("starts loading only once both the document and signed-in author become available", async () => {
    const { chat, resourceId, user } = makeClient(ref(""), ref<DocumentChatAuthor | null>(null));
    await startChat(chat);
    expect(getDocumentChatMessages).not.toHaveBeenCalled();
    expect(chat.messages.value).toEqual([]);
    resourceId.value = "resource";
    user.value = ownUser;
    await settle();
    expect(getDocumentChatMessages).toHaveBeenCalledOnce();
    expect(chat.loading.value).toBe(false);
  });

  it("treats a realtime echo as successful delivery even if its HTTP response is lost", async () => {
    const gate = deferred<DocumentChatMessagePublic>();
    vi.mocked(postDocumentChatMessage).mockReturnValueOnce(gate.promise);
    const { chat } = makeClient();
    await startChat(chat);
    const sending = chat.sendMessage("Accepted despite a lost response");
    await settle();
    const originalId = chat.messages.value[0]!.client_message_id;
    chat.receiveRealtime({ project_id: "project", resource_id: "resource", message: message(12, {
      author: ownUser,
      body: "Accepted despite a lost response",
      client_message_id: originalId,
    }) });
    gate.reject(new TypeError("HTTP response disappeared"));
    expect(await sending).toBe(true);
    await settle();
    expect(chat.messages.value).toHaveLength(1);
    expect(chat.messages.value[0]).toMatchObject({ id: 12, status: "sent" });
    expect(chat.sending.value).toBe(false);
  });

  it.each([401, 403, 404])("stops retries and polling after access is denied (HTTP %s)", async (status) => {
    vi.mocked(postDocumentChatMessage).mockRejectedValueOnce(new TypeError("Offline"));
    const original = makeClient();
    await startChat(original.chat);
    await original.chat.sendMessage("Retain safely without sending after removal");
    original.chat.dispose();
    original.scope.stop();
    vi.mocked(postDocumentChatMessage).mockClear();
    vi.mocked(getDocumentChatMessages).mockClear();
    vi.mocked(getDocumentChatMessages).mockRejectedValueOnce(new DocumentChatHttpError(status));
    const { chat } = makeClient();
    await startChat(chat);
    expect(chat.accessDenied.value).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    fakeWindow.dispatchEvent(new Event("focus"));
    fakeWindow.dispatchEvent(new Event("online"));
    fakeDocument.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(getDocumentChatMessages).toHaveBeenCalledOnce();
    expect(postDocumentChatMessage).not.toHaveBeenCalled();
    expect(chat.sending.value).toBe(false);
  });

  it("aborts previous-document requests and ignores late history after navigation", async () => {
    const oldHistory = deferred<DocumentChatPage>();
    vi.mocked(getDocumentChatMessages).mockImplementation(async (_projectId, resourceId) => (
      resourceId === "resource"
        ? oldHistory.promise
        : page([message(8, { resource_id: "second-resource" })])
    ));
    const { chat, resourceId } = makeClient();
    chat.start();
    await settle();
    const oldSignal = vi.mocked(getDocumentChatMessages).mock.calls[0]?.[2]?.signal;
    resourceId.value = "second-resource";
    await settle();
    expect(oldSignal?.aborted).toBe(true);
    oldHistory.resolve(page([message(1)]));
    await settle();
    expect(chat.messages.value.map((entry) => entry.resource_id)).toEqual(["second-resource"]);
    expect(chat.messages.value.map((entry) => entry.id)).toEqual([8]);
    expect(chat.unreadCount.value).toBe(0);
  });

  it("disposes browser listeners, requests and polling without later network work", async () => {
    const removeWindow = vi.spyOn(fakeWindow, "removeEventListener");
    const removeDocument = vi.spyOn(fakeDocument, "removeEventListener");
    const { chat } = makeClient();
    await startChat(chat);
    vi.mocked(getDocumentChatMessages).mockClear();
    chat.dispose();
    expect(removeWindow.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining(["focus", "online", "pageshow"]));
    expect(removeDocument.mock.calls.map((call) => call[0])).toContain("visibilitychange");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    fakeWindow.dispatchEvent(new Event("focus"));
    fakeWindow.dispatchEvent(new Event("online"));
    fakeWindow.dispatchEvent(new Event("pageshow"));
    fakeDocument.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(getDocumentChatMessages).not.toHaveBeenCalled();
  });

  it("rejects whitespace-only and over-2000-character messages without sending or queuing them", async () => {
    const { chat } = makeClient();
    await startChat(chat);
    await chat.sendMessage("  \n  ");
    await chat.sendMessage("x".repeat(2001));
    expect(postDocumentChatMessage).not.toHaveBeenCalled();
    expect(chat.messages.value).toEqual([]);
    await chat.sendMessage("x".repeat(2000));
    expect(postDocumentChatMessage).toHaveBeenCalledOnce();
  });
});
