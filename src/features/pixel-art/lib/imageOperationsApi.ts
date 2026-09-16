import { apiUrl, type ProjectResourceDetail } from "../../../lib/api";
import { parsePixelArtResourceData } from "./migrations";
import type { ImageOperation } from "./imageOperations";

export type ImageOperationAcknowledgement = {
  operation_id: string;
  applied_revision: number;
  resource: ProjectResourceDetail;
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
  return { ...acknowledgement, resource };
};

export type ImageOperationTransport = {
  fetchResource: () => Promise<ProjectResourceDetail>;
  sendOperation: (operation: ImageOperation) => Promise<unknown>;
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
    sendOperation(operation) {
      const { operation_id, base_revision, width, height, actions } = operation;
      return request("/image-operations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation_id, base_revision, width, height, actions }) });
    },
  };
};
