import { afterEach, describe, expect, it, vi } from "vitest";
import { createImageOperationTransport, ImageOperationHttpError } from "./imageOperationsApi";
import type { ImageOperation } from "./imageOperations";

const operation: ImageOperation = {
  operation_id: "test-operation", base_revision: 0, width: 1, height: 1,
  actions: [{ type: "pixels", layer_id: "layer", changes: [[0, "#FFFFFF"]] }],
};

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("image operation HTTP transport", () => {
  it("times out stalled requests so the original durable operation can retry", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    })));
    const sending = createImageOperationTransport("project", "resource").sendOperation(operation);
    const rejected = expect(sending).rejects.toThrow("connection timed out");
    await vi.advanceTimersByTimeAsync(20000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps an HTTP error's status even when the hosting provider returns HTML", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => { throw new Error("HTML response"); } }));
    const sending = createImageOperationTransport("project", "resource").sendOperation(operation);
    await expect(sending).rejects.toBeInstanceOf(ImageOperationHttpError);
    await expect(sending).rejects.toMatchObject({ status: 503 });
  });

  it("does not treat a successful but malformed acknowledgement as a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => { throw new Error("invalid JSON"); } }));
    await expect(createImageOperationTransport("project", "resource").sendOperation(operation)).rejects.toThrow("response could not be read");
  });
});
