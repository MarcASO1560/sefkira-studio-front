import { afterEach, describe, expect, it, vi } from "vitest";

import type { PixelArtDocumentV2 } from "../types";
import { isValidImageDimensions, MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXEL_COUNT } from "./document";
import { compactPixelArtDocument } from "./compactPixels";
import {
  PixelArtImportError,
  RasterImageTooLargeError,
  calculateRasterFitDimensions,
  exportPixelArtJson,
  exportPixelArtJsonBlob,
  exportPixelArtPng,
  importPixelArtJson,
  importRasterImage,
  importRasterImageReduced,
  parsePixelArtJson,
  parsePixelArtJsonValue,
  resizeDecodedRasterNearestNeighbor,
  rgbaBytesToPixelColors,
  sanitizeImageFileName,
} from "./importExport";

const documentV2: PixelArtDocumentV2 = {
  version: 2,
  width: 2,
  height: 1,
  palette: ["#FF0000", "#00FF0080"],
  layers: [
    {
      id: "base",
      name: "Base",
      visible: true,
      locked: false,
      opacity: 1,
      pixels: ["#FF0000", null],
    },
    {
      id: "highlight",
      name: "Highlight",
      visible: false,
      locked: true,
      opacity: 0.5,
      pixels: [null, "#00FF0080"],
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sanitizeImageFileName", () => {
  it("creates a portable base name and strips known extensions", () => {
    expect(sanitizeImageFileName("  Héroe: Idle / Norte.PNG  ")).toBe("heroe-idle-norte");
    expect(sanitizeImageFileName("CON.json")).toBe("con-image");
    expect(sanitizeImageFileName("***", "Untitled image")).toBe("untitled-image");
  });
});

describe("pixel-art JSON", () => {
  it("exports a native wrapper and imports it without losing layers", async () => {
    const json = exportPixelArtJson(documentV2);
    const parsedJson = JSON.parse(json) as { pixel_art: PixelArtDocumentV2 };

    expect(parsedJson).toEqual({ pixel_art: documentV2 });
    await expect(importPixelArtJson(new Blob([json]))).resolves.toEqual(documentV2);

    const blob = exportPixelArtJsonBlob(documentV2, { pretty: false });
    expect(blob.type).toBe("application/json");
    expect(await blob.text()).toBe(JSON.stringify({ pixel_art: documentV2 }));
  });

  it("accepts direct v1 data and migrates it to one normalized v2 layer", () => {
    const imported = parsePixelArtJson(
      JSON.stringify({
        version: 1,
        size: 2,
        palette: ["#ffffff", "#12345678"],
        pixels: ["#ffffff", null, "#12345678", null],
      }),
    );

    expect(imported).toMatchObject({
      version: 2,
      width: 2,
      height: 2,
      palette: ["#FFFFFF", "#12345678"],
    });
    expect(imported.layers).toHaveLength(1);
    expect(imported.layers[0]).toMatchObject({
      name: "Layer 1",
      visible: true,
      locked: false,
      opacity: 1,
      pixels: ["#FFFFFF", null, "#12345678", null],
    });
  });

  it("accepts API-shaped data.pixel_art and resource-data pixel_art wrappers", () => {
    expect(parsePixelArtJsonValue({ data: { pixel_art: documentV2 } })).toEqual(documentV2);
    expect(parsePixelArtJsonValue({ pixel_art: documentV2 })).toEqual(documentV2);
  });

  it.each([
    ["malformed JSON", "{"],
    ["unrelated JSON", JSON.stringify({ width: 2, height: 2, pixels: [] })],
    ["unsupported version", JSON.stringify({ version: 3, width: 1, height: 1 })],
    [
      "wrong pixel count",
      JSON.stringify({
        ...documentV2,
        layers: [{ ...documentV2.layers[0], pixels: [] }],
      }),
    ],
    [
      "invalid pixel color",
      JSON.stringify({
        ...documentV2,
        layers: [{ ...documentV2.layers[0], pixels: ["red", null] }],
      }),
    ],
  ])("rejects %s", (_label, json) => {
    expect(() => parsePixelArtJson(json)).toThrow(PixelArtImportError);
  });

  it("imports compact 1024 × 1024 native JSON through the strict canonical validator", () => {
    const pixels = Array<string | null>(1024 * 1024).fill(null);
    pixels[0] = "#ABCDEF80";
    pixels[pixels.length - 1] = "#FFFFFF";
    const large: PixelArtDocumentV2 = { ...documentV2, width: 1024, height: 1024,
      layers: [{ ...documentV2.layers[0]!, pixels }] };
    const compact = compactPixelArtDocument(large);
    const json = JSON.stringify({ pixel_art: compact });
    expect(json.length).toBeLessThan(10000);
    const imported = parsePixelArtJson(json);
    expect(imported.width).toBe(1024);
    expect(imported.height).toBe(1024);
    expect(imported.layers[0]!.pixels).toEqual(pixels);
    expect(() => parsePixelArtJsonValue({ pixel_art: {
      ...compact, layers: [{ ...compact.layers[0]!, pixels: { encoding: "indexed-deflate-v1", colors: [null], index_bytes: 1, data: "bad" } }],
    } })).toThrow(PixelArtImportError);
  });

  it("rejects excessive native JSON area before allocating large pixel buffers", () => {
    expect(() => parsePixelArtJsonValue({ ...documentV2, width: 4096, height: 4096 }))
      .toThrow(PixelArtImportError);
    expect(() => parsePixelArtJsonValue({ version: 1, width: 3000, height: 1500, pixels: [] }))
      .toThrow(/at most/i);
  });
});

describe("raster import", () => {
  it("calculates proportional fit geometry for wide and tall rasters", () => {
    expect(calculateRasterFitDimensions(1024, 512, 256)).toEqual({
      width: 256,
      height: 128,
      scale: 0.25,
    });
    expect(calculateRasterFitDimensions(200, 300, 256)).toEqual({
      width: 171,
      height: 256,
      scale: 256 / 300,
    });
    expect(calculateRasterFitDimensions(1, 1000, 256)).toEqual({
      width: 1,
      height: 256,
      scale: 0.256,
    });
  });

  it("does not upscale a raster that already fits", () => {
    const source = {
      width: 120,
      height: 80,
      data: new Uint8ClampedArray(120 * 80 * 4),
    };

    expect(calculateRasterFitDimensions(source.width, source.height)).toEqual({
      width: 120,
      height: 80,
      scale: 1,
    });
    expect(resizeDecodedRasterNearestNeighbor(source)).toBe(source);
  });

  it("resamples RGBA pixels with nearest-neighbor geometry", () => {
    const data = new Uint8ClampedArray(4 * 4 * 4);
    for (let index = 0; index < 16; index += 1) {
      data[index * 4] = index;
      data[index * 4 + 1] = 100 + index;
      data[index * 4 + 2] = 200 + index;
      data[index * 4 + 3] = index === 10 ? 128 : 255;
    }

    const resized = resizeDecodedRasterNearestNeighbor(
      { data, width: 4, height: 4 },
      2,
    );

    expect(resized.width).toBe(2);
    expect(resized.height).toBe(2);
    expect(Array.from(resized.data)).toEqual([
      0, 100, 200, 255,
      2, 102, 202, 255,
      8, 108, 208, 255,
      10, 110, 210, 128,
    ]);
  });

  it("maps RGBA bytes to null, RGB, and RGBA pixel colors", () => {
    expect(
      rgbaBytesToPixelColors(
        new Uint8ClampedArray([
          8, 9, 10, 0,
          255, 0, 16, 255,
          18, 52, 86, 128,
        ]),
        3,
        1,
      ),
    ).toEqual([null, "#FF0010", "#12345680"]);
  });

  it("imports PNG/JPEG/WebP decoder output as a one-layer v2 document", async () => {
    for (const mimeType of ["image/png", "image/jpeg", "image/webp"]) {
      const decoder = vi.fn(async () => ({
        width: 2,
        height: 1,
        data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 64]),
      }));
      const imported = await importRasterImage(new Blob([mimeType], { type: mimeType }), {
        decoder,
        layerName: "Imported",
      });

      expect(decoder).toHaveBeenCalledOnce();
      expect(imported).toMatchObject({ version: 2, width: 2, height: 1, palette: [] });
      expect(imported.layers[0]).toMatchObject({
        name: "Imported",
        pixels: ["#FF0000", "#00FF0040"],
      });
    }
  });

  it("reports oversized images without silently resizing them", async () => {
    const decoder = vi.fn(async () => ({
      width: MAX_IMAGE_DIMENSION + 1,
      height: 32,
      data: new Uint8ClampedArray(0),
    }));

    await expect(
      importRasterImage(new Blob([], { type: "image/png" }), { decoder }),
    ).rejects.toMatchObject({
      code: "image-too-large",
      width: MAX_IMAGE_DIMENSION + 1,
      height: 32,
      maxDimension: MAX_IMAGE_DIMENSION,
    });
    await expect(
      importRasterImage(new Blob([], { type: "image/png" }), { decoder }),
    ).rejects.toBeInstanceOf(RasterImageTooLargeError);
  });

  it("imports an oversized raster through the explicit proportional reduction path", async () => {
    const data = new Uint8ClampedArray(8192 * 4 * 4);
    data.set([17, 34, 51, 128], 0);
    const decoder = vi.fn(async () => ({ width: 8192, height: 4, data }));

    const imported = await importRasterImageReduced(
      new Blob([], { type: "image/webp" }),
      { decoder, layerName: "Reduced image" },
    );

    expect(decoder).toHaveBeenCalledOnce();
    expect(imported.width).toBe(4096);
    expect(imported.height).toBe(2);
    expect(imported.layers[0].name).toBe("Reduced image");
    expect(imported.layers[0].pixels).toHaveLength(4096 * 2);
    expect(imported.layers[0].pixels[0]).toBe("#11223380");
  });

  it("accepts full 1024 × 1024 raster imports without silently reducing them", async () => {
    const data = new Uint8ClampedArray(1024 * 1024 * 4);
    data.set([17, 34, 51, 128], 0);
    data.set([255, 0, 0, 255], data.length - 4);
    const decoder = vi.fn(async () => ({ width: 1024, height: 1024, data }));
    const imported = await importRasterImage(new Blob([], { type: "image/png" }), { decoder });
    expect(imported.width).toBe(1024);
    expect(imported.height).toBe(1024);
    expect(imported.layers[0].pixels).toHaveLength(1024 * 1024);
    expect(imported.layers[0].pixels[0]).toBe("#11223380");
    expect(imported.layers[0].pixels.at(-1)).toBe("#FF0000");
  });

  it("enforces the area budget for rasters within the per-axis limits", async () => {
    const decoder = vi.fn(async () => ({ width: 3000, height: 1500, data: new Uint8ClampedArray(0) }));
    await expect(importRasterImage(new Blob([], { type: "image/png" }), { decoder }))
      .rejects.toMatchObject({ code: "image-too-large", width: 3000, height: 1500 });
    expect(calculateRasterFitDimensions(1024, 1024)).toEqual({ width: 1024, height: 1024, scale: 1 });
    expect(calculateRasterFitDimensions(4096, 4096)).toEqual({ width: 2048, height: 2048, scale: 0.5 });
    for (const [width, height] of [[3200, 1400], [16384, 1000], [3000, 1500], [9999, 9999]]) {
      const fit = calculateRasterFitDimensions(width, height);
      expect(fit.width * fit.height).toBeLessThanOrEqual(MAX_IMAGE_PIXEL_COUNT);
      expect(isValidImageDimensions(fit.width, fit.height)).toBe(true);
    }
  });

  it("rejects unsupported file types before decoding", async () => {
    const decoder = vi.fn();

    await expect(
      importRasterImage(new Blob([], { type: "image/gif" }), { decoder }),
    ).rejects.toMatchObject({ code: "unsupported-file-type" });
    expect(decoder).not.toHaveBeenCalled();
  });
});

describe("PNG export", () => {
  it("composites visible layers at integer scale with smoothing disabled", async () => {
    const fillCalls: Array<{ color: string; x: number; y: number; width: number; height: number }> = [];
    const context = {
      imageSmoothingEnabled: true,
      fillStyle: "",
      clearRect: vi.fn(),
      fillRect: vi.fn(function (
        this: { fillStyle: string },
        x: number,
        y: number,
        width: number,
        height: number,
      ) {
        fillCalls.push({ color: this.fillStyle, x, y, width, height });
      }),
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => context),
      toBlob: vi.fn((callback: BlobCallback) => {
        callback(new Blob(["encoded"], { type: "image/png" }));
      }),
    };
    vi.stubGlobal("document", {
      createElement: vi.fn(() => canvas),
    });

    const blob = await exportPixelArtPng(documentV2, { scale: 4 });

    expect(canvas.width).toBe(8);
    expect(canvas.height).toBe(4);
    expect(context.imageSmoothingEnabled).toBe(false);
    expect(context.clearRect).toHaveBeenCalledWith(0, 0, 8, 4);
    expect(fillCalls).toEqual([{ color: "#FF0000", x: 0, y: 0, width: 4, height: 4 }]);
    expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/png");
    expect(blob.type).toBe("image/png");
  });

  it("fills an opaque background before drawing composed pixels", async () => {
    const fillCalls: Array<{ color: string; width: number; height: number }> = [];
    const context = {
      imageSmoothingEnabled: true,
      fillStyle: "",
      clearRect: vi.fn(),
      fillRect: vi.fn(function (
        this: { fillStyle: string },
        _x: number,
        _y: number,
        width: number,
        height: number,
      ) {
        fillCalls.push({ color: this.fillStyle, width, height });
      }),
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => context),
      toBlob: vi.fn((callback: BlobCallback) => callback(new Blob([], { type: "image/png" }))),
    };
    vi.stubGlobal("document", {
      createElement: vi.fn(() => canvas),
    });

    await exportPixelArtPng(documentV2, { backgroundColor: "#123456", scale: 2 });

    expect(fillCalls[0]).toEqual({ color: "#123456", width: 4, height: 2 });
    expect(fillCalls[1]).toEqual({ color: "#FF0000", width: 2, height: 2 });
  });

  it("rejects non-integer export scales and invalid background colors", async () => {
    await expect(
      exportPixelArtPng(documentV2, { scale: 3 as never }),
    ).rejects.toThrow(RangeError);
    await expect(
      exportPixelArtPng(documentV2, { backgroundColor: "red" }),
    ).rejects.toThrow(RangeError);
  });

  it("rejects huge scaled exports before creating an unsafe browser canvas", async () => {
    const large: PixelArtDocumentV2 = { ...documentV2, width: 1024, height: 1024,
      layers: [{ ...documentV2.layers[0]!, pixels: Array(1024 * 1024).fill(null) }] };
    const createElement = vi.fn();
    vi.stubGlobal("document", { createElement });
    await expect(exportPixelArtPng(large, { scale: 8 })).rejects.toThrow(/smaller export scale/i);
    expect(createElement).not.toHaveBeenCalled();
  });
});
