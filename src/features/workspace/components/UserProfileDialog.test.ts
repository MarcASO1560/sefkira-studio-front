// @ts-expect-error Node's test-only built-in is available without browser typings.
import { readFileSync } from "node:fs";

import * as vue from "vue";
import { compileScript, parse } from "vue/compiler-sfc";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { describe, expect, it, vi } from "vitest";

import * as palette from "../../pixel-art/lib/palette";

const source = readFileSync(new URL("./UserProfileDialog.vue", import.meta.url), "utf8");
const { descriptor } = parse(source);
const compiled = compileScript(descriptor, { id: "profile-dialog-test" });
const script = transpileModule(compiled.content, {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
}).outputText;

const setupProfile = () => {
  const patchCurrentUser = vi.fn(async () => ({ id: "user-1", username: "dr.maraka.exe" }));
  const emit = vi.fn();
  const exports: { default?: { setup: (...args: unknown[]) => unknown } } = {};
  const scope = vue.effectScope();
  new Function("require", "exports", script)((name: string) => {
    if (name === "vue") return vue;
    if (name === "../../../lib/api") return { patchCurrentUser };
    if (name === "../../../lib/session") return { clearClientSession: vi.fn() };
    if (name === "../../pixel-art/components/PixelArtEditor.vue") return { default: {} };
    if (name === "../../pixel-art/lib/palette") return palette;
    throw new Error(`Unexpected SFC dependency: ${name}`);
  }, exports);
  const state = scope.run(() => exports.default!.setup(
    { open: true, userUsername: "original_artist", userEmail: "artist@example.com" },
    { expose: () => {}, emit },
  )) as {
    username: vue.Ref<string>;
    usernameError: vue.ComputedRef<string>;
    canSave: vue.ComputedRef<boolean>;
    statusMessage: vue.Ref<string>;
    activeMobilePanel: vue.Ref<string>;
    saveProfile: () => Promise<boolean>;
  };
  return { state, patchCurrentUser, emit, stop: () => scope.stop() };
};

describe("UserProfileDialog username validation", () => {
  it("saves the dotted username from the reported failure", async () => {
    const profile = setupProfile();
    try {
      profile.state.username.value = "  Dr.Maraka.exe  ";
      expect(profile.state.canSave.value).toBe(true);
      expect(await profile.state.saveProfile()).toBe(true);
      expect(profile.patchCurrentUser).toHaveBeenCalledWith({
        username: "Dr.Maraka.exe", avatar_pixel_art: null,
      });
      expect(profile.emit).toHaveBeenCalledWith("saved", {
        id: "user-1", username: "dr.maraka.exe",
      });
    } finally {
      profile.stop();
    }
  });

  it.each(["pixel-artist_1", "marc_seguí", "玩家.123"])("accepts %s", (username) => {
    const profile = setupProfile();
    try {
      profile.state.username.value = username;
      expect(profile.state.usernameError.value).toBe("");
      expect(profile.state.canSave.value).toBe(true);
    } finally {
      profile.stop();
    }
  });

  it.each([
    ["ab", "between 3 and 40"],
    ["a".repeat(41), "between 3 and 40"],
    ["artist name", "Spaces and other symbols"],
    ["artist@name", "Spaces and other symbols"],
    [".-_", "at least one letter or number"],
  ])("explains why %s cannot be saved without sending it", async (username, message) => {
    const profile = setupProfile();
    try {
      profile.state.username.value = username;
      profile.state.activeMobilePanel.value = "avatar";
      expect(profile.state.canSave.value).toBe(false);
      expect(profile.state.usernameError.value).toContain(message);
      expect(await profile.state.saveProfile()).toBe(false);
      expect(profile.patchCurrentUser).not.toHaveBeenCalled();
      expect(profile.state.statusMessage.value).toContain(message);
      expect(profile.state.activeMobilePanel.value).toBe("profile");
    } finally {
      profile.stop();
    }
  });

  it("shows a failed save on the profile tab and clears the error when editing", async () => {
    const profile = setupProfile();
    try {
      profile.patchCurrentUser.mockRejectedValueOnce(new Error("A user with this username already exists"));
      profile.state.activeMobilePanel.value = "avatar";
      expect(await profile.state.saveProfile()).toBe(false);
      expect(profile.emit).not.toHaveBeenCalled();
      expect(profile.state.statusMessage.value).toContain("already exists");
      expect(profile.state.activeMobilePanel.value).toBe("profile");
      profile.state.username.value = "another_artist";
      await vue.nextTick();
      expect(profile.state.statusMessage.value).toBe("");
    } finally {
      profile.stop();
    }
  });
});
