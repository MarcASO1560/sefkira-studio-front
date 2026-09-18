<script setup lang="ts">
import { computed } from "vue";

import type { DocumentChatSticker } from "../lib/documentChatStickers";

const props = withDefaults(defineProps<{
  sticker: DocumentChatSticker;
  size?: number;
  preview?: boolean;
}>(), { size: 96, preview: false });

const style = computed(() => {
  const { sticker, size } = props;
  const column = sticker.previewFrame % sticker.columns;
  const row = Math.floor(sticker.previewFrame / sticker.columns);
  return {
    width: `${size}px`,
    height: `${size}px`,
    backgroundImage: `url("${sticker.src}")`,
    backgroundSize: `${sticker.columns * size}px ${sticker.rows * size}px`,
    backgroundPosition: `${-column * size}px ${-row * size}px`,
    "--sticker-size": `${size}px`,
    "--sticker-duration": `${sticker.durationMs}ms`,
  };
});
</script>

<template>
  <span class="document-chat-sticker" :class="{ 'document-chat-sticker--preview': preview }" :style="style"
    role="img" :aria-label="`${sticker.label} sticker`" />
</template>

<style scoped>
.document-chat-sticker { display: block; flex: 0 0 auto; background-repeat: no-repeat; image-rendering: pixelated; }
.document-chat-sticker:not(.document-chat-sticker--preview) {
  animation: sticker-frames var(--sticker-duration) step-end infinite;
}
/* The source is a 5×4 sheet with 16 frames; the final four cells are padding. */
@keyframes sticker-frames {
  0%, 100% { background-position: 0 0; }
  6.25% { background-position: calc(-1 * var(--sticker-size)) 0; }
  12.5% { background-position: calc(-2 * var(--sticker-size)) 0; }
  18.75% { background-position: calc(-3 * var(--sticker-size)) 0; }
  25% { background-position: calc(-4 * var(--sticker-size)) 0; }
  31.25% { background-position: 0 calc(-1 * var(--sticker-size)); }
  37.5% { background-position: calc(-1 * var(--sticker-size)) calc(-1 * var(--sticker-size)); }
  43.75% { background-position: calc(-2 * var(--sticker-size)) calc(-1 * var(--sticker-size)); }
  50% { background-position: calc(-3 * var(--sticker-size)) calc(-1 * var(--sticker-size)); }
  56.25% { background-position: calc(-4 * var(--sticker-size)) calc(-1 * var(--sticker-size)); }
  62.5% { background-position: 0 calc(-2 * var(--sticker-size)); }
  68.75% { background-position: calc(-1 * var(--sticker-size)) calc(-2 * var(--sticker-size)); }
  75% { background-position: calc(-2 * var(--sticker-size)) calc(-2 * var(--sticker-size)); }
  81.25% { background-position: calc(-3 * var(--sticker-size)) calc(-2 * var(--sticker-size)); }
  87.5% { background-position: calc(-4 * var(--sticker-size)) calc(-2 * var(--sticker-size)); }
  93.75% { background-position: 0 calc(-3 * var(--sticker-size)); }
}
@media (prefers-reduced-motion: reduce) {
  .document-chat-sticker:not(.document-chat-sticker--preview) { animation: none; }
}
</style>
