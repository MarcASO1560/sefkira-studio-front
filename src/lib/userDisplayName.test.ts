import { describe, expect, it, vi } from "vitest";

import { getAccessUserDisplayName, getUserDisplayName, getUserInitials, hasVisibleUserName } from "./userDisplayName";

describe("user display names", () => {
  it.each(["Dr.Maraka.exe", "  Artist  Name  ", "Píxel 🎨", "a".repeat(255)])(
    "preserves the complete username exactly: %s", (username) => {
      expect(getUserDisplayName({ username, email: "artist@example.com" })).toBe(username);
    },
  );

  it.each([undefined, null, "", " \t\n ", "\u00a0\u3000"])(
    "uses the complete email when username has no visible text: %s", (username) => {
      expect(getUserDisplayName({ username, email: "artist.name@example.com" })).toBe("artist.name@example.com");
      expect(getAccessUserDisplayName({ username, email: "artist.name@example.com" })).toBe("artist.name@example.com");
    },
  );

  it("uses a generic fallback only when neither username nor email is available", () => {
    expect(getUserDisplayName({ username: " ", email: " " })).toBe("Project member");
    expect(getUserDisplayName({}, "Collaborator")).toBe("Collaborator");
    expect(getAccessUserDisplayName({})).toBe("User");
  });

  it("keeps the access handle prefix without adding another prefix to an existing handle", () => {
    expect(getAccessUserDisplayName({ username: "Dr.Maraka.exe" })).toBe("@Dr.Maraka.exe");
    expect(getAccessUserDisplayName({ username: "@Artist" })).toBe("@Artist");
    expect(getAccessUserDisplayName({ username: "  @Artist  " })).toBe("  @Artist  ");
    expect(getAccessUserDisplayName({ username: "  Artist  " })).toBe("@  Artist  ");
  });

  it("rejects missing and malformed values without changing visible text", () => {
    for (const value of [undefined, null, 4, {}, "", " \t\n"]) expect(hasVisibleUserName(value)).toBe(false);
    expect(hasVisibleUserName("  Artist  ")).toBe(true);
  });
});

describe("Unicode user initials", () => {
  it.each([
    ["🎨 Artist", "🎨A"],
    ["👨‍💻 Artist", "👨‍💻A"],
    ["🇪🇸 Artist", "🇪🇸A"],
    ["👍🏽 Artist", "👍🏽A"],
    ["a\u0301 Artist", "A\u0301A"],
  ])("keeps the first grapheme intact for %s", (name, expected) => {
    expect(getUserInitials(name)).toBe(expected);
    expect(getUserInitials(name, "ME", 1)).toBe(expected);
  });

  it("uses complete graphemes for a single-word name", () => {
    expect(getUserInitials("🎨")).toBe("🎨");
    expect(getUserInitials("👨‍💻🇪🇸")).toBe("👨‍💻🇪🇸");
    expect(getUserInitials("👨‍💻🇪🇸", "ME", 1)).toBe("👨‍💻");
  });

  it("preserves existing letter initials and generic fallbacks", () => {
    expect(getUserInitials("Marc Albert")).toBe("MA");
    expect(getUserInitials("Artist")).toBe("AR");
    expect(getUserInitials("Artist", "ME", 1)).toBe("A");
    expect(getUserInitials(" \t\n", "ME")).toBe("ME");
  });

  it("keeps complete code points in runtimes without Intl.Segmenter", async () => {
    vi.resetModules();
    vi.stubGlobal("Intl", Object.assign(Object.create(Intl), { Segmenter: undefined }));
    try {
      const legacyRuntime = await import("./userDisplayName");
      expect(legacyRuntime.getUserInitials("🎨 Artist")).toBe("🎨A");
      expect(legacyRuntime.getUserInitials("🎨", "ME", 1)).toBe("🎨");
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
