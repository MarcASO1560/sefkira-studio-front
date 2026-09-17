import { describe, expect, it, vi } from "vitest";
import * as documentHelpers from "./document";

import {
  parsePixelArtResourceData,
  PixelArtMigrationError,
  serializePixelArtResourceData,
} from "./migrations";

describe("pixel-art migrations", () => {
  const v2 = (pixels: unknown[] = [null], overrides: Record<string, unknown> = {}) => ({ version: 2, width: pixels.length, height: 1, palette: [], layers: [{ id: "layer", name: "Layer", visible: true, locked: false, opacity: 1, pixels }], ...overrides });

  it("normalizes a frozen v2 input once, preserving raw IDs, metadata, alpha and palette order", () => {
    const pixels = Object.freeze([" #aabbcc ", null, "#12345680", "#AABBCC"]); const palette = Object.freeze(["#aabbcc", " #12345680 ", "#AABBCC", "#ffffff", "#FFFFFF"]);
    const layer = Object.freeze({ id: " layer ", name: "  Ink  ", visible: false, locked: true, opacity: 0.25, pixels });
    const payload = Object.freeze({ version: 2, width: 4, height: 1, palette, layers: Object.freeze([layer]) }); const result = parsePixelArtResourceData(Object.freeze({ pixel_art: payload }));
    expect(result).toEqual({ migrated: false, warnings: [], document: { version: 2, width: 4, height: 1, palette: ["#AABBCC", "#12345680", "#FFFFFF"], layers: [{ id: " layer ", name: "Ink", visible: false, locked: true, opacity: 0.25, pixels: ["#AABBCC", null, "#12345680", "#AABBCC"] }] } });
    expect(result.document.layers[0]?.pixels).not.toBe(pixels); expect(result.document.palette).not.toBe(palette); expect(layer.name).toBe("  Ink  "); expect(pixels[0]).toBe(" #aabbcc ");
  });

  it("normalizes each repeated palette color once per parse, without retaining a cache across calls", () => {
    const pixels = Array.from({ length: 65536 }, (_, index) => index % 2 ? "#ffffff" : "#11223380"); const layer = { id: "one", name: "One", visible: true, locked: false, opacity: 1, pixels };
    const payload = { version: 2, width: 256, height: 256, palette: ["#ffffff", "#11223380"], layers: [layer, { ...layer, id: "two" }, { ...layer, id: "three" }] };
    const normalize = vi.spyOn(documentHelpers, "normalizePixelColor"); let firstCalls = 0; let secondCalls = 0;
    try { parsePixelArtResourceData(payload); firstCalls = normalize.mock.calls.length; normalize.mockClear(); parsePixelArtResourceData(payload); secondCalls = normalize.mock.calls.length; } finally { normalize.mockRestore(); }
    expect(firstCalls).toBe(2); expect(secondCalls).toBe(2);
  });

  it("validates the last pixel of the last 256-square layer, even after a previous valid parse", () => {
    const pixels = Array<unknown>(65536).fill("#FFFFFF"); const layer = { id: "one", name: "One", visible: true, locked: false, opacity: 1, pixels };
    const payload = { version: 2, width: 256, height: 256, palette: ["#FFFFFF"], layers: [layer, { ...layer, id: "two" }, { ...layer, id: "three", pixels: [...pixels] }] };
    expect(parsePixelArtResourceData(payload).document.layers).toHaveLength(3); payload.layers[2]!.pixels[65535] = "invalid";
    expect(() => parsePixelArtResourceData(payload)).toThrow("Stored pixel-art v2 layer 3 is invalid.");
    try { parsePixelArtResourceData(payload); } catch (error) { expect(error).toMatchObject({ code: "invalid-document", version: 2 }); }
  });

  it("keeps the legacy v2 distinction between holes and explicit undefined pixels or palette entries", () => {
    const pixels = Array<unknown>(4); pixels[1] = "#ff0000"; const palette = Array<unknown>(2); palette[1] = "#ff0000";
    const parsed = parsePixelArtResourceData(v2(pixels, { palette })); expect(parsed.document.layers[0]?.pixels).toEqual([null, "#FF0000", null, null]); expect(parsed.document.palette).toEqual(["#FF0000"]);
    expect(0 in pixels).toBe(false); expect(0 in palette).toBe(false);
    expect(() => parsePixelArtResourceData(v2([undefined]))).toThrow("Stored pixel-art v2 layer 1 is invalid.");
    expect(() => parsePixelArtResourceData(v2([null], { palette: [undefined] }))).toThrow("Stored pixel-art v2 palette is invalid.");
  });

  it.each([
    { width: 0, height: 1 }, { width: 257, height: 1 }, { width: 1.5, height: 1 }, { width: "1", height: 1 },
    { width: 1, height: 0 }, { width: 1, height: 257 }, { width: 1, height: 1.5 }, { width: 1, height: Infinity },
  ])("preserves dimension validation for width=$width and height=$height", ({ width, height }) => {
    expect(() => parsePixelArtResourceData(v2([null], { width, height }))).toThrow("Stored pixel-art v2 dimensions must be integers between 1 and 256.");
  });

  it.each([null, [null], ["invalid"], [42], "#FFFFFF"])("preserves invalid palette rejection for %j", (palette) => {
    expect(() => parsePixelArtResourceData(v2([null], { palette }))).toThrow("Stored pixel-art v2 palette is invalid.");
  });

  it.each([
    { id: "" }, { id: "  " }, { id: 12 }, { name: "" }, { name: "  " }, { name: 12 },
    { visible: 1 }, { locked: 0 }, { opacity: "1" }, { opacity: NaN }, { opacity: Infinity }, { opacity: -0.1 }, { opacity: 1.1 },
    { pixels: [] }, { pixels: [null, null] }, { pixels: [undefined] }, { pixels: [42] }, { pixels: ["not-hex"] }, { pixels: null },
  ])("preserves rejection of malformed layer fields %j", (fields) => {
    const payload = v2(); payload.layers[0] = { ...payload.layers[0]!, ...fields } as typeof payload.layers[0];
    expect(() => parsePixelArtResourceData(payload)).toThrow("Stored pixel-art v2 layer 1 is invalid.");
  });

  it("rejects duplicate raw layer IDs but keeps whitespace-distinct IDs unchanged", () => {
    const payload = v2(); payload.layers.push({ ...payload.layers[0]! }); expect(() => parsePixelArtResourceData(payload)).toThrow("Stored pixel-art v2 layer 2 is invalid.");
    payload.layers[1]!.id = " layer "; expect(parsePixelArtResourceData(payload).document.layers.map((layer) => layer.id)).toEqual(["layer", " layer "]);
  });

  it("rejects a non-object layer and constructs separate arrays for layers sharing one source array", () => {
    expect(() => parsePixelArtResourceData(v2([null], { layers: [null] }))).toThrow("Stored pixel-art v2 layer 1 must be an object.");
    const payload = v2(["#FFFFFF"]); payload.layers.push({ ...payload.layers[0]!, id: "second" }); const document = parsePixelArtResourceData(payload).document;
    expect(document.layers[0]?.pixels).not.toBe(document.layers[1]?.pixels); expect(document.layers[0]?.pixels).not.toBe(payload.layers[0]?.pixels); document.layers[0]!.pixels[0] = null; expect(document.layers[1]?.pixels[0]).toBe("#FFFFFF");
  });

  it("keeps zero opacity normalized, including negative zero", () => {
    const payload = v2(); payload.layers[0]!.opacity = -0; const result = parsePixelArtResourceData(payload); expect(result.document.layers[0]?.opacity).toBe(0); expect(Object.is(result.document.layers[0]?.opacity, -0)).toBe(false);
  });

  it("migrates a legacy flat resource into one v2 layer", () => {
    const result = parsePixelArtResourceData({
      pixel_art: {
        version: 1,
        width: 2,
        height: 1,
        palette: ["#ffffff"],
        pixels: ["#ffffff", null],
      },
    });

    expect(result.migrated).toBe(true);
    expect(result.document).toMatchObject({
      version: 2,
      width: 2,
      height: 1,
      palette: ["#FFFFFF"],
    });
    expect(result.document.layers[0]?.pixels).toEqual(["#FFFFFF", null]);
  });

  it("preserves legacy square documents that use size instead of width and height", () => {
    const pixels = ["#FF0000", null, "#00FF00", "#0000FF"];
    const result = parsePixelArtResourceData({
      pixel_art: {
        version: 1,
        size: 2,
        palette: ["#ff0000", "#00ff00", "#0000ff"],
        pixels,
      },
    });

    expect(result.migrated).toBe(true);
    expect(result.document.width).toBe(2);
    expect(result.document.height).toBe(2);
    expect(result.document.layers[0]?.pixels).toEqual([
      "#FF0000",
      null,
      "#00FF00",
      "#0000FF",
    ]);
  });

  it("preserves unversioned legacy square documents that use size", () => {
    const result = parsePixelArtResourceData({
      pixel_art: {
        size: 1,
        pixels: ["#12345678"],
      },
    });

    expect(result.document).toMatchObject({ width: 1, height: 1, version: 2 });
    expect(result.document.layers[0]?.pixels).toEqual(["#12345678"]);
  });

  it("rejects unknown stored versions instead of replacing them with a blank document", () => {
    expect(() =>
      parsePixelArtResourceData({
        pixel_art: { version: 3, width: 1, height: 1, layers: [] },
      }),
    ).toThrow(PixelArtMigrationError);

    try {
      parsePixelArtResourceData({ pixel_art: { version: 3 } });
    } catch (error) {
      expect(error).toMatchObject({
        code: "unsupported-version",
        name: "PixelArtMigrationError",
        version: 3,
      });
    }
  });

  it.each([
    {
      label: "missing layers",
      document: { version: 2, width: 1, height: 1, palette: [] },
    },
    {
      label: "empty layers",
      document: { version: 2, width: 1, height: 1, palette: [], layers: [] },
    },
    {
      label: "wrong pixel count",
      document: {
        version: 2,
        width: 2,
        height: 1,
        palette: [],
        layers: [
          {
            id: "layer-one",
            name: "Layer 1",
            visible: true,
            locked: false,
            opacity: 1,
            pixels: [null],
          },
        ],
      },
    },
  ])("rejects malformed v2 data with $label", ({ document }) => {
    expect(() => parsePixelArtResourceData({ pixel_art: document })).toThrow(
      PixelArtMigrationError,
    );
  });

  it("rejects a malformed pixel_art wrapper", () => {
    expect(() => parsePixelArtResourceData({ pixel_art: null })).toThrow(
      PixelArtMigrationError,
    );

    try {
      parsePixelArtResourceData({ pixel_art: null });
    } catch (error) {
      expect(error).toMatchObject({
        code: "invalid-document",
        name: "PixelArtMigrationError",
      });
    }
  });

  it("round-trips a v2 document while preserving sibling resource data", () => {
    const migrated = parsePixelArtResourceData({
      pixel_art: {
        version: 2,
        width: 1,
        height: 1,
        palette: [],
        layers: [
          {
            id: "layer-one",
            name: "Ink",
            visible: true,
            locked: false,
            opacity: 0.5,
            pixels: ["#FF000080"],
          },
        ],
      },
    });
    const serialized = serializePixelArtResourceData({ unrelated: true }, migrated.document);

    expect(migrated.migrated).toBe(false);
    expect(serialized).toMatchObject({ unrelated: true });
    expect(serialized.pixel_art.layers[0]).toEqual({
      id: "layer-one",
      name: "Ink",
      visible: true,
      locked: false,
      opacity: 0.5,
      pixels: ["#FF000080"],
    });
  });
});
