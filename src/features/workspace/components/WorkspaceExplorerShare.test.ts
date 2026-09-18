// @ts-expect-error Node's test-only built-in is available without browser typings.
import { readFileSync } from "node:fs";
import * as vue from "vue";
import { compileScript, parse } from "vue/compiler-sfc";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectShareLinkPublic } from "../../../lib/api";
import * as displayName from "../../../lib/userDisplayName";
import * as palette from "../../pixel-art/lib/palette";
import * as expiration from "../lib/shareLinkExpiration";
import { copyShareLinkText } from "../lib/shareLinkClipboard";

const { descriptor } = parse(readFileSync(new URL("./WorkspaceExplorer.vue", import.meta.url), "utf8"));
const compiled = compileScript(descriptor, { id: "workspace-share-test" });
const script = transpileModule(compiled.content, {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
}).outputText;
const owner = { id: "project-1", name: "Project", color: "#fff", accessRole: "owner" as const, accessCount: 1, projectPixelArt: null };
const link: ProjectShareLinkPublic = {
  project_id: owner.id, token: "existing-token", url: "https://example.com/share/existing-token", role: "editor",
  created_at: "2026-09-18T00:00:00Z", updated_at: "2026-09-18T00:00:00Z",
  expires_at: "2026-09-20T00:00:00Z", is_expired: false,
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});
const setupShare = () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-18T12:00:00Z"));
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json(link));
  vi.stubGlobal("fetch", fetch);
  const assign = vi.fn();
  const storageRemoveItem = vi.fn();
  const classRemove = vi.fn();
  vi.stubGlobal("window", { setTimeout, clearTimeout, sessionStorage: { removeItem: storageRemoveItem }, location: { origin: "https://www.sefkirastudio.com", assign } });
  const documentStub = { activeElement: null as unknown, querySelectorAll: vi.fn(() => [] as unknown[]), getElementById: vi.fn(() => null), documentElement: { classList: { remove: classRemove } } };
  class FocusTarget {
    tabIndex = 0;
    isConnected = true;
    focus = vi.fn(() => { documentStub.activeElement = this; });
    scrollIntoView = vi.fn();
    closest = vi.fn((_selector: string) => null as FocusTarget | null);
    getClientRects = vi.fn(() => [{}]);
    querySelector = vi.fn((_selector: string) => null as FocusTarget | null);
    querySelectorAll = vi.fn((_selector: string) => [] as FocusTarget[]);
  }
  vi.stubGlobal("HTMLElement", FocusTarget);
  vi.stubGlobal("document", documentStub);
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => {}) } });
  const exports: { default?: { setup: (...args: unknown[]) => unknown } } = {};
  new Function("require", "exports", script)((name: string) => {
    if (name === "vue") return { ...vue, onMounted: vi.fn(), onUnmounted: vi.fn() };
    if (name === "../../../lib/api") return { API_V1_URL: "/api/v1" };
    if (name === "../../../lib/realtime") return { connectUserRealtime: vi.fn() };
    if (name === "../../../lib/routeTransition") return { WORKSPACE_TRANSITION_STORAGE_KEY: "transition" };
    if (name === "../../../lib/userDisplayName") return displayName;
    if (name === "../lib/shareLinkExpiration") return expiration;
    if (name === "../lib/shareLinkClipboard") return { copyShareLinkText };
    if (name === "../../pixel-art/lib/palette") return palette;
    if (name.endsWith(".vue")) return { default: {} };
    throw new Error(`Unexpected SFC dependency: ${name}`);
  }, exports);
  const state = exports.default!.setup({}, { expose: () => {} }) as {
    projectPendingShare: vue.Ref<typeof owner | null>; projectShareLink: vue.Ref<ProjectShareLinkPublic | null>;
    shareDialogRef: vue.Ref<HTMLElement | null>; handleShareDialogKeydown: (event: KeyboardEvent) => void;
    shareLinkLoaded: vue.Ref<boolean>; shareRole: vue.Ref<"viewer" | "editor">;
    shareMessage: vue.Ref<string>; isSharingProject: vue.Ref<boolean>;
    shareExpirationPreset: vue.Ref<expiration.ShareExpirationPreset>; shareExpirationDirty: vue.Ref<boolean>;
    shareCustomExpiration: vue.Ref<string>; shareDisablePending: vue.Ref<boolean>;
    openShareDialog: (project: typeof owner | (Omit<typeof owner, "accessRole"> & { accessRole: "viewer" | "editor" })) => Promise<void>;
    resetShareDialog: () => void; closeShareDialog: () => void; updateShareRole: (role: "viewer" | "editor") => Promise<void>;
    updateShareExpiration: (renew?: boolean) => Promise<void>; disableShareLink: () => Promise<void>;
    syncOpenShareLink: () => Promise<void>; copyShareLink: () => Promise<void>;
    openProject: (project: typeof owner) => void;
  };
  return { state, fetch, assign, storageRemoveItem, classRemove, documentStub, FocusTarget };
};
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("WorkspaceExplorer share controller", () => {
  it("brings custom-date validation into view without changing focused input or its selection", async () => {
    const share = setupShare();
    await share.state.openShareDialog(owner);
    const dialog = vue.markRaw(new share.FocusTarget());
    const status = vue.markRaw(new share.FocusTarget());
    const input = vue.markRaw(new share.FocusTarget());
    dialog.querySelector.mockReturnValue(status);
    share.state.shareDialogRef.value = dialog as unknown as HTMLElement;
    share.documentStub.activeElement = input;
    share.state.shareCustomExpiration.value = "";
    share.state.shareExpirationDirty.value = true;
    await share.state.updateShareExpiration();
    await vue.nextTick();
    await vue.nextTick();
    expect(share.state.shareMessage.value).toBe("Choose an expiration date and time.");
    expect(status.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    expect(share.documentStub.activeElement).toBe(input);
    expect(status.focus).not.toHaveBeenCalled();
    expect(input.focus).not.toHaveBeenCalled();
  });

  it("does not scroll a message from a closed dialog into a newly opened Share dialog", async () => {
    const share = setupShare();
    await share.state.openShareDialog(owner);
    const dialog = vue.markRaw(new share.FocusTarget());
    const status = vue.markRaw(new share.FocusTarget());
    dialog.querySelector.mockReturnValue(status);
    share.state.shareDialogRef.value = dialog as unknown as HTMLElement;
    share.state.shareMessage.value = "An obsolete error";
    await vue.nextTick();
    share.state.closeShareDialog();
    await share.state.openShareDialog(owner);
    await vue.nextTick();
    expect(status.scrollIntoView).not.toHaveBeenCalled();
  });

  it("focuses an enabled visible control while the link is still loading", async () => {
    const share = setupShare();
    const dialog = vue.markRaw(new share.FocusTarget());
    const input = vue.markRaw(new share.FocusTarget());
    dialog.querySelectorAll.mockReturnValue([input]);
    share.state.shareDialogRef.value = dialog as unknown as HTMLElement;
    let complete!: (response: Response) => void;
    share.fetch.mockImplementationOnce(async () => new Promise<Response>((resolve) => { complete = resolve; }));
    const loading = share.state.openShareDialog(owner);
    await vue.nextTick();
    expect(share.state.isSharingProject.value).toBe(true);
    expect(input.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(dialog.querySelectorAll.mock.calls[0]?.[0]).toContain("button:not(:disabled)");
    complete(json(link));
    await loading;
  });

  it("contains forward and backward Tab while allowing normal traversal within the dialog", () => {
    const share = setupShare();
    const dialog = vue.markRaw(new share.FocusTarget());
    const first = vue.markRaw(new share.FocusTarget());
    const last = vue.markRaw(new share.FocusTarget());
    dialog.querySelectorAll.mockReturnValue([first, last]);
    share.state.shareDialogRef.value = dialog as unknown as HTMLElement;
    share.state.projectPendingShare.value = owner;
    const key = (shiftKey = false) => ({ key: "Tab", shiftKey, preventDefault: vi.fn() });
    share.documentStub.activeElement = last;
    const forward = key();
    share.state.handleShareDialogKeydown(forward as unknown as KeyboardEvent);
    expect(forward.preventDefault).toHaveBeenCalled();
    expect(first.focus).toHaveBeenCalled();
    const backward = key(true);
    share.state.handleShareDialogKeydown(backward as unknown as KeyboardEvent);
    expect(backward.preventDefault).toHaveBeenCalled();
    expect(last.focus).toHaveBeenCalled();
    share.documentStub.activeElement = first;
    const normal = key();
    share.state.handleShareDialogKeydown(normal as unknown as KeyboardEvent);
    expect(normal.preventDefault).not.toHaveBeenCalled();
    share.documentStub.activeElement = dialog;
    const outsideControls = key(true);
    share.state.handleShareDialogKeydown(outsideControls as unknown as KeyboardEvent);
    expect(outsideControls.preventDefault).toHaveBeenCalled();
    expect(last.focus).toHaveBeenCalledTimes(2);
  });

  it("keeps focus on the dialog if no visible controls are enabled", () => {
    const share = setupShare();
    const dialog = vue.markRaw(new share.FocusTarget());
    share.state.shareDialogRef.value = dialog as unknown as HTMLElement;
    share.state.projectPendingShare.value = owner;
    const event = { key: "Tab", preventDefault: vi.fn() };
    share.state.handleShareDialogKeydown(event as unknown as KeyboardEvent);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(dialog.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("recovers Tab focus from the page body while open and leaves a closed dialog inert", () => {
    const share = setupShare();
    const dialog = vue.markRaw(new share.FocusTarget());
    const first = vue.markRaw(new share.FocusTarget());
    const body = vue.markRaw(new share.FocusTarget());
    dialog.querySelectorAll.mockReturnValue([first]);
    share.state.shareDialogRef.value = dialog as unknown as HTMLElement;
    share.state.projectPendingShare.value = owner;
    share.documentStub.activeElement = body;
    const event = { key: "Tab", target: body, preventDefault: vi.fn() };
    share.state.handleShareDialogKeydown(event as unknown as KeyboardEvent);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(first.focus).toHaveBeenCalledWith({ preventScroll: true });
    share.state.projectPendingShare.value = null;
    share.documentStub.activeElement = body;
    const closedEvent = { key: "Tab", target: body, preventDefault: vi.fn() };
    share.state.handleShareDialogKeydown(closedEvent as unknown as KeyboardEvent);
    expect(closedEvent.preventDefault).not.toHaveBeenCalled();
    expect(share.documentStub.activeElement).toBe(body);
    expect(first.focus).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape and restores initiating focus, while protecting an active mutation or composition", async () => {
    const share = setupShare();
    const opener = vue.markRaw(new share.FocusTarget());
    share.documentStub.activeElement = opener;
    await share.state.openShareDialog(owner);
    const escape = { key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() };
    share.state.isSharingProject.value = true;
    share.state.handleShareDialogKeydown(escape as unknown as KeyboardEvent);
    expect(share.state.projectPendingShare.value).not.toBeNull();
    share.state.isSharingProject.value = false;
    share.state.handleShareDialogKeydown({ ...escape, isComposing: true } as unknown as KeyboardEvent);
    expect(share.state.projectPendingShare.value).not.toBeNull();
    share.state.handleShareDialogKeydown(escape as unknown as KeyboardEvent);
    await vue.nextTick();
    expect(share.state.projectPendingShare.value).toBeNull();
    expect(opener.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("returns to the same card's actions button when its Share item became inert", async () => {
    const share = setupShare();
    const opener = vue.markRaw(new share.FocusTarget());
    const card = vue.markRaw(new share.FocusTarget());
    const actions = vue.markRaw(new share.FocusTarget());
    opener.closest.mockReturnValue(card);
    card.querySelector.mockReturnValue(actions);
    share.documentStub.activeElement = opener;
    await share.state.openShareDialog(owner);
    share.state.closeShareDialog();
    await vue.nextTick();
    expect(opener.focus).not.toHaveBeenCalled();
    expect(actions.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("does not replace the original opener on retry or restore focus over a newly opened dialog", async () => {
    const share = setupShare();
    const opener = vue.markRaw(new share.FocusTarget());
    const retry = vue.markRaw(new share.FocusTarget());
    share.documentStub.activeElement = opener;
    share.fetch.mockResolvedValueOnce(json({}, 503));
    await share.state.openShareDialog(owner);
    share.documentStub.activeElement = retry;
    await share.state.openShareDialog(owner);
    share.state.closeShareDialog();
    await vue.nextTick();
    expect(opener.focus).toHaveBeenCalledTimes(1);
    expect(retry.focus).not.toHaveBeenCalled();
    share.documentStub.activeElement = opener;
    await share.state.openShareDialog(owner);
    share.state.closeShareDialog();
    const nextLoading = share.state.openShareDialog(owner);
    await nextLoading;
    expect(opener.focus).toHaveBeenCalledTimes(1);
  });

  it.each(["storage removal", "storage access"])("opens a project card when %s is blocked", (failure) => {
    const share = setupShare();
    if (failure === "storage removal") share.storageRemoveItem.mockImplementation(() => { throw new Error("Storage blocked"); });
    else Object.defineProperty(window, "sessionStorage", { get: () => { throw new Error("Storage blocked"); } });
    expect(() => share.state.openProject(owner)).not.toThrow();
    expect(share.classRemove).toHaveBeenCalledWith("route-transition-pending");
    expect(share.assign).toHaveBeenCalledWith("/studio/project-1");
  });
  it.each(["viewer", "editor"] as const)("does not load/manage links for a %s", async (accessRole) => {
    const share = setupShare();
    await share.state.openShareDialog({ ...owner, accessRole });
    expect(share.fetch).not.toHaveBeenCalled();
    expect(share.state.projectPendingShare.value).toBeNull();
  });

  it("does not share a local-only project", async () => {
    const share = setupShare();
    await share.state.openShareDialog({ ...owner, id: "local-project" });
    expect(share.fetch).not.toHaveBeenCalled();
  });

  it("loads existing settings without creating or renewing the link", async () => {
    const share = setupShare();
    await share.state.openShareDialog(owner);
    expect(share.fetch).toHaveBeenCalledTimes(1);
    expect(share.fetch.mock.calls[0]?.[1]?.method).toBeUndefined();
    expect(share.state.projectShareLink.value?.token).toBe(link.token);
    expect(share.state.shareExpirationDirty.value).toBe(false);
  });

  it("recovers from a failed initial load through an explicit retry", async () => {
    const share = setupShare();
    share.fetch.mockResolvedValueOnce(json({ detail: "Temporary outage" }, 503));
    await share.state.openShareDialog(owner);
    expect(share.state.shareLinkLoaded.value).toBe(false);
    expect(share.state.isSharingProject.value).toBe(false);
    expect(share.state.shareMessage.value).toBe("Temporary outage");
    await share.state.openShareDialog(owner);
    expect(share.state.shareLinkLoaded.value).toBe(true);
    expect(share.state.shareMessage.value).toBe("");
  });

  it("changes only permission while preserving token, deadline and an unsaved expiration draft", async () => {
    const share = setupShare();
    await share.state.openShareDialog(owner);
    share.state.shareExpirationPreset.value = "30days";
    share.state.shareExpirationDirty.value = true;
    share.fetch.mockResolvedValueOnce(json({ ...link, role: "viewer" }));
    await share.state.updateShareRole("viewer");
    expect(JSON.parse(share.fetch.mock.calls[1]?.[1]?.body as string)).toEqual({ role: "viewer" });
    expect(share.state.projectShareLink.value?.expires_at).toBe(link.expires_at);
    expect(share.state.shareExpirationPreset.value).toBe("30days");
    expect(share.state.shareExpirationDirty.value).toBe(true);
  });

  it.each([null, { ...link, is_expired: true }])("keeps permission changes as a draft for an inactive link", async (inactive) => {
    const share = setupShare();
    share.fetch.mockResolvedValueOnce(json(inactive));
    await share.state.openShareDialog(owner);
    await share.state.updateShareRole("viewer");
    expect(share.state.shareRole.value).toBe("viewer");
    expect(share.fetch).toHaveBeenCalledTimes(1);
  });

  it("rolls permission back on a denied save and presents a useful error", async () => {
    const share = setupShare();
    await share.state.openShareDialog(owner);
    share.fetch.mockResolvedValueOnce(json({ detail: "Not enough permissions" }, 403));
    await share.state.updateShareRole("viewer");
    expect(share.state.shareRole.value).toBe("editor");
    expect(share.state.shareMessage.value).toBe("Not enough permissions");
    expect(share.state.isSharingProject.value).toBe(false);
  });

  it("creates a new link explicitly with the drafted permission and no expiration", async () => {
    const share = setupShare();
    share.fetch.mockResolvedValueOnce(json(null));
    await share.state.openShareDialog(owner);
    await share.state.updateShareRole("viewer");
    share.state.shareExpirationPreset.value = "never";
    await share.state.updateShareExpiration();
    expect(JSON.parse(share.fetch.mock.calls[1]?.[1]?.body as string)).toEqual({ role: "viewer", expires_at: null });
  });

  it("renews an expired dated link with a new token and a fresh seven-day deadline", async () => {
    const share = setupShare();
    share.fetch.mockResolvedValueOnce(json({ ...link, expires_at: "2026-09-17T00:00:00Z", is_expired: true }));
    await share.state.openShareDialog(owner);
    share.fetch.mockResolvedValueOnce(json({ ...link, token: "renewed-token", expires_at: "2026-09-25T12:00:00Z" }));
    await share.state.updateShareExpiration(true);
    expect(JSON.parse(share.fetch.mock.calls[1]?.[1]?.body as string)).toEqual({
      role: "editor", expires_at: "2026-09-25T12:00:00.000Z", rotate_token: true,
    });
    expect(share.state.shareMessage.value).toContain("previous link no longer works");
  });

  it("rejects a past custom expiration without a server write", async () => {
    const share = setupShare();
    await share.state.openShareDialog(owner);
    share.state.shareCustomExpiration.value = "2020-01-01T12:00";
    share.state.shareExpirationDirty.value = true;
    await share.state.updateShareExpiration();
    expect(share.fetch).toHaveBeenCalledTimes(1);
    expect(share.state.shareMessage.value).toContain("future");
  });

  it("disables the link only after confirmation and keeps member access messaging", async () => {
    const share = setupShare();
    await share.state.openShareDialog(owner);
    await share.state.disableShareLink();
    expect(share.fetch).toHaveBeenCalledTimes(1);
    share.state.shareDisablePending.value = true;
    share.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await share.state.disableShareLink();
    expect(share.fetch.mock.calls[1]?.[1]?.method).toBe("DELETE");
    expect(share.state.projectShareLink.value).toBeNull();
    expect(share.state.shareMessage.value).toContain("keep their access");
  });

  it("ignores a slow initial response after the dialog was reset", async () => {
    const share = setupShare();
    let complete!: (response: Response) => void;
    share.fetch.mockImplementationOnce(async () => new Promise<Response>((resolve) => { complete = resolve; }));
    const loading = share.state.openShareDialog(owner);
    share.state.resetShareDialog();
    complete(json(link));
    await loading;
    expect(share.state.projectPendingShare.value).toBeNull();
    expect(share.state.projectShareLink.value).toBeNull();
    expect(share.state.isSharingProject.value).toBe(false);
  });

  it("does not overwrite a permission save with an older background snapshot", async () => {
    const share = setupShare();
    await share.state.openShareDialog(owner);
    let complete!: (response: Response) => void;
    share.fetch.mockImplementationOnce(async () => new Promise<Response>((resolve) => { complete = resolve; }));
    const syncing = share.state.syncOpenShareLink();
    share.fetch.mockResolvedValueOnce(json({ ...link, role: "viewer" }));
    await share.state.updateShareRole("viewer");
    complete(json(link));
    await syncing;
    expect(share.state.shareRole.value).toBe("viewer");
    expect(share.state.projectShareLink.value?.role).toBe("viewer");
  });

  it("gives mobile/desktop manual-copy instructions when clipboard permission is denied", async () => {
    const share = setupShare();
    await share.state.openShareDialog(owner);
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => { throw new Error("Permission denied"); }) } });
    const input = { value: "https://www.sefkirastudio.com/share/existing-token", isConnected: true, focus: vi.fn(), select: vi.fn(), setSelectionRange: vi.fn() };
    vi.stubGlobal("document", { getElementById: vi.fn(() => input) });
    await share.state.copyShareLink();
    expect(input.select).toHaveBeenCalled();
    expect(share.state.shareMessage.value).toContain("Press and hold");
  });
});
