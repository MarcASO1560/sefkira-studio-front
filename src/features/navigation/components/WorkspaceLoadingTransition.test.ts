// @ts-expect-error Node's test-only built-in is available without browser typings.
import { readFileSync } from "node:fs";
import * as vue from "vue";
import { compileScript, parse } from "vue/compiler-sfc";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

const { descriptor } = parse(readFileSync(new URL("./WorkspaceLoadingTransition.vue", import.meta.url), "utf8"));
const compiled = compileScript(descriptor, { id: "loading-transition-test" });
const script = transpileModule(compiled.content, {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
}).outputText;
const setupEntry = () => {
  vi.useFakeTimers();
  const getItem = vi.fn(() => "pending" as string | null);
  const removeItem = vi.fn();
  const classRemove = vi.fn();
  vi.stubGlobal("window", {
    sessionStorage: { getItem, removeItem }, setTimeout, clearTimeout,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 1),
    cancelAnimationFrame: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", {
    readyState: "complete", documentElement: { classList: { remove: classRemove } },
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  });
  let mount: () => Promise<void> = async () => {};
  const exports: { default?: { setup: (...args: unknown[]) => unknown } } = {};
  new Function("require", "exports", script)((name: string) => {
    if (name === "vue") return { ...vue, watch: vi.fn(), onMounted: (callback: () => Promise<void>) => { mount = callback; }, onBeforeUnmount: vi.fn() };
    if (name === "../../../lib/routeTransition") return { WORKSPACE_TRANSITION_STORAGE_KEY: "transition" };
    throw new Error(`Unexpected SFC dependency: ${name}`);
  }, exports);
  const state = exports.default!.setup({ phase: "entry", active: false }, { expose: () => {} }) as {
    isRendered: vue.Ref<boolean>; isVisible: vue.Ref<boolean>;
  };
  return { state, getItem, removeItem, classRemove, mount: () => mount() };
};
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("WorkspaceLoadingTransition entry with restricted storage", () => {
  it.each(["access", "read", "cleanup"])("mounts without a rejected promise or overlay when storage %s is blocked", async (failure) => {
    const entry = setupEntry();
    if (failure === "access") Object.defineProperty(window, "sessionStorage", { get: () => { throw new Error("Storage blocked"); } });
    else if (failure === "read") entry.getItem.mockImplementation(() => { throw new Error("Storage blocked"); });
    else entry.removeItem.mockImplementation(() => { throw new Error("Storage blocked"); });
    await expect(entry.mount()).resolves.toBeUndefined();
    expect(entry.state.isRendered.value).toBe(false);
    expect(entry.classRemove).toHaveBeenCalledWith("route-transition-pending");
  });

  it("clears a stale page transition class when there is no pending entry", async () => {
    const entry = setupEntry();
    entry.getItem.mockReturnValue(null);
    await entry.mount();
    expect(entry.removeItem).not.toHaveBeenCalled();
    expect(entry.classRemove).toHaveBeenCalledWith("route-transition-pending");
  });

  it("still consumes the pending marker and finishes the normal entry transition", async () => {
    const entry = setupEntry();
    const mounting = entry.mount();
    await vi.advanceTimersByTimeAsync(1000);
    await mounting;
    expect(entry.removeItem).toHaveBeenCalledWith("transition");
    expect(entry.state.isRendered.value).toBe(false);
    expect(entry.classRemove).toHaveBeenCalledWith("route-transition-pending");
  });
});
