<script setup lang="ts">
import { MessageSquareText, SendHorizontal, UsersRound, X } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";

import type { DocumentChatAuthor } from "../../../lib/api";
import type { DocumentChatMessage } from "../composables/useDocumentChat";
import { useDocumentChatViewport } from "../composables/useDocumentChatViewport";
import { groupDocumentChatMessages, validatedDocumentChatAvatar } from "../lib/documentChatPresentation";

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
  retry: [clientMessageId: string];
  loadOlder: [];
  reload: [];
}>();
const dialog = ref<HTMLElement | null>(null);
const timeline = ref<HTMLElement | null>(null);
const composer = ref<HTMLTextAreaElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
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
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (props.open) emit("close");
  } else if (event.key === "Tab") {
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
  if (dialogEffectsActive && event.target instanceof Node && !dialog.value?.contains(event.target)) {
    closeButton.value?.focus({ preventScroll: true });
  }
}
const stopDialogEffects = () => {
  if (typeof window === "undefined") return;
  dialogEffectsActive = false;
  window.removeEventListener("keydown", handleModalKeydown, true);
  document.removeEventListener("focusin", handleModalFocus, true);
  stopViewport();
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
    if (target?.isConnected) target.focus({ preventScroll: true });
  }
};

watch(() => props.open, async (open) => {
  if (typeof window === "undefined") return;
  const generation = ++dialogGeneration;
  if (!open) {
    composer.value?.blur();
    isComposing.value = false;
    return;
  }
  if (!dialogEffectsActive) {
    if (!previousFocus?.isConnected) {
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogEffectsActive = true;
    window.addEventListener("keydown", handleModalKeydown, true);
    document.addEventListener("focusin", handleModalFocus, true);
  }
  nearBottom = true;
  scrollOwnMessage = false;
  renderedMessageKeys = props.messages.map(messageKey);
  startViewport();
  await nextTick();
  if (!props.open || generation !== dialogGeneration) return;
  scrollToBottom();
  resizeComposer();
  // Avoid opening the virtual keyboard before the user chooses to write.
  (isMobileLayout.value ? closeButton.value : composer.value)?.focus({ preventScroll: true });
}, { immediate: true });

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
  <Teleport to="body">
    <Transition name="document-chat" @after-leave="finishClose">
    <div v-if="open" class="document-chat-backdrop" :style="viewportStyle" @click.self="emit('close')"
      @wheel.stop @pointerdown.stop @pointermove.stop @pointerup.stop @keydown.stop>
      <section id="resource-document-chat-dialog" ref="dialog" class="document-chat" role="dialog"
        aria-modal="true" aria-labelledby="resource-document-chat-title" data-image-shortcuts="off" tabindex="-1">
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
                  <p>{{ message.body }}</p>
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
        <form class="document-chat__composer" @submit.prevent="sendDraft">
          <label class="document-chat__sr-only" for="resource-document-chat-message">Message this document</label>
          <textarea id="resource-document-chat-message" ref="composer" v-model="draft" rows="1" maxlength="2000"
            placeholder="Message this document…" enterkeyhint="send" :disabled="accessDenied"
            @compositionstart="isComposing = true" @compositionend="isComposing = false; scheduleComposerResize()"
            @input="scheduleComposerResize" @keydown="handleComposerKeydown" />
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
.document-chat-backdrop { position: fixed; z-index: 300; inset: 0; display: grid; place-items: center; padding: 20px; box-sizing: border-box; background: rgb(0 0 0 / 64%); overscroll-behavior: contain; }
.document-chat { display: flex; flex-direction: column; width: min(100%, 520px); height: min(620px, calc(var(--document-info-viewport-height, 100dvh) - 40px)); min-height: 0; overflow: hidden; box-sizing: border-box; border: 1px solid #353638; border-radius: 14px; background: #17181a; color: #fff; font-family: inherit; }
.document-chat-enter-active { transition: opacity 180ms ease-out; }
.document-chat-leave-active { transition: opacity 140ms ease-in; }
.document-chat-enter-active .document-chat { transition: transform 180ms cubic-bezier(0.2, 0.7, 0.3, 1); }
.document-chat-leave-active .document-chat { transition: transform 140ms ease-in; }
.document-chat-enter-from, .document-chat-leave-to { opacity: 0; }
.document-chat-enter-from .document-chat, .document-chat-leave-to .document-chat { transform: translateY(8px) scale(0.985); }
.document-chat__header { display: flex; align-items: center; flex: 0 0 auto; gap: 12px; padding: 12px 12px 12px 20px; border-bottom: 1px solid #303134; }
.document-chat__header-icon { flex: 0 0 auto; }
.document-chat__identity { flex: 1 1 auto; min-width: 0; }
.document-chat__identity h2 { overflow: hidden; margin: 0; text-overflow: ellipsis; white-space: nowrap; font-size: 16px; font-weight: 700; line-height: 1.5; }
.document-chat__identity p { margin: 1px 0 0; color: #a9adb2; font-size: 12px; line-height: 1.5; }
.document-chat__participants { display: inline-flex; align-items: center; flex: 0 0 auto; gap: 5px; color: #c0c3c7; font-size: 13px; font-variant-numeric: tabular-nums; }
.document-chat__icon-button { display: grid; place-items: center; flex: 0 0 44px; width: 44px; height: 44px; padding: 0; color: #fff; background: transparent; border: 0; border-radius: 6px; cursor: pointer; touch-action: manipulation; transition: background-color 140ms ease, opacity 100ms ease, transform 100ms ease; -webkit-tap-highlight-color: transparent; }
.document-chat__icon-button:active:not(:disabled) { opacity: 0.75; transform: scale(0.94); }
.document-chat__icon-button:disabled { opacity: 0.35; cursor: default; }
.document-chat button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.document-chat__timeline { flex: 1 1 auto; min-height: 0; padding: 8px 20px 20px; overflow-x: hidden; overflow-y: auto; overflow-anchor: none; scroll-padding-block: 8px 20px; scrollbar-width: thin; scrollbar-color: #484a4e transparent; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
.document-chat__date { display: flex; align-items: center; gap: 10px; margin: 20px 0; color: #93979e; font-size: 11px; line-height: 1.5; text-align: center; }
.document-chat__date::before, .document-chat__date::after { flex: 1; content: ''; border-top: 1px solid #303134; }
.document-chat__group { display: flex; align-items: flex-start; gap: 10px; margin-top: 18px; }
.document-chat__avatar { display: grid; place-items: center; flex: 0 0 32px; width: 32px; height: 32px; overflow: hidden; border-radius: 50%; background: #383a3e; color: #fff; font-size: 11px; font-weight: 700; }
.document-chat__avatar svg, .document-chat__avatar img { display: block; width: 100%; height: 100%; object-fit: cover; }
.document-chat__content { flex: 1 1 auto; min-width: 0; }
.document-chat__author-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 7px; min-width: 0; margin-bottom: 3px; font-size: 11px; line-height: 1.5; }
.document-chat__author { min-width: 0; overflow-wrap: anywhere; font-size: 13px; font-weight: 650; }
.document-chat__you, .document-chat time { color: #989da5; font-size: 10px; }
.document-chat__message p { margin: 0; color: #e7e8eb; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; line-height: 1.55; }
.document-chat__message + .document-chat__message { margin-top: 5px; }
.document-chat__message--new { animation: document-chat-message-enter 160ms ease-out both; }
@keyframes document-chat-message-enter {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
.document-chat__message--pending p { opacity: 0.6; }
.document-chat__delivery { color: #a9adb2; font-size: 11px; }
.document-chat__failed { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: #c1c4ca; font-size: 11px; }
.document-chat__failed button, .document-chat__error button { min-width: 44px; min-height: 44px; padding: 4px 8px; color: #fff; border: 0; border-radius: 5px; background: transparent; text-decoration: underline; font-family: inherit; cursor: pointer; touch-action: manipulation; transition: background-color 140ms ease, opacity 100ms ease; -webkit-tap-highlight-color: transparent; }
.document-chat__failed button:active:not(:disabled), .document-chat__error button:active:not(:disabled), .document-chat__older:active:not(:disabled) { opacity: 0.7; }
.document-chat__failed button:disabled { opacity: 0.4; cursor: default; }
.document-chat__older { display: block; min-height: 44px; margin: 4px auto 0; padding: 6px 10px; color: #c1c4ca; background: transparent; border: 0; border-radius: 5px; font-family: inherit; font-size: 12px; cursor: pointer; touch-action: manipulation; transition: background-color 140ms ease, opacity 100ms ease; -webkit-tap-highlight-color: transparent; }
.document-chat__notice { color: #a9adb2; font-size: 13px; text-align: center; }
.document-chat__empty { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100%; box-sizing: border-box; gap: 10px; padding: 24px 0; color: #a9adb2; text-align: center; }
.document-chat__empty p { margin: 0; color: #e7e8eb; font-size: 14px; }
.document-chat__empty span { font-size: 12px; }
.document-chat__error { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 20px; border-top: 1px solid #303134; color: #c1c4ca; font-size: 12px; overflow-wrap: anywhere; }
.document-chat__composer { display: flex; align-items: flex-end; flex: 0 0 auto; gap: 4px; margin: 0 16px 16px; padding: 4px 4px 4px 10px; background: #25272b; border: 1px solid transparent; border-radius: 8px; transition: border-color 140ms ease; }
.document-chat__composer:focus-within { border-color: #989da5; }
.document-chat__composer textarea { display: block; flex: 1 1 auto; width: 0; min-width: 0; min-height: 44px; max-height: clamp(44px, calc(var(--document-info-viewport-height, 100dvh) * 0.3), 120px); padding: 11px 4px; resize: none; box-sizing: border-box; overflow-y: auto; color: #fff; background: transparent; border: 0; border-radius: 4px; outline: none; box-shadow: none; font-family: inherit; font-size: 16px; line-height: 22px; overscroll-behavior: contain; }
.document-chat__composer textarea:focus-visible { outline: none; box-shadow: none; }
.document-chat__composer textarea::placeholder { color: #969ba3; }
.document-chat__composer textarea:disabled { opacity: 0.5; }
.document-chat__sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (hover: hover) and (pointer: fine) {
  .document-chat__icon-button:hover:not(:disabled), .document-chat__older:hover:not(:disabled),
  .document-chat__failed button:hover:not(:disabled), .document-chat__error button:hover:not(:disabled) { background: #303135; }
}
@media (max-width: 600px), (max-width: 960px) and (max-height: 500px) {
  .document-chat-backdrop { top: var(--document-info-viewport-top, 0px); bottom: auto; height: var(--document-info-viewport-height, 100dvh); padding: 0; background: #17181a; }
  .document-chat { width: 100%; height: 100%; max-height: none; border: 0; border-radius: 0; }
  .document-chat-enter-from .document-chat, .document-chat-leave-to .document-chat { transform: translateY(12px); }
  .document-chat__header { gap: 10px; padding: calc(8px + env(safe-area-inset-top, 0px)) max(8px, env(safe-area-inset-right, 0px)) 8px max(16px, env(safe-area-inset-left, 0px)); }
  .document-chat__timeline { padding-inline: max(16px, env(safe-area-inset-left, 0px)) max(16px, env(safe-area-inset-right, 0px)); }
  .document-chat__composer { margin: 0 max(12px, env(safe-area-inset-right, 0px)) max(12px, env(safe-area-inset-bottom, 0px)) max(12px, env(safe-area-inset-left, 0px)); }
  .document-chat__error { padding-inline: max(16px, env(safe-area-inset-left, 0px)) max(16px, env(safe-area-inset-right, 0px)); }
}
@media (prefers-reduced-motion: reduce) {
  .document-chat-enter-active, .document-chat-leave-active,
  .document-chat-enter-active .document-chat, .document-chat-leave-active .document-chat,
  .document-chat__icon-button, .document-chat__older, .document-chat__failed button,
  .document-chat__error button, .document-chat__composer { transition: none; }
  .document-chat-enter-from .document-chat, .document-chat-leave-to .document-chat,
  .document-chat__icon-button:active:not(:disabled) { transform: none; }
  .document-chat__message--new { animation: none; }
}
</style>
