// Vitest runs this test in Node; production intentionally has no @types/node.
// @ts-expect-error Node's test-only built-in is available without browser typings.
import { readFileSync } from "node:fs";

import { compileScript, parse } from "vue/compiler-sfc";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as bitmap from "../lib/canvasRendering";
import type { PixelColor } from "../types";

// Exercise the actual SFC setup without a DOM dependency; only lifecycle,
// watcher registration and the browser canvas/RAF interfaces are substituted.
const source = readFileSync(new URL("./ImageLayerThumbnail.vue", import.meta.url), "utf8");
const { descriptor } = parse(source);
const compiled = compileScript(descriptor, { id: "thumbnail-unit-test" });
const script = transpileModule(compiled.content, {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
}).outputText;

const mountThumbnail = (
  props: { pixels: PixelColor[]; width: number; height: number; opacity: number },
) => {
  let mounted = () => {};
  let unmounted = () => {};
  let changed = () => {};
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  const cancelFrame = vi.fn((id: number) => frames.delete(id));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", cancelFrame);

  const context = {
    imageSmoothingEnabled: true,
    createImageData: vi.fn((width: number, height: number) => ({
      width, height, data: new Uint8ClampedArray(width * height * 4),
    })),
    putImageData: vi.fn(),
  };
  let width = 0;
  let height = 0;
  const widthWrites: number[] = [];
  const heightWrites: number[] = [];
  const canvas = {
    get width() { return width; },
    set width(value: number) { widthWrites.push(value); width = value; },
    get height() { return height; },
    set height(value: number) { heightWrites.push(value); height = value; },
    getContext: vi.fn(() => context),
  };
  const vue = {
    defineComponent: (component: unknown) => component,
    ref: (value: unknown) => ({ value }),
    onMounted: (callback: () => void) => { mounted = callback; },
    onUnmounted: (callback: () => void) => { unmounted = callback; },
    watch: (_getter: unknown, callback: () => void) => { changed = callback; },
  };
  const exports: { default?: { setup: (...args: unknown[]) => Record<string, unknown> } } = {};
  new Function("require", "exports", script)((name: string) => {
    if (name === "vue") return vue;
    if (name === "../lib/canvasRendering") return bitmap;
    throw new Error(`Unexpected SFC dependency: ${name}`);
  }, exports);
  const setup = exports.default!.setup(props, { expose: () => {} });
  (setup.canvasRef as { value: unknown }).value = canvas;
  mounted();

  return {
    cancelFrame, changed, context, frames, heightWrites, unmounted, widthWrites,
    paintFrame: () => {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    },
  };
};

afterEach(() => vi.unstubAllGlobals());

describe("ImageLayerThumbnail", () => {
  it("coalesces updates in one frame and paints the latest pixels", () => {
    const props = { pixels: ["#FF0000"] as PixelColor[], width: 1, height: 1, opacity: 1 };
    const thumbnail = mountThumbnail(props);
    props.pixels = ["#00FF00"];
    thumbnail.changed();
    props.pixels = ["#0000FF"];
    thumbnail.changed();
    expect(thumbnail.frames.size).toBe(1);
    expect(thumbnail.context.putImageData).not.toHaveBeenCalled();
    thumbnail.paintFrame();
    expect(thumbnail.context.putImageData).toHaveBeenCalledTimes(1);
    expect([...thumbnail.context.putImageData.mock.calls[0]![0].data]).toEqual([0, 0, 255, 255]);
    expect(thumbnail.context.imageSmoothingEnabled).toBe(false);
  });

  it("reuses the bitmap and never resets unchanged canvas dimensions", () => {
    const props = { pixels: ["#FF0000"] as PixelColor[], width: 1, height: 1, opacity: 1 };
    const thumbnail = mountThumbnail(props);
    thumbnail.paintFrame();
    props.pixels = [null];
    thumbnail.changed();
    thumbnail.paintFrame();
    expect(thumbnail.widthWrites).toEqual([1]);
    expect(thumbnail.heightWrites).toEqual([1]);
    expect(thumbnail.context.createImageData).toHaveBeenCalledTimes(1);
    expect([...thumbnail.context.putImageData.mock.calls[1]![0].data]).toEqual([0, 0, 0, 0]);
    props.width = 2;
    props.pixels = [null, "#FFFFFF"];
    thumbnail.changed();
    thumbnail.paintFrame();
    expect(thumbnail.widthWrites).toEqual([1, 2]);
    expect(thumbnail.heightWrites).toEqual([1]);
    expect(thumbnail.context.createImageData).toHaveBeenCalledTimes(2);
  });

  it("preserves pixel alpha, layer opacity and transparent padding", () => {
    const thumbnail = mountThumbnail({
      pixels: ["#FF0000", "#00FF0080"], width: 3, height: 1, opacity: 0.5,
    });
    thumbnail.paintFrame();
    expect([...thumbnail.context.putImageData.mock.calls[0]![0].data]).toEqual([
      255, 0, 0, 128, 0, 255, 0, 64, 0, 0, 0, 0,
    ]);
  });

  it("ignores pixels beyond the logical dimensions and clamps layer opacity", () => {
    const thumbnail = mountThumbnail({
      pixels: ["#ABCDEF80", "#FFFFFF"], width: 1, height: 1, opacity: 2,
    });
    thumbnail.paintFrame();
    expect([...thumbnail.context.putImageData.mock.calls[0]![0].data]).toEqual([171, 205, 239, 128]);
  });

  it("cancels a pending paint when unmounted", () => {
    const thumbnail = mountThumbnail({ pixels: ["#FFFFFF"], width: 1, height: 1, opacity: 1 });
    expect(thumbnail.frames.size).toBe(1);
    thumbnail.unmounted();
    expect(thumbnail.cancelFrame).toHaveBeenCalledTimes(1);
    expect(thumbnail.frames.size).toBe(0);
    thumbnail.paintFrame();
    expect(thumbnail.context.putImageData).not.toHaveBeenCalled();
  });
});
