<script setup lang="ts">
import { Redo2, Undo2 } from "@lucide/vue";
import { computed } from "vue";

import type { BrushShape } from "../lib/drawing";
import type { ImageTool } from "../types";
import ImageSelectionControls from "./ImageSelectionControls.vue";
import ImageRotationControls from "./ImageRotationControls.vue";
import type {
  ImageSelectionMode,
  ImageSelectionTool,
} from "./ImageSelectionControls.types";

const props = withDefaults(defineProps<{
  activeTool: ImageTool;
  brushSize: number;
  brushShape: BrushShape;
  shapeFilled: boolean;
  canEdit: boolean;
  canUndo: boolean;
  canRedo: boolean;
  selectionTool?: ImageSelectionTool;
  selectionMode?: ImageSelectionMode;
  selectionContiguous?: boolean;
  hasSelection?: boolean;
  rotationDegrees?: number;
  rotationBusy?: boolean;
  canRotate?: boolean;
}>(), {
  selectionTool: "rectangle",
  selectionMode: "replace",
  selectionContiguous: true,
  hasSelection: false,
  rotationDegrees: 0,
  rotationBusy: false,
  canRotate: false,
});

const emit = defineEmits<{
  "update:brushSize": [size: number];
  "update:brushShape": [shape: BrushShape];
  "update:shapeFilled": [filled: boolean];
  "update:selectionTool": [tool: ImageSelectionTool];
  "update:selectionMode": [mode: ImageSelectionMode];
  "update:selectionContiguous": [contiguous: boolean];
  "update:rotationDegrees": [degrees: number];
  "apply-rotation": [];
  undo: [];
  redo: [];
}>();

const toolLabels: Record<ImageTool, string> = {
  pencil: "Pencil",
  graffiti: "Graffiti",
  erase: "Eraser",
  fill: "Fill",
  picker: "Color picker",
  line: "Line",
  rectangle: "Rectangle",
  ellipse: "Ellipse",
  select: "Selection",
  move: "Move",
  rotate: "Rotate pixels",
};

const brushTools: ReadonlySet<ImageTool> = new Set([
  "pencil",
  "graffiti",
  "erase",
  "line",
  "rectangle",
  "ellipse",
]);

const brushShapes: ReadonlyArray<Readonly<{ label: string; value: BrushShape }>> = [
  { label: "Square", value: "square" },
  { label: "Circle", value: "circle" },
  { label: "Diamond", value: "diamond" },
];

const normalizedBrushSize = computed(() =>
  Math.min(8, Math.max(1, Math.round(props.brushSize))),
);
const supportsBrushSize = computed(() => brushTools.has(props.activeTool));
const supportsFilledShape = computed(
  () => props.activeTool === "rectangle" || props.activeTool === "ellipse",
);

const updateBrushSize = (event: Event) => {
  const input = event.currentTarget as HTMLInputElement;
  const size = Math.min(8, Math.max(1, Math.round(Number(input.value) || 1)));
  emit("update:brushSize", size);
};
</script>

<template>
  <div
    class="image-tool-options"
    :class="{ 'is-selection': activeTool === 'select', 'is-rotation': activeTool === 'rotate' }"
    role="toolbar"
    aria-label="Tool options"
  >
    <div class="image-tool-options__history" role="group" aria-label="Edit history">
      <button
        type="button"
        class="image-tool-options__button"
        :disabled="!canEdit || !canUndo || rotationBusy"
        aria-label="Undo"
        aria-keyshortcuts="Control+Z Meta+Z"
        title="Undo last shared edit (Ctrl/Cmd + Z)"
        @click="emit('undo')"
      >
        <Undo2 aria-hidden="true" />
      </button>
      <button
        type="button"
        class="image-tool-options__button"
        :disabled="!canEdit || !canRedo || rotationBusy"
        aria-label="Redo"
        aria-keyshortcuts="Control+Y Meta+Y Control+Shift+Z Meta+Shift+Z"
        title="Redo shared edit (Ctrl/Cmd + Y)"
        @click="emit('redo')"
      >
        <Redo2 aria-hidden="true" />
      </button>
    </div>

    <span class="image-tool-options__separator" aria-hidden="true"></span>
    <span class="image-tool-options__tool">{{ toolLabels[activeTool] }}</span>

    <ImageRotationControls
      v-if="activeTool === 'rotate'"
      :degrees="rotationDegrees"
      :busy="rotationBusy"
      :can-edit="canEdit && canRotate"
      @update:degrees="emit('update:rotationDegrees', $event)"
      @apply="emit('apply-rotation')"
    />

    <ImageSelectionControls
      v-if="activeTool === 'select'"
      :tool="selectionTool"
      :mode="selectionMode"
      :contiguous="selectionContiguous"
      :has-selection="hasSelection"
      :can-edit="canEdit"
      @update:tool="emit('update:selectionTool', $event)"
      @update:mode="emit('update:selectionMode', $event)"
      @update:contiguous="emit('update:selectionContiguous', $event)"
    />

    <label v-if="supportsBrushSize" class="image-tool-options__size">
      <span>Size</span>
      <input
        type="range"
        min="1"
        max="8"
        step="1"
        :disabled="!canEdit"
        :value="normalizedBrushSize"
        :aria-valuetext="`${normalizedBrushSize} ${normalizedBrushSize === 1 ? 'pixel' : 'pixels'}`"
        @input="updateBrushSize"
      />
      <output>{{ normalizedBrushSize }} px</output>
    </label>

    <div
      v-if="supportsBrushSize"
      class="image-tool-options__shape"
      role="group"
      aria-label="Brush shape"
    >
      <button
        v-for="shape in brushShapes"
        :key="shape.value"
        type="button"
        :class="{ 'is-active': brushShape === shape.value }"
        :disabled="!canEdit"
        :aria-label="`${shape.label} brush`"
        :aria-pressed="brushShape === shape.value"
        :title="`${shape.label} brush`"
        @click="emit('update:brushShape', shape.value)"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect v-if="shape.value === 'square'" x="5" y="5" width="14" height="14" rx="1" />
          <circle v-else-if="shape.value === 'circle'" cx="12" cy="12" r="7" />
          <path v-else d="m12 4 8 8-8 8-8-8Z" />
        </svg>
      </button>
    </div>

    <label v-if="supportsFilledShape" class="image-tool-options__filled">
      <input
        type="checkbox"
        :checked="shapeFilled"
        :disabled="!canEdit"
        @change="emit('update:shapeFilled', ($event.currentTarget as HTMLInputElement).checked)"
      />
      <span>Filled</span>
    </label>
  </div>
</template>

<style scoped>
  .image-tool-options {
    --tool-options-ink: #eeeeee;
    --tool-options-muted: #989898;
    --tool-options-line: #2c2c2c;
    display: flex;
    gap: 9px;
    align-items: center;
    width: 100%;
    min-width: 0;
    min-height: 40px;
    padding: 0 8px;
    box-sizing: border-box;
    color: var(--tool-options-ink);
    font-size: 11px;
    background: #0c0c0c;
    border: 0;
    border-bottom: 1px solid var(--tool-options-line);
    border-radius: 0;
    box-shadow: none;
  }

  .image-tool-options__history {
    display: inline-flex;
    flex: 0 0 auto;
    gap: 1px;
    align-items: center;
  }

  .image-tool-options__button {
    display: inline-grid;
    place-items: center;
    width: 30px;
    min-width: 30px;
    height: 30px;
    min-height: 30px;
    padding: 0;
    color: #b6b6b6;
    cursor: pointer;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    outline: none;
    transition:
      color 150ms ease,
      background-color 150ms ease;
  }

  .image-tool-options__button:hover:not(:disabled) {
    color: #ffffff;
    background: #1c1c1c;
  }

  .image-tool-options__button:focus-visible {
    outline: 2px solid #ffffff;
    outline-offset: 1px;
  }

  .image-tool-options__button:disabled {
    cursor: not-allowed;
    opacity: 0.3;
  }

  .image-tool-options__button svg {
    width: 16px;
    height: 16px;
    stroke-width: 2.1;
  }

  .image-tool-options__separator {
    flex: 0 0 1px;
    width: 1px;
    height: 20px;
    background: #333333;
  }

  .image-tool-options__tool {
    flex: 0 0 auto;
    min-width: 76px;
    color: var(--tool-options-ink);
    font-size: 12px;
    font-weight: 650;
  }

  .image-tool-options__size,
  .image-tool-options__filled {
    display: inline-flex;
    flex: 0 0 auto;
    gap: 8px;
    align-items: center;
    min-height: 30px;
  }

  .image-tool-options__size > span {
    color: var(--tool-options-muted);
    font-size: 10px;
    font-weight: 600;
  }

  .image-tool-options__size input[type="range"] {
    width: 112px;
    height: 28px;
    padding: 0;
    margin: 0;
    appearance: none;
    cursor: pointer;
    background: transparent;
  }

  .image-tool-options__size input[type="range"]::-webkit-slider-runnable-track {
    height: 4px;
    background: #5f5f5f;
    border-radius: 999px;
  }

  .image-tool-options__size input[type="range"]::-webkit-slider-thumb {
    width: 14px;
    height: 14px;
    margin-top: -5px;
    appearance: none;
    background: #f2f2f2;
    border: 1px solid #ffffff;
    border-radius: 50%;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
  }

  .image-tool-options__size input[type="range"]::-moz-range-track {
    height: 4px;
    background: #5f5f5f;
    border: 0;
    border-radius: 999px;
  }

  .image-tool-options__size input[type="range"]::-moz-range-thumb {
    width: 14px;
    height: 14px;
    background: #f2f2f2;
    border: 1px solid #ffffff;
    border-radius: 50%;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
  }

  .image-tool-options__size input[type="range"]:focus-visible {
    outline: 2px solid #ffffff;
    outline-offset: 2px;
    border-radius: 999px;
  }

  .image-tool-options__size input[type="range"]:disabled {
    cursor: not-allowed;
    opacity: 0.35;
  }

  .image-tool-options__size output {
    min-width: 34px;
    color: var(--tool-options-ink);
    font-size: 11px;
    font-weight: 650;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .image-tool-options__shape {
    display: inline-flex;
    flex: 0 0 auto;
    gap: 2px;
    align-items: center;
  }

  .image-tool-options__shape button {
    display: inline-grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    color: #8f8f8f;
    cursor: pointer;
    background: transparent;
    border: 0;
    border-radius: 5px;
    outline: none;
  }

  .image-tool-options__shape button:hover:not(:disabled) {
    color: #ffffff;
    background: #1c1c1c;
  }

  .image-tool-options__shape button.is-active {
    color: #111111;
    background: #eeeeee;
  }

  .image-tool-options__shape button:focus-visible {
    outline: 2px solid #ffffff;
    outline-offset: 1px;
  }

  .image-tool-options__shape button:disabled {
    cursor: not-allowed;
    opacity: 0.3;
  }

  .image-tool-options__shape svg {
    width: 13px;
    height: 13px;
    fill: currentColor;
    stroke: none;
  }

  .image-tool-options__filled {
    min-width: 66px;
    padding: 0 4px;
    color: #d0d0d0;
    cursor: pointer;
    border-radius: 5px;
    transition: color 150ms ease;
  }

  .image-tool-options__filled:hover:not(:has(input:disabled)) {
    color: #ffffff;
  }

  .image-tool-options__filled input {
    width: 16px;
    height: 16px;
    margin: 0;
    accent-color: #f2f2f2;
  }

  .image-tool-options__filled:has(input:disabled) {
    cursor: not-allowed;
    opacity: 0.4;
  }

  @media (max-width: 768px) {
    .image-tool-options {
      gap: 6px;
      min-height: 44px;
      padding-right: 4px;
      padding-left: 4px;
      overflow-x: auto;
      overflow-y: hidden;
      scrollbar-width: none;
    }

    .image-tool-options::-webkit-scrollbar {
      display: none;
    }

    .image-tool-options__history,
    .image-tool-options__tool,
    .image-tool-options__size,
    .image-tool-options__filled,
    .image-tool-options__shape {
      flex-shrink: 0;
    }

    .image-tool-options.is-selection .image-tool-options__history,
    .image-tool-options.is-rotation .image-tool-options__history {
      display: none;
    }

    .image-tool-options__button {
      width: 34px;
      min-width: 34px;
      height: 34px;
      min-height: 34px;
    }

    .image-tool-options__separator,
    .image-tool-options__tool {
      display: none;
    }

    .image-tool-options__size {
      gap: 6px;
    }

    .image-tool-options__size input[type="range"] {
      width: 52px;
    }

    .image-tool-options__size output {
      min-width: 30px;
    }

    .image-tool-options__shape {
      gap: 1px;
    }

    .image-tool-options__shape button {
      width: 27px;
      height: 30px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .image-tool-options__button,
    .image-tool-options__filled {
      transition: none;
    }
  }

  @media (forced-colors: active) {
    .image-tool-options,
    .image-tool-options__button,
    .image-tool-options__separator,
    .image-tool-options__shape button {
      border-color: ButtonBorder;
    }
  }
</style>
