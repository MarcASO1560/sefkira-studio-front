import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCESS_TOKEN_STORAGE_KEY, LEGACY_ACCESS_TOKEN_STORAGE_KEY, clearStoredAccessTokens } from "./session";

afterEach(() => vi.unstubAllGlobals());
describe("cookie sessions with restricted client storage", () => {
  it("removes both legacy access tokens when client storage is available", () => {
    const removeItem = vi.fn();
    vi.stubGlobal("window", { localStorage: { removeItem } });
    clearStoredAccessTokens();
    expect(removeItem.mock.calls).toEqual([[ACCESS_TOKEN_STORAGE_KEY], [LEGACY_ACCESS_TOKEN_STORAGE_KEY]]);
  });
  it("does not break authentication when accessing localStorage is forbidden", () => {
    vi.stubGlobal("window", { get localStorage() { throw new Error("Storage blocked"); } });
    expect(clearStoredAccessTokens).not.toThrow();
  });
  it("still attempts the second legacy token after the first removal fails", () => {
    const removeItem = vi.fn().mockImplementationOnce(() => { throw new Error("Storage blocked"); });
    vi.stubGlobal("window", { localStorage: { removeItem } });
    expect(clearStoredAccessTokens).not.toThrow();
    expect(removeItem).toHaveBeenCalledTimes(2);
  });
});
