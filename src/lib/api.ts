const runtimeEnv = (
  globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  }
).process?.env;

export const BACKEND_API_ORIGIN = (
  runtimeEnv?.API_BASE_URL ||
  import.meta.env.PUBLIC_API_BASE_URL ||
  "http://127.0.0.1:8001"
)
  .replace(/\/$/, "")
  .replace(/\/api\/v1$/, "");

export const API_ORIGIN = "";
export const API_V1_URL = "/api/v1";
export const BACKEND_API_V1_URL = `${BACKEND_API_ORIGIN}/api/v1`;

export type UserPublic = {
  id: string;
  username?: string | null;
  email: string;
  avatar_url?: string | null;
  avatar_pixel_art?: PixelAvatarData | null;
  pixel_art_palette?: PixelArtPaletteColor[];
  is_admin: boolean;
  created_at: string;
  updated_at: string;
};

export type PixelArtPaletteColor = {
  id: string;
  color: string;
  name?: string | null;
};

export type UserUpdate = {
  username?: string | null;
  avatar_pixel_art?: PixelAvatarData | null;
  pixel_art_palette?: PixelArtPaletteColor[];
};

export type PixelAvatarData = {
  version: 1;
  size: number;
  palette: string[];
  pixels: Array<string | null>;
};

export type DocumentChatAuthor = {
  id: string;
  username?: string | null;
  display_name?: string | null;
  avatar_url?: string | null;
  avatar_pixel_art?: PixelAvatarData | null;
};

export type DocumentChatMessagePublic = {
  id: number;
  client_message_id: string;
  project_id: string;
  resource_id: string;
  author: DocumentChatAuthor;
  body: string;
  sticker_id?: string | null;
  created_at: string;
};

export type DocumentChatMessageCreate = {
  client_message_id: string;
  body: string;
  sticker_id?: string | null;
};

export type DocumentChatPage = {
  messages: DocumentChatMessagePublic[];
  has_more: boolean;
  next_before_id: number | null;
};

export class DocumentChatHttpError extends Error {
  constructor(readonly status: number) {
    super(`Chat request failed (HTTP ${status}).`);
    this.name = "DocumentChatHttpError";
  }
}

export type ProjectAccessRole = "owner" | "editor" | "viewer";

export type ProjectPublic = {
  id: string;
  owner_id: string;
  access_role?: ProjectAccessRole;
  access_count?: number;
  name: string;
  description?: string | null;
  settings: Record<string, unknown>;
  thumbnail_url?: string | null;
  created_at: string;
  updated_at: string;
  last_opened_at?: string | null;
};

export type ProjectFolderPublic = {
  id: string;
  project_id: string;
  parent_id?: string | null;
  name: string;
  color?: string | null;
  position: number;
  created_at: string;
  updated_at: string;
};

export type ProjectResourcePublic = {
  id: string;
  project_id: string;
  folder_id?: string | null;
  revision: number;
  name: string;
  type: string;
  resource_metadata: Record<string, unknown>;
  thumbnail_url?: string | null;
  color?: string | null;
  position: number;
  created_at: string;
  updated_at: string;
};

export type ProjectResourceDetail = ProjectResourcePublic & {
  data: Record<string, unknown>;
};

export type ProjectResourceUpdate = {
  name?: string;
  folder_id?: string | null;
  resource_metadata?: Record<string, unknown>;
  data?: Record<string, unknown>;
  base_revision?: number;
  thumbnail_url?: string | null;
  color?: string | null;
  position?: number;
};

export type ResourceEditorStatePayload = {
  version: number;
  state: Record<string, unknown>;
};

export type ResourceEditorStatePublic = ResourceEditorStatePayload & {
  user_id: string;
  resource_id: string;
  created_at: string;
  updated_at: string;
};

export type ProjectResourceRevisionConflict = {
  code: "resource_revision_conflict";
  current_revision: number | null;
};

export type ProjectResourcePatchResult =
  | {
      ok: true;
      status: number;
      resource: ProjectResourcePublic;
    }
  | {
      ok: false;
      status: number;
      statusText: string;
      detail: unknown;
      conflict: ProjectResourceRevisionConflict | null;
    };

export type ProjectResourcePatchOptions = {
  accessToken?: string;
  direct?: boolean;
  signal?: AbortSignal;
};

export type ProjectTree = {
  folders: ProjectFolderPublic[];
  resources: ProjectResourcePublic[];
};

export type ProjectShareLinkPublic = {
  project_id: string;
  token: string;
  url: string;
  role: ProjectAccessRole;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  is_expired: boolean;
};

export type ProjectAccessUserPublic = {
  id: string;
  username?: string | null;
  email: string;
  avatar_url?: string | null;
  avatar_pixel_art?: PixelAvatarData | null;
  role: ProjectAccessRole;
  is_owner: boolean;
  joined_at?: string | null;
};

export type ProjectBlockedUserPublic = {
  id: string;
  username?: string | null;
  email: string;
  avatar_url?: string | null;
  avatar_pixel_art?: PixelAvatarData | null;
  blocked_at: string;
};

export type WorkspaceBootstrap = {
  user: UserPublic;
  projects: ProjectPublic[];
};

export type ProjectWorkspaceBootstrap = {
  user: UserPublic;
  project: ProjectPublic;
  tree: ProjectTree;
};

export const apiUrl = (path: string, options: { direct?: boolean } = {}) => {
  const apiBase = options.direct ? BACKEND_API_V1_URL : API_V1_URL;
  const origin = options.direct ? BACKEND_API_ORIGIN : API_ORIGIN;

  return path.startsWith("/api/")
    ? `${origin}${path}`
    : `${apiBase}${path.startsWith("/") ? path : `/${path}`}`;
};

export const healthUrl = () => `${BACKEND_API_ORIGIN}/health`;

export const fetchApi = async <ResponseBody>(
  path: string,
  init: RequestInit & { accessToken?: string; direct?: boolean } = {},
) => {
  const { accessToken, direct = false, headers, ...requestInit } = init;
  const response = await fetch(apiUrl(path, { direct }), {
    ...requestInit,
    credentials: requestInit.credentials ?? (direct ? "omit" : "same-origin"),
    headers: {
      Accept: "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
  });

  if (!response.ok) {
    return null;
  }

  if (response.status === 204) {
    return null;
  }

  return (await response.json()) as ResponseBody;
};

const resourceEditorStatePath = (projectId: string, resourceId: string) =>
  `/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(
    resourceId,
  )}/editor-state`;

export const getResourceEditorState = (projectId: string, resourceId: string) =>
  fetchApi<ResourceEditorStatePublic>(resourceEditorStatePath(projectId, resourceId));

const documentChatPath = (projectId: string, resourceId: string) =>
  `/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(resourceId)}/chat/messages`;

const requestDocumentChat = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(apiUrl(path), {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json", ...init.headers },
  });
  if (!response.ok) throw new DocumentChatHttpError(response.status);
  return await response.json() as T;
};

export const getDocumentChatMessages = (
  projectId: string,
  resourceId: string,
  options: { limit?: number; beforeId?: number; afterId?: number; signal?: AbortSignal } = {},
) => {
  const query = new URLSearchParams({ limit: String(options.limit ?? 50) });
  if (options.beforeId !== undefined) query.set("before_id", String(options.beforeId));
  if (options.afterId !== undefined) query.set("after_id", String(options.afterId));
  return requestDocumentChat<DocumentChatPage>(`${documentChatPath(projectId, resourceId)}?${query}`, {
    signal: options.signal,
  });
};

export const postDocumentChatMessage = (
  projectId: string,
  resourceId: string,
  payload: DocumentChatMessageCreate,
  options: { signal?: AbortSignal } = {},
) => requestDocumentChat<DocumentChatMessagePublic>(documentChatPath(projectId, resourceId), {
  method: "POST",
  signal: options.signal,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

export const putResourceEditorState = (
  projectId: string,
  resourceId: string,
  payload: ResourceEditorStatePayload,
  options: { keepalive?: boolean } = {},
) =>
  fetchApi<ResourceEditorStatePublic>(resourceEditorStatePath(projectId, resourceId), {
    method: "PUT",
    keepalive: options.keepalive,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const readProjectResourceConflict = (
  status: number,
  responseBody: unknown,
): ProjectResourceRevisionConflict | null => {
  if (status !== 409 || !isRecord(responseBody) || !isRecord(responseBody.detail)) {
    return null;
  }

  const { code, current_revision: currentRevision } = responseBody.detail;
  if (
    code !== "resource_revision_conflict" ||
    (currentRevision !== null &&
      (!Number.isInteger(currentRevision) || Number(currentRevision) < 0))
  ) {
    return null;
  }

  return {
    code,
    current_revision: currentRevision === null ? null : Number(currentRevision),
  };
};

const readJsonResponse = async (response: Response) => {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
};

const readApiErrorMessage = (responseBody: unknown, fallback: string) => {
  if (!isRecord(responseBody)) {
    return fallback;
  }

  if (typeof responseBody.detail === "string") {
    return responseBody.detail;
  }

  if (Array.isArray(responseBody.detail)) {
    const messages = responseBody.detail
      .filter(isRecord)
      .map((issue) => typeof issue.msg === "string" ? issue.msg.replace(/^Value error, /, "").trim() : "")
      .filter(Boolean);
    if (messages.length) return [...new Set(messages)].slice(0, 3).join(" ");
  }

  return fallback;
};

const isUserPublicAcknowledgement = (value: unknown): value is UserPublic =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.email === "string" &&
  typeof value.is_admin === "boolean" &&
  typeof value.created_at === "string" &&
  typeof value.updated_at === "string" &&
  (value.pixel_art_palette === undefined || Array.isArray(value.pixel_art_palette));

type NormalizedPixelArtPaletteColor = {
  id: string;
  color: string;
  name: string | null;
};

const normalizePixelArtPaletteColor = (
  value: unknown,
): NormalizedPixelArtPaletteColor | null => {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.color !== "string") {
    return null;
  }

  const id = value.id.trim();
  const color = value.color.trim().toUpperCase();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id) ||
    !/^#[0-9A-F]{6}(?:[0-9A-F]{2})?$/.test(color)
  ) {
    return null;
  }

  if (
    value.name !== undefined &&
    value.name !== null &&
    typeof value.name !== "string"
  ) {
    return null;
  }

  const name = typeof value.name === "string" ? value.name.trim() || null : null;
  return { id, color, name };
};

const normalizePixelArtPalette = (
  value: unknown,
): NormalizedPixelArtPaletteColor[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }

  const palette: NormalizedPixelArtPaletteColor[] = [];
  for (const entry of value) {
    const normalizedEntry = normalizePixelArtPaletteColor(entry);
    if (!normalizedEntry) {
      return null;
    }
    palette.push(normalizedEntry);
  }

  return palette;
};

const isMatchingPixelArtPaletteAcknowledgement = (
  requested: unknown,
  acknowledged: unknown,
) => {
  const requestedPalette = normalizePixelArtPalette(requested);
  const acknowledgedPalette = normalizePixelArtPalette(acknowledged);

  return (
    requestedPalette !== null &&
    acknowledgedPalette !== null &&
    requestedPalette.length === acknowledgedPalette.length &&
    requestedPalette.every((entry, index) => {
      const acknowledgedEntry = acknowledgedPalette[index];
      return (
        acknowledgedEntry !== undefined &&
        entry.id === acknowledgedEntry.id &&
        entry.color === acknowledgedEntry.color &&
        entry.name === acknowledgedEntry.name
      );
    })
  );
};

export const patchCurrentUser = async (update: UserUpdate): Promise<UserPublic> => {
  const isPaletteUpdate = update.pixel_art_palette !== undefined;
  const response = await fetch(apiUrl("/users/me"), {
    method: "PATCH",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(update),
  });
  const responseBody = await readJsonResponse(response);

  if (!response.ok) {
    throw new Error(
      readApiErrorMessage(responseBody, isPaletteUpdate
        ? "Your personal palette could not be saved."
        : "Could not update your profile."),
    );
  }

  if (!isUserPublicAcknowledgement(responseBody)) {
    throw new Error(isPaletteUpdate
      ? "The server did not confirm the personal palette update."
      : "The server did not confirm the profile update.");
  }

  if (
    update.pixel_art_palette !== undefined &&
    !isMatchingPixelArtPaletteAcknowledgement(
      update.pixel_art_palette,
      responseBody.pixel_art_palette,
    )
  ) {
    throw new Error("The server did not confirm the personal palette update.");
  }

  return responseBody;
};

const isProjectResourcePatchAcknowledgement = (
  value: unknown,
  projectId: string,
  resourceId: string,
): value is ProjectResourcePublic =>
  isRecord(value) &&
  value.id === resourceId &&
  value.project_id === projectId &&
  Number.isInteger(value.revision) &&
  Number(value.revision) >= 0 &&
  typeof value.name === "string" &&
  typeof value.type === "string" &&
  isRecord(value.resource_metadata) &&
  Number.isInteger(value.position) &&
  typeof value.created_at === "string" &&
  typeof value.updated_at === "string";

export const patchProjectResource = async (
  projectId: string,
  resourceId: string,
  update: ProjectResourceUpdate,
  options: ProjectResourcePatchOptions = {},
): Promise<ProjectResourcePatchResult> => {
  const { accessToken, direct = false, signal } = options;
  const response = await fetch(
    apiUrl(
      `/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(resourceId)}`,
      { direct },
    ),
    {
      method: "PATCH",
      credentials: direct ? "omit" : "same-origin",
      signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(update),
    },
  );
  const responseBody = await readJsonResponse(response);

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      statusText: response.statusText,
      detail: isRecord(responseBody) ? responseBody.detail : null,
      conflict: readProjectResourceConflict(response.status, responseBody),
    };
  }

  // A successful HTTP status alone is not proof that the resource mutation was
  // committed. Only expose success to autosave after the backend identifies the
  // exact resource and returns its persisted revision.
  if (!isProjectResourcePatchAcknowledgement(responseBody, projectId, resourceId)) {
    throw new Error("The server did not confirm the resource update.");
  }

  if (
    update.base_revision !== undefined &&
    responseBody.revision < update.base_revision
  ) {
    throw new Error("The server returned an invalid resource revision.");
  }

  return {
    ok: true,
    status: response.status,
    resource: responseBody,
  };
};
