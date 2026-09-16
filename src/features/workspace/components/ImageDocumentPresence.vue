<script setup lang="ts">
import { UsersRound, X } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue";

import type { ProjectPresenceMember } from "../../../lib/realtime";
import { getDocumentPresenceMembers } from "../lib/documentPresence";

const props = defineProps<{
  members: ProjectPresenceMember[];
  currentUserId: string;
}>();

const dialogId = `image-document-presence-${useId()}`;
const titleId = `${dialogId}-title`;
const trigger = ref<HTMLButtonElement | null>(null);
const dialog = ref<HTMLElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const isOpen = ref(false);
const failedAvatarUrls = ref(new Map<string, string>());
let previousFocus: HTMLElement | null = null;
let previousBodyOverflow: string | null = null;

const presence = computed(() =>
  getDocumentPresenceMembers(props.members, props.currentUserId),
);
const listedMembers = computed(() => presence.value.members);
const otherCount = computed(() => presence.value.others.length);
const countLabel = computed(() => (otherCount.value > 99 ? "99+" : String(otherCount.value)));
const triggerLabel = computed(() =>
  `${otherCount.value} other ${otherCount.value === 1 ? "person is" : "people are"} in this drawing. Show people`,
);

const displayName = (member: ProjectPresenceMember) =>
  member.username?.trim() || member.email || "Project member";

const initials = (member: ProjectPresenceMember) => {
  const source = member.username?.trim() || member.email.split("@")[0] || "?";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0]?.[0] || ""}${parts[1]?.[0] || ""}` : source.slice(0, 2))
    .toUpperCase();
};

const hasPixelAvatar = (member: ProjectPresenceMember) =>
  Boolean(member.avatar_pixel_art?.pixels?.length && member.avatar_pixel_art.size > 0);

const canShowImageAvatar = (member: ProjectPresenceMember) =>
  Boolean(member.avatar_url && failedAvatarUrls.value.get(member.id) !== member.avatar_url);

const markAvatarFailed = (member: ProjectPresenceMember) => {
  failedAvatarUrls.value = new Map([
    ...failedAvatarUrls.value,
    [member.id, member.avatar_url || ""],
  ]);
};

const focusableElements = () =>
  [...(dialog.value?.querySelectorAll<HTMLElement>(
    'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
  ) || [])].filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);

const stopDialogEffects = () => {
  if (typeof window === "undefined") return;
  window.removeEventListener("keydown", handleModalKeydown, true);
  document.removeEventListener("focusin", handleModalFocus, true);
  if (previousBodyOverflow !== null) {
    document.body.style.overflow = previousBodyOverflow;
    previousBodyOverflow = null;
  }
};

const closeDialog = () => {
  if (!isOpen.value) return;
  isOpen.value = false;
  stopDialogEffects();
  const target = previousFocus;
  previousFocus = null;
  void nextTick(() => {
    if (target?.isConnected && (target !== trigger.value || otherCount.value > 0)) {
      target.focus({ preventScroll: true });
    }
  });
};

function handleModalKeydown(event: KeyboardEvent) {
  // Keep editor shortcuts behind the modal from changing tools or the drawing.
  event.stopImmediatePropagation();
  if (event.key === "Escape") {
    event.preventDefault();
    closeDialog();
    return;
  }
  if (event.key !== "Tab") return;
  const elements = focusableElements();
  const first = elements[0];
  const last = elements[elements.length - 1];
  if (!first || !last) {
    event.preventDefault();
    dialog.value?.focus({ preventScroll: true });
  } else if (event.shiftKey && (document.activeElement === first || !dialog.value?.contains(document.activeElement))) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && (document.activeElement === last || !dialog.value?.contains(document.activeElement))) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}

function handleModalFocus(event: FocusEvent) {
  if (isOpen.value && event.target instanceof Node && !dialog.value?.contains(event.target)) {
    closeButton.value?.focus({ preventScroll: true });
  }
}

const openDialog = async () => {
  if (!otherCount.value || isOpen.value) return;
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : trigger.value;
  isOpen.value = true;
  previousBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  window.addEventListener("keydown", handleModalKeydown, true);
  document.addEventListener("focusin", handleModalFocus, true);
  await nextTick();
  if (isOpen.value) closeButton.value?.focus({ preventScroll: true });
};

watch(otherCount, (count) => {
  if (count === 0) closeDialog();
});

onBeforeUnmount(() => {
  isOpen.value = false;
  previousFocus = null;
  stopDialogEffects();
});
</script>

<template>
  <button
    v-if="otherCount > 0"
    ref="trigger"
    class="image-document-presence"
    :class="{ 'has-many-people': otherCount > 99 }"
    type="button"
    data-image-shortcuts="off"
    :aria-label="triggerLabel"
    :title="triggerLabel"
    aria-haspopup="dialog"
    :aria-expanded="isOpen"
    :aria-controls="dialogId"
    @click="openDialog"
  >
    <span class="image-document-presence__badge" aria-hidden="true">
      <UsersRound :size="16" :stroke-width="1.8" />
      <span>{{ countLabel }}</span>
    </span>
  </button>

  <Teleport to="body">
    <div
      v-if="isOpen"
      class="image-document-presence-backdrop"
      @click.self="closeDialog"
      @wheel.stop
      @pointerdown.stop
      @pointermove.stop
      @pointerup.stop
    >
      <section
        :id="dialogId"
        ref="dialog"
        class="image-document-presence-dialog"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        data-image-shortcuts="off"
        tabindex="-1"
      >
        <span class="image-document-presence-dialog__handle" aria-hidden="true" />
        <header class="image-document-presence-dialog__header">
          <div>
            <h2 :id="titleId">In this drawing</h2>
            <p>{{ listedMembers.length }} {{ listedMembers.length === 1 ? 'person' : 'people' }} present</p>
          </div>
          <button
            ref="closeButton"
            class="image-document-presence-dialog__close"
            type="button"
            aria-label="Close people in this drawing"
            @click="closeDialog"
          >
            <X :size="20" aria-hidden="true" />
          </button>
        </header>

        <ul class="image-document-presence-dialog__list" aria-label="People in this drawing">
          <li v-for="member in listedMembers" :key="member.id" class="image-document-presence-member">
            <span class="image-document-presence-member__avatar" aria-hidden="true">
              <svg
                v-if="hasPixelAvatar(member)"
                :viewBox="`0 0 ${member.avatar_pixel_art?.size || 16} ${member.avatar_pixel_art?.size || 16}`"
                shape-rendering="crispEdges"
              >
                <rect
                  v-for="(pixel, pixelIndex) in member.avatar_pixel_art?.pixels || []"
                  v-show="pixel"
                  :key="pixelIndex"
                  :x="pixelIndex % (member.avatar_pixel_art?.size || 16)"
                  :y="Math.floor(pixelIndex / (member.avatar_pixel_art?.size || 16))"
                  width="1"
                  height="1"
                  :fill="pixel || 'transparent'"
                />
              </svg>
              <img
                v-else-if="canShowImageAvatar(member)"
                :src="member.avatar_url || ''"
                alt=""
                draggable="false"
                referrerpolicy="no-referrer"
                @error="markAvatarFailed(member)"
              />
              <span v-else>{{ initials(member) }}</span>
            </span>
            <span class="image-document-presence-member__info">
              <span class="image-document-presence-member__name">{{ displayName(member) }}</span>
              <span class="image-document-presence-member__status">Present</span>
            </span>
            <span v-if="member.id === currentUserId" class="image-document-presence-member__self">You</span>
          </li>
        </ul>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
  .image-document-presence {
    display: inline-flex;
    flex: 0 0 44px;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    margin: 0;
    padding: 0;
    color: #fff;
    background: transparent;
    border: 0;
    border-radius: 8px;
    cursor: pointer;
    font: inherit;
    touch-action: manipulation;
  }

  .image-document-presence__badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    box-sizing: border-box;
    width: 44px;
    height: 28px;
    padding: 0 3px;
    background: #242424;
    border: 1px solid #555;
    border-radius: 7px;
    font-size: 0.68rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }

  .image-document-presence__badge svg {
    flex: 0 0 auto;
  }

  .image-document-presence.has-many-people .image-document-presence__badge {
    gap: 2px;
    padding: 0 2px;
  }

  .image-document-presence.has-many-people svg {
    width: 14px;
    height: 14px;
  }

  .image-document-presence:hover .image-document-presence__badge,
  .image-document-presence[aria-expanded="true"] .image-document-presence__badge {
    background: #333;
    border-color: #fff;
  }

  .image-document-presence:focus-visible,
  .image-document-presence-dialog__close:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 2px;
  }

  .image-document-presence-backdrop {
    position: fixed;
    z-index: 300;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    padding: 20px;
    background: rgba(0, 0, 0, 0.64);
    overscroll-behavior: contain;
  }

  .image-document-presence-dialog {
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    width: min(100%, 400px);
    max-height: min(640px, calc(100dvh - 40px));
    overflow: hidden;
    color: #fff;
    background: #111212;
    border: 1px solid #454645;
    border-radius: 14px;
    box-shadow: 0 12px 48px rgba(0, 0, 0, 0.45);
    font-family: inherit;
  }

  .image-document-presence-dialog__handle {
    display: none;
  }

  .image-document-presence-dialog__header {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 12px 12px 18px;
    border-bottom: 1px solid #303130;
  }

  .image-document-presence-dialog__header h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 700;
    line-height: 1.4;
  }

  .image-document-presence-dialog__header p {
    margin: 3px 0 0;
    color: #aaa;
    font-size: 0.75rem;
    line-height: 1.4;
  }

  .image-document-presence-dialog__close {
    display: grid;
    flex: 0 0 44px;
    place-items: center;
    width: 44px;
    height: 44px;
    padding: 0;
    color: #fff;
    background: transparent;
    border: 0;
    border-radius: 8px;
    cursor: pointer;
    touch-action: manipulation;
  }

  .image-document-presence-dialog__close:hover {
    background: #2b2c2b;
  }

  .image-document-presence-dialog__list {
    min-height: 0;
    margin: 0;
    padding: 6px 12px 12px;
    overflow-y: auto;
    list-style: none;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
  }

  .image-document-presence-member {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 60px;
    padding: 6px;
  }

  .image-document-presence-member__avatar {
    display: grid;
    flex: 0 0 38px;
    place-items: center;
    width: 38px;
    height: 38px;
    overflow: hidden;
    color: #fff;
    background: #343534;
    border: 1px solid #626362;
    border-radius: 50%;
    font-size: 0.7rem;
    font-weight: 800;
  }

  .image-document-presence-member__avatar img,
  .image-document-presence-member__avatar svg {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .image-document-presence-member__info {
    display: grid;
    flex: 1 1 auto;
    gap: 3px;
    min-width: 0;
  }

  .image-document-presence-member__name {
    overflow: hidden;
    font-size: 0.85rem;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .image-document-presence-member__status {
    color: #aaa;
    font-size: 0.72rem;
  }

  .image-document-presence-member__self {
    flex: 0 0 auto;
    padding: 3px 7px;
    color: #fff;
    background: #2b2c2b;
    border: 1px solid #505150;
    border-radius: 5px;
    font-size: 0.65rem;
    font-weight: 600;
  }

  @media (max-width: 768px) {
    .image-document-presence-backdrop {
      align-items: flex-end;
      padding: 0;
    }

    .image-document-presence-dialog {
      width: 100%;
      max-height: min(70dvh, 560px);
      padding-bottom: env(safe-area-inset-bottom, 0px);
      border-right: 0;
      border-bottom: 0;
      border-left: 0;
      border-radius: 16px 16px 0 0;
    }

    .image-document-presence-dialog__handle {
      display: block;
      flex: 0 0 4px;
      align-self: center;
      width: 32px;
      margin: 8px 0 0;
      background: #626362;
      border-radius: 4px;
    }

    .image-document-presence-dialog__header {
      padding-top: 5px;
    }
  }
</style>
