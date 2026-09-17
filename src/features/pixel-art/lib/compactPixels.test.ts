import { describe, expect, it } from "vitest";
import { zlibSync } from "fflate";
import { compactPixelArtDocument, compactPixelLayer, decodeCompactPixels, type CompactPixelData } from "./compactPixels";
import { createPixelArtDocument, createPixelLayer } from "./document";
import { parsePixelArtResourceData } from "./migrations";
import { hasNormalizedPixelArray } from "./pixelBufferTrust";

const fixture: CompactPixelData = { encoding: "indexed-deflate-v1", colors: [null, "#AABBCC", "#11223380", "#abcdefFF", "#00000000", "#FFFFFF"], index_bytes: 1, data: "eAFjYGRiZmFgZGJgYGBlZWRiAAAA4gAb" };
const fixturePixels = [null, "#AABBCC", "#11223380", "#ABCDEFFF", "#00000000", null, "#AABBCC", "#11223380", null, null, null, "#FFFFFF", "#FFFFFF", "#AABBCC", "#11223380", null];
const base64 = (bytes: Uint8Array) => { let value = ""; for (let index = 0; index < bytes.length; index += 32_768) value += String.fromCharCode(...bytes.subarray(index, index + 32_768)); return btoa(value); };

describe("bounded indexed pixel codec", () => {
  it("decodes the Python zlib fixture including null, alpha and raw-case colors", () => {
    Object.freeze(fixture.colors); Object.freeze(fixture);
    const pixels = decodeCompactPixels(fixture, 16);
    expect(pixels).toEqual(fixturePixels); expect(hasNormalizedPixelArray(pixels)).toBe(true);
    expect(fixture.colors[3]).toBe("#abcdefFF");
  });
  it("keeps small legacy arrays and compacts 1024-square images below the response ceiling", () => {
    const small = createPixelLayer(256, 256); expect(compactPixelLayer(small, 256, 256)).toBe(small);
    const document = createPixelArtDocument(1024, 1024); document.layers[0]!.pixels[1_048_575] = "#12345680";
    const packed = compactPixelArtDocument(document);
    expect(Array.isArray(packed.layers[0]!.pixels)).toBe(false);
    expect(JSON.stringify(packed).length).toBeLessThan(20_000);
    const parsed = parsePixelArtResourceData({ pixel_art: packed }).document;
    expect(parsed.width).toBe(1024); expect(parsed.layers[0]!.pixels).toHaveLength(1_048_576);
    expect(parsed.layers[0]!.pixels[1_048_575]).toBe("#12345680");
    expect(compactPixelArtDocument(document).layers[0]!.pixels).toBe(packed.layers[0]!.pixels);
  });
  it.each([257, 65_537])("roundtrips little-endian multi-byte palette indexes with %i colors", (colorCount) => {
    const count = 1024 * 65; const pixels = Array.from({ length: count }, (_, index) => `#${(index % colorCount).toString(16).padStart(6, "0")}`);
    const layer = { id: "colors", name: "Colors", visible: true, locked: false, opacity: 1, pixels };
    const compact = compactPixelLayer(layer, 1024, 65).pixels as CompactPixelData;
    expect(compact.index_bytes).toBe(colorCount === 257 ? 2 : 4);
    expect(decodeCompactPixels(compact, count)).toEqual(pixels.map((value) => value.toUpperCase()));
    expect(pixels[15]).toBe("#00000f");
  });
  it.each([
    { encoding: "wrong" }, { colors: ["#FFFFFF"] }, { colors: [null, null] },
    { colors: [null, "#AABBCC", "#AABBCC"] }, { colors: [null, "bad"] },
    { index_bytes: 2 }, { index_bytes: 3 }, { data: "%%%=" }, { data: "AAAA" }, { unexpected: true },
  ])("rejects malformed compact metadata %j", (changes) => {
    expect(() => decodeCompactPixels({ ...fixture, ...changes }, 16)).toThrow(RangeError);
  });
  it("rejects wrong output length, invalid indexes, truncation and checksum corruption", () => {
    expect(() => decodeCompactPixels(fixture, 15)).toThrow(RangeError);
    expect(() => decodeCompactPixels(fixture, 17)).toThrow(RangeError);
    expect(() => decodeCompactPixels({ ...fixture, data: base64(zlibSync(new Uint8Array(16).fill(6))) }, 16)).toThrow(RangeError);
    const compressed = Uint8Array.from(atob(fixture.data), (character) => character.charCodeAt(0));
    expect(() => decodeCompactPixels({ ...fixture, data: base64(compressed.subarray(0, compressed.length - 1)) }, 16)).toThrow(RangeError);
    compressed[compressed.length - 1] ^= 1;
    expect(() => decodeCompactPixels({ ...fixture, data: base64(compressed) }, 16)).toThrow(RangeError);
  });
  it("rejects a compressed expansion bomb as soon as its bounded output exceeds the frame", () => {
    const bomb = base64(zlibSync(new Uint8Array(65_536)));
    expect(() => decodeCompactPixels({ encoding: "indexed-deflate-v1", colors: [null], index_bytes: 1, data: bomb }, 16)).toThrow(RangeError);
    expect(() => decodeCompactPixels(fixture, 4_194_305)).toThrow(RangeError);
  });
  it("rejects document-area and aggregate-layer budgets before decoding any layer", () => {
    const layer = { id: "one", name: "One", visible: true, locked: false, opacity: 1, pixels: fixture };
    expect(() => parsePixelArtResourceData({ version: 2, width: 4096, height: 4096, palette: [], layers: [layer] })).toThrow("canvas may contain at most");
    expect(() => parsePixelArtResourceData({ version: 2, width: 2048, height: 2048, palette: [], layers: Array.from({ length: 5 }, (_, index) => ({ ...layer, id: `layer-${index}` })) })).toThrow("document may contain at most");
  });
});
