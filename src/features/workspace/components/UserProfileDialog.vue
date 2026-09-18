<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { patchCurrentUser, type PixelAvatarData, type UserPublic } from "../../../lib/api";
import { clearClientSession } from "../../../lib/session";
import PixelArtEditor from "../../pixel-art/components/PixelArtEditor.vue";
import {
  PIXEL_ART_CORAL,
  PIXEL_ART_GOLD,
  PIXEL_ART_PALETTE,
  PIXEL_ART_WHITE,
} from "../../pixel-art/lib/palette";

const AVATAR_SIZE = 16;
const palette = PIXEL_ART_PALETTE;

const props = defineProps<{
  open: boolean;
  userName?: string;
  userUsername?: string | null;
  userEmail?: string;
  userAvatarUrl?: string;
  userPixelAvatar?: PixelAvatarData | null;
}>();

const emit = defineEmits<{
  close: [];
  saved: [user: UserPublic];
}>();

const username = ref("");
const pixels = ref<Array<string | null>>([]);
const isSaving = ref(false);
const statusMessage = ref("");
const avatarMode = ref<"google" | "pixel">("google");
const activeMobilePanel = ref<"profile" | "avatar">("profile");
const showLogoutConfirm = ref(false);
const showUnsavedConfirm = ref(false);
const isLoggingOut = ref(false);
const initialUsername = ref("");
const initialAvatarMode = ref<"google" | "pixel">("google");
const initialPixelsKey = ref("");

const currentProfileName = computed(
  () => username.value.trim() || props.userUsername || props.userName || props.userEmail || "User",
);

const pixelAvatarJson = computed<PixelAvatarData>(() => ({
  version: 1,
  size: AVATAR_SIZE,
  palette,
  pixels: [...pixels.value],
}));

const hasGoogleAvatar = computed(() => Boolean(props.userAvatarUrl?.trim()));
const usernameError = computed(() => {
  const value = username.value.trim();
  if (Array.from(value).length < 3 || Array.from(value).length > 40) {
    return "Username must be between 3 and 40 characters.";
  }
  if (!/^[\p{L}\p{N}_.-]+$/u.test(value)) {
    return "Use only letters, numbers, dots (.), hyphens (-) and underscores (_). Spaces and other symbols are not allowed.";
  }
  if (!/[\p{L}\p{N}]/u.test(value)) {
    return "Username must include at least one letter or number.";
  }
  return "";
});
const canSave = computed(() => !usernameError.value && !isSaving.value);
const pixelsKey = (items: Array<string | null>) => items.map((pixel) => pixel || "").join("|");
const hasUnsavedChanges = computed(
  () =>
    username.value.trim() !== initialUsername.value ||
    avatarMode.value !== initialAvatarMode.value ||
    pixelsKey(pixels.value) !== initialPixelsKey.value,
);

const createEmptyPixels = () => Array<string | null>(AVATAR_SIZE * AVATAR_SIZE).fill(null);

const createStarterPixels = () => {
  const draft = createEmptyPixels();
  const draw = (row: number, column: number, color: string) => {
    draft[row * AVATAR_SIZE + column] = color;
  };

  for (let index = 4; index < 12; index += 1) {
    draw(4, index, PIXEL_ART_WHITE);
    draw(11, index, PIXEL_ART_WHITE);
  }

  for (let index = 5; index < 11; index += 1) {
    draw(index, 4, PIXEL_ART_WHITE);
    draw(index, 11, PIXEL_ART_CORAL);
  }

  draw(7, 7, PIXEL_ART_GOLD);
  draw(7, 8, PIXEL_ART_GOLD);
  draw(8, 7, PIXEL_ART_GOLD);
  draw(8, 8, PIXEL_ART_GOLD);
  return draft;
};

const normalizePixels = (avatar: PixelAvatarData | null | undefined) => {
  if (!avatar || !Array.isArray(avatar.pixels)) {
    return createStarterPixels();
  }

  return createEmptyPixels().map((_, index) => avatar.pixels[index] || null);
};

const resetForm = () => {
  username.value = props.userUsername || "";
  pixels.value = normalizePixels(props.userPixelAvatar);
  avatarMode.value = props.userPixelAvatar ? "pixel" : "google";
  initialUsername.value = username.value.trim();
  initialAvatarMode.value = avatarMode.value;
  initialPixelsKey.value = pixelsKey(pixels.value);
  activeMobilePanel.value = "profile";
  showLogoutConfirm.value = false;
  showUnsavedConfirm.value = false;
  isLoggingOut.value = false;
  statusMessage.value = "";
};

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      resetForm();
    }
  },
  { immediate: true },
);

watch(username, () => {
  statusMessage.value = "";
}, { flush: "sync" });

const requestLogout = () => {
  showLogoutConfirm.value = true;
};

const logOut = async () => {
  if (isLoggingOut.value) {
    return;
  }

  isLoggingOut.value = true;
  statusMessage.value = "";

  const didClearSession = await clearClientSession();
  if (!didClearSession) {
    statusMessage.value = "Could not log out. Check your connection and try again.";
    showLogoutConfirm.value = false;
    isLoggingOut.value = false;
    return;
  }

  window.location.assign("/login");
};

const markPixelAvatarEdited = () => {
  avatarMode.value = "pixel";
};

const useGoogleAvatar = () => {
  avatarMode.value = "google";
};

const requestClose = () => {
  if (isSaving.value) {
    return;
  }

  if (hasUnsavedChanges.value) {
    showUnsavedConfirm.value = true;
    return;
  }

  emit("close");
};

const discardUnsavedChanges = () => {
  showUnsavedConfirm.value = false;
  emit("close");
};

const saveProfile = async () => {
  if (isSaving.value) {
    return false;
  }
  if (usernameError.value) {
    statusMessage.value = usernameError.value;
    activeMobilePanel.value = "profile";
    showUnsavedConfirm.value = false;
    return false;
  }

  isSaving.value = true;
  statusMessage.value = "";

  try {
    const user = await patchCurrentUser({
      username: username.value.trim(),
      avatar_pixel_art: avatarMode.value === "pixel" ? pixelAvatarJson.value : null,
    });
    emit("saved", user);
    return true;
  } catch (error) {
    statusMessage.value =
      error instanceof Error ? error.message : "Could not update your profile.";
    activeMobilePanel.value = "profile";
    showUnsavedConfirm.value = false;
    return false;
  } finally {
    isSaving.value = false;
  }
};

const saveUnsavedChanges = async () => {
  await saveProfile();
};
</script>

<template>
  <div v-if="open" class="profile-dialog-layer" role="presentation">
    <section
      class="profile-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="profile-dialog-title"
      @click.stop
    >
      <header>
        <div>
          <h2 id="profile-dialog-title">Edit profile</h2>
        </div>
        <button type="button" aria-label="Close profile editor" @click="requestClose">
          <span aria-hidden="true"></span>
        </button>
      </header>

      <div class="profile-mobile-tabs" role="tablist" aria-label="Profile editor sections">
        <button
          type="button"
          role="tab"
          :aria-selected="activeMobilePanel === 'profile'"
          :class="{ 'is-active': activeMobilePanel === 'profile' }"
          @click="activeMobilePanel = 'profile'"
        >
          Profile
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="activeMobilePanel === 'avatar'"
          :class="{ 'is-active': activeMobilePanel === 'avatar' }"
          @click="activeMobilePanel = 'avatar'"
        >
          Avatar
        </button>
      </div>

      <div class="profile-dialog__content">
        <form
          class="profile-fields"
          :class="{ 'is-mobile-hidden': activeMobilePanel !== 'profile' }"
          @submit.prevent="saveProfile"
        >
          <label>
            <span id="profile-username-label">Username</span>
            <input
              v-model="username"
              autocomplete="username"
              autocapitalize="none"
              :spellcheck="false"
              maxlength="40"
              aria-labelledby="profile-username-label"
              aria-describedby="profile-username-hint profile-username-error"
              :aria-invalid="Boolean(usernameError)"
            />
            <small id="profile-username-hint" class="profile-field-hint">
              3–40 characters. Letters, numbers, dots (.), hyphens (-) and underscores (_).
            </small>
            <small
              id="profile-username-error"
              class="profile-field-error"
              aria-live="polite"
            >{{ usernameError }}</small>
          </label>

          <label>
            <span>Email</span>
            <input :value="userEmail" disabled />
          </label>

          <div class="profile-preview">
            <div class="profile-preview__avatar">
              <img
                v-if="avatarMode === 'google' && hasGoogleAvatar"
                :src="userAvatarUrl"
                :alt="`${currentProfileName} Google profile photo`"
                referrerpolicy="no-referrer"
              />
              <svg v-else class="pixel-preview" :viewBox="`0 0 ${AVATAR_SIZE} ${AVATAR_SIZE}`" shape-rendering="crispEdges" aria-hidden="true">
                <rect
                  v-for="(pixel, index) in pixels"
                  :key="`preview-${index}`"
                  :x="index % AVATAR_SIZE"
                  :y="Math.floor(index / AVATAR_SIZE)"
                  width="1"
                  height="1"
                  :fill="pixel && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(pixel) ? pixel : 'transparent'"
                />
              </svg>
            </div>
            <div>
              <strong>{{ currentProfileName }}</strong>
              <p>{{ avatarMode === "pixel" ? "Custom pixel avatar" : "Google profile photo" }}</p>
            </div>
          </div>

          <button
            v-if="hasGoogleAvatar"
            type="button"
            class="secondary-action profile-google-action"
            @click="useGoogleAvatar"
          >
            Use Google photo
          </button>

          <button
            type="button"
            class="secondary-action logout-action"
            @click="requestLogout"
          >
            Log out
          </button>

          <p v-if="statusMessage" class="profile-status" role="alert">{{ statusMessage }}</p>
        </form>

        <PixelArtEditor
          v-model:pixels="pixels"
          class="pixel-editor"
          :class="{ 'is-mobile-hidden': activeMobilePanel !== 'avatar' }"
          :palette="palette"
          aria-label="Pixel avatar editor"
          @changed="markPixelAvatarEdited"
        />
      </div>

      <footer class="profile-dialog__footer">
        <button type="button" class="secondary-action" @click="requestClose">
          Cancel
        </button>
        <button type="button" class="primary-action" :disabled="!canSave" @click="saveProfile">
          {{ isSaving ? "Saving..." : "Save profile" }}
        </button>
      </footer>

      <div
        v-if="showLogoutConfirm"
        class="logout-confirm-layer"
        role="presentation"
        @click.stop
      >
        <section
          class="logout-confirm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="logout-confirm-title"
        >
          <h3 id="logout-confirm-title">Log out?</h3>
          <p>You will return to the login screen and can choose another account.</p>
          <div class="logout-confirm__actions">
            <button
              type="button"
              class="secondary-action"
              :disabled="isLoggingOut"
              @click="showLogoutConfirm = false"
            >
              Cancel
            </button>
            <button
              type="button"
              class="danger-action"
              :disabled="isLoggingOut"
              @click="logOut"
            >
              {{ isLoggingOut ? "Logging out..." : "Log out" }}
            </button>
          </div>
        </section>
      </div>

      <div
        v-if="showUnsavedConfirm"
        class="unsaved-confirm-layer"
        role="presentation"
        @click.stop
      >
        <section
          class="unsaved-confirm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="profile-unsaved-title"
        >
          <p>Unsaved changes</p>
          <h3 id="profile-unsaved-title">Save profile changes?</h3>
          <span>These changes have not been saved.</span>
          <div class="unsaved-confirm__actions">
            <button
              type="button"
              class="secondary-action"
              :disabled="isSaving"
              @click="discardUnsavedChanges"
            >
              Discard changes
            </button>
            <button
              type="button"
              class="primary-action"
              :disabled="isSaving"
              @click="saveUnsavedChanges"
            >
              {{ isSaving ? "Saving..." : "Save changes" }}
            </button>
          </div>
        </section>
      </div>
    </section>
  </div>
</template>

<style scoped>
  .profile-dialog-layer {
    position: fixed;
    inset: 0;
    z-index: 80;
    display: grid;
    place-items: center;
    padding: 22px;
    background: rgba(2, 2, 2, 0.58);
    backdrop-filter: blur(12px);
  }

  .profile-dialog {
    position: relative;
    display: flex;
    flex-direction: column;
    width: min(920px, 100%);
    max-height: calc(100dvh - 44px);
    overflow: hidden;
    color: #f7f1e7;
    border: 1px solid rgba(255, 252, 244, 0.2);
    border-radius: 8px;
    background: rgba(16, 17, 17, 0.98);
    box-shadow: 0 26px 80px rgba(0, 0, 0, 0.52);
  }

  .profile-dialog header {
    display: flex;
    flex: 0 0 auto;
    align-items: flex-start;
    justify-content: space-between;
    padding: 20px 22px;
    border-bottom: 1px solid rgba(255, 252, 244, 0.13);
  }

  .profile-mobile-tabs {
    display: none;
  }

  .profile-dialog__footer {
    display: flex;
    flex: 0 0 auto;
    gap: 10px;
    justify-content: flex-end;
    padding: 16px 22px;
    border-top: 1px solid rgba(255, 252, 244, 0.1);
  }

  .profile-dialog h2,
  .profile-dialog h3 {
    margin: 0;
    letter-spacing: 0;
  }

  .profile-dialog h2 {
    font-size: 1.55rem;
  }

  .profile-dialog h3 {
    font-size: 1.05rem;
  }

  .profile-dialog header > button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 7px;
    cursor: pointer;
  }

  .profile-dialog header > button:hover {
    background: rgba(255, 252, 244, 0.08);
    border-color: rgba(255, 252, 244, 0.14);
  }

  .profile-dialog header > button span {
    position: relative;
    display: block;
    width: 16px;
    height: 16px;
  }

  .profile-dialog header > button span::before,
  .profile-dialog header > button span::after {
    position: absolute;
    top: 7px;
    left: 0;
    width: 16px;
    height: 2px;
    content: "";
    background: rgba(247, 241, 231, 0.72);
    border-radius: 999px;
  }

  .profile-dialog header > button span::before {
    transform: rotate(45deg);
  }

  .profile-dialog header > button span::after {
    transform: rotate(-45deg);
  }

  .profile-dialog__content {
    display: grid;
    flex: 1;
    min-height: 0;
    overflow: auto;
    grid-template-columns: minmax(250px, 330px) minmax(390px, 1fr);
    gap: 36px;
    align-items: start;
    padding: 22px 22px 24px;
  }

  .profile-fields,
  .pixel-editor {
    min-width: 0;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .profile-fields {
    display: grid;
    align-content: start;
    gap: 14px;
  }

  .profile-fields label {
    display: grid;
    gap: 8px;
  }

  .profile-fields label span {
    color: rgba(247, 241, 231, 0.62);
    font-size: 0.82rem;
  }

  .profile-fields input {
    width: 100%;
    height: 42px;
    padding: 0 12px;
    color: #f7f1e7;
    background: rgba(255, 252, 244, 0.055);
    border: 1px solid rgba(255, 252, 244, 0.18);
    border-radius: 8px;
    outline: 0;
  }

  .profile-fields input:focus {
    border-color: rgba(247, 241, 231, 0.72);
    box-shadow: 0 0 0 3px rgba(247, 241, 231, 0.1);
  }

  .profile-fields input:disabled {
    color: rgba(247, 241, 231, 0.52);
    cursor: not-allowed;
  }

  .profile-field-hint,
  .profile-field-error {
    font-size: 0.75rem;
    line-height: 1.45;
  }

  .profile-field-hint {
    color: rgba(247, 241, 231, 0.62);
  }

  .profile-field-error {
    color: #f0a18d;
  }

  .profile-field-error:empty {
    display: none;
  }

  .profile-fields input[aria-invalid="true"] {
    border-color: rgba(240, 161, 141, 0.65);
  }

  .profile-preview {
    display: flex;
    gap: 12px;
    align-items: center;
    padding: 12px;
    border: 1px solid rgba(255, 252, 244, 0.12);
    border-radius: 8px;
    background: rgba(255, 252, 244, 0.045);
  }

  .profile-preview__avatar {
    flex: 0 0 auto;
    width: 54px;
    height: 54px;
    overflow: hidden;
    border: 1px solid rgba(255, 252, 244, 0.18);
    border-radius: 999px;
    background: rgba(255, 252, 244, 0.06);
  }

  .profile-preview__avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .profile-preview > div:last-child {
    flex: 1;
    min-width: 0;
  }

  .profile-preview strong,
  .profile-preview p {
    display: block;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .profile-preview p {
    margin-top: 4px;
    color: rgba(247, 241, 231, 0.56);
    font-size: 0.8rem;
  }

  .profile-google-action {
    width: 100%;
  }

  .secondary-action.logout-action {
    width: 100%;
    margin-top: 4px;
    color: #f0a18d;
    border-color: rgba(240, 161, 141, 0.26);
  }

  .secondary-action.logout-action:hover {
    color: #ffd3c8;
    background: rgba(225, 132, 100, 0.08);
    border-color: rgba(240, 161, 141, 0.4);
  }

  .profile-status {
    margin: 0;
    padding: 10px 12px;
    color: #f0a18d;
    background: rgba(225, 132, 100, 0.08);
    border: 1px solid rgba(225, 132, 100, 0.18);
    border-radius: 8px;
  }

  .primary-action,
  .secondary-action,
  .danger-action {
    min-height: 38px;
    padding: 0 14px;
    border-radius: 8px;
    cursor: pointer;
  }

  .primary-action {
    color: #07100b;
    background: #f7f1e7;
    border: 1px solid transparent;
  }

  .primary-action:disabled {
    cursor: not-allowed;
    filter: grayscale(0.45);
    opacity: 0.6;
  }

  .secondary-action:disabled,
  .danger-action:disabled {
    cursor: not-allowed;
    opacity: 0.62;
  }

  .danger-action {
    color: #160604;
    background: #f0a18d;
    border: 1px solid transparent;
  }

  .danger-action:hover {
    background: #ffd3c8;
  }

  .secondary-action {
    color: #f7f1e7;
    background: rgba(255, 252, 244, 0.045);
    border: 1px solid rgba(255, 252, 244, 0.16);
  }

  .secondary-action:hover {
    background: rgba(255, 252, 244, 0.1);
  }

  .pixel-editor {
    display: grid;
    align-content: start;
    justify-self: center;
    width: min(100%, 430px);
    gap: 14px;
  }

  .pixel-preview {
    display: block;
    width: 100%;
    height: 100%;
    background: rgba(255, 252, 244, 0.045);
    image-rendering: pixelated;
  }

  .logout-confirm-layer,
  .unsaved-confirm-layer {
    position: absolute;
    inset: 0;
    z-index: 4;
    display: grid;
    place-items: center;
    padding: 22px;
    background: rgba(2, 2, 2, 0.64);
    backdrop-filter: blur(10px);
  }

  .logout-confirm,
  .unsaved-confirm {
    width: min(360px, 100%);
    padding: 20px;
    color: #f7f1e7;
    background: rgba(16, 17, 17, 0.98);
    border: 1px solid rgba(255, 252, 244, 0.18);
    border-radius: 8px;
    box-shadow: 0 20px 54px rgba(0, 0, 0, 0.48);
  }

  .logout-confirm h3 {
    margin: 0;
    font-size: 1.2rem;
  }

  .logout-confirm p,
  .unsaved-confirm span {
    margin: 10px 0 18px;
    color: rgba(247, 241, 231, 0.66);
    line-height: 1.45;
  }

  .unsaved-confirm p {
    margin: 0 0 8px;
    color: rgba(255, 176, 159, 0.76);
    font-size: 0.7rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    line-height: 1;
    text-transform: uppercase;
  }

  .unsaved-confirm h3 {
    margin: 0;
    font-size: 1.2rem;
  }

  .unsaved-confirm span {
    display: block;
  }

  .logout-confirm__actions,
  .unsaved-confirm__actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  @media (min-width: 521px) and (max-width: 900px) {
    .profile-dialog-layer {
      padding: 18px;
    }

    .profile-dialog {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      width: min(760px, 100%);
      max-height: calc(100dvh - 36px);
      overflow: hidden;
    }

    .profile-dialog header {
      padding: 18px 20px;
    }

    .profile-dialog__content {
      grid-template-columns: minmax(210px, 250px) minmax(0, 1fr);
      gap: 20px;
      min-height: 0;
      padding: 18px 20px;
      overflow: auto;
    }

    .profile-dialog__footer {
      padding: 12px 20px 16px;
    }

    .profile-fields {
      gap: 12px;
    }

    .profile-fields input {
      height: 40px;
    }

    .profile-preview {
      gap: 10px;
      padding: 10px;
    }

    .profile-preview__avatar {
      width: 46px;
      height: 46px;
    }

    .pixel-editor {
      --pixel-editor-max-width: 360px;
      --pixel-canvas-max-size: min(340px, calc(100dvh - 390px));

      gap: 12px;
    }

    .pixel-editor :deep(.shared-pixel-editor__toolbar) {
      justify-content: center;
    }

    .pixel-editor :deep(.shared-pixel-editor__actions) {
      width: 100%;
      justify-content: center;
    }

    .pixel-editor :deep(.shared-tool-button) {
      width: 38px;
      height: 38px;
      min-height: 38px;
    }

  }

  @media (max-width: 520px) {
    .profile-dialog-layer {
      display: block;
      padding: 0;
    }

    .profile-dialog {
      display: flex;
      flex-direction: column;
      width: 100%;
      min-height: 100dvh;
      max-height: 100dvh;
      border-width: 0;
      border-radius: 0;
    }

    .profile-dialog header {
      align-items: center;
      padding: 16px;
      border-bottom: 0;
    }

    .profile-dialog h2 {
      font-size: 1.35rem;
    }

    .profile-mobile-tabs {
      display: flex;
      gap: 22px;
      padding: 0 16px;
      border-bottom: 1px solid rgba(255, 252, 244, 0.12);
    }

    .profile-mobile-tabs button {
      position: relative;
      min-height: 44px;
      padding: 0 2px;
      color: rgba(247, 241, 231, 0.56);
      font-weight: 750;
      background: transparent;
      border: 0;
      cursor: pointer;
    }

    .profile-mobile-tabs button.is-active {
      color: #f7f1e7;
    }

    .profile-mobile-tabs button::after {
      position: absolute;
      right: 0;
      bottom: -1px;
      left: 0;
      height: 2px;
      content: "";
      background: transparent;
      border-radius: 999px;
    }

    .profile-mobile-tabs button.is-active::after {
      background: #f7f1e7;
    }

    .profile-dialog__content {
      display: block;
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: 14px 16px;
    }

    .profile-fields.is-mobile-hidden,
    .pixel-editor.is-mobile-hidden {
      display: none;
    }

    .pixel-editor:not(.is-mobile-hidden) {
      --pixel-canvas-max-size: min(390px, calc(100dvh - 390px));

      align-content: start;
      padding-bottom: 4px;
    }

    .profile-dialog__footer {
      display: grid;
      grid-template-columns: 1fr 1fr;
      flex: 0 0 auto;
      margin-top: auto;
      padding: 12px 16px 16px;
      border-top: 1px solid rgba(255, 252, 244, 0.12);
      background: rgba(16, 17, 17, 0.96);
      backdrop-filter: blur(12px);
    }

    .profile-dialog__footer button {
      width: 100%;
    }
  }

  @media (max-width: 380px), (max-height: 700px) {
    .profile-dialog header {
      padding: 12px 14px;
    }

    .profile-dialog h2 {
      font-size: 1.22rem;
    }

    .profile-mobile-tabs {
      gap: 18px;
      padding: 0 14px;
    }

    .profile-mobile-tabs button {
      min-height: 40px;
    }

    .profile-dialog__content {
      padding: 12px 14px;
    }

    .pixel-editor:not(.is-mobile-hidden) {
      --pixel-canvas-max-size: min(390px, calc(100dvh - 350px));
    }

    .profile-dialog__footer {
      gap: 8px;
      padding: 10px 14px 12px;
    }
  }

  @media (max-width: 340px), (max-height: 620px) {
    .pixel-editor:not(.is-mobile-hidden) {
      --pixel-canvas-max-size: min(390px, calc(100dvh - 342px));
    }
  }
</style>
