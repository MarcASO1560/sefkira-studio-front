/**
 * Reproducible CPU benchmark, not a network or browser frame-time guarantee.
 * Run from pixel_front with Node 24+: node scripts/bench-editor-render.mjs
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

const { blendPixelColors, compositeVisibleLayers, createPixelArtDocument } = await import(
  "../src/features/pixel-art/lib/document.ts"
);
const { writeImageCanvasBitmapPixels } = await import("../src/features/pixel-art/lib/canvasRendering.ts");

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

const measure = (callback, sampleCount = 24) => {
  for (let index = 0; index < 8; index += 1) callback();
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

for (const size of [32, 128, 256]) {
  for (const layerCount of [1, 3]) {
    for (const mode of ["opaque", "alpha"]) {
      const colors = mode === "opaque"
        ? ["#AA1122", "#11BB33", "#1234CC", "#F0EEDD"]
        : ["#AA112280", "#11BB33", null, "#F0EEDD40"];
      const document = createPixelArtDocument(size, size, {
        layers: Array.from({ length: layerCount }, (_, layerIndex) => ({
          id: `layer-${layerIndex}`,
          name: `Layer ${layerIndex}`,
          visible: true,
          locked: false,
          opacity: mode === "opaque" || layerIndex === 0 ? 1 : 0.5,
          pixels: Array.from({ length: size * size }, (_, index) => colors[(index + layerIndex) % colors.length]),
        })),
      });
      const target = new Uint8ClampedArray(size * size * 4);
      assert.deepEqual(compositeVisibleLayers(document), referenceComposite(document));
      const referencePair = measure(() => {
        referenceComposite(document);
        referenceComposite(document);
      });
      const optimizedPair = measure(() => {
        compositeVisibleLayers(document);
        compositeVisibleLayers(document);
      });
      const sharedCompositeAndBitmap = measure(() => {
        const pixels = compositeVisibleLayers(document);
        writeImageCanvasBitmapPixels(pixels, "#101111", target);
      });
      console.log(JSON.stringify({
        size,
        layerCount,
        mode,
        referencePair,
        optimizedPair,
        sharedCompositeAndBitmap,
        cpuSpeedup: +(referencePair.medianMs / sharedCompositeAndBitmap.medianMs).toFixed(1),
        correctness: "identical composite pixels",
      }));
    }
  }
}
