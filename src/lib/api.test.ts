import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getResourceEditorState,
  patchCurrentUser,
  patchProjectResource,
  putResourceEditorState,
  type PixelAvatarData,
  type ProjectResourcePublic,
} from "./api";

const resource: ProjectResourcePublic = {
  id: "resource-1",
  project_id: "project-1",
  folder_id: null,
  revision: 4,
  name: "Hero",
  type: "pixel_art",
  resource_metadata: { kind: "image" },
  thumbnail_url: null,
  color: "#79b8ff",
  position: 1,
  created_at: "2026-09-11T18:00:00Z",
  updated_at: "2026-09-11T18:01:00Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resource editor state", () => {
  it("loads and saves the private state endpoint with encoded identifiers", async () => {
    const persisted = {
      version: 1,
      state: { activeLayerId: "layer-2", primaryColor: "#FF00FF" },
      user_id: "user-1",
      resource_id: "resource/1",
      created_at: "2026-09-14T10:00:00Z",
      updated_at: "2026-09-14T10:01:00Z",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(persisted), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(persisted), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await getResourceEditorState("project 1", "resource/1");
    const saved = await putResourceEditorState("project 1", "resource/1", {
      version: 1,
      state: persisted.state,
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/v1/projects/project%201/resources/resource%2F1/editor-state",
    );
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: "PUT",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      version: 1,
      state: persisted.state,
    });
    expect(saved).toEqual(persisted);
  });
});

describe("patchProjectResource", () => {
  it("sends an optional base revision and returns the updated resource", async () => {
    const encodedPathResource = {
      ...resource,
      id: "resource 1",
      project_id: "project/1",
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(encodedPathResource), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await patchProjectResource("project/1", "resource 1", {
      data: { pixel_art: { version: 2 } },
      base_revision: 3,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/projects/project%2F1/resources/resource%201");
    expect(init).toMatchObject({
      method: "PATCH",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      data: { pixel_art: { version: 2 } },
      base_revision: 3,
    });
    expect(result).toEqual({ ok: true, status: 200, resource: encodedPathResource });
  });

  it("keeps legacy updates valid when base_revision is omitted", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ ...resource, revision: 5 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await patchProjectResource("project-1", "resource-1", { name: "Hero idle" });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({ name: "Hero idle" });
  });

  it("returns structured revision conflict information for HTTP 409", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            detail: {
              code: "resource_revision_conflict",
              current_revision: 7,
            },
          }),
          {
            status: 409,
            statusText: "Conflict",
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );

    const result = await patchProjectResource("project-1", "resource-1", {
      data: {},
      base_revision: 4,
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      statusText: "Conflict",
      detail: {
        code: "resource_revision_conflict",
        current_revision: 7,
      },
      conflict: {
        code: "resource_revision_conflict",
        current_revision: 7,
      },
    });
  });

  it("returns ordinary HTTP failures without inventing a conflict", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ detail: "Insufficient project role" }), {
          status: 403,
          statusText: "Forbidden",
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const result = await patchProjectResource("project-1", "resource-1", { data: {} });

    expect(result).toEqual({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      detail: "Insufficient project role",
      conflict: null,
    });
  });

  it("lets network failures reject so autosave can retain the local snapshot", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));

    await expect(
      patchProjectResource("project-1", "resource-1", { data: {}, base_revision: 4 }),
    ).rejects.toThrow("Failed to fetch");
  });

  it("rejects an empty successful response instead of reporting a false save", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );

    await expect(
      patchProjectResource("project-1", "resource-1", {
        data: { pixel_art: { version: 2 } },
        base_revision: 4,
      }),
    ).rejects.toThrow("did not confirm");
  });

  it("rejects a successful response for a different resource", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ...resource, id: "resource-2" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(
      patchProjectResource("project-1", "resource-1", {
        data: { pixel_art: { version: 2 } },
        base_revision: 4,
      }),
    ).rejects.toThrow("did not confirm");
  });

  it("rejects an acknowledgement older than the requested base revision", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ...resource, revision: 3 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(
      patchProjectResource("project-1", "resource-1", {
        data: { pixel_art: { version: 2 } },
        base_revision: 4,
      }),
    ).rejects.toThrow("invalid resource revision");
  });
});

describe("patchCurrentUser", () => {
  it("sends a dotted username and pixel avatar together and returns the saved profile", async () => {
    const avatar: PixelAvatarData = {
      version: 1,
      size: 16,
      palette: ["#FFFFFF", "#000000"],
      pixels: Array.from({ length: 256 }, (_, index) => index % 2 ? "#000000" : "#FFFFFF"),
    };
    const user = {
      id: "user-1",
      username: "Dr.Maraka.exe",
      email: "artist@example.com",
      avatar_url: null,
      avatar_pixel_art: avatar,
      is_admin: false,
      created_at: "2026-09-12T08:00:00Z",
      updated_at: "2026-09-12T08:02:00Z",
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(user), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      patchCurrentUser({ username: "Dr.Maraka.exe", avatar_pixel_art: avatar }),
    ).resolves.toEqual(user);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/users/me");
    expect(init).toMatchObject({
      method: "PATCH",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      username: "Dr.Maraka.exe",
      avatar_pixel_art: avatar,
    });
  });

  it("turns FastAPI validation details into a readable profile error", async () => {
    const message = "Username can only contain letters, numbers, dots, underscores and hyphens";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({
          detail: [{
            type: "value_error",
            loc: ["body", "username"],
            msg: `Value error, ${message}`,
            input: "artist/name",
            ctx: { error: {} },
          }],
        }), {
          status: 422,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(patchCurrentUser({ username: "artist/name" })).rejects.toEqual(
      new Error(message),
    );
  });

  it.each([
    { label: "object detail", detail: { error: "Unknown validation error" } },
    { label: "malformed validation entries", detail: [{ msg: {} }, null, "Unknown error"] },
    { label: "empty validation message", detail: [{ msg: "   " }] },
    { label: "missing detail", detail: undefined },
  ])("uses the profile fallback for $label", async ({ detail }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ detail }), {
          status: 422,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(patchCurrentUser({ username: "artist" })).rejects.toEqual(
      new Error("Could not update your profile."),
    );
  });

  it("surfaces the server's duplicate username error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ detail: "Username already taken" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(patchCurrentUser({ username: "existing_artist" })).rejects.toEqual(
      new Error("Username already taken"),
    );
  });

  it("accepts a semantically matching normalized personal pixel-art palette", async () => {
    const user = {
      id: "user-1",
      username: "artist",
      email: "artist@example.com",
      avatar_url: null,
      avatar_pixel_art: null,
      pixel_art_palette: [
        { id: "ocean", color: "#2A8198", name: "Ocean" },
        { id: "ink", color: "#19002F" },
      ],
      is_admin: false,
      created_at: "2026-09-12T08:00:00Z",
      updated_at: "2026-09-12T08:01:00Z",
    };
    const requestedPalette = [
      { id: "  ocean  ", color: " #2a8198 ", name: "  Ocean  " },
      { id: "ink", color: "#19002f", name: "   " },
    ];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(user), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      patchCurrentUser({ pixel_art_palette: requestedPalette }),
    ).resolves.toEqual(user);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/users/me");
    expect(init).toMatchObject({
      method: "PATCH",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      pixel_art_palette: requestedPalette,
    });
  });

  it("does not require a palette acknowledgement for updates that omit it", async () => {
    const userWithoutPalette = {
      id: "user-1",
      username: "renamed_artist",
      email: "artist@example.com",
      is_admin: false,
      created_at: "2026-09-12T08:00:00Z",
      updated_at: "2026-09-12T08:02:00Z",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify(userWithoutPalette), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(
      patchCurrentUser({ username: "renamed_artist" }),
    ).resolves.toEqual(userWithoutPalette);
  });

  it("surfaces a palette validation failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ detail: "Palette colors must be unique" }), {
          status: 422,
          statusText: "Unprocessable Content",
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(
      patchCurrentUser({
        pixel_art_palette: [
          { id: "one", color: "#FFFFFF" },
          { id: "two", color: "#FFFFFF" },
        ],
      }),
    ).rejects.toThrow("Palette colors must be unique");
  });

  it("rejects an unconfirmed palette update", async () => {
    const userWithoutPalette = {
      id: "user-1",
      email: "artist@example.com",
      is_admin: false,
      created_at: "2026-09-12T08:00:00Z",
      updated_at: "2026-09-12T08:01:00Z",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify(userWithoutPalette), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(patchCurrentUser({ pixel_art_palette: [] })).rejects.toThrow(
      "did not confirm",
    );
  });

  it.each([
    ["id", [{ id: "different", color: "#2A8198", name: "Ocean" }]],
    ["color", [{ id: "ocean", color: "#FFFFFF", name: "Ocean" }]],
    ["name", [{ id: "ocean", color: "#2A8198", name: "Lagoon" }]],
  ])("rejects a palette acknowledgement with a mismatched %s", async (_field, palette) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            id: "user-1",
            email: "artist@example.com",
            pixel_art_palette: palette,
            is_admin: false,
            created_at: "2026-09-12T08:00:00Z",
            updated_at: "2026-09-12T08:01:00Z",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );

    await expect(
      patchCurrentUser({
        pixel_art_palette: [
          { id: "ocean", color: "#2A8198", name: "Ocean" },
        ],
      }),
    ).rejects.toThrow("did not confirm");
  });
});
