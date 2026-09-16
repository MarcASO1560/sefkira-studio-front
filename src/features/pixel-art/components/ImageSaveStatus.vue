<script setup lang="ts">
import { Check, Circle, LoaderCircle, RotateCcw, TriangleAlert, WifiOff } from "@lucide/vue";
import { computed } from "vue";

import type { SaveStatus } from "../types";

const props = withDefaults(
  defineProps<{
    status: SaveStatus;
    error?: string;
    lastSavedAt?: number | string | null;
    compactOnMobile?: boolean;
  }>(),
  {
    error: "",
    lastSavedAt: null,
    compactOnMobile: false,
  },
);

const emit = defineEmits<{
  retry: [];
}>();

const savedAtDate = computed(() => {
  if (props.lastSavedAt === null || props.lastSavedAt === undefined || props.lastSavedAt === "") {
    return null;
  }

  const date = new Date(props.lastSavedAt);
  return Number.isFinite(date.getTime()) ? date : null;
});

const savedAtDescription = computed(() =>
  savedAtDate.value
    ? `Saved at ${new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "medium",
      }).format(savedAtDate.value)}`
    : "Saved",
);

const label = computed(() => {
  switch (props.status) {
    case "saving":
      return "Saving…";
    case "dirty":
      return "Unsaved";
    case "error":
      return "Save failed";
    case "offline":
      return "Offline";
    default:
      return "Saved";
  }
});

const accessibleLabel = computed(() => {
  if (props.status === "error" && props.error.trim()) {
    return `${label.value}: ${props.error.trim()}`;
  }
  return props.status === "saved" ? savedAtDescription.value : label.value;
});

const canRetry = computed(() => props.status === "error" || props.status === "offline");
</script>

<template>
  <div
    class="image-save-status"
    :class="[`is-${status}`, { 'is-compact-on-mobile': compactOnMobile }]"
    :role="status === 'error' ? 'alert' : 'status'"
    :aria-live="status === 'error' ? 'assertive' : 'polite'"
    aria-atomic="true"
    :aria-label="accessibleLabel"
    :title="accessibleLabel"
  >
    <Check v-if="status === 'saved'" :size="13" :stroke-width="2.2" aria-hidden="true" />
    <LoaderCircle
      v-else-if="status === 'saving'"
      class="image-save-status__spinner"
      :size="13"
      :stroke-width="2.1"
      aria-hidden="true"
    />
    <Circle v-else-if="status === 'dirty'" :size="9" fill="currentColor" aria-hidden="true" />
    <TriangleAlert v-else-if="status === 'error'" :size="13" :stroke-width="2.2" aria-hidden="true" />
    <WifiOff v-else :size="13" :stroke-width="2.1" aria-hidden="true" />
    <span>{{ label }}</span>

    <button
      v-if="canRetry"
      type="button"
      class="image-save-status__retry"
      :aria-label="status === 'offline' ? 'Retry save while offline' : 'Retry save'"
      title="Retry save"
      @click="emit('retry')"
    >
      <RotateCcw :size="12" :stroke-width="2.2" aria-hidden="true" />
      <span>Retry</span>
    </button>
  </div>
</template>

<style scoped>
  .image-save-status {
    --status-color: #b8b8b8;
    display: inline-flex;
    gap: 5px;
    align-items: center;
    width: max-content;
    min-height: 24px;
    padding: 0 7px;
    color: var(--status-color);
    font-size: 11px;
    font-weight: 600;
    line-height: 1;
    background: #151515;
    border: 1px solid #303030;
    border-radius: 6px;
    box-shadow: none;
  }

  .image-save-status.is-saving,
  .image-save-status.is-dirty {
    --status-color: #d0d0d0;
  }

  .image-save-status.is-error {
    --status-color: #ff7b72;
  }

  .image-save-status.is-offline {
    --status-color: #d9ad55;
  }

  .image-save-status__retry {
    display: inline-flex;
    gap: 4px;
    align-items: center;
    min-height: 24px;
    padding: 0 4px;
    color: inherit;
    font: inherit;
    cursor: pointer;
    background: transparent;
    border: 0;
    border-left: 1px solid currentColor;
    border-radius: 0 5px 5px 0;
    outline: none;
  }

  .image-save-status__retry:hover {
    color: #ffffff;
    background: #1b1b1b;
  }

  .image-save-status__retry:focus-visible {
    outline: 1px solid currentColor;
    outline-offset: -2px;
  }

  .image-save-status__spinner {
    animation: image-save-status-spin 800ms linear infinite;
  }

  @keyframes image-save-status-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .image-save-status__spinner {
      animation: none;
    }
  }

  @media (max-width: 768px) {
    .image-save-status.is-compact-on-mobile {
      gap: 4px;
      padding-right: 4px;
      padding-left: 4px;
    }

    .image-save-status.is-compact-on-mobile.is-saved > span,
    .image-save-status.is-compact-on-mobile.is-saving > span,
    .image-save-status.is-compact-on-mobile.is-dirty > span,
    .image-save-status.is-compact-on-mobile .image-save-status__retry > span {
      display: none;
    }
  }

  @media (forced-colors: active) {
    .image-save-status__retry {
      border-color: ButtonBorder;
    }
  }
</style>
