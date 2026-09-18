// @ts-expect-error Node's test-only built-in is available without browser typings.
import { readFileSync } from "node:fs";

import * as vue from "vue";
import { compileScript, parse } from "vue/compiler-sfc";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { describe, expect, it, vi } from "vitest";

import type { UserPublic, UserUpdate } from "../../../lib/api";
import * as palette from "../../pixel-art/lib/palette";

const source = readFileSync(new URL("./UserProfileDialog.vue", import.meta.url), "utf8");
const { descriptor } = parse(source);
const compiled = compileScript(descriptor, { id: "profile-dialog-test" });
const script = transpileModule(compiled.content, {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
}).outputText;

const setupProfile = (username: string | null = "Original Artist", pixelAvatar = false) => {
  const user: UserPublic = {
    id: "user-1", username, email: "artist@example.com", is_admin: false,
    created_at: "2026-09-18T00:00:00Z", updated_at: "2026-09-18T00:00:00Z",
  };
  const patchCurrentUser = vi.fn(async (update: UserUpdate): Promise<UserPublic> => ({ ...user, ...update }));
  const emit = vi.fn();
  const props = vue.reactive({
    open: true,
    userUsername: username,
    userName: "Old display name",
    userEmail: user.email,
    userPixelAvatar: pixelAvatar ? {
      version: 1 as const, size: 16, palette: [...palette.PIXEL_ART_PALETTE],
      pixels: Array<string | null>(256).fill(null),
    } : null,
  });
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
    props,
    { expose: () => {}, emit },
  )) as {
    username: vue.Ref<string>;
    usernameError: vue.ComputedRef<string>;
    canSave: vue.ComputedRef<boolean>;
    currentProfileName: vue.ComputedRef<string>;
    hasUnsavedChanges: vue.ComputedRef<boolean>;
    pixels: vue.Ref<Array<string | null>>;
    avatarMode: vue.Ref<"google" | "pixel">;
    showUnsavedConfirm: vue.Ref<boolean>;
    statusMessage: vue.Ref<string>;
    activeMobilePanel: vue.Ref<string>;
    markPixelAvatarEdited: () => void;
    requestClose: () => void;
    discardUnsavedChanges: () => void;
    saveProfile: () => Promise<boolean>;
  };
  return { state, props, user, patchCurrentUser, emit, stop: () => scope.stop() };
};

describe("UserProfileDialog optional free-form usernames", () => {
  it.each([
    "  Dr.Maraka.exe  ",
    "a",
    "Marc Albert Seguí Olmos",
    "玩家 🎨",
    "🧑🏽‍🎨✨",
    "@!# / <artist> .-_",
    "e\u0301 É",
  ])("previews and saves %s exactly as entered", async (username) => {
    const profile = setupProfile();
    try {
      profile.state.username.value = username;
      expect(profile.state.currentProfileName.value).toBe(username);
      expect(profile.state.usernameError.value).toBe("");
      expect(profile.state.canSave.value).toBe(true);
      expect(await profile.state.saveProfile()).toBe(true);
      expect(profile.patchCurrentUser).toHaveBeenCalledWith({
        username, avatar_pixel_art: null,
      });
      expect(profile.emit).toHaveBeenCalledWith("saved", {
        ...profile.user, username, avatar_pixel_art: null,
      });
    } finally {
      profile.stop();
    }
  });

  it.each(["", " \t\n ", " ".repeat(256)])("removes a blank username and saves the pixel avatar independently", async (username) => {
    const profile = setupProfile();
    try {
      profile.state.username.value = username;
      profile.state.pixels.value[0] = palette.PIXEL_ART_CORAL;
      profile.state.markPixelAvatarEdited();
      expect(profile.state.currentProfileName.value).toBe("artist@example.com");
      expect(profile.state.usernameError.value).toBe("");
      expect(profile.state.canSave.value).toBe(true);
      expect(await profile.state.saveProfile()).toBe(true);
      expect(profile.patchCurrentUser).toHaveBeenCalledWith({
        username: null,
        avatar_pixel_art: {
          version: 1, size: 16, palette: palette.PIXEL_ART_PALETTE,
          pixels: profile.state.pixels.value,
        },
      });
      expect(profile.emit.mock.calls[0]?.[1].username).toBeNull();
    } finally {
      profile.stop();
    }
  });

  it("allows editing an avatar on an account that has never had a username", async () => {
    const profile = setupProfile(null, true);
    try {
      expect(profile.state.hasUnsavedChanges.value).toBe(false);
      expect(profile.state.currentProfileName.value).toBe("artist@example.com");
      profile.state.pixels.value[1] = palette.PIXEL_ART_GOLD;
      expect(profile.state.hasUnsavedChanges.value).toBe(true);
      expect(await profile.state.saveProfile()).toBe(true);
      expect(profile.patchCurrentUser.mock.calls[0]?.[0].username).toBeNull();
      expect(profile.patchCurrentUser.mock.calls[0]?.[0].avatar_pixel_art?.pixels[1]).toBe(palette.PIXEL_ART_GOLD);
    } finally {
      profile.stop();
    }
  });

  it("counts the broad length limit in Unicode code points rather than UTF-16 units", async () => {
    const profile = setupProfile();
    try {
      profile.state.username.value = "🎨".repeat(255);
      expect(profile.state.canSave.value).toBe(true);
      expect(await profile.state.saveProfile()).toBe(true);
      expect(profile.patchCurrentUser.mock.calls[0]?.[0].username).toBe("🎨".repeat(255));
      profile.patchCurrentUser.mockClear();
      profile.state.username.value += "🎨";
      profile.state.activeMobilePanel.value = "avatar";
      expect(profile.state.canSave.value).toBe(false);
      expect(profile.state.usernameError.value).toContain("255 characters or fewer");
      expect(await profile.state.saveProfile()).toBe(false);
      expect(profile.patchCurrentUser).not.toHaveBeenCalled();
      expect(profile.state.statusMessage.value).toContain("255 characters or fewer");
      expect(profile.state.activeMobilePanel.value).toBe("profile");
    } finally {
      profile.stop();
    }
  });

  it.each(["original Artist ", "Original Artist  ", " Original Artist "])("warns before discarding a case or whitespace change: %s", async (username) => {
    const profile = setupProfile("Original Artist ");
    try {
      expect(profile.state.username.value).toBe("Original Artist ");
      expect(profile.state.hasUnsavedChanges.value).toBe(false);
      profile.state.username.value = username;
      expect(profile.state.hasUnsavedChanges.value).toBe(true);
      profile.state.requestClose();
      expect(profile.state.showUnsavedConfirm.value).toBe(true);
      expect(profile.emit).not.toHaveBeenCalled();
      expect(await profile.state.saveProfile()).toBe(true);
      expect(profile.patchCurrentUser.mock.calls[0]?.[0].username).toBe(username);
    } finally {
      profile.stop();
    }
  });

  it("preserves the exact username and avatar draft after an error, allowing retry", async () => {
    const profile = setupProfile();
    try {
      profile.state.username.value = "  Marc 🎨  ";
      profile.state.pixels.value[0] = palette.PIXEL_ART_CORAL;
      profile.state.markPixelAvatarEdited();
      profile.patchCurrentUser.mockRejectedValueOnce(new Error("Could not update your profile."));
      profile.state.activeMobilePanel.value = "avatar";
      expect(await profile.state.saveProfile()).toBe(false);
      expect(profile.emit).not.toHaveBeenCalled();
      expect(profile.state.statusMessage.value).toBe("Could not update your profile.");
      expect(profile.state.activeMobilePanel.value).toBe("profile");
      expect(profile.state.username.value).toBe("  Marc 🎨  ");
      expect(profile.state.pixels.value[0]).toBe(palette.PIXEL_ART_CORAL);
      expect(profile.state.hasUnsavedChanges.value).toBe(true);
      expect(await profile.state.saveProfile()).toBe(true);
      expect(profile.patchCurrentUser.mock.calls[1]?.[0]).toEqual(profile.patchCurrentUser.mock.calls[0]?.[0]);
    } finally {
      profile.stop();
    }
  });

  it("restores the original profile when changes are discarded and the dialog reopens", async () => {
    const profile = setupProfile("  Original 🎨  ", true);
    try {
      profile.state.username.value = "";
      profile.state.pixels.value[0] = palette.PIXEL_ART_CORAL;
      profile.state.requestClose();
      profile.state.discardUnsavedChanges();
      expect(profile.emit).toHaveBeenCalledWith("close");
      expect(profile.patchCurrentUser).not.toHaveBeenCalled();
      profile.props.open = false;
      await vue.nextTick();
      profile.props.open = true;
      await vue.nextTick();
      expect(profile.state.username.value).toBe("  Original 🎨  ");
      expect(profile.state.currentProfileName.value).toBe("  Original 🎨  ");
      expect(profile.state.pixels.value[0]).toBeNull();
      expect(profile.state.hasUnsavedChanges.value).toBe(false);
      expect(profile.state.statusMessage.value).toBe("");
    } finally {
      profile.stop();
    }
  });

  it("clears a save error when editing the name", async () => {
    const profile = setupProfile();
    try {
      profile.patchCurrentUser.mockRejectedValueOnce(new Error("Could not update your profile."));
      await profile.state.saveProfile();
      profile.state.username.value = "Another ✨";
      expect(profile.state.statusMessage.value).toBe("");
    } finally {
      profile.stop();
    }
  });
});
