<script setup lang="ts">
import { AlertTriangle, RefreshCw, ShieldCheck, X } from "@lucide/vue";
import { nextTick, onBeforeUnmount, ref, useId, watch } from "vue";

type Revision = number | string | null;

const props = withDefaults(
  defineProps<{
    open: boolean;
    busy?: boolean;
    operation?: "document" | "rename";
    localRevision?: Revision;
    remoteRevision?: Revision;
  }>(),
  {
    busy: false,
    operation: "document",
    localRevision: null,
    remoteRevision: null,
  },
);

const emit = defineEmits<{
  reload: [];
  "keep-local": [];
  close: [];
}>();

const dialogRef = ref<HTMLElement | null>(null);
const keepLocalButtonRef = ref<HTMLButtonElement | null>(null);
const titleId = useId();
const descriptionId = useId();
const consequencesId = useId();
let previouslyFocusedElement: HTMLElement | null = null;

const hasRevisionDetails = () =>
  props.localRevision !== null || props.remoteRevision !== null;

const restorePreviousFocus = () => {
  previouslyFocusedElement?.focus?.();
  previouslyFocusedElement = null;
};

watch(
  () => props.open,
  async (open) => {
    if (open) {
      previouslyFocusedElement =
        typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null);
      await nextTick();
      keepLocalButtonRef.value?.focus();
      return;
    }

    restorePreviousFocus();
  },
  { immediate: true },
);

onBeforeUnmount(restorePreviousFocus);

const handleTab = (event: KeyboardEvent) => {
  const dialog = dialogRef.value;
  if (!dialog) {
    return;
  }

  const focusable = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );

  if (focusable.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }

  const first = focusable[0] as HTMLElement;
  const last = focusable[focusable.length - 1] as HTMLElement;
  const activeElement = typeof document === "undefined" ? null : document.activeElement;

  if (event.shiftKey && (activeElement === first || !dialog.contains(activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (activeElement === last || !dialog.contains(activeElement))) {
    event.preventDefault();
    first.focus();
  }
};
</script>

<template>
  <div v-if="open" class="image-conflict-notice" role="presentation">
    <section
      ref="dialogRef"
      class="image-conflict-notice__dialog"
      role="alertdialog"
      aria-modal="true"
      :aria-labelledby="titleId"
      :aria-describedby="`${descriptionId} ${consequencesId}`"
      :aria-busy="busy"
      tabindex="-1"
      @keydown.esc.stop.prevent="emit('close')"
      @keydown.tab="handleTab"
    >
      <div class="image-conflict-notice__heading">
        <span class="image-conflict-notice__icon" aria-hidden="true">
          <AlertTriangle :size="18" :stroke-width="2.2" />
        </span>
        <div>
          <h2 :id="titleId">Newer remote version detected</h2>
          <p :id="descriptionId">
            {{
              operation === "rename"
                ? "This resource changed remotely while your new local name was being saved."
                : "The canvas or a layer changed remotely and these pending changes cannot be combined safely. Your local copy is still preserved on this device."
            }}
          </p>
        </div>
        <button
          type="button"
          class="image-conflict-notice__close"
          aria-label="Close conflict notice"
          title="Close"
          :disabled="busy"
          @click="emit('close')"
        >
          <X :size="15" :stroke-width="2.4" aria-hidden="true" />
        </button>
      </div>

      <dl v-if="hasRevisionDetails()" class="image-conflict-notice__revisions">
        <div v-if="localRevision !== null">
          <dt>Local revision</dt>
          <dd :title="String(localRevision)">{{ localRevision }}</dd>
        </div>
        <div v-if="remoteRevision !== null">
          <dt>Remote revision</dt>
          <dd :title="String(remoteRevision)">{{ remoteRevision }}</dd>
        </div>
      </dl>

      <p :id="consequencesId" class="image-conflict-notice__consequences">
        <strong>Reload remote</strong> discards your local
        {{ operation === "rename" ? "name" : "image changes" }}.
        <template v-if="operation === 'rename'">
          <strong>Keep local name</strong> loads the latest remote resource, then retries only your local name.
        </template>
        <template v-else>
          <strong>Export local copy</strong> downloads your image without overwriting anybody else's changes.
          Export it before reloading if you want to keep both versions.
        </template>
      </p>

      <div class="image-conflict-notice__actions">
        <button
          type="button"
          class="image-conflict-notice__action is-reload"
          :disabled="busy"
          @click="emit('reload')"
        >
          <RefreshCw :size="15" :stroke-width="2.2" aria-hidden="true" />
          Reload remote
        </button>
        <button
          ref="keepLocalButtonRef"
          type="button"
          class="image-conflict-notice__action is-primary"
          :disabled="busy"
          @click="emit('keep-local')"
        >
          <ShieldCheck :size="15" :stroke-width="2.2" aria-hidden="true" />
          {{ busy ? "Resolving…" : operation === "rename" ? "Keep local name" : "Export local copy" }}
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
  .image-conflict-notice {
    position: fixed;
    inset: 0;
    z-index: 80;
    display: grid;
    place-items: center;
    padding: 16px;
    box-sizing: border-box;
    background: rgba(0, 0, 0, 0.72);
  }

  .image-conflict-notice__dialog {
    width: min(420px, 100%);
    padding: 16px;
    box-sizing: border-box;
    color: #f2f2f2;
    background: #111313;
    border: 1px solid rgba(242, 242, 242, 0.24);
    border-top-color: rgba(255, 215, 111, 0.72);
    border-radius: 8px;
    outline: none;
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.62);
  }

  .image-conflict-notice__dialog:focus-visible {
    outline: 2px solid #ffd76f;
    outline-offset: 3px;
  }

  .image-conflict-notice__heading {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 9px;
    align-items: start;
  }

  .image-conflict-notice__icon {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    color: #ffd76f;
    background: transparent;
    border: 0;
  }

  .image-conflict-notice h2 {
    margin: 1px 0 5px;
    font-size: 14px;
    font-weight: 650;
    line-height: 1.25;
  }

  .image-conflict-notice__heading p {
    margin: 0;
    color: rgba(242, 242, 242, 0.7);
    font-size: 12px;
    line-height: 1.42;
  }

  .image-conflict-notice__close {
    display: grid;
    place-items: center;
    width: 27px;
    height: 27px;
    padding: 0;
    color: rgba(242, 242, 242, 0.7);
    cursor: pointer;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 5px;
    outline: none;
  }

  .image-conflict-notice__close:hover,
  .image-conflict-notice__close:focus-visible {
    color: #f2f2f2;
    background: rgba(242, 242, 242, 0.07);
    border-color: rgba(242, 242, 242, 0.18);
  }

  .image-conflict-notice__close:focus-visible,
  .image-conflict-notice__action:focus-visible {
    outline: 2px solid #ffd76f;
    outline-offset: 1px;
  }

  .image-conflict-notice__revisions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0;
    margin: 14px 0 0;
    border-top: 1px solid rgba(242, 242, 242, 0.14);
    border-bottom: 1px solid rgba(242, 242, 242, 0.14);
  }

  .image-conflict-notice__revisions div {
    min-width: 0;
    padding: 9px 0;
    background: transparent;
    border: 0;
  }

  .image-conflict-notice__revisions div + div {
    padding-left: 12px;
    border-left: 1px solid rgba(242, 242, 242, 0.14);
  }

  .image-conflict-notice__revisions dt {
    margin-bottom: 4px;
    color: rgba(242, 242, 242, 0.6);
    font-size: 11px;
    font-weight: 600;
  }

  .image-conflict-notice__revisions dd {
    margin: 0;
    overflow: hidden;
    color: rgba(242, 242, 242, 0.86);
    font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .image-conflict-notice__consequences {
    margin: 14px 0 0;
    padding: 0 0 0 10px;
    color: rgba(242, 242, 242, 0.72);
    font-size: 12px;
    line-height: 1.45;
    background: transparent;
    border-left: 2px solid rgba(255, 215, 111, 0.58);
  }

  .image-conflict-notice__consequences strong {
    color: rgba(242, 242, 242, 0.96);
  }

  .image-conflict-notice__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 12px;
  }

  .image-conflict-notice__action {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    min-height: 34px;
    padding: 0 11px;
    color: rgba(242, 242, 242, 0.86);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    background: transparent;
    border: 1px solid rgba(242, 242, 242, 0.22);
    border-radius: 6px;
    outline: none;
  }

  .image-conflict-notice__action:hover {
    background: rgba(242, 242, 242, 0.08);
    border-color: rgba(242, 242, 242, 0.4);
  }

  .image-conflict-notice__action:disabled,
  .image-conflict-notice__close:disabled {
    cursor: wait;
    opacity: 0.55;
  }

  .image-conflict-notice__action.is-reload {
    color: #ffaaa3;
    border-color: rgba(255, 140, 131, 0.26);
  }

  .image-conflict-notice__action.is-primary {
    color: #101111;
    background: #f2f2f2;
    border-color: #f2f2f2;
  }

  .image-conflict-notice__action.is-primary:hover {
    background: #ffffff;
    border-color: #ffffff;
  }

  @media (max-width: 480px) {
    .image-conflict-notice__revisions {
      grid-template-columns: 1fr;
    }

    .image-conflict-notice__actions {
      display: grid;
      grid-template-columns: 1fr;
    }

    .image-conflict-notice__action {
      justify-content: center;
    }

    .image-conflict-notice__revisions div + div {
      padding-left: 0;
      border-top: 1px solid rgba(242, 242, 242, 0.14);
      border-left: 0;
    }
  }

  @media (forced-colors: active) {
    .image-conflict-notice__dialog,
    .image-conflict-notice__action,
    .image-conflict-notice__close {
      border-color: ButtonBorder;
    }

    .image-conflict-notice__action.is-primary {
      color: HighlightText;
      background: Highlight;
    }
  }
</style>
