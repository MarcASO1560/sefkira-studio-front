/**
 * Reproducible CPU benchmark, not a network or browser frame-time guarantee.
 * Run from pixel_front with Node 24+: node scripts/bench-editor-render.mjs
 * Large fixtures: node scripts/bench-editor-render.mjs --sizes=1024
 * With canonical/journal CPU: node scripts/bench-editor-render.mjs --sizes=1024 --io
 * Imports the real TypeScript helpers; fixtures contain no user documents.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && context.parentURL) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});

const { blendPixelColors, compositeVisibleLayers, MAX_IMAGE_DIMENSION } = await import(
  "../src/features/pixel-art/lib/document.ts"
);
const { writeImageCanvasBitmapPixels } = await import("../src/features/pixel-art/lib/canvasRendering.ts");
const { parsePixelArtResourceData } = await import("../src/features/pixel-art/lib/migrations.ts");
const { compactPixelArtDocument } = await import("../src/features/pixel-art/lib/compactPixels.ts");
const { createIncrementalUsedPaletteColors } = await import("../src/features/pixel-art/lib/incrementalPalette.ts");
const { resizePixelArray } = await import("../src/features/pixel-art/lib/resize.ts");
const { paintPixels } = await import("../src/features/pixel-art/lib/drawing.ts");
const { registerNormalizedPixelArray } = await import("../src/features/pixel-art/lib/pixelBufferTrust.ts");
const { createIncrementalImageCanvasBitmap } = await import("../src/features/pixel-art/lib/incrementalCanvasBitmap.ts");

// Exactly the former compositor. blendPixelColors retains the original math,
// including HEX round trips after every layer rather than rounding only once.
const referenceComposite = (document) => {
  const pixels = Array(document.width * document.height).fill(null);
  for (const layer of document.layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    for (let index = 0; index < pixels.length; index += 1) {
      pixels[index] = blendPixelColors(pixels[index], layer.pixels[index], layer.opacity);
    }
  }
  return pixels;
};

const measure = (callback, sampleCount = 24, warmupCount = 8) => {
  for (let index = 0; index < warmupCount; index += 1) callback();
  const durations = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const started = performance.now();
    callback();
    durations.push(performance.now() - started);
  }
  durations.sort((left, right) => left - right);
  return {
    medianMs: +durations[Math.floor(sampleCount / 2)].toFixed(3),
    p95Ms: +durations[Math.floor(sampleCount * 0.95)].toFixed(3),
  };
};

const sizesArgument = process.argv.find((argument) => argument.startsWith("--sizes="));
const includeIo = process.argv.includes("--io");
const sizes = sizesArgument ? sizesArgument.slice("--sizes=".length).split(",").map(Number) : [32, 128, 256];
if (sizes.some((size) => !Number.isSafeInteger(size) || size < 1 || size > 4096 || size * size > 4194304)) {
  throw new RangeError("Benchmark fixture sizes must fit 1–4096 per axis and 4,194,304 pixels.");
}
for (const size of sizes) {
  const sampleCount = size > 256 ? 6 : 24;
  const referenceSamples = size > 256 ? 2 : 24;
  const warmups = size > 256 ? 1 : 8;
  for (const layerCount of [1, 3]) {
    for (const mode of ["opaque", "alpha"]) {
      const colors = mode === "opaque"
        ? ["#AA1122", "#11BB33", "#1234CC", "#F0EEDD"]
        : ["#AA112280", "#11BB33", null, "#F0EEDD40"];
      // A plain validated-shape fixture deliberately measures renderer behavior
      // independently of whichever creation limit is configured at this commit.
      const document = {
        version: 2,
        width: size,
        height: size,
        palette: [],
        layers: Array.from({ length: layerCount }, (_, layerIndex) => ({
          id: `layer-${layerIndex}`,
          name: `Layer ${layerIndex}`,
          visible: true,
          locked: false,
          opacity: mode === "opaque" || layerIndex === 0 ? 1 : 0.5,
          pixels: registerNormalizedPixelArray(Array.from({ length: size * size }, (_, index) => colors[(index + layerIndex) % colors.length])),
        })),
      };
      const target = new Uint8ClampedArray(size * size * 4);
      assert.deepEqual(compositeVisibleLayers(document), referenceComposite(document));
      const referencePair = measure(() => {
        referenceComposite(document);
        referenceComposite(document);
      }, referenceSamples, warmups);
      const optimizedPair = measure(() => {
        compositeVisibleLayers(document);
        compositeVisibleLayers(document);
      }, sampleCount, warmups);
      const sharedCompositeAndBitmap = measure(() => {
        const pixels = compositeVisibleLayers(document);
        writeImageCanvasBitmapPixels(pixels, "#101111", target);
      }, sampleCount, warmups);
      console.log(JSON.stringify({
        size,
        layerCount,
        mode,
        configuredMaxDimension: MAX_IMAGE_DIMENSION,
        optimizedSampleCount: sampleCount,
        referenceSampleCount: referenceSamples,
        referencePair,
        optimizedPair,
        sharedCompositeAndBitmap,
        cpuSpeedup: +(referencePair.medianMs / sharedCompositeAndBitmap.medianMs).toFixed(1),
        correctness: "identical composite pixels",
      }));

      if (includeIo && mode === "opaque" && size <= MAX_IMAGE_DIMENSION) {
        const started = performance.now();
        const compact = compactPixelArtDocument(document);
        const compactEncodingFirstMs = +(performance.now() - started).toFixed(3);
        const denseQueue = { version: 1, resource: { id: "fixture", revision: 1, data: { pixel_art: document } }, operations: [] };
        const compactQueue = { ...denseQueue, resource: { ...denseQueue.resource, data: { pixel_art: compact } } };
        const denseJson = JSON.stringify(denseQueue);
        const compactJson = JSON.stringify(compactQueue);
        const palette = createIncrementalUsedPaletteColors();
        const sourcePixels = registerNormalizedPixelArray(Array.from({ length: 256 * 256 }, (_, index) => colors[index % colors.length]));
        console.log(JSON.stringify({
          size,
          layerCount,
          kind: "canonical-and-journal-cpu",
          samples: sampleCount,
          denseWireMiB: +(Buffer.byteLength(denseJson) / 1048576).toFixed(3),
          compactWireKiB: +(Buffer.byteLength(compactJson) / 1024).toFixed(3),
          compactEncodingFirstMs,
          canonicalDense: measure(() => parsePixelArtResourceData({ pixel_art: document }), sampleCount, warmups),
          canonicalCompact: measure(() => parsePixelArtResourceData({ pixel_art: compact }), sampleCount, warmups),
          paletteFirstIndex: measure(() => { palette.clear(); palette.derive(document.layers); }, sampleCount, warmups),
          trustedSinglePixelPaint: measure(() => paintPixels({ width: size, height: size, pixels: document.layers[0].pixels }, [{ x: 0, y: 0 }], "#FFFFFF"), sampleCount, warmups),
          cloneDenseJournal: measure(() => structuredClone(denseQueue), sampleCount, warmups),
          cloneCompactJournal: measure(() => structuredClone(compactQueue), sampleCount, warmups),
          resizeFrom256: measure(() => Array.from({ length: layerCount }, () => resizePixelArray(sourcePixels, 256, 256, size, size, "center")), sampleCount, warmups),
          // Actual IndexedDB completion/quota and browser Canvas calls require
          // a browser test. structuredClone models CPU, not disk durability.
          includesIndexedDbCommit: false,
          includesBrowserCanvas: false,
        }));
      }

      if (includeIo && size >= 1024) {
        const renderer = createIncrementalImageCanvasBitmap();
        const bitmap = new Uint8ClampedArray(size * size * 4);
        let current = document;
        renderer.write(current, "#101111", bitmap);
        const durations = [];
        for (let step = 0; step < 200; step += 1) {
          const previousPixels = current.layers[0].pixels;
          // The normal immutable brush copy is deliberately outside these
          // measurements; its cost is reported by trustedSinglePixelPaint.
          const nextPixels = registerNormalizedPixelArray(previousPixels.slice());
          const changes = Array.from({ length: 100 }, (_, offset) => {
            const index = step * 100 + offset;
            return { index, before: previousPixels[index], after: step % 2 ? "#FFFFFF80" : "#000000" };
          });
          for (const change of changes) nextPixels[change.index] = change.after;
          const next = { ...current, layers: current.layers.map((layer, index) => index === 0 ? { ...layer, pixels: nextPixels } : layer) };
          const started = performance.now();
          renderer.registerMutation({ layerId: current.layers[0].id, previousPixels, nextPixels, changes });
          renderer.write(next, "#101111", bitmap);
          durations.push(performance.now() - started);
          current = next;
        }
        assert.deepEqual(bitmap, writeImageCanvasBitmapPixels(compositeVisibleLayers(current), "#101111", new Uint8ClampedArray(bitmap.length)));
        durations.sort((left, right) => left - right);
        console.log(JSON.stringify({
          size,
          layerCount,
          mode,
          kind: "incremental-bitmap-cpu",
          dirtyIndexesPerFrame: 100,
          samples: 200,
          medianMs: +durations[100].toFixed(4),
          p95Ms: +durations[190].toFixed(4),
          includesBufferClone: false,
          includesBrowserCanvas: false,
          correctness: "exact full bitmap after 200 frames",
        }));
      }
    }
  }
}
