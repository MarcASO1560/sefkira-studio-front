import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const supabaseMocks = vi.hoisted(() => ({ RealtimeClient: vi.fn() }));
vi.mock("@supabase/realtime-js", () => ({ RealtimeClient: supabaseMocks.RealtimeClient }));

import { connectProjectPresence, connectUserRealtime } from "./realtime";

const config = (epoch = "epoch-1") => ({
  enabled: true,
  supabase_url: "https://project.supabase.co",
  publishable_key: "sb_publishable_test",
  access_token: `test-token-${epoch}`,
  expires_at: "2099-01-01T00:00:00Z",
  channel: `project:project-1:presence:${epoch}`,
  user: { id: "user-1", email: "artist@example.com", username: "Artist" },
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const activity = (sequence = 1) => ({ payload: {
  client_id: "remote-client", kind: "cursor", resource_id: "resource-1",
  sent_at: "2026-09-17T10:00:00Z", sequence,
  payload: { x: 2, y: 3 }, user: { id: "user-2", email: "other@example.com" },
} });

class FakeRoom {
  handlers = new Map<string, (message: { payload: unknown }) => void>();
  subscription: ((status: string) => void) | undefined;
  on = vi.fn((kind: string, filter: { event: string }, handler: (message: { payload: unknown }) => void) => {
    this.handlers.set(`${kind}:${filter.event}`, handler);
    return this;
  });
  subscribe = vi.fn((handler: (status: string) => void) => {
    this.subscription = handler;
    handler("SUBSCRIBED");
    return this;
  });
  presenceState = vi.fn(() => ({ "user-2": [{ id: "user-2", email: "other@example.com", resource_id: "resource-1" }] }));
  track = vi.fn(() => trackDelay || Promise.resolve("ok"));
  untrack = vi.fn(async () => "ok");
  send = vi.fn(async () => "ok");
  sync() { this.handlers.get("presence:sync")?.({ payload: {} }); }
  broadcast() { this.handlers.get("broadcast:editor.activity")?.(activity()); }
}

type FakeClient = {
  room: FakeRoom;
  options: { accessToken: () => Promise<string | null> };
  channel: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  removeChannel: ReturnType<typeof vi.fn>;
  setAuth: ReturnType<typeof vi.fn>;
};
let clients: FakeClient[];
let connections: Array<{ close: () => void }>;
let fetchMock: ReturnType<typeof vi.fn>;
let browser: EventTarget;
let browserDocument: EventTarget;
let online: { onLine: boolean };
let authDelay: Promise<void> | null;
let trackDelay: Promise<string> | null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-17T10:00:00Z"));
  clients = [];
  connections = [];
  authDelay = null;
  trackDelay = null;
  browser = new EventTarget();
  Object.assign(browser, { setTimeout, clearTimeout });
  browserDocument = new EventTarget();
  online = { onLine: true };
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", browserDocument);
  vi.stubGlobal("navigator", online);
  fetchMock = vi.fn(async () => response(config()));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  supabaseMocks.RealtimeClient.mockImplementation(class {
    room = new FakeRoom();
    options: { accessToken: () => Promise<string | null> };
    channel = vi.fn(() => this.room);
    disconnect = vi.fn();
    removeChannel = vi.fn(async () => "ok");
    setAuth = vi.fn(() => authDelay || Promise.resolve());
    constructor(_url: string, options: { accessToken: () => Promise<string | null> }) {
      this.options = options;
      clients.push(this);
    }
  } as unknown as (...args: any[]) => any);
});

afterEach(() => {
  connections.forEach((connection) => connection.close());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const openPresence = async () => {
  const onSync = vi.fn();
  const onActivity = vi.fn();
  const onDenied = vi.fn();
  const connection = connectProjectPresence("project-1", onSync, "resource-1", onActivity, onDenied);
  connections.push(connection);
  await connection.refresh();
  return { connection, onSync, onActivity, onDenied };
};

const openUserRealtime = async (expiresAt = "2099-01-01T00:00:00Z") => {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/events/config")) {
      return response({ ...config(), expires_at: expiresAt, channel: "user:user-1", latest_event_id: 0 });
    }
    return response([]);
  });
  const onProjectUpdated = vi.fn();
  const connection = connectUserRealtime({ "project.updated": onProjectUpdated });
  connections.push(connection);
  await vi.waitFor(() => expect(clients[0]?.room.subscribe).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(0);
  return { connection, client: clients[0]!, onProjectUpdated };
};

describe("user realtime closure", () => {
  it.each(["acknowledged", "rejected"])(
    "disconnects before a pending unsubscribe is %s and ignores late room callbacks", async (outcome) => {
      const { connection, client, onProjectUpdated } = await openUserRealtime();
      let finish!: (value: string) => void;
      let reject!: (reason: Error) => void;
      client.removeChannel.mockReturnValueOnce(new Promise<string>((resolve, fail) => {
        finish = resolve;
        reject = fail;
      }));
      const requestCount = fetchMock.mock.calls.length;

      connection.close();
      connection.close();
      expect(client.removeChannel).toHaveBeenCalledExactlyOnceWith(client.room);
      expect(client.disconnect).toHaveBeenCalledOnce();
      client.room.handlers.get("broadcast:project.updated")?.({ payload: { project_id: "late" } });
      client.room.subscription?.("SUBSCRIBED");
      await vi.advanceTimersByTimeAsync(0);
      expect(onProjectUpdated).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(requestCount);

      if (outcome === "acknowledged") finish("ok");
      else reject(new Error("unsubscribe failed after the socket was closed"));
      await vi.advanceTimersByTimeAsync(0);
      expect(client.disconnect).toHaveBeenCalledOnce();
    },
  );

  it.each(["2099-01-01T00:00:00Z", "2026-09-17T10:00:30Z"])(
    "returns null from late auth callbacks without requesting config, expiration %s", async (expiresAt) => {
      const { connection, client } = await openUserRealtime(expiresAt);
      const requestCount = fetchMock.mock.calls.length;
      connection.close();
      expect(await client.options.accessToken()).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(requestCount);
    },
  );

  it("discards an auth refresh completed after close and cannot restart a channel", async () => {
    const { connection, client, onProjectUpdated } = await openUserRealtime("2026-09-17T10:00:30Z");
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    const token = client.options.accessToken();
    const requestCount = fetchMock.mock.calls.length;
    expect(String(fetchMock.mock.calls.at(-1)![0])).toMatch(/\/events\/config$/);
    connection.close();
    pending.resolve(response({ ...config(), channel: "user:user-1", latest_event_id: 0 }));
    expect(await token).toBeNull();
    client.room.subscription?.("SUBSCRIBED");
    client.room.handlers.get("broadcast:project.updated")?.({ payload: { project_id: "late" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.channel).toHaveBeenCalledOnce();
    expect(client.room.subscribe).toHaveBeenCalledOnce();
    expect(client.disconnect).toHaveBeenCalledOnce();
    expect(onProjectUpdated).not.toHaveBeenCalled();
    expect(await client.options.accessToken()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(requestCount);
  });
});

describe("project presence authorization lease", () => {
  it("rotates the room, retires the old socket first, and ignores every late old callback", async () => {
    const { connection, onSync, onActivity } = await openPresence();
    const oldClient = clients[0]!;
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    const refresh = connection.refresh();
    connection.sendEditorActivity("cursor", { x: 4 });
    oldClient.room.broadcast();
    expect(oldClient.room.send).toHaveBeenCalledTimes(1);
    expect(onActivity).not.toHaveBeenCalled();
    pending.resolve(response(config("epoch-2")));
    await refresh;
    const newClient = clients[1]!;
    expect(oldClient.disconnect).toHaveBeenCalledOnce();
    expect(oldClient.removeChannel).toHaveBeenCalledWith(oldClient.room);
    expect(oldClient.disconnect.mock.invocationCallOrder[0]).toBeLessThan(newClient.channel.mock.invocationCallOrder[0]!);
    expect(newClient.channel).toHaveBeenCalledWith("project:project-1:presence:epoch-2", expect.any(Object));
    onSync.mockClear();
    oldClient.room.sync();
    oldClient.room.broadcast();
    oldClient.room.subscription?.("SUBSCRIBED");
    expect(onSync).not.toHaveBeenCalled();
    expect(onActivity).not.toHaveBeenCalled();
    expect(await oldClient.options.accessToken()).toBeNull();
    newClient.room.sync();
    newClient.room.broadcast();
    expect(onSync).toHaveBeenCalledWith({ "resource-1": [expect.objectContaining({ id: "user-2" })] });
    expect(onActivity).toHaveBeenCalledOnce();
    connection.sendEditorActivity("selection", { rect: { x: 0, y: 0 } });
    expect(newClient.room.send).toHaveBeenCalledTimes(2);
  });

  it("coalesces simultaneous verifications and cannot reconnect after close or a late HTTP response", async () => {
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    const onDenied = vi.fn();
    const connection = connectProjectPresence("project-1", vi.fn(), "resource-1", vi.fn(), onDenied);
    connections.push(connection);
    const first = connection.refresh();
    expect(connection.refresh()).toBe(first);
    expect(connection.refresh()).toBe(first);
    expect(fetchMock).toHaveBeenCalledOnce();
    connection.close();
    await first;
    pending.resolve(response(config()));
    await Promise.resolve();
    await connection.refresh();
    expect(clients).toHaveLength(0);
    expect(onDenied).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([401, 403, 404])("terminates only the project room on access denial %i and notifies once", async (status) => {
    const { connection, onDenied, onSync, onActivity } = await openPresence();
    const oldClient = clients[0]!;
    fetchMock.mockResolvedValueOnce(response({}, status));
    await connection.refresh();
    expect(onDenied).toHaveBeenCalledExactlyOnceWith(status);
    expect(oldClient.disconnect).toHaveBeenCalledOnce();
    expect(onSync).toHaveBeenLastCalledWith({});
    oldClient.room.broadcast();
    oldClient.room.sync();
    connection.sendEditorActivity("pixels", { pixels: [1] });
    connection.setResourceId("resource-2");
    await connection.refresh();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(oldClient.room.send).toHaveBeenCalledTimes(1);
    expect(onActivity).not.toHaveBeenCalled();
    expect(onDenied).toHaveBeenCalledOnce();
  });

  it.each([401, 403, 404])("never joins a room when its initial access check is denied with %i", async (status) => {
    fetchMock.mockResolvedValueOnce(response({}, status));
    const { connection, onDenied } = await openPresence();
    expect(clients).toHaveLength(0);
    expect(onDenied).toHaveBeenCalledExactlyOnceWith(status);
    await connection.refresh();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("leaves the independent user notification connection alive when a project is blocked", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/events/config")) return response({ ...config(), channel: "user:user-1", latest_event_id: 0 });
      if (String(input).includes("/events/pending")) return response([]);
      return response(config());
    });
    const user = connectUserRealtime({ "project.access.updated": vi.fn() });
    connections.push(user);
    await vi.waitFor(() => expect(clients[0]?.room.subscribe).toHaveBeenCalledOnce());
    const userClient = clients[0]!;
    const { connection, onDenied } = await openPresence();
    const projectClient = clients[1]!;
    fetchMock.mockResolvedValueOnce(response({}, 404));
    await connection.refresh();
    expect(onDenied).toHaveBeenCalledOnce();
    expect(projectClient.disconnect).toHaveBeenCalledOnce();
    expect(userClient.disconnect).not.toHaveBeenCalled();
    expect(userClient.removeChannel).not.toHaveBeenCalled();
  });

  it.each([500, 503])("pauses on transient HTTP %i and recovers without falsely denying access", async (status) => {
    const { connection, onDenied, onActivity } = await openPresence();
    const oldClient = clients[0]!;
    fetchMock.mockResolvedValueOnce(response({}, status));
    await connection.refresh();
    oldClient.room.broadcast();
    expect(onActivity).not.toHaveBeenCalled();
    expect(onDenied).not.toHaveBeenCalled();
    expect(oldClient.disconnect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(clients).toHaveLength(2);
    clients[1]!.room.broadcast();
    expect(onActivity).toHaveBeenCalledOnce();
  });

  it("retires disabled realtime and retries configuration without pretending access was revoked", async () => {
    const { connection, onDenied } = await openPresence();
    fetchMock.mockResolvedValueOnce(response({ enabled: false }));
    await connection.refresh();
    expect(clients[0]!.disconnect).toHaveBeenCalledOnce();
    expect(onDenied).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(clients).toHaveLength(2);
  });

  it("recovers from a network rejection without converting it to a permanent access denial", async () => {
    const { connection, onDenied } = await openPresence();
    fetchMock.mockRejectedValueOnce(new TypeError("Network unavailable"));
    await connection.refresh();
    expect(clients[0]!.disconnect).toHaveBeenCalledOnce();
    expect(onDenied).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(clients).toHaveLength(2);
  });

  it("does not extend a cached authorization lease when the system clock moves backwards", async () => {
    const { connection, onActivity } = await openPresence();
    const oldClient = clients[0]!;
    vi.setSystemTime(new Date("2026-09-17T09:00:00Z"));
    oldClient.room.broadcast();
    expect(onActivity).not.toHaveBeenCalled();
    expect(oldClient.disconnect).toHaveBeenCalledOnce();
    await connection.refresh();
    expect(clients).toHaveLength(2);
  });

  it("renews periodically without stalling an authorized live stroke, but still clears an expired lease", async () => {
    const { connection, onSync, onActivity, onDenied } = await openPresence();
    const oldClient = clients[0]!;
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    oldClient.room.broadcast();
    connection.sendEditorActivity("cursor", { x: 7 });
    expect(onActivity).toHaveBeenCalledOnce();
    expect(oldClient.room.send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(oldClient.disconnect).toHaveBeenCalledOnce();
    expect(onSync).toHaveBeenLastCalledWith({});
    oldClient.room.broadcast();
    connection.sendEditorActivity("pixels", { preview_protocol: 1 });
    expect(onActivity).toHaveBeenCalledOnce();
    expect(oldClient.room.send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(onDenied).not.toHaveBeenCalled();
    pending.resolve(response(config("late-expired-verification")));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(clients).toHaveLength(2);
    expect(clients[1]!.channel).toHaveBeenCalledWith(config().channel, expect.any(Object));
  });

  it("retires the active lease as soon as periodic renewal confirms access denial", async () => {
    const { connection, onActivity, onDenied } = await openPresence();
    const oldClient = clients[0]!;
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(10_000);
    oldClient.room.broadcast();
    expect(onActivity).toHaveBeenCalledOnce();
    pending.resolve(response({}, 404));
    await vi.advanceTimersByTimeAsync(0);
    expect(onDenied).toHaveBeenCalledExactlyOnceWith(404);
    expect(oldClient.disconnect).toHaveBeenCalledOnce();
    oldClient.room.broadcast();
    connection.sendEditorActivity("pixels", { preview_protocol: 1 });
    expect(onActivity).toHaveBeenCalledOnce();
    expect(oldClient.room.send).toHaveBeenCalledTimes(1);
  });

  it("explicit verification interrupts an active periodic renewal, pauses immediately and rejects its late authorization after denial", async () => {
    const { connection, onActivity, onDenied } = await openPresence();
    const oldClient = clients[0]!; const periodic = deferred<Response>(); const explicit = deferred<Response>();
    fetchMock.mockReturnValueOnce(periodic.promise).mockReturnValueOnce(explicit.promise);
    await vi.advanceTimersByTimeAsync(10_000);
    const periodicSignal = fetchMock.mock.calls[1]![1]!.signal as AbortSignal;
    oldClient.room.broadcast(); connection.sendEditorActivity("pixels", { preview_protocol: 1 });
    expect(onActivity).toHaveBeenCalledOnce(); expect(oldClient.room.send).toHaveBeenCalledTimes(2);
    const verifying = connection.refresh();
    expect(periodicSignal.aborted).toBe(true); expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(connection.refresh()).toBe(verifying); expect(connection.refresh()).toBe(verifying);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    oldClient.room.broadcast(); connection.sendEditorActivity("pixels", { preview_protocol: 1 });
    expect(onActivity).toHaveBeenCalledOnce(); expect(oldClient.room.send).toHaveBeenCalledTimes(2);
    explicit.resolve(response({}, 403)); await verifying;
    expect(onDenied).toHaveBeenCalledExactlyOnceWith(403); expect(oldClient.disconnect).toHaveBeenCalledOnce();
    periodic.resolve(response(config("stale-periodic-authorization"))); await vi.advanceTimersByTimeAsync(0);
    expect(clients).toHaveLength(1); oldClient.room.broadcast();
    expect(onActivity).toHaveBeenCalledOnce(); expect(onDenied).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000); expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("ignores a superseded periodic response while explicit verification is pending and rejoins only its fresh epoch", async () => {
    const { connection, onActivity, onDenied } = await openPresence();
    const oldClient = clients[0]!; const periodic = deferred<Response>(); const explicit = deferred<Response>();
    fetchMock.mockReturnValueOnce(periodic.promise).mockReturnValueOnce(explicit.promise);
    await vi.advanceTimersByTimeAsync(10_000);
    browserDocument.dispatchEvent(new Event("visibilitychange"));
    const verifying = connection.refresh(); expect(fetchMock).toHaveBeenCalledTimes(3);
    periodic.resolve(response(config("superseded-periodic-epoch"))); await vi.advanceTimersByTimeAsync(0);
    expect(clients).toHaveLength(1); oldClient.room.broadcast();
    connection.sendEditorActivity("pixels", { preview_protocol: 1 });
    expect(onActivity).not.toHaveBeenCalled(); expect(oldClient.room.send).toHaveBeenCalledTimes(1);
    explicit.resolve(response(config("fresh-explicit-epoch"))); await verifying;
    expect(clients).toHaveLength(2); expect(clients[1]!.channel).toHaveBeenCalledWith(config("fresh-explicit-epoch").channel, expect.any(Object));
    clients[1]!.room.broadcast(); expect(onActivity).toHaveBeenCalledOnce(); expect(onDenied).not.toHaveBeenCalled();
  });

  it("rejects stale sends/receives after a throttled timer and recovers only from new configuration", async () => {
    const { connection, onActivity } = await openPresence();
    const oldClient = clients[0]!;
    vi.setSystemTime(new Date("2026-09-17T10:00:16Z"));
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    oldClient.room.broadcast();
    connection.sendEditorActivity("selection", { mask: "old" });
    expect(onActivity).not.toHaveBeenCalled();
    expect(oldClient.disconnect).toHaveBeenCalledOnce();
    expect(oldClient.room.send).toHaveBeenCalledTimes(1);
    pending.resolve(response(config("epoch-2")));
    await connection.refresh();
    expect(clients).toHaveLength(2);
    expect(clients[1]!.room.send).toHaveBeenCalledTimes(1); // Only new-room sync request, never replay old selection.
  });

  it("pauses offline, rechecks online, and ignores a verification response from before the network transition", async () => {
    const { connection, onDenied, onActivity } = await openPresence();
    const oldClient = clients[0]!;
    const oldRequest = deferred<Response>();
    fetchMock.mockReturnValueOnce(oldRequest.promise);
    const oldRefresh = connection.refresh();
    online.onLine = false;
    browser.dispatchEvent(new Event("offline"));
    await oldRefresh;
    expect(oldClient.disconnect).toHaveBeenCalledOnce();
    oldClient.room.broadcast();
    connection.sendEditorActivity("cursor", { x: 7 });
    expect(onActivity).not.toHaveBeenCalled();
    online.onLine = true;
    fetchMock.mockResolvedValueOnce(response(config("epoch-2")));
    browser.dispatchEvent(new Event("online"));
    await connection.refresh();
    oldRequest.resolve(response(config("stale-epoch")));
    await Promise.resolve();
    expect(clients).toHaveLength(2);
    expect(clients[1]!.channel).toHaveBeenCalledWith(config("epoch-2").channel, expect.any(Object));
    expect(onDenied).not.toHaveBeenCalled();
  });

  it("rechecks visibility changes without leaving an authorized background document, and removes listeners on close", async () => {
    const { connection } = await openPresence();
    browserDocument.dispatchEvent(new Event("visibilitychange"));
    connection.sendEditorActivity("cursor", { x: 4 });
    expect(clients[0]!.room.send).toHaveBeenCalledTimes(1);
    await connection.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(clients).toHaveLength(1);
    expect(clients[0]!.disconnect).not.toHaveBeenCalled();
    connection.close();
    browserDocument.dispatchEvent(new Event("visibilitychange"));
    browser.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("cannot create a channel when close interrupts delayed bootstrap authentication", async () => {
    const auth = deferred<void>();
    authDelay = auth.promise;
    const connection = connectProjectPresence("project-1", vi.fn(), "resource-1");
    connections.push(connection);
    const refresh = connection.refresh();
    await vi.waitFor(() => expect(clients).toHaveLength(1));
    connection.close();
    await refresh;
    auth.resolve();
    await Promise.resolve();
    expect(clients[0]!.channel).not.toHaveBeenCalled();
    expect(clients[0]!.disconnect).toHaveBeenCalledOnce();
  });

  it("untracks a document exit even if the preceding track acknowledgement is delayed", async () => {
    const tracked = deferred<string>();
    trackDelay = tracked.promise;
    const { connection } = await openPresence();
    const room = clients[0]!.room;
    expect(room.track).toHaveBeenCalledOnce();
    connection.setResourceId(null);
    expect(room.untrack).toHaveBeenCalledOnce();
    tracked.resolve("ok");
    await Promise.resolve();
    connection.close();
    expect(room.untrack).toHaveBeenCalledOnce();
  });

  it("timeouts authentication safely and retries instead of leaving a permanently verifying connection", async () => {
    const auth = deferred<void>();
    authDelay = auth.promise;
    const connection = connectProjectPresence("project-1", vi.fn(), "resource-1");
    connections.push(connection);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(clients[0]!.disconnect).toHaveBeenCalledOnce();
    authDelay = null;
    auth.resolve();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(clients).toHaveLength(2);
    expect(clients[1]!.room.subscribe).toHaveBeenCalledOnce();
  });

  it.each(["invalid-date", "2020-01-01T00:00:00Z"])("refuses malformed/expired JWT expiration %s without falsely denying project access", async (expiresAt) => {
    const { connection, onDenied } = await openPresence();
    fetchMock.mockResolvedValueOnce(response({ ...config(), expires_at: expiresAt }));
    await connection.refresh();
    expect(clients[0]!.disconnect).toHaveBeenCalledOnce();
    expect(onDenied).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(clients).toHaveLength(2);
  });
});
