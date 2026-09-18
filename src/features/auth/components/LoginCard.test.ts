// @ts-expect-error Node's test-only built-in is available without browser typings.
import { readFileSync } from "node:fs";

import * as vue from "vue";
import { compileScript, parse } from "vue/compiler-sfc";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSafeRedirectPath } from "../../../lib/session";

const source = readFileSync(new URL("./LoginCard.vue", import.meta.url), "utf8");
const { descriptor } = parse(source);
const compiled = compileScript(descriptor, { id: "login-card-test" });
const script = transpileModule(compiled.content.replace(
  "import.meta.env.PUBLIC_GOOGLE_CLIENT_ID", '""',
), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
}).outputText;

const setupRegistration = (redirectPath = "", search = "", hash = "") => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ status: "ok" }), {
    status: 200, headers: { "Content-Type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetch);
  const assign = vi.fn();
  const sessionStorageSetItem = vi.fn();
  const setTimeout = vi.fn((_callback: () => void, _delay: number) => 1);
  vi.stubGlobal("window", {
    clearTimeout: vi.fn(), setTimeout, dispatchEvent: vi.fn(),
    sessionStorage: { setItem: sessionStorageSetItem },
    location: { hash, search, assign },
  });
  vi.stubGlobal("document", { documentElement: { classList: { add: vi.fn() } } });
  const exports: { default?: { setup: (...args: unknown[]) => unknown } } = {};
  new Function("require", "exports", script)((name: string) => {
    if (name === "vue") return { ...vue, onMounted: vi.fn(), onBeforeUnmount: vi.fn() };
    if (name === "../../../lib/session") return {
      clearStoredAccessTokens: vi.fn(), createSafeRedirectPath,
    };
    if (name === "../../../lib/routeTransition") return { WORKSPACE_TRANSITION_STORAGE_KEY: "transition" };
    if (name === "./PulsarLogo.vue") return { default: {} };
    throw new Error(`Unexpected SFC dependency: ${name}`);
  }, exports);
  const state = exports.default!.setup({ redirectPath }, { expose: () => {} }) as {
    signUpUsername: vue.Ref<string>;
    signUpEmail: vue.Ref<string>;
    signUpPassword: vue.Ref<string>;
    signUpRepeatPassword: vue.Ref<string>;
    canCreateAccount: vue.ComputedRef<boolean>;
    status: vue.Ref<string>;
    message: vue.Ref<string>;
    createAccount: () => Promise<void>;
    email: vue.Ref<string>;
    password: vue.Ref<string>;
    signInWithEmail: () => Promise<void>;
    handleGoogleCredential: (response: { credential: string }) => Promise<void>;
  };
  state.signUpEmail.value = " artist@example.com ";
  state.signUpPassword.value = "a-secure-password";
  state.signUpRepeatPassword.value = "a-secure-password";
  return { state, fetch, assign, sessionStorageSetItem, finishRedirect: () => setTimeout.mock.calls.at(-1)?.[0]() };
};

afterEach(() => vi.unstubAllGlobals());

describe("LoginCard optional free-form registration username", () => {
  it.each(["", " \t\n ", " ".repeat(256)])("registers with a blank username as null", async (username) => {
    const registration = setupRegistration();
    registration.state.signUpUsername.value = username;
    expect(registration.state.canCreateAccount.value).toBe(true);
    await registration.state.createAccount();
    expect(registration.state.status.value).toBe("success");
    expect(registration.fetch).toHaveBeenCalledWith("/api/v1/auth/register", expect.objectContaining({
      body: JSON.stringify({
        username: null, email: "artist@example.com", password: "a-secure-password",
        password_confirmation: "a-secure-password",
      }),
    }));
  });

  it.each(["a", "  Marc Seguí 🎨  ", "🧑🏽‍🎨", "@!# / <artist>", "e\u0301 É", "🎨".repeat(255)])("registers with an exact free-form username: %s", async (username) => {
    const registration = setupRegistration();
    registration.state.signUpUsername.value = username;
    await registration.state.createAccount();
    expect(registration.state.status.value).toBe("success");
    const request = registration.fetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(request?.body as string).username).toBe(username);
  });

  it("rejects more than 255 Unicode code points with an actionable message", async () => {
    const registration = setupRegistration();
    registration.state.signUpUsername.value = "🎨".repeat(256);
    await registration.state.createAccount();
    expect(registration.fetch).not.toHaveBeenCalled();
    expect(registration.state.message.value).toBe("Username must be 255 characters or fewer.");
  });

  it("still requires an email and matching passwords when the username is omitted", async () => {
    const registration = setupRegistration();
    registration.state.signUpEmail.value = " ";
    expect(registration.state.canCreateAccount.value).toBe(false);
    await registration.state.createAccount();
    expect(registration.fetch).not.toHaveBeenCalled();
    registration.state.signUpEmail.value = "artist@example.com";
    registration.state.signUpRepeatPassword.value = "another-password";
    await registration.state.createAccount();
    expect(registration.fetch).not.toHaveBeenCalled();
    expect(registration.state.message.value).toBe("Passwords do not match.");
  });
});

describe("LoginCard shared project destination", () => {
  it.each(["email", "signup", "google"])("returns a guest to the exact share link after %s authentication", async (method) => {
    const destination = "/share/a%20token";
    const login = setupRegistration(destination);
    if (method === "signup") await login.state.createAccount();
    else if (method === "google") await login.state.handleGoogleCredential({ credential: "google-test-credential" });
    else {
      login.state.email.value = "artist@example.com";
      login.state.password.value = "a-secure-password";
      await login.state.signInWithEmail();
    }
    login.finishRedirect();
    expect(login.assign).toHaveBeenCalledWith(destination);
  });

  it("restores the share token from the login hash after a session expires", async () => {
    const destination = "/share/a%20token";
    const login = setupRegistration("", "", `#next=${encodeURIComponent(destination)}`);
    await login.state.createAccount();
    login.finishRedirect();
    expect(login.assign).toHaveBeenCalledWith(destination);
  });
  it("follows the share link after successful signup even when transition storage is blocked", async () => {
    const login = setupRegistration("/share/token");
    login.sessionStorageSetItem.mockImplementation(() => { throw new Error("Storage blocked"); });
    await login.state.createAccount();
    login.finishRedirect();
    expect(login.state.status.value).toBe("success");
    expect(login.assign).toHaveBeenCalledWith("/share/token");
  });
});
