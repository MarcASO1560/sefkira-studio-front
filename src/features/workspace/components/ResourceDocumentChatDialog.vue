<script setup lang="ts">
import { MessageSquareText, SendHorizontal, Sticker, UsersRound, X } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";

import type { DocumentChatAuthor } from "../../../lib/api";
import type { DocumentChatMessage } from "../composables/useDocumentChat";
import { useDocumentChatViewport } from "../composables/useDocumentChatViewport";
import { useDocumentChatResize } from "../composables/useDocumentChatResize";
import { groupDocumentChatMessages, validatedDocumentChatAvatar } from "../lib/documentChatPresentation";
import { DOCUMENT_CHAT_STICKERS, getDocumentChatSticker } from "../lib/documentChatStickers";
import DocumentChatSticker from "./DocumentChatSticker.vue";

const props = defineProps<{
  open: boolean;
  documentName: string;
  participantsCount: number;
  currentUserId: string;
  messages: DocumentChatMessage[];
  loading: boolean;
  error: string | null;
  hasOlder: boolean;
  sending: boolean;
  accessDenied?: boolean;
}>();
const emit = defineEmits<{
  close: [];
  send: [body: string];
  sendSticker: [stickerId: string];
  retry: [clientMessageId: string];
  loadOlder: [];
  reload: [];
}>();
const dialog = ref<HTMLElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const timeline = ref<HTMLElement | null>(null);
const composer = ref<HTMLTextAreaElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const stickerButton = ref<HTMLButtonElement | null>(null);
const stickerPicker = ref<HTMLElement | null>(null);
const isStickerPickerOpen = ref(false);
const draft = ref("");
const isComposing = ref(false);
const failedAvatarUrls = ref(new Map<string, string>());
const enteringMessageKeys = ref(new Set<string>());
const groups = computed(() => groupDocumentChatMessages(props.messages));
const canSend = computed(() => Boolean(draft.value.trim()) && draft.value.trim().length <= 2000
  && Boolean(props.currentUserId) && !props.accessDenied && !isComposing.value);
let previousFocus: HTMLElement | null = null;
let previousBodyOverflow: string | null = null;
let dialogEffectsActive = false;
let modalEffectsActive = false;
let restoreFocusOnClose = true;
let dialogGeneration = 0;
let composerResizeFrame: number | null = null;
let messageAnimationTimer: ReturnType<typeof setTimeout> | null = null;
let nearBottom = true;
let scrollOwnMessage = false;
const messageKey = (message: DocumentChatMessage) => `${message.author.id}:${message.client_message_id}`;
let renderedMessageKeys = props.messages.map(messageKey);

const { isMobileLayout, viewportStyle, start: startViewport, stop: stopViewport } = useDocumentChatViewport({
  onResize: () => {
    if (!props.open) return;
    scheduleComposerResize();
    if (nearBottom) void nextTick(() => { if (props.open) scrollToBottom(); });
  },
});
const chatResize = useDocumentChatResize({
  panel, isMobileLayout,
  onResize: () => {
    scheduleComposerResize();
    if (nearBottom) void nextTick(() => { if (props.open) scrollToBottom(); });
  },
});
const displayName = (author: DocumentChatAuthor) => author.username?.trim() || "Project member";
const initials = (author: DocumentChatAuthor) => {
  const source = displayName(author);
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0]?.[0] || ""}${parts[1]?.[0] || ""}` : source.slice(0, 2)).toUpperCase();
};
const canShowImageAvatar = (author: DocumentChatAuthor) => Boolean(
  author.avatar_url && failedAvatarUrls.value.get(author.id) !== author.avatar_url,
);
const markAvatarFailed = (author: DocumentChatAuthor) => {
  failedAvatarUrls.value = new Map([...failedAvatarUrls.value, [author.id, author.avatar_url || ""]]);
};
const timeLabel = (timestamp: string) => {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
};
const dayLabel = (timestamp: string) => {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "Messages" : date.toLocaleDateString(undefined, {
    day: "numeric", month: "long", year: "numeric",
  });
};
function scrollToBottom() {
  if (timeline.value) timeline.value.scrollTop = timeline.value.scrollHeight;
  nearBottom = true;
}
const updateScrollPosition = () => {
  const element = timeline.value;
  if (element) nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
};
const loadOlder = () => {
  if (props.loading || !props.hasOlder || !timeline.value) return;
  emit("loadOlder");
};
const captureTimelineAnchor = () => {
  const element = timeline.value;
  if (!element) return null;
  const top = element.getBoundingClientRect().top;
  const rows = [...element.querySelectorAll<HTMLElement>("[data-message-key]")];
  const row = rows.find((item) => item.getBoundingClientRect().bottom > top) || rows[0];
  return row ? { key: row.dataset.messageKey, offset: row.getBoundingClientRect().top - top } : null;
};
const restoreTimelineAnchor = (anchor: ReturnType<typeof captureTimelineAnchor>) => {
  const element = timeline.value;
  if (!element || !anchor) return;
  const row = [...element.querySelectorAll<HTMLElement>("[data-message-key]")]
    .find((item) => item.dataset.messageKey === anchor.key);
  if (row) element.scrollTop += row.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.offset;
  updateScrollPosition();
};
const resizeComposer = () => {
  const element = composer.value;
  if (!element) return;
  const keepBottom = nearBottom;
  const maxHeight = Number.parseFloat(window.getComputedStyle(element).maxHeight) || 120;
  element.style.height = "auto";
  element.style.height = `${Math.min(maxHeight, Math.max(44, element.scrollHeight))}px`;
  if (keepBottom) void nextTick(() => { if (props.open) scrollToBottom(); });
};
function scheduleComposerResize() {
  if (composerResizeFrame !== null || typeof window === "undefined") return;
  composerResizeFrame = window.requestAnimationFrame(() => {
    composerResizeFrame = null;
    if (props.open) resizeComposer();
  });
}
const keepComposerFocused = (event: PointerEvent) => {
  if (event.button === 0 && document.activeElement === composer.value) {
    event.preventDefault();
  }
};
const sendDraft = () => {
  if (!canSend.value) return;
  const body = draft.value.trim();
  scrollOwnMessage = true;
  emit("send", body);
  draft.value = "";
  if (!isMobileLayout.value) composer.value?.focus({ preventScroll: true });
  scheduleComposerResize();
};
const closeStickerPicker = (restoreFocus = false) => {
  isStickerPickerOpen.value = false;
  if (restoreFocus) stickerButton.value?.focus({ preventScroll: true });
};
const toggleStickerPicker = async () => {
  if (props.accessDenied || !props.currentUserId) return;
  if (isStickerPickerOpen.value) {
    closeStickerPicker(true);
    return;
  }
  // Give the picker the space occupied by the phone keyboard.
  if (isMobileLayout.value) composer.value?.blur();
  isStickerPickerOpen.value = true;
  await nextTick();
  stickerPicker.value?.querySelector<HTMLButtonElement>("[data-sticker-id]")?.focus({ preventScroll: true });
};
const sendSticker = (stickerId: string) => {
  if (props.accessDenied || !props.currentUserId || isComposing.value || !getDocumentChatSticker(stickerId)) return;
  scrollOwnMessage = true;
  emit("sendSticker", stickerId);
  closeStickerPicker(isMobileLayout.value);
  if (!isMobileLayout.value) composer.value?.focus({ preventScroll: true });
};
const handleOutsidePointer = (event: PointerEvent) => {
  if (!isStickerPickerOpen.value || !(event.target instanceof Node)) return;
  if (!stickerPicker.value?.contains(event.target) && !stickerButton.value?.contains(event.target)) {
    closeStickerPicker();
  }
};
const handleComposerKeydown = (event: KeyboardEvent) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    sendDraft();
  }
};
const focusableElements = () => [...(dialog.value?.querySelectorAll<HTMLElement>(
  'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
) || [])].filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
function handleModalKeydown(event: KeyboardEvent) {
  if (!dialogEffectsActive || event.isComposing || event.keyCode === 229) return;
  if (!isMobileLayout.value && !dialog.value?.contains(event.target instanceof Node ? event.target : document.activeElement)) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (isStickerPickerOpen.value) closeStickerPicker(true);
    else if (props.open) emit("close");
  } else if (event.key === "Tab" && isMobileLayout.value) {
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
}
function handleModalFocus(event: FocusEvent) {
  if (modalEffectsActive && event.target instanceof Node && !dialog.value?.contains(event.target)) {
    closeButton.value?.focus({ preventScroll: true });
  }
}
const syncModalEffects = () => {
  const needsModal = dialogEffectsActive && isMobileLayout.value;
  if (needsModal && !modalEffectsActive) {
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("focusin", handleModalFocus, true);
    modalEffectsActive = true;
  } else if (!needsModal && modalEffectsActive) {
    document.removeEventListener("focusin", handleModalFocus, true);
    if (previousBodyOverflow !== null) document.body.style.overflow = previousBodyOverflow;
    previousBodyOverflow = null;
    modalEffectsActive = false;
  }
};
const stopDialogEffects = () => {
  if (typeof window === "undefined") return;
  dialogEffectsActive = false;
  window.removeEventListener("keydown", handleModalKeydown, true);
  document.removeEventListener("pointerdown", handleOutsidePointer, true);
  syncModalEffects();
  stopViewport();
  chatResize.stop();
  if (composerResizeFrame !== null) window.cancelAnimationFrame(composerResizeFrame);
  composerResizeFrame = null;
  if (messageAnimationTimer !== null) clearTimeout(messageAnimationTimer);
  messageAnimationTimer = null;
  enteringMessageKeys.value = new Set();
  if (previousBodyOverflow !== null) {
    document.body.style.overflow = previousBodyOverflow;
    previousBodyOverflow = null;
  }
};
const finishClose = async () => {
  if (props.open) return;
  const generation = ++dialogGeneration;
  stopDialogEffects();
  const target = previousFocus;
  await nextTick();
  if (generation === dialogGeneration && !props.open) {
    previousFocus = null;
    if (restoreFocusOnClose && target?.isConnected) target.focus({ preventScroll: true });
  }
};

watch(() => props.open, async (open) => {
  if (typeof window === "undefined") return;
  const generation = ++dialogGeneration;
  if (!open) {
    chatResize.stop();
    restoreFocusOnClose = isMobileLayout.value || Boolean(dialog.value?.contains(document.activeElement));
    closeStickerPicker();
    composer.value?.blur();
    isComposing.value = false;
    return;
  }
  if (!dialogEffectsActive) {
    if (!previousFocus?.isConnected) {
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    dialogEffectsActive = true;
    window.addEventListener("keydown", handleModalKeydown, true);
    document.addEventListener("pointerdown", handleOutsidePointer, true);
  }
  nearBottom = true;
  scrollOwnMessage = false;
  renderedMessageKeys = props.messages.map(messageKey);
  startViewport();
  syncModalEffects();
  await nextTick();
  if (!props.open || generation !== dialogGeneration) return;
  chatResize.start();
  scrollToBottom();
  resizeComposer();
  // Avoid opening the virtual keyboard before the user chooses to write.
  (isMobileLayout.value ? closeButton.value : composer.value)?.focus({ preventScroll: true });
}, { immediate: true });

watch(isMobileLayout, async (mobile) => {
  if (!dialogEffectsActive) return;
  syncModalEffects();
  scheduleComposerResize();
  chatResize.stop();
  const generation = dialogGeneration;
  await nextTick();
  if (!props.open || generation !== dialogGeneration) return;
  if (!mobile) { chatResize.start(); return; }
  if (props.open && isMobileLayout.value && generation === dialogGeneration
    && !dialog.value?.contains(document.activeElement)) closeButton.value?.focus({ preventScroll: true });
});
watch(() => props.accessDenied, (denied) => { if (denied) closeStickerPicker(); });
watch(isStickerPickerOpen, async () => {
  const keepBottom = nearBottom;
  await nextTick();
  if (props.open && keepBottom) scrollToBottom();
});

watch(() => props.messages.map((message) => `${messageKey(message)}:${message.status}`).join("|"), async () => {
  const previousKeys = renderedMessageKeys;
  const keys = props.messages.map(messageKey);
  renderedMessageKeys = keys;
  if (!props.open) return;
  const generation = dialogGeneration;
  const prepended = previousKeys.length > 0 && keys.indexOf(previousKeys[0]!) > 0;
  const shouldScroll = nearBottom || scrollOwnMessage;
  const anchor = prepended ? captureTimelineAnchor() : null;
  if (!prepended && shouldScroll && !props.loading) {
    const knownKeys = new Set(previousKeys);
    const arrivals = props.messages.filter((message) => !knownKeys.has(messageKey(message))
      && (previousKeys.length > 0 || message.status === "pending")).map(messageKey);
    if (arrivals.length) {
      enteringMessageKeys.value = new Set([...enteringMessageKeys.value, ...arrivals]);
      if (messageAnimationTimer !== null) clearTimeout(messageAnimationTimer);
      messageAnimationTimer = setTimeout(() => {
        enteringMessageKeys.value = new Set();
        messageAnimationTimer = null;
      }, 200);
    }
  }
  await nextTick();
  if (!props.open || generation !== dialogGeneration) return;
  if (prepended) restoreTimelineAnchor(anchor);
  else if (shouldScroll) scrollToBottom();
  scrollOwnMessage = false;
});
onBeforeUnmount(() => { dialogGeneration++; previousFocus = null; stopDialogEffects(); });
</script>

<template>
  <Teleport to="body" :disabled="!isMobileLayout">
    <Transition name="document-chat" @after-leave="finishClose">
    <div v-if="open" ref="panel" class="document-chat-backdrop" :class="{ 'document-chat-backdrop--resizing': chatResize.isResizing.value }"
      :style="[viewportStyle, chatResize.panelStyle.value]"
      @wheel.stop @pointerdown.stop @pointermove.stop @pointerup.stop @keydown.stop>
      <section id="resource-document-chat-dialog" ref="dialog" class="document-chat" :class="{ 'document-chat--choosing-sticker': isStickerPickerOpen }"
        :role="isMobileLayout ? 'dialog' : 'complementary'"
        :aria-modal="isMobileLayout ? true : undefined" aria-labelledby="resource-document-chat-title" data-image-shortcuts="off" tabindex="-1">
        <div v-if="!isMobileLayout" class="document-chat__resize-handle" role="separator" aria-label="Resize document chat"
          aria-orientation="vertical" aria-controls="resource-document-chat-dialog" tabindex="0"
          :aria-valuenow="Math.round(chatResize.width.value)" :aria-valuemin="Math.round(chatResize.bounds.value.minimum)"
          :aria-valuemax="Math.round(chatResize.bounds.value.maximum)" :aria-valuetext="`${Math.round(chatResize.width.value)} pixels wide`"
          title="Drag to resize chat. Double-click to reset."
          @pointerdown.stop="chatResize.startDrag" @pointermove.stop="chatResize.moveDrag"
          @pointerup.stop="chatResize.endDrag" @pointercancel.stop="chatResize.endDrag"
          @lostpointercapture.stop="chatResize.endDrag" @keydown="chatResize.handleKeydown" @dblclick="chatResize.reset" />
        <header class="document-chat__header">
          <MessageSquareText :size="22" aria-hidden="true" class="document-chat__header-icon" />
          <div class="document-chat__identity">
            <h2 id="resource-document-chat-title">{{ documentName }}</h2>
            <p>Document chat</p>
          </div>
          <span class="document-chat__participants" :aria-label="`${participantsCount} people in this document`">
            <UsersRound :size="18" aria-hidden="true" /> {{ participantsCount }}
          </span>
          <button ref="closeButton" class="document-chat__icon-button" type="button" aria-label="Close document chat" @click="emit('close')">
            <X :size="22" aria-hidden="true" />
          </button>
        </header>

        <div ref="timeline" class="document-chat__timeline" role="log" aria-label="Document messages"
          aria-live="polite" aria-relevant="additions" :aria-busy="loading" @scroll="updateScrollPosition">
          <button v-if="hasOlder" class="document-chat__older" type="button" :disabled="loading" @click="loadOlder">
            {{ loading ? 'Loading messages…' : 'Load earlier messages' }}
          </button>
          <p v-if="loading && !messages.length" class="document-chat__notice" role="status">Loading messages…</p>
          <div v-else-if="!messages.length && !error" class="document-chat__empty">
            <MessageSquareText :size="32" aria-hidden="true" />
            <p>A conversation for this document.</p>
            <span>Send the first message.</span>
          </div>
          <template v-for="(group, groupIndex) in groups" :key="group.key">
            <div v-if="groupIndex === 0 || groups[groupIndex - 1]?.day !== group.day" class="document-chat__date">
              <span>{{ dayLabel(group.messages[0]!.created_at) }}</span>
            </div>
            <article class="document-chat__group">
              <span class="document-chat__avatar" aria-hidden="true">
                <svg v-if="validatedDocumentChatAvatar(group.messages[0]!.author.avatar_pixel_art)"
                  :viewBox="`0 0 ${group.messages[0]!.author.avatar_pixel_art!.size} ${group.messages[0]!.author.avatar_pixel_art!.size}`" shape-rendering="crispEdges">
                  <rect v-for="(pixel, pixelIndex) in group.messages[0]!.author.avatar_pixel_art!.pixels" :key="pixelIndex"
                    v-show="pixel" :x="pixelIndex % group.messages[0]!.author.avatar_pixel_art!.size"
                    :y="Math.floor(pixelIndex / group.messages[0]!.author.avatar_pixel_art!.size)" width="1" height="1" :fill="pixel || 'transparent'" />
                </svg>
                <img v-else-if="canShowImageAvatar(group.messages[0]!.author)" :src="group.messages[0]!.author.avatar_url || ''"
                  alt="" draggable="false" referrerpolicy="no-referrer" @error="markAvatarFailed(group.messages[0]!.author)" />
                <span v-else>{{ initials(group.messages[0]!.author) }}</span>
              </span>
              <div class="document-chat__content">
                <div class="document-chat__author-line">
                  <span class="document-chat__author">{{ displayName(group.messages[0]!.author) }}</span>
                  <span v-if="group.messages[0]!.author.id === currentUserId" class="document-chat__you">You</span>
                  <time :datetime="group.messages[0]!.created_at" :title="new Date(group.messages[0]!.created_at).toLocaleString()">{{ timeLabel(group.messages[0]!.created_at) }}</time>
                </div>
                <div v-for="message in group.messages" :key="`${message.author.id}:${message.client_message_id}`" class="document-chat__message"
                  :data-message-key="messageKey(message)"
                  :class="{ 'document-chat__message--pending': message.status === 'pending',
                    'document-chat__message--new': enteringMessageKeys.has(messageKey(message)) }">
                  <DocumentChatSticker v-if="getDocumentChatSticker(message.sticker_id)"
                    :sticker="getDocumentChatSticker(message.sticker_id)!" class="document-chat__sticker" />
                  <p v-else-if="message.sticker_id" class="document-chat__unavailable-sticker">Sticker unavailable</p>
                  <p v-else>{{ message.body }}</p>
                  <span v-if="message.status === 'pending'" class="document-chat__delivery" role="status">Sending…</span>
                  <div v-else-if="message.status === 'failed'" class="document-chat__failed" role="status">
                    <span>{{ message.error || 'Message not sent.' }}</span>
                    <button type="button" :disabled="accessDenied" @click="emit('retry', message.client_message_id)">Retry</button>
                  </div>
                </div>
              </div>
            </article>
          </template>
        </div>

        <div v-if="error || accessDenied" class="document-chat__error" role="status">
          <span>{{ accessDenied ? 'You no longer have access to this document.' : error }}</span>
          <button v-if="!accessDenied" type="button" :disabled="loading" @click="emit('reload')">Retry</button>
        </div>
        <Transition name="sticker-picker">
          <section v-if="isStickerPickerOpen" id="resource-document-chat-stickers" ref="stickerPicker"
            class="document-chat__sticker-picker" aria-labelledby="resource-document-chat-stickers-title">
            <header class="document-chat__sticker-picker-header">
              <h3 id="resource-document-chat-stickers-title">Pixel stickers</h3>
              <button class="document-chat__icon-button" type="button" aria-label="Close stickers" @click="closeStickerPicker(true)">
                <X :size="18" aria-hidden="true" />
              </button>
            </header>
            <div class="document-chat__sticker-grid">
              <button v-for="sticker in DOCUMENT_CHAT_STICKERS" :key="sticker.id" type="button" class="document-chat__sticker-option"
                :data-sticker-id="sticker.id" :aria-label="`Send ${sticker.label} sticker`" :title="sticker.label"
                :disabled="accessDenied || isComposing" @click="sendSticker(sticker.id)">
                <DocumentChatSticker :sticker="sticker" :size="64" preview />
              </button>
            </div>
          </section>
        </Transition>
        <form class="document-chat__composer" @submit.prevent="sendDraft">
          <label class="document-chat__sr-only" for="resource-document-chat-message">Message this document</label>
          <textarea id="resource-document-chat-message" ref="composer" v-model="draft" rows="1" maxlength="2000"
            placeholder="Message this document…" enterkeyhint="send" :disabled="accessDenied"
            @compositionstart="isComposing = true" @compositionend="isComposing = false; scheduleComposerResize()"
            @input="scheduleComposerResize" @keydown="handleComposerKeydown" />
          <button ref="stickerButton" class="document-chat__icon-button" type="button" aria-label="Choose a sticker"
            aria-controls="resource-document-chat-stickers" :aria-expanded="isStickerPickerOpen"
            :disabled="accessDenied || !currentUserId || isComposing" @click="toggleStickerPicker">
            <Sticker :size="21" aria-hidden="true" />
          </button>
          <button class="document-chat__icon-button" type="submit" :disabled="!canSend" aria-label="Send message"
            @pointerdown="keepComposerFocused">
            <SendHorizontal :size="22" aria-hidden="true" />
          </button>
        </form>
      </section>
    </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.document-chat-backdrop { position: relative; z-index: 6; display: flex; flex: 0 0 var(--document-chat-width, min(380px, 42vw)); width: var(--document-chat-width, min(380px, 42vw)); min-width: 0; min-height: 0; height: 100%; box-sizing: border-box; overscroll-behavior: contain; }
.document-chat__resize-handle { position: absolute; z-index: 2; inset: 0 auto 0 -4px; width: 9px; cursor: col-resize; touch-action: none; outline: none; }
.document-chat__resize-handle::after { position: absolute; inset: 0 auto 0 4px; width: 2px; content: ''; background: transparent; transition: background-color 140ms ease; }
.document-chat__resize-handle:focus-visible::after, .document-chat-backdrop--resizing .document-chat__resize-handle::after { background: var(--editor-focus, #ffffff); }
.document-chat { display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; overflow: hidden; box-sizing: border-box; border: 0; border-left: 1px solid var(--editor-border, #2b2b2b); background: var(--editor-panel, #111111); color: var(--editor-text, #f2f2f2); font-family: inherit; }
.document-chat-enter-active { transition: opacity 180ms ease-out; }
.document-chat-leave-active { transition: opacity 140ms ease-in; }
.document-chat-enter-active .document-chat { transition: transform 180ms cubic-bezier(0.2, 0.7, 0.3, 1); }
.document-chat-leave-active .document-chat { transition: transform 140ms ease-in; }
.document-chat-enter-from, .document-chat-leave-to { opacity: 0; }
.document-chat-enter-from .document-chat, .document-chat-leave-to .document-chat { transform: translateX(16px); }
.document-chat__header { display: flex; align-items: center; flex: 0 0 auto; gap: 12px; padding: 12px 12px 12px 20px; border-bottom: 1px solid var(--editor-border, #2b2b2b); }
.document-chat__header-icon { flex: 0 0 auto; }
.document-chat__identity { flex: 1 1 auto; min-width: 0; }
.document-chat__identity h2 { overflow: hidden; margin: 0; text-overflow: ellipsis; white-space: nowrap; font-size: 16px; font-weight: 700; line-height: 1.5; }
.document-chat__identity p { margin: 1px 0 0; color: var(--editor-muted, #b8b8b8); font-size: 12px; line-height: 1.5; }
.document-chat__participants { display: inline-flex; align-items: center; flex: 0 0 auto; gap: 5px; color: var(--editor-muted, #b8b8b8); font-size: 13px; font-variant-numeric: tabular-nums; }
.document-chat__icon-button { display: grid; place-items: center; flex: 0 0 44px; width: 44px; height: 44px; padding: 0; color: var(--editor-text, #f2f2f2); background: transparent; border: 0; border-radius: 6px; cursor: pointer; touch-action: manipulation; transition: background-color 140ms ease, opacity 100ms ease, transform 100ms ease; -webkit-tap-highlight-color: transparent; }
.document-chat__icon-button:active:not(:disabled) { opacity: 0.75; transform: scale(0.94); }
.document-chat__icon-button:disabled { opacity: 0.35; cursor: default; }
.document-chat button:focus-visible { outline: 2px solid var(--editor-focus, #ffffff); outline-offset: 2px; }
.document-chat__timeline { flex: 1 1 0%; min-height: 0; padding: 8px 20px 20px; overflow-x: hidden; overflow-y: auto; overflow-anchor: none; scroll-padding-block: 8px 20px; scrollbar-width: thin; scrollbar-color: var(--editor-border-strong, #666666) transparent; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
.document-chat__date { display: flex; align-items: center; gap: 10px; margin: 20px 0; color: var(--editor-quiet, #8a8a8a); font-size: 11px; line-height: 1.5; text-align: center; }
.document-chat__date::before, .document-chat__date::after { flex: 1; content: ''; border-top: 1px solid var(--editor-border, #2b2b2b); }
.document-chat__group { display: flex; align-items: flex-start; gap: 10px; margin-top: 18px; }
.document-chat__avatar { display: grid; place-items: center; flex: 0 0 32px; width: 32px; height: 32px; overflow: hidden; border-radius: 50%; background: var(--editor-surface, #1c1c1c); color: var(--editor-text, #f2f2f2); font-size: 11px; font-weight: 700; }
.document-chat__avatar svg, .document-chat__avatar img { display: block; width: 100%; height: 100%; object-fit: cover; }
.document-chat__content { flex: 1 1 auto; min-width: 0; }
.document-chat__author-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 7px; min-width: 0; margin-bottom: 3px; font-size: 11px; line-height: 1.5; }
.document-chat__author { min-width: 0; overflow-wrap: anywhere; font-size: 13px; font-weight: 650; }
.document-chat__you, .document-chat time { color: var(--editor-quiet, #8a8a8a); font-size: 10px; }
.document-chat__message p { margin: 0; color: var(--editor-text, #f2f2f2); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; line-height: 1.55; }
.document-chat__message + .document-chat__message { margin-top: 5px; }
.document-chat__sticker { margin-block: 6px; }
.document-chat__message .document-chat__unavailable-sticker { color: var(--editor-quiet, #8a8a8a); font-style: italic; }
.document-chat__message--new { animation: document-chat-message-enter 160ms ease-out both; }
@keyframes document-chat-message-enter {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
.document-chat__message--pending p, .document-chat__message--pending .document-chat__sticker { opacity: 0.6; }
.document-chat__delivery { color: var(--editor-muted, #b8b8b8); font-size: 11px; }
.document-chat__failed { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--editor-muted, #b8b8b8); font-size: 11px; }
.document-chat__failed button, .document-chat__error button { min-width: 44px; min-height: 44px; padding: 4px 8px; color: var(--editor-text, #f2f2f2); border: 0; border-radius: 5px; background: transparent; text-decoration: underline; font-family: inherit; cursor: pointer; touch-action: manipulation; transition: background-color 140ms ease, opacity 100ms ease; -webkit-tap-highlight-color: transparent; }
.document-chat__failed button:active:not(:disabled), .document-chat__error button:active:not(:disabled), .document-chat__older:active:not(:disabled) { opacity: 0.7; }
.document-chat__failed button:disabled { opacity: 0.4; cursor: default; }
.document-chat__older { display: block; min-height: 44px; margin: 4px auto 0; padding: 6px 10px; color: var(--editor-muted, #b8b8b8); background: transparent; border: 0; border-radius: 5px; font-family: inherit; font-size: 12px; cursor: pointer; touch-action: manipulation; transition: background-color 140ms ease, opacity 100ms ease; -webkit-tap-highlight-color: transparent; }
.document-chat__notice { color: var(--editor-muted, #b8b8b8); font-size: 13px; text-align: center; }
.document-chat__empty { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100%; box-sizing: border-box; gap: 10px; padding: 24px 0; color: var(--editor-muted, #b8b8b8); text-align: center; }
.document-chat__empty p { margin: 0; color: var(--editor-text, #f2f2f2); font-size: 14px; }
.document-chat__empty span { font-size: 12px; }
.document-chat__error { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 20px; border-top: 1px solid var(--editor-border, #2b2b2b); color: var(--editor-muted, #b8b8b8); font-size: 12px; overflow-wrap: anywhere; }
.document-chat__composer { display: flex; align-items: flex-end; flex: 0 0 auto; gap: 2px; margin: 0 12px 12px; padding: 4px 4px 4px 10px; background: var(--editor-surface, #1c1c1c); border: 1px solid transparent; border-radius: 8px; transition: border-color 140ms ease; }
.document-chat__composer:focus-within { border-color: var(--editor-border-strong, #666666); }
.document-chat__composer textarea { display: block; flex: 1 1 auto; width: 0; min-width: 0; min-height: 44px; max-height: clamp(44px, calc(var(--document-info-viewport-height, 100dvh) * 0.3), 120px); padding: 11px 4px; resize: none; box-sizing: border-box; overflow-y: auto; color: var(--editor-text, #f2f2f2); background: transparent; border: 0; border-radius: 4px; outline: none; box-shadow: none; font-family: inherit; font-size: 16px; line-height: 22px; overscroll-behavior: contain; }
.document-chat__composer textarea:focus-visible { outline: none; box-shadow: none; }
.document-chat__composer textarea::placeholder { color: var(--editor-quiet, #8a8a8a); }
.document-chat__composer textarea:disabled { opacity: 0.5; }
.document-chat__sticker-picker { display: flex; flex-direction: column; flex: 0 1 auto; min-height: 0; height: min(280px, calc(var(--document-info-viewport-height, 100dvh) * 0.45)); margin: 0 12px 10px; overflow: hidden; border: 1px solid var(--editor-border, #2b2b2b); border-radius: 8px; background: var(--editor-surface, #1c1c1c); }
.document-chat__sticker-picker-header { display: flex; align-items: center; justify-content: space-between; flex: 0 0 auto; padding-left: 12px; border-bottom: 1px solid var(--editor-border, #2b2b2b); }
.document-chat__sticker-picker-header h3 { margin: 0; color: var(--editor-muted, #b8b8b8); font-size: 12px; font-weight: 600; }
.document-chat__sticker-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(72px, 1fr)); align-content: start; flex: 1 1 0%; min-height: 0; gap: 4px; padding: 8px; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--editor-border-strong, #666666) transparent; }
.document-chat__sticker-option { display: grid; place-items: center; min-width: 0; min-height: 72px; padding: 4px; border: 0; border-radius: 6px; background: transparent; cursor: pointer; touch-action: manipulation; -webkit-tap-highlight-color: transparent; transition: background-color 140ms ease, transform 100ms ease; }
.document-chat__sticker-option:active:not(:disabled) { background: var(--editor-hover, #242424); transform: scale(0.94); }
.document-chat__sticker-option:disabled { opacity: 0.4; cursor: default; }
.sticker-picker-enter-active, .sticker-picker-leave-active { transition: opacity 120ms ease, transform 120ms ease; }
.sticker-picker-enter-from, .sticker-picker-leave-to { opacity: 0; transform: translateY(6px); }
.document-chat__sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (hover: hover) and (pointer: fine) {
  .document-chat__resize-handle:hover::after { background: var(--editor-border-strong, #666666); }
  .document-chat__icon-button:hover:not(:disabled), .document-chat__older:hover:not(:disabled),
  .document-chat__failed button:hover:not(:disabled), .document-chat__error button:hover:not(:disabled),
  .document-chat__sticker-option:hover:not(:disabled) { background: var(--editor-hover, #242424); }
}
@media (max-width: 600px), (max-width: 960px) and (max-height: 500px) and (pointer: coarse) {
  .document-chat-backdrop { position: fixed; z-index: 300; inset: var(--document-info-viewport-top, 0px) 0 auto; width: 100%; height: var(--document-info-viewport-height, 100dvh); background: var(--editor-panel, #111111); }
  .document-chat { width: 100%; height: 100%; max-height: none; border: 0; border-radius: 0; }
  .document-chat-enter-from .document-chat, .document-chat-leave-to .document-chat { transform: translateY(12px); }
  .document-chat__header { gap: 10px; padding: calc(8px + env(safe-area-inset-top, 0px)) max(8px, env(safe-area-inset-right, 0px)) 8px max(16px, env(safe-area-inset-left, 0px)); }
  .document-chat__timeline { padding-inline: max(16px, env(safe-area-inset-left, 0px)) max(16px, env(safe-area-inset-right, 0px)); }
  .document-chat__composer { margin: 0 max(12px, env(safe-area-inset-right, 0px)) max(12px, env(safe-area-inset-bottom, 0px)) max(12px, env(safe-area-inset-left, 0px)); }
  .document-chat__sticker-picker { height: min(288px, calc(var(--document-info-viewport-height, 100dvh) * 0.45)); margin-inline: max(12px, env(safe-area-inset-left, 0px)) max(12px, env(safe-area-inset-right, 0px)); }
  .document-chat--choosing-sticker .document-chat__timeline { padding-top: clamp(0px, calc(var(--document-info-viewport-height, 100dvh) - 360px), 8px); padding-bottom: clamp(0px, calc(var(--document-info-viewport-height, 100dvh) - 360px), 20px); }
  .document-chat__sticker-grid { padding-block: clamp(4px, calc(var(--document-info-viewport-height, 100dvh) - 360px), 8px); }
  .document-chat__error { padding-inline: max(16px, env(safe-area-inset-left, 0px)) max(16px, env(safe-area-inset-right, 0px)); }
}
@media (prefers-reduced-motion: reduce) {
  .document-chat__resize-handle::after { transition: none; }
  .document-chat-enter-active, .document-chat-leave-active,
  .document-chat-enter-active .document-chat, .document-chat-leave-active .document-chat,
  .document-chat__icon-button, .document-chat__older, .document-chat__failed button,
  .document-chat__error button, .document-chat__composer, .document-chat__sticker-option,
  .sticker-picker-enter-active, .sticker-picker-leave-active { transition: none; }
  .document-chat-enter-from .document-chat, .document-chat-leave-to .document-chat,
  .document-chat__icon-button:active:not(:disabled), .document-chat__sticker-option:active:not(:disabled),
  .sticker-picker-enter-from, .sticker-picker-leave-to { transform: none; }
  .document-chat__message--new { animation: none; }
}
</style>
