import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DocumentChatHttpError,
  getDocumentChatMessages,
  getProjectChatUnread,
  markDocumentChatRead,
  postDocumentChatMessage,
  type DocumentChatMessagePublic,
  type DocumentChatPage,
} from "./api";
import { connectUserRealtime, REALTIME_EVENT_NAMES, type RealtimeConnection } from "./realtime";

vi.mock("@supabase/realtime-js", () => ({ RealtimeClient: vi.fn() }));

const message: DocumentChatMessagePublic = {
  id: 1,
  project_id: "project",
  resource_id: "resource",
  client_message_id: "00000000-0000-4000-8000-000000000001",
  author: { id: "owner", username: "Owner", avatar_url: null, avatar_pixel_art: null },
  body: "Hello from the document",
  created_at: "2026-09-18T12:00:00Z",
};
const history: DocumentChatPage = { messages: [message], has_more: false, next_before_id: 1,
  unread_count: 1, last_read_message_id: 0, last_message_id: 1, history_visible_from: "2026-09-18T10:00:00Z" };
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});
const connections: RealtimeConnection[] = [];

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("document chat HTTP transport", () => {
  it("loads project counters and acknowledges a document cursor privately without retrieving message bodies", async () => {
    const summary = { resource_id: "resource/1", unread_count: 2, last_message_id: 9, last_read_message_id: 7 };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ documents: [summary] }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getProjectChatUnread("project /one")).resolves.toEqual({ documents: [summary] });
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...summary, unread_count: 0, last_read_message_id: 9 }));
    await expect(markDocumentChatRead("project /one", "resource/1", 9)).resolves.toMatchObject({ unread_count: 0 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/projects/project%20%2Fone/chat/unread");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/projects/project%20%2Fone/resources/resource%2F1/chat/read");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST", cache: "no-store", credentials: "same-origin" });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ last_read_message_id: 9 });
  });
  it("loads only the dedicated, encoded document chat path with private, uncached credentials", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(history));
    vi.stubGlobal("fetch", fetchMock);
    const result = await getDocumentChatMessages("project /one", "resource/1 ?", { signal: controller.signal });
    expect(result).toEqual(history);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/projects/project%20%2Fone/resources/resource%2F1%20%3F/chat/messages?limit=50");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  });

  it("maps older and catch-up cursors to the server query parameter names", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(history));
    vi.stubGlobal("fetch", fetchMock);
    await getDocumentChatMessages("project", "resource", { limit: 25, beforeId: 80 });
    await getDocumentChatMessages("project", "resource", { limit: 100, afterId: 80 });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/projects/project/resources/resource/chat/messages?limit=25&before_id=80",
      "/api/v1/projects/project/resources/resource/chat/messages?limit=100&after_id=80",
    ]);
  });

  it("keeps text payloads backward compatible without requiring a sticker ID", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(message));
    vi.stubGlobal("fetch", fetchMock);
    const payload = { client_message_id: message.client_message_id, body: message.body };
    const result = await postDocumentChatMessage("project/one", "resource 1", payload, { signal: controller.signal });
    expect(result).toEqual(message);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/projects/project%2Fone/resources/resource%201/chat/messages");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "application/json", "Content-Type": "application/json" },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(payload);
  });

  it("sends an empty-body sticker ID and stable client receipt and preserves the acknowledgement", async () => {
    const stickerMessage = { ...message, body: "", sticker_id: "tiny-rpg-slime" };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(stickerMessage));
    vi.stubGlobal("fetch", fetchMock);
    const payload = { client_message_id: message.client_message_id, body: "", sticker_id: "tiny-rpg-slime" };
    await expect(postDocumentChatMessage("project", "resource", payload)).resolves.toEqual(stickerMessage);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(payload);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST", cache: "no-store", credentials: "same-origin" });
  });

  it("preserves optional and nullable sticker IDs alongside existing text history", async () => {
    const stickerHistory = {
      ...history,
      messages: [message, { ...message, id: 2, sticker_id: null }, { ...message, id: 3, body: "", sticker_id: "tiny-rpg-slime" }],
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(stickerHistory)));
    await expect(getDocumentChatMessages("project", "resource")).resolves.toEqual(stickerHistory);
  });

  it.each([401, 403, 404, 409, 422, 500])("retains a typed HTTP status without exposing server internals (%s)", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ detail: "private backend diagnostic" }, status)));
    let failure: unknown;
    try { await getDocumentChatMessages("project", "resource"); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(DocumentChatHttpError);
    expect(failure).toMatchObject({ status, message: `Chat request failed (HTTP ${status}).` });
    expect(String(failure)).not.toContain("private backend diagnostic");
  });

  it("preserves abort failures so navigation can cancel both fetches and sends", async () => {
    const cancellation = new DOMException("Aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn(async () => { throw cancellation; }));
    await expect(getDocumentChatMessages("project", "resource")).rejects.toBe(cancellation);
    await expect(postDocumentChatMessage("project", "resource", {
      client_message_id: message.client_message_id,
      body: message.body,
    })).rejects.toBe(cancellation);
  });
});

describe("dedicated document chat realtime event", () => {
  it("uses the existing authenticated SSE stream and dispatches chat without a canvas-save event", async () => {
    const listeners = new Map<string, EventListener>();
    const close = vi.fn();
    const constructor = vi.fn();
    class FakeEventSource {
      constructor(url: string | URL, options?: EventSourceInit) { constructor(url, options); }
      addEventListener(name: string, handler: EventListener) { listeners.set(name, handler); }
      close = close;
    }
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ enabled: false, latest_event_id: 7 })));
    vi.stubGlobal("EventSource", FakeEventSource);
    const onChat = vi.fn();
    const onCanvasUpdate = vi.fn();
    const connection = connectUserRealtime({ "document.chat.created": onChat, "project.updated": onCanvasUpdate });
    connections.push(connection);
    await vi.waitFor(() => expect(listeners.has("document.chat.created")).toBe(true));
    expect(REALTIME_EVENT_NAMES).toContain("document.chat.created");
    expect(constructor).toHaveBeenCalledOnce();
    expect(constructor).toHaveBeenCalledWith("/api/v1/events/stream", { withCredentials: true });
    const payload = { project_id: message.project_id, resource_id: message.resource_id,
      message: { ...message, body: "", sticker_id: "tiny-rpg-slime" } };
    listeners.get("document.chat.created")?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
    expect(onChat).toHaveBeenCalledWith(payload);
    expect(onCanvasUpdate).not.toHaveBeenCalled();
    connection.close();
    expect(close).toHaveBeenCalledOnce();
  });
});
