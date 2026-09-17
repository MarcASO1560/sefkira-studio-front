import { describe, expect, it, vi } from "vitest";

import {
  brushPoints,
  clearRect,
  constrainPointToEightDirections,
  ellipsePoints,
  extractBlock,
  flipBlock,
  floodFill,
  linePoints,
  moveLayer,
  moveRegion,
  normalizeSelection,
  paintPixels,
  placeBlock,
  rectanglePoints,
  rotateBlock90,
  squareBrushPoints,
  strokePoints,
  type PixelBlock,
  type PixelBuffer,
  type PixelColor,
  type Point,
} from "./drawing";

const makeBuffer = (
  width: number,
  height: number,
  pixels: ReadonlyArray<PixelColor>,
): PixelBuffer => ({
  width,
  height,
  pixels,
});

const pointKeys = (points: ReadonlyArray<Point>) =>
  new Set(points.map((point) => `${point.x},${point.y}`));

describe("line and brush rasterization", () => {
  it.each([
    { x: 5, y: 2 },
    { x: 2, y: 5 },
    { x: -2, y: 5 },
    { x: -5, y: 2 },
    { x: -5, y: -2 },
    { x: -2, y: -5 },
    { x: 2, y: -5 },
    { x: 5, y: -2 },
  ])("draws a connected line in the octant ending at ($x, $y)", (end) => {
    const points = linePoints({ x: 0, y: 0 }, end);

    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points.at(-1)).toEqual(end);
    for (let index = 1; index < points.length; index += 1) {
      const deltaX = Math.abs(points[index].x - points[index - 1].x);
      const deltaY = Math.abs(points[index].y - points[index - 1].y);
      expect(Math.max(deltaX, deltaY)).toBe(1);
    }
  });

  it("snaps to the nearest of eight directions", () => {
    const origin = { x: 10, y: 10 };

    expect(constrainPointToEightDirections(origin, { x: 18, y: 12 })).toEqual({ x: 18, y: 10 });
    expect(constrainPointToEightDirections(origin, { x: 16, y: 15 })).toEqual({ x: 16, y: 16 });
    expect(constrainPointToEightDirections(origin, { x: 8, y: 18 })).toEqual({ x: 10, y: 18 });
    expect(constrainPointToEightDirections(origin, origin)).toEqual(origin);
  });

  it("uses the documented negative-axis bias for even brush sizes", () => {
    expect(squareBrushPoints({ x: 2, y: 2 }, 2)).toEqual([
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 1, y: 2 },
      { x: 2, y: 2 },
    ]);
  });

  it("rasterizes distinct hard-edged circle and diamond brush stamps", () => {
    const circle = pointKeys(brushPoints({ x: 5, y: 5 }, 5, "circle"));
    const diamond = pointKeys(brushPoints({ x: 5, y: 5 }, 5, "diamond"));

    expect(circle.size).toBe(21);
    expect(circle.has("3,3")).toBe(false);
    expect(circle.has("5,3")).toBe(true);
    expect(diamond.size).toBe(13);
    expect(diamond.has("4,4")).toBe(true);
    expect(diamond.has("3,4")).toBe(false);
  });

  it("keeps every brush shape anchored consistently at size one and two", () => {
    for (const shape of ["circle", "diamond", "square"] as const) {
      expect(brushPoints({ x: 2, y: 2 }, 1, shape)).toEqual([{ x: 2, y: 2 }]);
      expect(brushPoints({ x: 2, y: 2 }, 2, shape)).toEqual([
        { x: 1, y: 1 },
        { x: 2, y: 1 },
        { x: 1, y: 2 },
        { x: 2, y: 2 },
      ]);
    }
  });

  it("clips brush stamps and interpolated strokes safely", () => {
    expect(squareBrushPoints({ x: 0, y: 0 }, 3, { width: 2, height: 2 })).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ]);

    expect(strokePoints([{ x: 0, y: 0 }, { x: 3, y: 0 }], 1)).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ]);
  });
});

describe("pixel mutations", () => {
  it("paints immutably, de-duplicates points, and reports the dirty bounds", () => {
    const sourcePixels = Object.freeze<PixelColor[]>([null, "#111111", null, null]);
    const source = Object.freeze(makeBuffer(2, 2, sourcePixels));
    const mutation = paintPixels(
      source,
      [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 5, y: 5 }],
      "#ffffff",
    );

    expect(source.pixels).toEqual([null, "#111111", null, null]);
    expect(mutation.buffer).not.toBe(source);
    expect(mutation.buffer.pixels).toEqual(["#ffffff", "#111111", null, null]);
    expect(mutation.changes).toEqual([
      {
        index: 0,
        point: { x: 0, y: 0 },
        before: null,
        after: "#ffffff",
      },
    ]);
    expect(mutation.dirtyBounds).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("returns the original buffer and no changes for a no-op", () => {
    const source = makeBuffer(1, 1, ["#ffffff"]);
    const mutation = paintPixels(source, [{ x: 0, y: 0 }], "#ffffff");

    expect(mutation.buffer).toBe(source);
    expect(mutation.changes).toEqual([]);
    expect(mutation.dirtyBounds).toBeNull();
  });

  it("reports only touched changes on a 256-square canvas, sorted with exact before/after values", () => {
    const pixels = Array<PixelColor>(256 * 256).fill(null); pixels[2] = "#ffffff"; pixels[255 * 256 + 255] = "#111111";
    const source = Object.freeze(makeBuffer(256, 256, Object.freeze(pixels)));
    const mutation = paintPixels(source, [{ x: 255, y: 255 }, { x: 2, y: 0 }, { x: 4, y: 3 }, { x: 4, y: 3 }, { x: 256, y: 255 }, { x: -1, y: 0 }], "#ffffff");
    expect(mutation.buffer.width).toBe(256); expect(mutation.buffer.height).toBe(256); expect(mutation.buffer.pixels).toHaveLength(65536);
    expect(mutation.changes).toEqual([
      { index: 772, point: { x: 4, y: 3 }, before: null, after: "#ffffff" },
      { index: 65535, point: { x: 255, y: 255 }, before: "#111111", after: "#ffffff" },
    ]);
    expect(mutation.dirtyBounds).toEqual({ x: 4, y: 3, width: 252, height: 253 }); expect(source.pixels[772]).toBeNull(); expect(source.pixels[65535]).toBe("#111111");
  });

  it("uses one normalizing array copy initially and one native copy for subsequent brush frames", () => {
    const source = makeBuffer(256, 256, Array<PixelColor>(65536).fill(null));
    const from = vi.spyOn(Array, "from"); let firstCopies = 0; let followingCopies = 0; let mutation!: ReturnType<typeof paintPixels>;
    try {
      mutation = paintPixels(source, [{ x: 0, y: 0 }], "#ffffff"); firstCopies = from.mock.calls.length; from.mockClear();
      Object.freeze(mutation.buffer.pixels);
      mutation = paintPixels(mutation.buffer, [{ x: 1, y: 0 }], "#111111"); followingCopies = from.mock.calls.length;
    } finally { from.mockRestore(); }
    expect(firstCopies).toBe(1); expect(followingCopies).toBe(0); expect(mutation.buffer.pixels.slice(0, 3)).toEqual(["#ffffff", "#111111", null]); expect(mutation.changes).toHaveLength(1);
  });

  it("does not copy the canvas pixel array for an unchanged or entirely clipped brush stamp", () => {
    const source = makeBuffer(256, 256, Array<PixelColor>(65536).fill("#ffffff")); const from = vi.spyOn(Array, "from"); let calls = 0;
    let unchanged!: ReturnType<typeof paintPixels>; let clipped!: ReturnType<typeof paintPixels>;
    try { unchanged = paintPixels(source, [{ x: 255, y: 255 }, { x: 0, y: 0 }], "#ffffff"); clipped = paintPixels(source, [{ x: -1, y: 0 }, { x: 256, y: 256 }], null); calls = from.mock.calls.length; } finally { from.mockRestore(); }
    expect(calls).toBe(0); expect(unchanged.buffer).toBe(source); expect(clipped.buffer).toBe(source); expect(unchanged.changes).toEqual([]); expect(clipped.dirtyBounds).toBeNull();
  });

  it.each([
    { name: "short", pixels: ["A"] as PixelColor[] },
    { name: "sparse", pixels: Object.assign(Array<PixelColor>(4), { 0: "A" }) },
    { name: "undefined", pixels: ["A", undefined, null, undefined] as unknown as PixelColor[] },
    { name: "oversized", pixels: ["A", null, null, null, "out-of-bounds"] as PixelColor[] },
  ])("normalizes a legacy $name buffer in its single copy without changing its input", ({ pixels }) => {
    const originalKeys = Object.keys(pixels); const originalLength = pixels.length; const source = makeBuffer(2, 2, Object.freeze(pixels));
    const mutation = paintPixels(source, [{ x: 1, y: 1 }], "B");
    expect(mutation.buffer.pixels).toEqual(["A", null, null, "B"]); expect(Object.keys(pixels)).toEqual(originalKeys); expect(pixels).toHaveLength(originalLength);
    expect(mutation.changes).toEqual([{ index: 3, point: { x: 1, y: 1 }, before: null, after: "B" }]); expect(mutation.dirtyBounds).toEqual({ x: 1, y: 1, width: 1, height: 1 });
  });

  it("erases only opaque touched pixels and excludes already-transparent cells from dirty bounds", () => {
    const source = makeBuffer(3, 2, [null, "A", null, "B", null, null]); const mutation = paintPixels(source, [{ x: 2, y: 1 }, { x: 0, y: 1 }, { x: 1, y: 0 }, { x: 1, y: 0 }], null);
    expect(mutation.buffer.pixels).toEqual(Array<PixelColor>(6).fill(null)); expect(mutation.changes).toEqual([
      { index: 1, point: { x: 1, y: 0 }, before: "A", after: null },
      { index: 3, point: { x: 0, y: 1 }, before: "B", after: null },
    ]); expect(mutation.dirtyBounds).toEqual({ x: 0, y: 0, width: 2, height: 2 }); expect(source.pixels).toEqual([null, "A", null, "B", null, null]);
  });

  it("keeps normalized fractional dimensions and point rounding in the sparse-change path", () => {
    const source = makeBuffer(2.9, 2.8, [null]); const mutation = paintPixels(source, [{ x: 0.6, y: 1.4 }, { x: 1.2, y: 1.1 }, { x: 2, y: 1 }], "A");
    expect(mutation.buffer).toEqual({ width: 2, height: 2, pixels: [null, null, null, "A"] }); expect(mutation.changes).toEqual([{ index: 3, point: { x: 1, y: 1 }, before: null, after: "A" }]);
  });

  it("flood-fills only the four-connected region", () => {
    const source = makeBuffer(3, 3, [
      "A", "A", "B",
      "B", "A", "B",
      "A", "B", "A",
    ]);
    const mutation = floodFill(source, { x: 0, y: 0 }, "C");

    expect(mutation.buffer.pixels).toEqual([
      "C", "C", "B",
      "B", "C", "B",
      "A", "B", "A",
    ]);
    expect(floodFill(mutation.buffer, { x: 0, y: 0 }, "C").changes).toEqual([]);
    expect(floodFill(source, { x: -1, y: 0 }, "C").buffer).toBe(source);
  });
});

describe("shape rasterization", () => {
  it("produces deterministic filled and outline rectangles", () => {
    const outline = pointKeys(rectanglePoints({ x: 0, y: 0 }, { x: 2, y: 2 }));
    const filled = pointKeys(
      rectanglePoints({ x: 2, y: 2 }, { x: 0, y: 0 }, { filled: true }),
    );

    expect(outline.size).toBe(8);
    expect(outline.has("1,1")).toBe(false);
    expect(filled.size).toBe(9);
    expect(filled.has("1,1")).toBe(true);
  });

  it("clips thick outlines after expanding the brush", () => {
    const points = rectanglePoints(
      { x: 0, y: 0 },
      { x: 2, y: 2 },
      { brushSize: 2, bounds: { width: 3, height: 3 } },
    );

    expect(points.every((point) => point.x >= 0 && point.y >= 0)).toBe(true);
    expect(pointKeys(points).has("1,1")).toBe(true);
  });

  it("keeps ellipses symmetric and handles one-cell axes", () => {
    const outline = ellipsePoints({ x: 0, y: 0 }, { x: 4, y: 4 });
    const keys = pointKeys(outline);

    for (const point of outline) {
      expect(keys.has(`${4 - point.x},${point.y}`)).toBe(true);
      expect(keys.has(`${point.x},${4 - point.y}`)).toBe(true);
    }
    expect(keys.has("2,2")).toBe(false);
    expect(ellipsePoints({ x: 3, y: 0 }, { x: 3, y: 3 }, { filled: true })).toEqual([
      { x: 3, y: 0 },
      { x: 3, y: 1 },
      { x: 3, y: 2 },
      { x: 3, y: 3 },
    ]);
  });
});

describe("selection, blocks, and movement", () => {
  it("normalizes reverse drags and clips selections", () => {
    expect(
      normalizeSelection({ x: 5, y: 4 }, { x: -2, y: 1 }, { width: 4, height: 3 }),
    ).toEqual({ x: 0, y: 1, width: 4, height: 2 });
  });

  it("extracts only the in-bounds intersection", () => {
    const source = makeBuffer(3, 2, ["A", "B", "C", "D", "E", "F"]);

    expect(extractBlock(source, { x: -1, y: 0, width: 3, height: 2 })).toEqual({
      width: 2,
      height: 2,
      pixels: ["A", "B", "D", "E"],
    });
  });

  it("clears a clipped rectangle and treats an already clear region as a no-op", () => {
    const source = makeBuffer(3, 1, ["A", null, "C"]);
    const mutation = clearRect(source, { x: 1, y: 0, width: 5, height: 1 });

    expect(mutation.buffer.pixels).toEqual(["A", null, null]);
    expect(clearRect(mutation.buffer, { x: 1, y: 0, width: 1, height: 1 }).changes).toEqual([]);
  });

  it("moves overlapping regions from an immutable source snapshot", () => {
    const source = makeBuffer(4, 1, ["A", "B", "C", null]);
    const result = moveRegion(source, { x: 0, y: 0, width: 2, height: 1 }, { x: 1, y: 0 });

    expect(source.pixels).toEqual(["A", "B", "C", null]);
    expect(result.mutation.buffer.pixels).toEqual([null, "A", "B", null]);
    expect(result.selection).toEqual({ x: 1, y: 0, width: 2, height: 1 });
  });

  it("preserves destination data beneath transparent pixels and clips moved content", () => {
    const source = makeBuffer(3, 1, ["A", null, "C"]);
    const moved = moveRegion(source, { x: 0, y: 0, width: 2, height: 1 }, { x: 1, y: 0 });

    expect(moved.mutation.buffer.pixels).toEqual([null, "A", "C"]);

    const clipped = moveRegion(
      makeBuffer(3, 1, ["A", "B", "C"]),
      { x: 1, y: 0, width: 2, height: 1 },
      { x: 1, y: 0 },
    );
    expect(clipped.mutation.buffer.pixels).toEqual(["A", null, "B"]);
    expect(clipped.selection).toEqual({ x: 2, y: 0, width: 1, height: 1 });
  });

  it("moves transparent selection bounds even when no pixels change", () => {
    const source = makeBuffer(4, 2, Array<PixelColor>(8).fill(null));
    const result = moveRegion(source, { x: 0, y: 0, width: 2, height: 2 }, { x: 1, y: 0 });

    expect(result.mutation.buffer).toBe(source);
    expect(result.mutation.changes).toEqual([]);
    expect(result.selection).toEqual({ x: 1, y: 0, width: 2, height: 2 });
  });

  it("moves a whole layer with clipping and returns a no-op for zero delta", () => {
    const source = makeBuffer(3, 1, ["A", "B", "C"]);

    expect(moveLayer(source, { x: 1, y: 0 }).buffer.pixels).toEqual([null, "A", "B"]);
    expect(moveLayer(source, { x: 0, y: 0 }).buffer).toBe(source);
  });
});

describe("block transformations and placement", () => {
  const block: PixelBlock = {
    width: 2,
    height: 3,
    pixels: ["A", "B", "C", "D", "E", "F"],
  };

  it("flips blocks horizontally and vertically without changing their dimensions", () => {
    expect(flipBlock(block, "horizontal")).toEqual({
      width: 2,
      height: 3,
      pixels: ["B", "A", "D", "C", "F", "E"],
    });
    expect(flipBlock(block, "vertical")).toEqual({
      width: 2,
      height: 3,
      pixels: ["E", "F", "C", "D", "A", "B"],
    });
    expect(flipBlock(flipBlock(block, "horizontal"), "horizontal")).toEqual(block);
  });

  it("rotates rectangular blocks in both directions", () => {
    expect(rotateBlock90(block, "clockwise")).toEqual({
      width: 3,
      height: 2,
      pixels: ["E", "C", "A", "F", "D", "B"],
    });
    expect(rotateBlock90(block, "counterclockwise")).toEqual({
      width: 3,
      height: 2,
      pixels: ["B", "D", "F", "A", "C", "E"],
    });

    let rotated = block;
    for (let turn = 0; turn < 4; turn += 1) {
      rotated = rotateBlock90(rotated, "clockwise");
    }
    expect(rotated).toEqual(block);
  });

  it("places with clipping and preserves transparent destinations by default", () => {
    const source = makeBuffer(3, 2, ["A", "B", "C", "D", "E", "F"]);
    const overlay: PixelBlock = { width: 2, height: 2, pixels: [null, "X", "Y", null] };

    expect(placeBlock(source, overlay, { x: 1, y: 0 }).buffer.pixels).toEqual([
      "A", "B", "X",
      "D", "Y", "F",
    ]);
    expect(
      placeBlock(source, overlay, { x: 1, y: 0 }, { transparent: "replace" }).buffer.pixels,
    ).toEqual([
      "A", null, "X",
      "D", "Y", null,
    ]);
    expect(placeBlock(source, overlay, { x: 2, y: 1 }).buffer.pixels).toEqual([
      "A", "B", "C",
      "D", "E", "F",
    ]);
  });
});
