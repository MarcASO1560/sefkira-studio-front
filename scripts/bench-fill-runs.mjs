/** Local CPU/packet benchmark; never a network-latency guarantee. Node 24+. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && context.parentURL) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
  }
  return nextResolve(specifier, context);
} });

const { floodFillPixelRuns } = await import("../src/features/pixel-art/lib/floodFillRuns.ts");
const { registerNormalizedPixelArray } = await import("../src/features/pixel-art/lib/pixelBufferTrust.ts");
const { splitImageActionBatches, toImageOperationPacket, validateImageOperation } =
  await import("../src/features/pixel-art/lib/imageOperations.ts");

for (const size of [256, 1024, 2048]) {
  const pixels = registerNormalizedPixelArray(Array(size * size).fill(null));
  const times = [];
  let fill;
  for (let sample = 0; sample < 9; sample += 1) {
    const started = performance.now();
    fill = floodFillPixelRuns({ pixels, width: size, height: size, startIndex: 0, color: "#AABBCC" });
    if (sample > 1) times.push(performance.now() - started);
  }
  times.sort((left, right) => left - right);
  assert.deepEqual(fill.runs, [[0, size * size]]);
  const action = { type: "pixel-runs", layer_id: "local-fixture", color: fill.color, runs: fill.runs };
  const operation = { operation_id: "local-benchmark", base_revision: 0, width: size, height: size, actions: [action] };
  assert.equal(validateImageOperation(operation), true);
  assert.equal(splitImageActionBatches(operation.actions).length, 1);
  console.log(JSON.stringify({ canvas: `${size}x${size}`, fillMedianMs: +times[3].toFixed(3),
    runs: fill.runs.length, durableRequests: 1,
    operationBytes: new TextEncoder().encode(JSON.stringify(toImageOperationPacket(operation))).length }));
}
