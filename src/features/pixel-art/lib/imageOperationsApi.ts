import { apiUrl, type ProjectResourceDetail } from "../../../lib/api";
import { parsePixelArtResourceData } from "./migrations";
import { toImageOperationPacket, type ImageOperation, type ImageOperationTransform, type SharedImageHistory } from "./imageOperations";
import { isValidImageDimensions } from "./document";

export type ImageOperationAcknowledgement = {
  operation_id: string;
  applied_revision: number;
  resource: ProjectResourceDetail;
  history?: SharedImageHistory;
  transforms?: ImageOperationTransform[];
};

export type ImageOperationState = {
  resource: ProjectResourceDetail;
  history: SharedImageHistory;
  transforms: ImageOperationTransform[];
};

export const validateSharedImageHistory = (value: unknown): SharedImageHistory => {
  if (!value || typeof value !== "object" || typeof (value as SharedImageHistory).can_undo !== "boolean" || typeof (value as SharedImageHistory).can_redo !== "boolean") throw new Error("The server returned invalid shared history state.");
  return { can_undo: (value as SharedImageHistory).can_undo, can_redo: (value as SharedImageHistory).can_redo };
};
export const validateImageOperationTransforms = (value: unknown): ImageOperationTransform[] => {
  if (!Array.isArray(value)) throw new Error("The server returned invalid shared coordinate history.");
  for (const event of value as ImageOperationTransform[]) {
    if (!event || !Number.isSafeInteger(event.revision) || event.revision < 0 || !isValidImageDimensions(event.from_width, event.from_height) || !isValidImageDimensions(event.to_width, event.to_height) || !Number.isInteger(event.offset_x) || !Number.isInteger(event.offset_y) || event.operation_id !== undefined && typeof event.operation_id !== "string" || event.user_id !== undefined && event.user_id !== null && typeof event.user_id !== "string") throw new Error("The server returned malformed shared coordinate history.");
  }
  if (new Set(value.map((event) => event.revision)).size !== value.length) throw new Error("The server returned duplicate shared coordinate revisions.");
  return value as ImageOperationTransform[];
};
export const validateImageOperationState = (value: unknown, projectId: string, resourceId: string): ImageOperationState => {
  if (!value || typeof value !== "object") throw new Error("The server returned invalid image synchronization state.");
  const state = value as ImageOperationState;
  const resource = normalizeImageOperationResource(state.resource, projectId, resourceId);
  const history = validateSharedImageHistory(state.history);
  const transforms = validateImageOperationTransforms(state.transforms);
  if (transforms.some((event) => event.revision > resource.revision)) throw new Error("The shared coordinate history is newer than its image snapshot.");
  return { resource, history, transforms };
};

export class ImageOperationHttpError extends Error {
  readonly status: number;
  readonly detail: unknown;
  constructor(status: number, detail: unknown) {
    const message = detail && typeof detail === "object" && "message" in detail && typeof detail.message === "string" ? detail.message : `Unable to synchronize image changes (HTTP ${status}).`;
    super(message);
    this.name = "ImageOperationHttpError";
    this.status = status;
    this.detail = detail;
  }
}

export const normalizeImageOperationResource = (value: unknown, projectId: string, resourceId: string): ProjectResourceDetail => {
  if (!value || typeof value !== "object") throw new Error("The server returned an invalid image resource.");
  const resource = value as ProjectResourceDetail;
  if (resource.id !== resourceId || resource.project_id !== projectId || !Number.isSafeInteger(resource.revision) || resource.revision < 0 || !resource.data || typeof resource.data !== "object") throw new Error("The server returned an unrelated or invalid image resource.");
  const parsed = parsePixelArtResourceData(resource.data);
  if (parsed.migrated) parsed.document.layers[0]!.id = "legacy-layer-1";
  return { ...resource, data: { ...resource.data, pixel_art: parsed.document } };
};

export const validateImageOperationAcknowledgement = (value: unknown, operation: ImageOperation, projectId: string, resourceId: string): ImageOperationAcknowledgement => {
  if (!value || typeof value !== "object") throw new Error("The server did not confirm your image operation.");
  const acknowledgement = value as ImageOperationAcknowledgement;
  if (acknowledgement.operation_id !== operation.operation_id || !Number.isSafeInteger(acknowledgement.applied_revision) || acknowledgement.applied_revision <= operation.base_revision) throw new Error("The server returned an invalid image-operation acknowledgement. Your changes remain pending.");
  const resource = normalizeImageOperationResource(acknowledgement.resource, projectId, resourceId);
  if (acknowledgement.applied_revision > resource.revision) throw new Error("The server returned an inconsistent image revision. Your changes remain pending.");
  const history = acknowledgement.history === undefined ? undefined : validateSharedImageHistory(acknowledgement.history);
  const transforms = acknowledgement.transforms === undefined ? undefined : validateImageOperationTransforms(acknowledgement.transforms);
  if (transforms?.some((event) => event.revision > resource.revision)) throw new Error("The acknowledged coordinate history is newer than its image snapshot.");
  return { ...acknowledgement, resource, history, transforms };
};

export type ImageOperationTransport = {
  fetchResource: () => Promise<ProjectResourceDetail>;
  sendOperation: (operation: ImageOperation) => Promise<unknown>;
  fetchState?: (sinceRevision: number) => Promise<ImageOperationState>;
};

export const createImageOperationTransport = (projectId: string, resourceId: string): ImageOperationTransport => {
  const path = `/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(resourceId)}`;
  const request = async (suffix: string, init?: RequestInit) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(apiUrl(path + suffix), { ...init, signal: controller.signal, credentials: "same-origin", headers: { Accept: "application/json", ...init?.headers } });
      let value: unknown;
      try { value = await response.json(); } catch {
        if (controller.signal.aborted) throw new Error("The connection timed out. Your changes remain pending.");
        if (!response.ok) throw new ImageOperationHttpError(response.status, null);
        throw new Error("The server response could not be read. Your changes remain pending.");
      }
      if (!response.ok) throw new ImageOperationHttpError(response.status, value && typeof value === "object" && "detail" in value ? value.detail : value);
      return value;
    } catch (error) {
      if (controller.signal.aborted) throw new Error("The connection timed out. Your changes remain pending.");
      throw error;
    } finally { clearTimeout(timeout); }
  };
  return {
    async fetchResource() { return normalizeImageOperationResource(await request("", { cache: "no-store" }), projectId, resourceId); },
    async fetchState(sinceRevision) { return validateImageOperationState(await request(`/image-operations?since_revision=${encodeURIComponent(sinceRevision)}`, { cache: "no-store" }), projectId, resourceId); },
    sendOperation(operation) {
      return request("/image-operations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(toImageOperationPacket(operation)) });
    },
  };
};
