import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref } from "vue";
import { DocumentChatHttpError, getProjectChatUnread } from "../../../lib/api";
import { useProjectChatUnread } from "./useProjectChatUnread";

vi.mock("../../../lib/api", async (original) => ({
  ...await original<typeof import("../../../lib/api")>(), getProjectChatUnread: vi.fn(),
}));
const result = (count: number, resourceId = "drawing") => ({ documents: [
  { resource_id: resourceId, unread_count: count, last_message_id: 20, last_read_message_id: 10 },
] });
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await nextTick(); };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

describe("project chat unread indicators", () => {
  const cleanups: Array<() => void> = [];
  let fakeDocument: EventTarget & { visibilityState: string };
  let fakeWindow: EventTarget;
  const make = () => {
    const projectId = ref("project");
    const accountKey = ref("artist@example.com");
    const enabled = ref(true);
    const onAccessDenied = vi.fn(() => { enabled.value = false; });
    const scope = effectScope();
    const chat = scope.run(() => useProjectChatUnread({ projectId, accountKey, enabled, onAccessDenied }))!;
    cleanups.push(() => { chat.dispose(); scope.stop(); });
    chat.start();
    return { chat, projectId, accountKey, enabled, onAccessDenied };
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    fakeDocument = Object.assign(new EventTarget(), { visibilityState: "visible" });
    fakeWindow = new EventTarget();
    vi.stubGlobal("document", fakeDocument);
    vi.stubGlobal("window", fakeWindow);
    vi.mocked(getProjectChatUnread).mockResolvedValue(result(3));
  });
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("loads persisted counts and removes a badge after another device reads", async () => {
    const { chat } = make();
    await settle();
    expect(chat.counts.value).toEqual({ drawing: 3 });
    vi.mocked(getProjectChatUnread).mockResolvedValue(result(0));
    fakeWindow.dispatchEvent(new Event("focus"));
    await settle();
    expect(chat.counts.value).toEqual({});
  });

  it("coalesces duplicate realtime events and uses authoritative counts", async () => {
    const { chat } = make();
    await settle();
    vi.mocked(getProjectChatUnread).mockResolvedValue(result(4));
    for (let i = 0; i < 10; i++) chat.receiveRealtime({ project_id: "project", message: { id: 30 } });
    chat.receiveRealtime({ project_id: "another-project" });
    await vi.advanceTimersByTimeAsync(180);
    expect(getProjectChatUnread).toHaveBeenCalledTimes(2);
    expect(chat.counts.value).toEqual({ drawing: 4 });
  });

  it("keeps confirmed badges after a network failure", async () => {
    const { chat } = make();
    await settle();
    vi.mocked(getProjectChatUnread).mockRejectedValue(new Error("offline"));
    await chat.refresh();
    expect(chat.counts.value).toEqual({ drawing: 3 });
  });

  it("does not fetch while hidden and catches up on return", async () => {
    const { chat } = make();
    await settle();
    fakeDocument.visibilityState = "hidden";
    await vi.advanceTimersByTimeAsync(60000);
    chat.receiveRealtime({ project_id: "project" });
    await vi.advanceTimersByTimeAsync(180);
    expect(getProjectChatUnread).toHaveBeenCalledTimes(1);
    fakeDocument.visibilityState = "visible";
    fakeDocument.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(getProjectChatUnread).toHaveBeenCalledTimes(2);
  });

  it("aborts account changes and ignores stale counts from the previous account", async () => {
    const old = deferred<ReturnType<typeof result>>();
    vi.mocked(getProjectChatUnread).mockReturnValueOnce(old.promise);
    const { chat, accountKey } = make();
    const oldSignal = vi.mocked(getProjectChatUnread).mock.calls[0]![1]!.signal;
    accountKey.value = "other@example.com";
    await settle();
    expect(oldSignal?.aborted).toBe(true);
    expect(chat.counts.value).toEqual({ drawing: 3 });
    old.resolve(result(90));
    await settle();
    expect(chat.counts.value).toEqual({ drawing: 3 });
  });

  it("queues one fresh summary if a message arrives during an existing request", async () => {
    const first = deferred<ReturnType<typeof result>>();
    vi.mocked(getProjectChatUnread).mockReturnValueOnce(first.promise).mockResolvedValue(result(4));
    const { chat } = make();
    chat.receiveRealtime({ project_id: "project" });
    await vi.advanceTimersByTimeAsync(180);
    expect(getProjectChatUnread).toHaveBeenCalledTimes(1);
    first.resolve(result(3));
    await settle();
    expect(getProjectChatUnread).toHaveBeenCalledTimes(2);
    expect(chat.counts.value).toEqual({ drawing: 4 });
  });

  it("clears indicators and stops synchronization after access is revoked", async () => {
    const { chat, onAccessDenied } = make();
    await settle();
    vi.mocked(getProjectChatUnread).mockRejectedValue(new DocumentChatHttpError(403));
    await chat.refresh();
    await settle();
    expect(onAccessDenied).toHaveBeenCalledOnce();
    expect(chat.counts.value).toEqual({});
    const calls = vi.mocked(getProjectChatUnread).mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(getProjectChatUnread).toHaveBeenCalledTimes(calls);
  });

  it("disposal aborts pending reads and prevents detached updates", async () => {
    const first = deferred<ReturnType<typeof result>>();
    vi.mocked(getProjectChatUnread).mockReturnValueOnce(first.promise);
    const { chat } = make();
    const signal = vi.mocked(getProjectChatUnread).mock.calls[0]![1]!.signal;
    chat.dispose();
    expect(signal?.aborted).toBe(true);
    first.resolve(result(90));
    await settle();
    expect(chat.counts.value).toEqual({});
    await vi.advanceTimersByTimeAsync(60000);
    expect(getProjectChatUnread).toHaveBeenCalledTimes(1);
  });
});
