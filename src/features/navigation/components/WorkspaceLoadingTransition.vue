<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { WORKSPACE_TRANSITION_STORAGE_KEY } from "../../../lib/routeTransition";

const props = withDefaults(
  defineProps<{
    active?: boolean;
    phase?: "exit" | "entry";
  }>(),
  {
    active: false,
    phase: "exit",
  },
);

const isRendered = ref(false);
const isVisible = ref(false);
const isLeaving = ref(false);
const isCanvasReady = ref(false);
const canvasRef = ref<HTMLCanvasElement | null>(null);
let leaveTimer = 0;
let entrySafetyTimer = 0;
let animationFrame = 0;
let lastStepAt = 0;
let generation = 0;
let board = new Uint8Array();
let scratchBoard = new Uint8Array();
let context: CanvasRenderingContext2D | null = null;
let resizeHandler: (() => void) | null = null;
let visibleColumns = 0;
let visibleRows = 0;
let visibleColumnOffset = 0;
let columns = 0;
let rows = 0;
let canvasWidth = 0;
let canvasHeight = 0;
let entryTransitionToken = 0;
let entryVisibilityHandler: (() => void) | null = null;
let entryPageShowHandler: (() => void) | null = null;
const WORKSPACE_ENTRY_MINIMUM_MS = 650;
const WORKSPACE_ENTRY_MAXIMUM_MS = 1800;
const DESKTOP_CELL_SIZE = 11;
const MOBILE_CELL_SIZE_MIN = 3;
const STEP_MS = 18;
const RESET_GENERATION = 2000;
const SIMULATION_COLUMN_BUFFER = 220;
const SIMULATION_LEFT_BUFFER = 70;
const MAX_TRANSITION_DPR = 1.25;
let cellSize = DESKTOP_CELL_SIZE;

type Point = readonly [row: number, column: number];

type LifeScene = {
  name: string;
  points: Point[];
};

const translate = (points: Point[], rowOffset: number, columnOffset: number): Point[] =>
  points.map(([row, column]) => [row + rowOffset, column + columnOffset]);

const mirrorHorizontally = (points: Point[]): Point[] => {
  const maxColumn = Math.max(...points.map(([, column]) => column));
  return points.map(([row, column]) => [row, maxColumn - column]);
};

const combine = (...patterns: Point[][]): Point[] => patterns.flat();

const GOSPER_GLIDER_GUN: Point[] = [
  [5, 1],
  [5, 2],
  [6, 1],
  [6, 2],
  [3, 13],
  [3, 14],
  [4, 12],
  [4, 16],
  [5, 11],
  [5, 17],
  [6, 11],
  [6, 15],
  [6, 17],
  [6, 18],
  [7, 11],
  [7, 17],
  [8, 12],
  [8, 16],
  [9, 13],
  [9, 14],
  [1, 25],
  [2, 23],
  [2, 25],
  [3, 21],
  [3, 22],
  [4, 21],
  [4, 22],
  [5, 21],
  [5, 22],
  [6, 23],
  [6, 25],
  [7, 25],
  [3, 35],
  [3, 36],
  [4, 35],
  [4, 36],
];

const R_PENTOMINO: Point[] = [
  [0, 1],
  [0, 2],
  [1, 0],
  [1, 1],
  [2, 1],
];

const ACORN: Point[] = [
  [0, 1],
  [1, 3],
  [2, 0],
  [2, 1],
  [2, 4],
  [2, 5],
  [2, 6],
];

const DIEHARD: Point[] = [
  [0, 6],
  [1, 0],
  [1, 1],
  [2, 1],
  [2, 5],
  [2, 6],
  [2, 7],
];

const LOADER_SCENES: LifeScene[] = [
  {
    name: "gosper-glider-gun",
    points: GOSPER_GLIDER_GUN,
  },
  {
    name: "twin-gosper-guns",
    points: combine(
      GOSPER_GLIDER_GUN,
      translate(mirrorHorizontally(GOSPER_GLIDER_GUN), 0, 58),
    ),
  },
  {
    name: "generator-bank",
    points: combine(
      GOSPER_GLIDER_GUN,
      translate(GOSPER_GLIDER_GUN, 20, 26),
      translate(GOSPER_GLIDER_GUN, -12, 52),
    ),
  },
  {
    name: "chaos-breeder",
    points: combine(
      translate(R_PENTOMINO, 0, 0),
      translate(ACORN, 10, 24),
      translate(DIEHARD, 2, 52),
      translate(ACORN, 18, 82),
    ),
  },
  {
    name: "seed-factory",
    points: combine(
      translate(R_PENTOMINO, 0, 0),
      translate(R_PENTOMINO, 13, 20),
      translate(ACORN, 4, 42),
      translate(DIEHARD, 17, 70),
      translate(ACORN, 25, 94),
    ),
  },
];

let activeScene = LOADER_SCENES[0];

const columnSpanFor = (points: Point[]) => {
  const minColumn = Math.min(...points.map(([, column]) => column));
  const maxColumn = Math.max(...points.map(([, column]) => column));

  return maxColumn - minColumn + 1;
};

const MAX_SCENE_COLUMNS = Math.max(
  ...LOADER_SCENES.map((scene) => columnSpanFor(scene.points)),
);

const getResponsiveCellSize = (width: number) => {
  if (width <= 520) {
    return Math.max(MOBILE_CELL_SIZE_MIN, Math.floor((width - 24) / MAX_SCENE_COLUMNS));
  }

  if (width <= 820) {
    return Math.max(5, Math.floor((width - 32) / MAX_SCENE_COLUMNS));
  }

  if (width <= 1120) {
    return Math.max(7, Math.floor((width - 40) / MAX_SCENE_COLUMNS));
  }

  return DESKTOP_CELL_SIZE;
};

const chooseScene = () => {
  activeScene = LOADER_SCENES[Math.floor(Math.random() * LOADER_SCENES.length)];
};

const indexFor = (row: number, column: number) => row * columns + column;

const createBoard = () => {
  const nextBoard = new Uint8Array(columns * rows);
  const scenePoints = activeScene.points;
  const minPatternRow = Math.min(...scenePoints.map(([row]) => row));
  const maxPatternRow = Math.max(...scenePoints.map(([row]) => row));
  const minPatternColumn = Math.min(...scenePoints.map(([, column]) => column));
  const maxPatternColumn = Math.max(...scenePoints.map(([, column]) => column));
  const patternRows = maxPatternRow - minPatternRow + 1;
  const patternColumns = maxPatternColumn - minPatternColumn + 1;
  const rowOffset = Math.round((visibleRows - patternRows) / 2 - minPatternRow);
  const columnOffset =
    visibleColumnOffset +
    Math.round((visibleColumns - patternColumns) / 2 - minPatternColumn);

  for (const [row, column] of scenePoints) {
    const nextRow = row + rowOffset;
    const nextColumn = column + columnOffset;

    if (nextRow >= 0 && nextRow < rows && nextColumn >= 0 && nextColumn < columns) {
      nextBoard[indexFor(nextRow, nextColumn)] = 1;
    }
  }

  return nextBoard;
};

const stepBoard = () => {
  if (scratchBoard.length !== board.length) {
    scratchBoard = new Uint8Array(board.length);
  }

  const currentBoard = board;
  const nextBoard = scratchBoard;

  for (let row = 0; row < rows; row += 1) {
    const hasPreviousRow = row > 0;
    const hasNextRow = row < rows - 1;
    const previousRowStart = (row - 1) * columns;
    const rowStart = row * columns;
    const nextRowStart = (row + 1) * columns;

    for (let column = 0; column < columns; column += 1) {
      const hasPreviousColumn = column > 0;
      const hasNextColumn = column < columns - 1;
      const index = rowStart + column;
      let neighbors = 0;

      if (hasPreviousRow) {
        neighbors += currentBoard[previousRowStart + column];
        if (hasPreviousColumn) {
          neighbors += currentBoard[previousRowStart + column - 1];
        }
        if (hasNextColumn) {
          neighbors += currentBoard[previousRowStart + column + 1];
        }
      }
      if (hasPreviousColumn) {
        neighbors += currentBoard[rowStart + column - 1];
      }
      if (hasNextColumn) {
        neighbors += currentBoard[rowStart + column + 1];
      }
      if (hasNextRow) {
        neighbors += currentBoard[nextRowStart + column];
        if (hasPreviousColumn) {
          neighbors += currentBoard[nextRowStart + column - 1];
        }
        if (hasNextColumn) {
          neighbors += currentBoard[nextRowStart + column + 1];
        }
      }

      const isAlive = currentBoard[index] === 1;

      nextBoard[index] = isAlive
        ? neighbors === 2 || neighbors === 3
          ? 1
          : 0
        : neighbors === 3
          ? 1
          : 0;
    }
  }

  board = nextBoard;
  scratchBoard = currentBoard;
  generation += 1;

  if (generation >= RESET_GENERATION) {
    board = createBoard();
    generation = 0;
  }
};

const drawBoard = () => {
  if (!context) {
    return;
  }

  context.clearRect(0, 0, canvasWidth, canvasHeight);
  context.fillStyle = "#fff";

  for (let row = 0; row < rows; row += 1) {
    for (let column = visibleColumnOffset; column < visibleColumnOffset + visibleColumns; column += 1) {
      const index = indexFor(row, column);

      if (board[index] !== 1) {
        continue;
      }

      const visibleColumn = column - visibleColumnOffset;
      context.fillRect(
        visibleColumn * cellSize,
        row * cellSize,
        cellSize,
        cellSize,
      );
    }
  }
};

const loop = (timestamp: number) => {
  if (timestamp - lastStepAt >= STEP_MS) {
    stepBoard();
    lastStepAt = timestamp;
  }

  drawBoard();
  animationFrame = window.requestAnimationFrame(loop);
};

const resizeCanvas = (canvas: HTMLCanvasElement) => {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_TRANSITION_DPR);
  canvasWidth = Math.max(1, rect.width || window.innerWidth);
  canvasHeight = Math.max(1, rect.height || window.innerHeight);
  cellSize = getResponsiveCellSize(canvasWidth);
  visibleColumns = Math.ceil(canvasWidth / cellSize);
  visibleRows = Math.ceil(canvasHeight / cellSize);
  visibleColumnOffset = SIMULATION_LEFT_BUFFER;
  columns = visibleColumns + SIMULATION_COLUMN_BUFFER;
  rows = visibleRows;
  canvas.width = Math.ceil(canvasWidth * dpr);
  canvas.height = Math.ceil(canvasHeight * dpr);
  context = canvas.getContext("2d");
  context?.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (context) {
    context.imageSmoothingEnabled = false;
  }

  board = createBoard();
  scratchBoard = new Uint8Array(board.length);
  generation = 0;
  drawBoard();
  isCanvasReady.value = true;
};

const startGun = async () => {
  await nextTick();
  const canvas = canvasRef.value;

  if (!canvas) {
    return;
  }

  lastStepAt = 0;
  window.cancelAnimationFrame(animationFrame);
  if (resizeHandler) {
    window.removeEventListener("resize", resizeHandler);
  }
  resizeCanvas(canvas);
  resizeHandler = () => resizeCanvas(canvas);
  window.addEventListener("resize", resizeHandler);

  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    animationFrame = window.requestAnimationFrame(loop);
  }
};

const stopGun = () => {
  window.cancelAnimationFrame(animationFrame);
  if (resizeHandler) {
    window.removeEventListener("resize", resizeHandler);
  }
  animationFrame = 0;
  resizeHandler = null;
  isCanvasReady.value = false;
  context = null;
};

const show = async (options: { instant?: boolean } = {}) => {
  window.clearTimeout(leaveTimer);
  chooseScene();
  isCanvasReady.value = false;
  isLeaving.value = false;
  isVisible.value = options.instant === true;
  isRendered.value = true;
  await nextTick();
  await startGun();

  if (options.instant) {
    window.requestAnimationFrame(() => {
      document.documentElement.classList.remove("route-transition-pending");
    });
    return;
  }

  window.requestAnimationFrame(() => {
    isVisible.value = true;
    document.documentElement.classList.remove("route-transition-pending");
  });
};

const hide = () => {
  window.clearTimeout(entrySafetyTimer);
  document.documentElement.classList.remove("route-transition-pending");
  isLeaving.value = true;
  isVisible.value = false;
  leaveTimer = window.setTimeout(() => {
    isRendered.value = false;
    isLeaving.value = false;
    stopGun();
  }, 240);
};

const waitForNextPaint = () =>
  new Promise<void>((resolve) => {
    let isResolved = false;
    const fallbackTimer = window.setTimeout(() => {
      if (isResolved) {
        return;
      }

      isResolved = true;
      resolve();
    }, 240);

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (isResolved) {
          return;
        }

        isResolved = true;
        window.clearTimeout(fallbackTimer);
        resolve();
      });
    });
  });

const waitForWorkspacePaint = async () => {
  if (document.readyState !== "complete") {
    await new Promise<void>((resolve) => {
      window.addEventListener("load", () => resolve(), { once: true });
    });
  }

  await document.fonts?.ready.catch(() => undefined);
  await waitForNextPaint();
  await new Promise<void>((resolve) => window.setTimeout(resolve, 90));
};

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

watch(
  () => props.active,
  (active) => {
    if (props.phase !== "exit") {
      return;
    }

    if (active) {
      void show();
    }
  },
);

onMounted(async () => {
  if (props.phase !== "entry") {
    return;
  }

  let pending = false;
  try {
    pending = window.sessionStorage.getItem(WORKSPACE_TRANSITION_STORAGE_KEY) === "pending";
    if (pending) window.sessionStorage.removeItem(WORKSPACE_TRANSITION_STORAGE_KEY);
  } catch {
    // The workspace remains usable when the browser blocks optional storage.
    document.documentElement.classList.remove("route-transition-pending");
    return;
  }
  if (!pending) {
    document.documentElement.classList.remove("route-transition-pending");
    return;
  }

  const transitionToken = entryTransitionToken + 1;
  entryTransitionToken = transitionToken;
  const startedAt = performance.now();
  const finishEntry = () => {
    if (entryTransitionToken !== transitionToken) {
      return;
    }

    entryTransitionToken += 1;
    hide();
  };
  entryVisibilityHandler = () => {
    if (document.visibilityState === "hidden") {
      finishEntry();
    }
  };
  entryPageShowHandler = () => {
    if (performance.now() - startedAt > WORKSPACE_ENTRY_MAXIMUM_MS) {
      finishEntry();
    }
  };

  window.clearTimeout(entrySafetyTimer);
  entrySafetyTimer = window.setTimeout(finishEntry, WORKSPACE_ENTRY_MAXIMUM_MS);
  document.addEventListener("visibilitychange", entryVisibilityHandler);
  window.addEventListener("pageshow", entryPageShowHandler);

  try {
    await show({ instant: true });
    if (entryTransitionToken !== transitionToken) {
      hide();
      return;
    }

    await waitForWorkspacePaint();
    await wait(Math.max(0, WORKSPACE_ENTRY_MINIMUM_MS - (performance.now() - startedAt)));
    finishEntry();
  } finally {
    window.clearTimeout(entrySafetyTimer);
    if (entryVisibilityHandler) {
      document.removeEventListener("visibilitychange", entryVisibilityHandler);
      entryVisibilityHandler = null;
    }
    if (entryPageShowHandler) {
      window.removeEventListener("pageshow", entryPageShowHandler);
      entryPageShowHandler = null;
    }
  }
});

onBeforeUnmount(() => {
  window.clearTimeout(leaveTimer);
  window.clearTimeout(entrySafetyTimer);
  if (entryVisibilityHandler) {
    document.removeEventListener("visibilitychange", entryVisibilityHandler);
  }
  if (entryPageShowHandler) {
    window.removeEventListener("pageshow", entryPageShowHandler);
  }
  stopGun();
});
</script>

<template>
  <div
    v-if="isRendered"
    class="workspace-loading-transition"
    :class="{ 'is-visible': isVisible, 'is-leaving': isLeaving }"
    role="status"
    aria-label="Loading studio"
  >
    <div class="gosper-loader" :class="{ 'is-ready': isCanvasReady }" aria-hidden="true">
      <p>Launching studio</p>
      <div class="gosper-loader__viewport">
        <canvas ref="canvasRef" class="gosper-loader__canvas"></canvas>
      </div>
    </div>
  </div>
</template>

<style scoped>
.workspace-loading-transition {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  overflow: hidden;
  background: #000;
  color: rgba(255, 252, 255, 0.92);
  opacity: 0;
  pointer-events: auto;
  transition: opacity 130ms ease-out;
}

.workspace-loading-transition.is-visible {
  opacity: 1;
}

.workspace-loading-transition.is-leaving {
  transition-duration: 220ms;
  transition-timing-function: ease-in-out;
}

.gosper-loader {
  display: grid;
  position: absolute;
  inset: 0;
  place-items: center;
  justify-items: center;
  width: 100%;
  height: 100%;
  opacity: 0;
}

.gosper-loader.is-ready {
  opacity: 1;
}

.gosper-loader__viewport {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.gosper-loader__canvas {
  display: block;
  width: 100%;
  height: 100%;
  image-rendering: pixelated;
}

.gosper-loader p {
  position: absolute;
  top: max(72px, calc(50% - 150px));
  left: 50%;
  z-index: 1;
  margin: 0;
  color: #fff;
  font-size: clamp(1.2rem, 2.2vw, 1.7rem);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  transform: translateX(-50%);
  white-space: nowrap;
}
</style>
