<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";

import { writeImageCanvasBitmapPixels } from "../lib/canvasRendering";
import type { PixelColor } from "../types";

const props = defineProps<{
  pixels: PixelColor[];
  width: number;
  height: number;
  opacity: number;
}>();

const canvasRef = ref<HTMLCanvasElement | null>(null);
let thumbnailImageData: ImageData | null = null;
let thumbnailRenderFrame: number | null = null;

const renderThumbnail = () => {
  const canvas = canvasRef.value;
  const width = Math.max(1, Math.floor(props.width));
  const height = Math.max(1, Math.floor(props.height));
  if (!canvas) return;

  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return;

  context.imageSmoothingEnabled = false;
  if (!thumbnailImageData || thumbnailImageData.width !== width || thumbnailImageData.height !== height) {
    thumbnailImageData = context.createImageData(width, height);
  }
  const imageData = thumbnailImageData;
  const layerOpacity = Math.min(1, Math.max(0, props.opacity));
  const pixels = props.pixels.length === width * height
    ? props.pixels
    : Array.from({ length: width * height }, (_, index) => props.pixels[index] ?? null);
  writeImageCanvasBitmapPixels(pixels, null, imageData.data);
  if (layerOpacity !== 1) {
    for (let offset = 3; offset < imageData.data.length; offset += 4) {
      imageData.data[offset] = Math.round(imageData.data[offset]! * layerOpacity);
    }
  }

  context.putImageData(imageData, 0, 0);
};

const scheduleThumbnailRender = () => {
  if (thumbnailRenderFrame !== null) return;
  thumbnailRenderFrame = requestAnimationFrame(() => {
    thumbnailRenderFrame = null;
    renderThumbnail();
  });
};

watch(
  () => [props.pixels, props.width, props.height, props.opacity] as const,
  scheduleThumbnailRender,
  { flush: "post" },
);

onMounted(scheduleThumbnailRender);
onUnmounted(() => {
  if (thumbnailRenderFrame !== null) cancelAnimationFrame(thumbnailRenderFrame);
  thumbnailRenderFrame = null;
  thumbnailImageData = null;
});
</script>

<template>
  <canvas ref="canvasRef" aria-hidden="true"></canvas>
</template>

<style scoped>
  canvas {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
    image-rendering: pixelated;
  }
</style>
