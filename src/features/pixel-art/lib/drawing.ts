export type PixelColor = string | null;

export type Point = Readonly<{
  x: number;
  y: number;
}>;

export type Rect = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type PixelBlock = Readonly<{
  width: number;
  height: number;
  pixels: ReadonlyArray<PixelColor>;
}>;

export type PixelBuffer = Readonly<{
  width: number;
  height: number;
  pixels: ReadonlyArray<PixelColor>;
}>;

export type PixelChange = Readonly<{
  index: number;
  point: Point;
  before: PixelColor;
  after: PixelColor;
}>;

export type PixelMutation = Readonly<{
  buffer: PixelBuffer;
  changes: ReadonlyArray<PixelChange>;
  dirtyBounds: Rect | null;
}>;

export type PixelBounds = Readonly<{
  width: number;
  height: number;
}>;

export type BrushShape = "circle" | "diamond" | "square";

export type ShapeOptions = Readonly<{
  filled?: boolean;
  brushSize?: number;
  brushShape?: BrushShape;
  bounds?: PixelBounds;
}>;

export type PlaceBlockOptions = Readonly<{
  transparent?: "preserve" | "replace";
}>;

export type MoveRegionResult = Readonly<{
  mutation: PixelMutation;
  selection: Rect | null;
}>;

const MAX_BRUSH_SIZE = 8;
const ELLIPSE_EPSILON = 1e-10;

const integer = (value: number) => (Number.isFinite(value) ? Math.round(value) : 0);

const dimension = (value: number) =>
  Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

const normalizePoint = (point: Point): Point => ({
  x: integer(point.x),
  y: integer(point.y),
});

const normalizeBounds = (bounds: PixelBounds): PixelBounds => ({
  width: dimension(bounds.width),
  height: dimension(bounds.height),
});

const normalizeBrushSize = (size: number) =>
  Math.min(MAX_BRUSH_SIZE, Math.max(1, dimension(size) || 1));

const isInside = (point: Point, bounds: PixelBounds) =>
  point.x >= 0 &&
  point.x < bounds.width &&
  point.y >= 0 &&
  point.y < bounds.height;

const pointKey = (point: Point) => `${point.x},${point.y}`;

const uniquePoints = (points: ReadonlyArray<Point>, bounds?: PixelBounds) => {
  const normalizedBounds = bounds ? normalizeBounds(bounds) : null;
  const seen = new Set<string>();
  const result: Point[] = [];

  for (const rawPoint of points) {
    const point = normalizePoint(rawPoint);
    if (normalizedBounds && !isInside(point, normalizedBounds)) {
      continue;
    }

    const key = pointKey(point);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(point);
  }

  return result;
};

const normalizeRect = (rect: Rect): Rect => {
  let x = integer(rect.x);
  let y = integer(rect.y);
  let width = integer(rect.width);
  let height = integer(rect.height);

  if (width < 0) {
    x += width + 1;
    width = Math.abs(width);
  }

  if (height < 0) {
    y += height + 1;
    height = Math.abs(height);
  }

  return {
    x,
    y,
    width: Math.max(0, width),
    height: Math.max(0, height),
  };
};

const rectFromPoints = (from: Point, to: Point): Rect => {
  const start = normalizePoint(from);
  const end = normalizePoint(to);
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);

  return {
    x,
    y,
    width: Math.abs(end.x - start.x) + 1,
    height: Math.abs(end.y - start.y) + 1,
  };
};

const intersectRect = (rect: Rect, bounds: PixelBounds): Rect | null => {
  const normalized = normalizeRect(rect);
  const normalizedBounds = normalizeBounds(bounds);
  const x = Math.max(0, normalized.x);
  const y = Math.max(0, normalized.y);
  const right = Math.min(normalizedBounds.width, normalized.x + normalized.width);
  const bottom = Math.min(normalizedBounds.height, normalized.y + normalized.height);

  if (right <= x || bottom <= y) {
    return null;
  }

  return { x, y, width: right - x, height: bottom - y };
};

const pixelAt = (pixels: ReadonlyArray<PixelColor>, index: number): PixelColor =>
  pixels[index] ?? null;

// Buffers are immutable. Remember arrays normalized by this module so ordinary
// brush frames can use one native copy; legacy short/sparse arrays still pass
// through the null-normalizing fallback when first encountered.
const normalizedPixelArrays = new WeakSet<ReadonlyArray<PixelColor>>();

const normalizedPixels = (buffer: PixelBuffer) => {
  const width = dimension(buffer.width);
  const height = dimension(buffer.height);
  const length = width * height;
  const pixels = normalizedPixelArrays.has(buffer.pixels) && buffer.pixels.length === length
    ? buffer.pixels.slice()
    : Array.from({ length }, (_, index) => pixelAt(buffer.pixels, index));
  normalizedPixelArrays.add(pixels);
  return pixels;
};

const mutationFromPixels = (
  buffer: PixelBuffer,
  candidatePixels: ReadonlyArray<PixelColor>,
): PixelMutation => {
  const width = dimension(buffer.width);
  const height = dimension(buffer.height);
  const length = width * height;
  const nextPixels = Array.from({ length }, (_, index) => pixelAt(candidatePixels, index));
  const changes: PixelChange[] = [];
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let index = 0; index < length; index += 1) {
    const before = pixelAt(buffer.pixels, index);
    const after = nextPixels[index];
    if (before === after) {
      continue;
    }

    const x = index % width;
    const y = Math.floor(index / width);
    changes.push({ index, point: { x, y }, before, after });
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  if (changes.length === 0) {
    return { buffer, changes: [], dirtyBounds: null };
  }

  return {
    buffer: { width, height, pixels: nextPixels },
    changes,
    dirtyBounds: {
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    },
  };
};

const emptyMutation = (buffer: PixelBuffer): PixelMutation => ({
  buffer,
  changes: [],
  dirtyBounds: null,
});

const pointsInRect = (rect: Rect) => {
  const points: Point[] = [];
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      points.push({ x, y });
    }
  }
  return points;
};

/** Rasterizes an inclusive, one-pixel-wide Bresenham line. */
export const linePoints = (from: Point, to: Point): Point[] => {
  const start = normalizePoint(from);
  const end = normalizePoint(to);
  const points: Point[] = [];
  let x = start.x;
  let y = start.y;
  const xStep = x < end.x ? 1 : -1;
  const yStep = y < end.y ? 1 : -1;
  const xDelta = Math.abs(end.x - x);
  const yDelta = -Math.abs(end.y - y);
  let error = xDelta + yDelta;

  while (true) {
    points.push({ x, y });
    if (x === end.x && y === end.y) {
      return points;
    }

    const doubledError = error * 2;
    if (doubledError >= yDelta) {
      error += yDelta;
      x += xStep;
    }
    if (doubledError <= xDelta) {
      error += xDelta;
      y += yStep;
    }
  }
};

/** Snaps a point to the nearest horizontal, vertical, or 45-degree ray. */
export const constrainPointToEightDirections = (origin: Point, target: Point): Point => {
  const start = normalizePoint(origin);
  const end = normalizePoint(target);
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const span = Math.max(Math.abs(deltaX), Math.abs(deltaY));

  if (span === 0) {
    return start;
  }

  const directions: ReadonlyArray<Point> = [
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
    { x: -1, y: 1 },
    { x: -1, y: 0 },
    { x: -1, y: -1 },
    { x: 0, y: -1 },
    { x: 1, y: -1 },
  ];
  const sector = Math.round(Math.atan2(deltaY, deltaX) / (Math.PI / 4));
  const direction = directions[(sector + directions.length) % directions.length];

  return {
    x: start.x + direction.x * span,
    y: start.y + direction.y * span,
  };
};

/** Returns a hard-edged pixel brush stamp with a stable anchor for every shape. */
export const brushPoints = (
  center: Point,
  size = 1,
  shape: BrushShape = "square",
  bounds?: PixelBounds,
): Point[] => {
  const point = normalizePoint(center);
  const brushSize = normalizeBrushSize(size);
  const offset = Math.floor(brushSize / 2);
  const localCenter = (brushSize - 1) / 2;
  const circleRadius = Math.max(0.5, brushSize / 2 - 0.1);
  const diamondRadius = brushSize / 2;
  const points: Point[] = [];

  for (let y = point.y - offset; y < point.y - offset + brushSize; y += 1) {
    for (let x = point.x - offset; x < point.x - offset + brushSize; x += 1) {
      const localX = x - (point.x - offset);
      const localY = y - (point.y - offset);
      const deltaX = Math.abs(localX - localCenter);
      const deltaY = Math.abs(localY - localCenter);
      const isIncluded =
        shape === "square" ||
        (shape === "circle" && Math.hypot(deltaX, deltaY) <= circleRadius) ||
        (shape === "diamond" && deltaX + deltaY <= diamondRadius);
      if (!isIncluded) continue;
      points.push({ x, y });
    }
  }

  return uniquePoints(points, bounds);
};

/**
 * Returns a square brush stamp. Even brushes are biased towards the negative
 * axes: a size-2 brush at (x, y) covers x-1..x and y-1..y.
 */
export const squareBrushPoints = (
  center: Point,
  size = 1,
  bounds?: PixelBounds,
): Point[] => brushPoints(center, size, "square", bounds);

/** Joins sampled pointer positions and stamps a brush along the path. */
export const strokePoints = (
  path: ReadonlyArray<Point>,
  brushSize = 1,
  bounds?: PixelBounds,
  brushShape: BrushShape = "square",
): Point[] => {
  if (path.length === 0) {
    return [];
  }

  const centers: Point[] = [];
  if (path.length === 1) {
    centers.push(normalizePoint(path[0]));
  } else {
    for (let index = 1; index < path.length; index += 1) {
      centers.push(...linePoints(path[index - 1], path[index]));
    }
  }

  return uniquePoints(
    centers.flatMap((point) => brushPoints(point, brushSize, brushShape)),
    bounds,
  );
};

/** Paints or erases points without modifying the source buffer. */
export const paintPixels = (
  buffer: PixelBuffer,
  points: ReadonlyArray<Point>,
  color: PixelColor,
): PixelMutation => {
  const bounds = normalizeBounds(buffer);
  const validPoints = uniquePoints(points, bounds);
  if (validPoints.length === 0) {
    return emptyMutation(buffer);
  }

  const changes: PixelChange[] = [];
  let minX = bounds.width;
  let minY = bounds.height;
  let maxX = -1;
  let maxY = -1;
  for (const point of validPoints) {
    const index = point.y * bounds.width + point.x;
    const before = pixelAt(buffer.pixels, index);
    if (before === color) continue;
    changes.push({ index, point, before, after: color });
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  if (changes.length === 0) return emptyMutation(buffer);

  // The old whole-canvas comparison reported changes in row-major order.
  // Preserve that contract while examining only the touched pixels.
  changes.sort((left, right) => left.index - right.index);
  const pixels = normalizedPixels(buffer);
  for (const change of changes) pixels[change.index] = change.after;
  return {
    buffer: { width: bounds.width, height: bounds.height, pixels },
    changes,
    dirtyBounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
  };
};

/** Fills a four-connected region from the given point. */
export const floodFill = (
  buffer: PixelBuffer,
  start: Point,
  replacement: PixelColor,
): PixelMutation => {
  const bounds = normalizeBounds(buffer);
  const origin = normalizePoint(start);
  if (!isInside(origin, bounds)) {
    return emptyMutation(buffer);
  }

  const pixels = normalizedPixels(buffer);
  const startIndex = origin.y * bounds.width + origin.x;
  const target = pixels[startIndex];
  if (target === replacement) {
    return emptyMutation(buffer);
  }

  const pending = [startIndex];
  const visited = new Uint8Array(bounds.width * bounds.height);
  const region: Point[] = [];

  while (pending.length > 0) {
    const index = pending.pop();
    if (index === undefined || visited[index] || pixels[index] !== target) {
      continue;
    }

    visited[index] = 1;
    const x = index % bounds.width;
    const y = Math.floor(index / bounds.width);
    region.push({ x, y });

    if (x > 0) pending.push(index - 1);
    if (x < bounds.width - 1) pending.push(index + 1);
    if (y > 0) pending.push(index - bounds.width);
    if (y < bounds.height - 1) pending.push(index + bounds.width);
  }

  return paintPixels(buffer, region, replacement);
};

export const rectanglePoints = (
  from: Point,
  to: Point,
  options: ShapeOptions = {},
): Point[] => {
  const rect = rectFromPoints(from, to);
  if (options.filled) {
    return uniquePoints(pointsInRect(rect), options.bounds);
  }

  const outline: Point[] = [];
  for (let x = rect.x; x < rect.x + rect.width; x += 1) {
    outline.push({ x, y: rect.y });
    outline.push({ x, y: rect.y + rect.height - 1 });
  }
  for (let y = rect.y + 1; y < rect.y + rect.height - 1; y += 1) {
    outline.push({ x: rect.x, y });
    outline.push({ x: rect.x + rect.width - 1, y });
  }

  return uniquePoints(
    outline.flatMap((point) =>
      brushPoints(point, options.brushSize ?? 1, options.brushShape),
    ),
    options.bounds,
  );
};

export const ellipsePoints = (
  from: Point,
  to: Point,
  options: ShapeOptions = {},
): Point[] => {
  const rect = rectFromPoints(from, to);
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const radiusX = rect.width / 2;
  const radiusY = rect.height / 2;
  const filled: Point[] = [];
  const filledKeys = new Set<string>();

  for (const point of pointsInRect(rect)) {
    const normalizedX = (point.x + 0.5 - centerX) / radiusX;
    const normalizedY = (point.y + 0.5 - centerY) / radiusY;
    if (normalizedX * normalizedX + normalizedY * normalizedY <= 1 + ELLIPSE_EPSILON) {
      filled.push(point);
      filledKeys.add(pointKey(point));
    }
  }

  if (options.filled) {
    return uniquePoints(filled, options.bounds);
  }

  const neighbors: ReadonlyArray<Point> = [
    { x: -1, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: -1 },
    { x: 0, y: 1 },
  ];
  const outline = filled.filter((point) =>
    neighbors.some(
      (delta) => !filledKeys.has(pointKey({ x: point.x + delta.x, y: point.y + delta.y })),
    ),
  );

  return uniquePoints(
    outline.flatMap((point) =>
      brushPoints(point, options.brushSize ?? 1, options.brushShape),
    ),
    options.bounds,
  );
};

/** Creates an inclusive rectangular selection, optionally clipped to a canvas. */
export const normalizeSelection = (
  from: Point,
  to: Point,
  bounds?: PixelBounds,
): Rect => {
  const rect = rectFromPoints(from, to);
  if (!bounds) {
    return rect;
  }

  return intersectRect(rect, bounds) ?? { x: 0, y: 0, width: 0, height: 0 };
};

export const extractBlock = (buffer: PixelBuffer, sourceRect: Rect): PixelBlock => {
  const bounds = normalizeBounds(buffer);
  const rect = intersectRect(sourceRect, bounds);
  if (!rect) {
    return { width: 0, height: 0, pixels: [] };
  }

  const pixels: PixelColor[] = [];
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      pixels.push(pixelAt(buffer.pixels, y * bounds.width + x));
    }
  }

  return { width: rect.width, height: rect.height, pixels };
};

export const clearRect = (buffer: PixelBuffer, sourceRect: Rect): PixelMutation => {
  const rect = intersectRect(sourceRect, buffer);
  return rect ? paintPixels(buffer, pointsInRect(rect), null) : emptyMutation(buffer);
};

/**
 * Cuts a selected rectangle and places its opaque pixels at the translated
 * position. Transparent source pixels do not erase unrelated destination data.
 */
export const moveRegion = (
  buffer: PixelBuffer,
  sourceRect: Rect,
  delta: Point,
): MoveRegionResult => {
  const bounds = normalizeBounds(buffer);
  const rect = intersectRect(sourceRect, bounds);
  if (!rect) {
    return { mutation: emptyMutation(buffer), selection: null };
  }

  const movement = normalizePoint(delta);
  const block = extractBlock(buffer, rect);
  const pixels = normalizedPixels(buffer);

  for (const point of pointsInRect(rect)) {
    pixels[point.y * bounds.width + point.x] = null;
  }

  const destination = { x: rect.x + movement.x, y: rect.y + movement.y };
  for (let blockY = 0; blockY < block.height; blockY += 1) {
    for (let blockX = 0; blockX < block.width; blockX += 1) {
      const color = pixelAt(block.pixels, blockY * block.width + blockX);
      if (color === null) {
        continue;
      }

      const point = { x: destination.x + blockX, y: destination.y + blockY };
      if (isInside(point, bounds)) {
        pixels[point.y * bounds.width + point.x] = color;
      }
    }
  }

  const destinationRect: Rect = {
    x: destination.x,
    y: destination.y,
    width: block.width,
    height: block.height,
  };

  return {
    mutation: mutationFromPixels(buffer, pixels),
    selection: intersectRect(destinationRect, bounds),
  };
};

export const moveLayer = (buffer: PixelBuffer, delta: Point): PixelMutation => {
  const bounds = normalizeBounds(buffer);
  const movement = normalizePoint(delta);
  if (movement.x === 0 && movement.y === 0) {
    return emptyMutation(buffer);
  }

  const pixels = Array<PixelColor>(bounds.width * bounds.height).fill(null);
  for (let y = 0; y < bounds.height; y += 1) {
    for (let x = 0; x < bounds.width; x += 1) {
      const color = pixelAt(buffer.pixels, y * bounds.width + x);
      if (color === null) {
        continue;
      }

      const destination = { x: x + movement.x, y: y + movement.y };
      if (isInside(destination, bounds)) {
        pixels[destination.y * bounds.width + destination.x] = color;
      }
    }
  }

  return mutationFromPixels(buffer, pixels);
};

export const flipBlock = (
  block: PixelBlock,
  axis: "horizontal" | "vertical",
): PixelBlock => {
  const width = dimension(block.width);
  const height = dimension(block.height);
  const pixels = Array<PixelColor>(width * height).fill(null);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const destinationX = axis === "horizontal" ? width - 1 - x : x;
      const destinationY = axis === "vertical" ? height - 1 - y : y;
      pixels[destinationY * width + destinationX] = pixelAt(block.pixels, y * width + x);
    }
  }

  return { width, height, pixels };
};

export const rotateBlock90 = (
  block: PixelBlock,
  direction: "clockwise" | "counterclockwise",
): PixelBlock => {
  const sourceWidth = dimension(block.width);
  const sourceHeight = dimension(block.height);
  const width = sourceHeight;
  const height = sourceWidth;
  const pixels = Array<PixelColor>(width * height).fill(null);

  for (let y = 0; y < sourceHeight; y += 1) {
    for (let x = 0; x < sourceWidth; x += 1) {
      const destinationX = direction === "clockwise" ? sourceHeight - 1 - y : y;
      const destinationY = direction === "clockwise" ? x : sourceWidth - 1 - x;
      pixels[destinationY * width + destinationX] = pixelAt(
        block.pixels,
        y * sourceWidth + x,
      );
    }
  }

  return { width, height, pixels };
};

/** Places a block with clipping; transparent pixels preserve the destination by default. */
export const placeBlock = (
  buffer: PixelBuffer,
  block: PixelBlock,
  rawOrigin: Point,
  options: PlaceBlockOptions = {},
): PixelMutation => {
  const bounds = normalizeBounds(buffer);
  const origin = normalizePoint(rawOrigin);
  const blockWidth = dimension(block.width);
  const blockHeight = dimension(block.height);
  const replaceTransparent = options.transparent === "replace";
  const pixels = normalizedPixels(buffer);

  for (let y = 0; y < blockHeight; y += 1) {
    for (let x = 0; x < blockWidth; x += 1) {
      const color = pixelAt(block.pixels, y * blockWidth + x);
      if (color === null && !replaceTransparent) {
        continue;
      }

      const destination = { x: origin.x + x, y: origin.y + y };
      if (isInside(destination, bounds)) {
        pixels[destination.y * bounds.width + destination.x] = color;
      }
    }
  }

  return mutationFromPixels(buffer, pixels);
};
