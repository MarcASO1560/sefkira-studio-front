<script setup lang="ts">
import { computed } from "vue";
import { MessageCircleMore } from "@lucide/vue";
const props = defineProps<{ count: number; name: string; folder?: boolean }>();
const emit = defineEmits<{ open: [] }>();
const label = computed(() => `${props.count} unread ${props.count === 1 ? "message" : "messages"} ${props.folder ? "in" : "for"} ${props.name}. ${props.folder ? "Open folder" : "Open chat"}.`);
</script>

<template>
  <button v-if="count > 0" type="button" class="chat-unread-badge" :aria-label="label" :title="label"
    draggable="false" @click.stop="emit('open')" @keydown.stop @dragstart.stop.prevent>
    <MessageCircleMore :size="15" :stroke-width="2" aria-hidden="true" />
    <span aria-hidden="true">{{ count > 99 ? '99+' : count }}</span>
  </button>
</template>

<style scoped>
.chat-unread-badge { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; gap: 5px; min-width: 44px; min-height: 44px; padding: 0 6px; border: 0; border-radius: 6px; background: transparent; color: #ffb697; font-family: inherit; font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent; transition: background-color 140ms ease, opacity 100ms ease; }
.chat-unread-badge:focus-visible { outline: 2px solid currentColor; outline-offset: 1px; }
.chat-unread-badge:active { opacity: .7; }
@media (hover: hover) and (pointer: fine) { .chat-unread-badge:hover { background: rgb(255 182 151 / 9%); } }
@media (prefers-reduced-motion: reduce) { .chat-unread-badge { transition: none; } }
</style>
