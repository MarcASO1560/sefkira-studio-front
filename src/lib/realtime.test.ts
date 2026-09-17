import { afterEach, describe, expect, it, vi } from "vitest";

const supabaseMocks = vi.hoisted(() => ({
  RealtimeClient: vi.fn(),
}));

vi.mock("@supabase/realtime-js", () => ({
  RealtimeClient: supabaseMocks.RealtimeClient,
}));

import {
  aggregateProjectPresenceByFolder,
  connectProjectPresence,
  connectUserRealtime,
  groupProjectPresenceState,
} from "./realtime";

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("connectUserRealtime", () => {
  it("uses SSE as a safe fallback when Supabase is not configured", async () => {
    const listeners = new Map<string, (event: Event) => void>();
    const close = vi.fn();
    let eventSourceUrl = "";
    let eventSourceOptions: EventSourceInit | undefined;

    class FakeEventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        eventSourceUrl = String(url);
        eventSourceOptions = options;
      }

      addEventListener(name: string, handler: EventListener) {
        listeners.set(name, handler);
      }

      close = close;
    }

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ enabled: false, latest_event_id: 7 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("EventSource", FakeEventSource);
    const onProjectUpdated = vi.fn();

    const connection = connectUserRealtime({
      "project.updated": onProjectUpdated,
    });
    await vi.waitFor(() => expect(eventSourceUrl).toBe("/api/v1/events/stream"));

    listeners.get("project.updated")?.({
      data: JSON.stringify({ project_id: "project-1" }),
    } as MessageEvent<string>);

    expect(eventSourceOptions).toEqual({ withCredentials: true });
    expect(onProjectUpdated).toHaveBeenCalledWith({ project_id: "project-1" });

    connection.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("subscribes to a private channel and catches up persisted events", async () => {
    const broadcastHandlers = new Map<
      string,
      (message: { payload: Record<string, unknown> }) => void
    >();
    let subscriptionHandler: ((status: string) => void) | undefined;
    const channel = {
      on: vi.fn(
        (
          _type: string,
          filter: { event: string },
          handler: (message: { payload: Record<string, unknown> }) => void,
        ) => {
          broadcastHandlers.set(filter.event, handler);
          return channel;
        },
      ),
      subscribe: vi.fn((handler: (status: string) => void) => {
        subscriptionHandler = handler;
        handler("SUBSCRIBED");
        return channel;
      }),
    };
    const disconnect = vi.fn();
    const removeChannel = vi.fn(async () => "ok");
    const setAuth = vi.fn(async () => undefined);
    supabaseMocks.RealtimeClient.mockImplementation(
      class {
        channel = vi.fn(() => channel);
        disconnect = disconnect;
        removeChannel = removeChannel;
        setAuth = setAuth;
      } as unknown as (...args: any[]) => any,
    );
    vi.stubGlobal("window", {
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/events/config")) {
          return new Response(
            JSON.stringify({
              enabled: true,
              supabase_url: "https://project.supabase.co",
              publishable_key: "sb_publishable_test",
              access_token: "realtime-token",
              expires_at: "2099-09-14T12:00:00Z",
              channel: "user:user-1",
              latest_event_id: 10,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.includes("/events/pending?after_event_id=10")) {
          return new Response(
            JSON.stringify([
              {
                id: 11,
                event: "project.updated",
                data: { project_id: "project-1" },
                created_at: "2026-09-14T12:00:00Z",
              },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const onProjectUpdated = vi.fn();

    const connection = connectUserRealtime({
      "project.updated": onProjectUpdated,
    });

    await vi.waitFor(() => {
      expect(subscriptionHandler).toBeTypeOf("function");
      expect(onProjectUpdated).toHaveBeenCalledWith({
        project_id: "project-1",
        event_id: 11,
        created_at: "2026-09-14T12:00:00Z",
      });
    });

    expect(supabaseMocks.RealtimeClient).toHaveBeenCalledWith(
      "wss://project.supabase.co/realtime/v1",
      expect.objectContaining({
        accessToken: expect.any(Function),
        params: { apikey: "sb_publishable_test" },
      }),
    );
    expect(channel.on).toHaveBeenCalledWith(
      "broadcast",
      { event: "project.updated" },
      expect.any(Function),
    );
    expect(setAuth).toHaveBeenCalledWith("realtime-token");
    expect(setAuth.mock.invocationCallOrder[0]).toBeLessThan(
      channel.subscribe.mock.invocationCallOrder[0]!,
    );
    broadcastHandlers.get("project.updated")?.({
      payload: { project_id: "project-1", event_id: 11 },
    });
    expect(onProjectUpdated).toHaveBeenCalledOnce();

    broadcastHandlers.get("project.updated")?.({
      payload: { project_id: "project-1", event_id: 12 },
    });
    expect(onProjectUpdated).toHaveBeenCalledTimes(2);

    connection.close();
    expect(removeChannel).toHaveBeenCalledWith(channel);
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledOnce());
  });
});

describe("project presence", () => {
  it("groups presence by resource and deduplicates multiple tabs for one user", () => {
    expect(
      groupProjectPresenceState({
        "user-1": [
          {
            id: "user-1",
            email: "one@example.com",
            username: "One",
            resource_id: "resource-1",
            online_at: "2026-09-14T12:00:00Z",
          },
          {
            id: "user-1",
            email: "one@example.com",
            username: "One",
            resource_id: "resource-1",
            online_at: "2026-09-14T12:01:00Z",
          },
        ],
        "user-2": [
          {
            id: "user-2",
            email: "two@example.com",
            username: "Two",
            resource_id: "resource-2",
          },
        ],
        invalid: [{ id: "invalid", email: "invalid@example.com" }],
      }),
    ).toEqual({
      "resource-1": [
        expect.objectContaining({
          id: "user-1",
          resource_id: "resource-1",
          online_at: "2026-09-14T12:01:00Z",
        }),
      ],
      "resource-2": [
        expect.objectContaining({ id: "user-2", resource_id: "resource-2" }),
      ],
    });
  });

  it("propagates resource presence through parent folders without duplicating users", () => {
    const snapshot = aggregateProjectPresenceByFolder(
      {
        "resource-1": [
          {
            id: "user-1",
            email: "one@example.com",
            username: "One",
            resource_id: "resource-1",
            online_at: "2026-09-14T12:00:00Z",
          },
        ],
        "resource-2": [
          {
            id: "user-1",
            email: "one@example.com",
            username: "One",
            resource_id: "resource-2",
            online_at: "2026-09-14T12:01:00Z",
          },
          {
            id: "user-2",
            email: "two@example.com",
            username: "Two",
            resource_id: "resource-2",
          },
        ],
      },
      [
        { id: "folder-parent", parent_id: null },
        { id: "folder-child", parent_id: "folder-parent" },
      ],
      [
        { id: "resource-1", folder_id: "folder-child" },
        { id: "resource-2", folder_id: "folder-child" },
      ],
    );

    expect(snapshot["folder-child"]).toEqual([
      expect.objectContaining({
        id: "user-1",
        resource_id: "resource-2",
        online_at: "2026-09-14T12:01:00Z",
      }),
      expect.objectContaining({ id: "user-2" }),
    ]);
    expect(snapshot["folder-parent"]?.map((member) => member.id)).toEqual([
      "user-1",
      "user-2",
    ]);
  });

  it.each([
    { visibilityState: "visible", supportsWorker: false },
    { visibilityState: "hidden", supportsWorker: true },
  ] as const)("keeps open-document presence ($visibilityState, worker: $supportsWorker)", async ({
    visibilityState,
    supportsWorker,
  }) => {
    let presenceSync: (() => void) | undefined;
    let editorActivity: ((message: { payload: unknown }) => void) | undefined;
    let subscriptionHandler: ((status: string) => void) | undefined;
    const track = vi.fn(async () => "ok");
    const untrack = vi.fn(async () => "ok");
    const send = vi.fn(async () => "ok");
    const state = {
      "user-1": [
        {
          id: "user-1",
          email: "artist@example.com",
          username: "Artist",
          resource_id: "resource-1",
        },
      ],
    };
    const channel = {
      on: vi.fn(
        (
          type: string,
          filter: { event: string },
          handler: ((message: { payload: unknown }) => void) | (() => void),
        ) => {
          if (type === "presence" && filter.event === "sync") {
            presenceSync = handler as () => void;
          }
          if (type === "broadcast" && filter.event === "editor.activity") {
            editorActivity = handler as (message: { payload: unknown }) => void;
          }
          return channel;
        },
      ),
      presenceState: vi.fn(() => state),
      subscribe: vi.fn((handler: (status: string) => void) => {
        subscriptionHandler = handler;
        handler("SUBSCRIBED");
        return channel;
      }),
      send,
      track,
      untrack,
    };
    const disconnect = vi.fn();
    const removeChannel = vi.fn(async () => "ok");
    const createChannel = vi.fn(() => channel);
    const setAuth = vi.fn(async () => undefined);
    supabaseMocks.RealtimeClient.mockImplementation(
      class {
        channel = createChannel;
        disconnect = disconnect;
        removeChannel = removeChannel;
        setAuth = setAuth;
      } as unknown as (...args: any[]) => any,
    );
    vi.stubGlobal("window", supportsWorker ? { Worker: vi.fn() } : {});
    const documentState = { visibilityState } as { visibilityState: DocumentVisibilityState };
    vi.stubGlobal("document", documentState);
    const config = {
      enabled: true,
      supabase_url: "https://project.supabase.co",
      publishable_key: "sb_publishable_test",
      access_token: "realtime-token",
      expires_at: new Date(Date.now() + 65_000).toISOString(),
      channel: "project:project-1:presence",
      user: {
        id: "user-1",
        email: "artist@example.com",
        username: "Artist",
        avatar_url: null,
        avatar_pixel_art: null,
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify(config),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const onSync = vi.fn();
    const onEditorActivity = vi.fn();

    const connection = connectProjectPresence(
      "project-1",
      onSync,
      "resource-1",
      onEditorActivity,
    );

    await vi.waitFor(() => {
      expect(track).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "user-1",
          resource_id: "resource-1",
        }),
      );
    });
    expect(createChannel).toHaveBeenCalledWith("project:project-1:presence", {
      config: {
        broadcast: { ack: false, self: false },
        private: true,
        presence: { enabled: true, key: "user-1" },
      },
    });
    expect(supabaseMocks.RealtimeClient).toHaveBeenCalledWith(
      "wss://project.supabase.co/realtime/v1",
      expect.objectContaining({ worker: supportsWorker }),
    );
    expect(setAuth).toHaveBeenCalledWith("realtime-token");
    expect(setAuth.mock.invocationCallOrder[0]).toBeLessThan(
      channel.subscribe.mock.invocationCallOrder[0]!,
    );
    expect(send).toHaveBeenCalledWith({
      event: "editor.activity",
      payload: expect.objectContaining({
        client_id: connection.clientId,
        kind: "sync-request",
        resource_id: "resource-1",
        sequence: 1,
      }),
      type: "broadcast",
    });

    presenceSync?.();
    expect(onSync).toHaveBeenLastCalledWith({
      "resource-1": [
        expect.objectContaining({ id: "user-1", resource_id: "resource-1" }),
      ],
    });

    connection.sendEditorActivity("cursor", {
      height: 32,
      tool: "pencil",
      visible: true,
      width: 32,
      x: 2,
      y: 3,
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send).toHaveBeenCalledWith({
      event: "editor.activity",
      payload: expect.objectContaining({
        client_id: connection.clientId,
        kind: "cursor",
        resource_id: "resource-1",
        sequence: 2,
      }),
      type: "broadcast",
    });

    editorActivity?.({
      payload: {
        client_id: "remote-client",
        kind: "cursor",
        payload: { height: 32, tool: "pencil", visible: true, width: 32, x: 4, y: 5 },
        resource_id: "resource-1",
        sent_at: "2026-09-14T14:00:00Z",
        sequence: 1,
        user: { id: "user-2", email: "other@example.com" },
      },
    });
    expect(onEditorActivity).toHaveBeenCalledWith(
      expect.objectContaining({ client_id: "remote-client", kind: "cursor" }),
    );

    documentState.visibilityState = "hidden";
    presenceSync?.();
    expect(onSync).toHaveBeenLastCalledWith({
      "resource-1": [expect.objectContaining({ id: "user-1" })],
    });
    expect(untrack).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();

    // A real network interruption can still happen. Rejoining must restore
    // the same document even when its browser tab remains in the background.
    subscriptionHandler?.("CHANNEL_ERROR");
    expect(onSync).toHaveBeenLastCalledWith({});
    subscriptionHandler?.("SUBSCRIBED");
    await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(2));
    expect(track).toHaveBeenLastCalledWith(
      expect.objectContaining({ client_id: connection.clientId, resource_id: "resource-1" }),
    );
    expect(send).toHaveBeenLastCalledWith({
      type: "broadcast",
      event: "editor.activity",
      payload: expect.objectContaining({ kind: "sync-request", resource_id: "resource-1" }),
    });

    const options = supabaseMocks.RealtimeClient.mock.calls[0]?.[1] as {
      accessToken: () => Promise<string | null>;
    };
    expect(await options.accessToken()).toBe("realtime-token");
    expect(fetch).toHaveBeenCalledOnce();
    // Renew a nearly expired JWT while the independently checked room lease
    // is still fresh. A jump of decades must instead retire the stale room.
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(config.expires_at) - 60_000);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      ...config,
      access_token: "refreshed-token",
      expires_at: "2100-09-14T12:00:00Z",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    expect(await options.accessToken()).toBe("refreshed-token");
    expect(fetch).toHaveBeenCalledTimes(2);
    documentState.visibilityState = "visible";
    presenceSync?.();
    expect(untrack).not.toHaveBeenCalled();

    connection.setResourceId(null);
    await vi.waitFor(() => expect(untrack).toHaveBeenCalledOnce());
    connection.setResourceId("resource-2");
    await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(3));
    expect(track).toHaveBeenLastCalledWith(expect.objectContaining({ resource_id: "resource-2" }));
    connection.close();
    connection.close();
    await vi.waitFor(() => expect(removeChannel).toHaveBeenCalledWith(channel));
    expect(untrack).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalledOnce();
    subscriptionHandler?.("SUBSCRIBED");
    connection.sendEditorActivity("sync-request", {});
    connection.setResourceId("resource-1");
    expect(track).toHaveBeenCalledTimes(3);
  });
});
