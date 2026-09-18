// @ts-expect-error Node's test-only built-in is available without browser typings.
import { readFileSync } from "node:fs";
import * as vue from "vue";
import { compileScript, parse } from "vue/compiler-sfc";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as expiration from "../lib/shareLinkExpiration";

const { descriptor } = parse(readFileSync(new URL("./ProjectShareGate.vue", import.meta.url), "utf8"));
const compiled = compileScript(descriptor, { id: "share-gate-test" });
const script = transpileModule(compiled.content, {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
}).outputText;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});
const setupGate = () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json({ id: "joined-project" }));
  vi.stubGlobal("fetch", fetch);
  const assign = vi.fn();
  const storage = vi.fn();
  vi.stubGlobal("window", {
    setTimeout, clearTimeout,
    sessionStorage: { setItem: storage },
    location: { origin: "https://www.sefkirastudio.com", pathname: "/share/a%20token", assign },
  });
  const classAdd = vi.fn();
  vi.stubGlobal("document", { documentElement: { classList: { add: classAdd } } });
  let mounted = () => {};
  let unmounted = () => {};
  const exports: { default?: { setup: (...args: unknown[]) => unknown } } = {};
  new Function("require", "exports", script)((name: string) => {
    if (name === "vue") return { ...vue, onMounted: (callback: () => void) => { mounted = callback; }, onUnmounted: (callback: () => void) => { unmounted = callback; } };
    if (name === "../../../lib/api") return { API_V1_URL: "/api/v1" };
    if (name === "../../../lib/routeTransition") return { WORKSPACE_TRANSITION_STORAGE_KEY: "transition" };
    if (name === "../lib/shareLinkExpiration") return expiration;
    throw new Error(`Unexpected SFC dependency: ${name}`);
  }, exports);
  const state = exports.default!.setup({ token: "a token" }, { expose: () => {} }) as {
    status: vue.Ref<string>; message: vue.Ref<string>; canRetry: vue.ComputedRef<boolean>;
    joinSharedProject: () => Promise<void>; redirectToStudio: () => void;
  };
  return { state, fetch, assign, storage, classAdd, mount: () => mounted(), unmount: () => unmounted() };
};
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("ProjectShareGate", () => {
  it("accepts the link on mount using the session and opens the joined project", async () => {
    const gate = setupGate();
    gate.mount();
    await vi.advanceTimersByTimeAsync(260);
    expect(gate.fetch).toHaveBeenCalledWith("/api/v1/projects/share-links/a%20token/accept", expect.objectContaining({
      method: "POST", credentials: "same-origin", signal: expect.any(AbortSignal),
    }));
    expect(gate.state.status.value).toBe("redirecting");
    expect(gate.assign).toHaveBeenCalledWith("/studio/joined-project");
  });

  it("still opens the project when private browser storage is unavailable", async () => {
    const gate = setupGate();
    gate.storage.mockImplementation(() => { throw new Error("Storage blocked"); });
    await gate.state.joinSharedProject();
    await vi.advanceTimersByTimeAsync(260);
    expect(gate.assign).toHaveBeenCalledWith("/studio/joined-project");
  });

  it.each([401, 403])("preserves the share destination when authentication expires (%s)", async (status) => {
    const gate = setupGate();
    gate.fetch.mockResolvedValue(json({ detail: "Could not validate credentials" }, status));
    await gate.state.joinSharedProject();
    const loginUrl = new URL(gate.assign.mock.calls[0]?.[0] as string);
    expect(loginUrl.pathname).toBe("/login");
    expect(new URLSearchParams(loginUrl.hash.slice(1)).get("next")).toBe("/share/a%20token");
  });

  it.each([
    [410, { code: "share_link_expired" }, "expired"],
    [403, { code: "project_user_blocked" }, "blocked"],
    [403, "Not enough permissions", "access"],
    [404, "Share link not found", "active link"],
  ])("shows a final link/permission error without a misleading retry (%s)", async (status, detail, message) => {
    const gate = setupGate();
    gate.fetch.mockResolvedValue(json({ detail }, status as number));
    await gate.state.joinSharedProject();
    expect(gate.state.status.value).toBe("error");
    expect(gate.state.canRetry.value).toBe(false);
    expect(gate.state.message.value).toContain(message as string);
    expect(gate.assign).not.toHaveBeenCalled();
  });

  it.each([408, 429, 500, 503])("offers retry for temporary server failures (%s)", async (status) => {
    const gate = setupGate();
    gate.fetch.mockResolvedValueOnce(json({}, status));
    await gate.state.joinSharedProject();
    expect(gate.state.canRetry.value).toBe(true);
    expect(gate.state.message.value).toContain("try again");
    await gate.state.joinSharedProject();
    await vi.advanceTimersByTimeAsync(260);
    expect(gate.assign).toHaveBeenCalledWith("/studio/joined-project");
  });

  it("uses a fresh request after a timeout and accepts a subsequent retry", async () => {
    const gate = setupGate();
    gate.fetch.mockImplementationOnce(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Timed out", "AbortError")));
    }));
    const initial = gate.state.joinSharedProject();
    await vi.advanceTimersByTimeAsync(18000);
    await initial;
    expect(gate.state.canRetry.value).toBe(true);
    const initialSignal = gate.fetch.mock.calls[0]?.[1]?.signal;
    expect(initialSignal?.aborted).toBe(true);
    await gate.state.joinSharedProject();
    expect(gate.fetch.mock.calls[1]?.[1]?.signal).not.toBe(initialSignal);
    expect(gate.fetch.mock.calls[1]?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(260);
    expect(gate.assign).toHaveBeenCalledWith("/studio/joined-project");
  });

  it("avoids duplicate accepts and ignores completion after unmount", async () => {
    const gate = setupGate();
    let complete!: (response: Response) => void;
    gate.fetch.mockImplementationOnce(async () => new Promise<Response>((resolve) => { complete = resolve; }));
    const initial = gate.state.joinSharedProject();
    await gate.state.joinSharedProject();
    expect(gate.fetch).toHaveBeenCalledTimes(1);
    gate.unmount();
    expect(gate.fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    complete(json({ id: "joined-project" }));
    await initial;
    await vi.advanceTimersByTimeAsync(260);
    expect(gate.assign).not.toHaveBeenCalled();
  });

  it("cancels a pending navigation on unmount", async () => {
    const gate = setupGate();
    await gate.state.joinSharedProject();
    gate.unmount();
    await vi.advanceTimersByTimeAsync(260);
    expect(gate.assign).not.toHaveBeenCalled();
  });
});
