<script setup lang="ts">
import { computed, ref, watch } from "vue";

import type { PixelAvatarData } from "../../../lib/api";
import PulsarLogo from "../../auth/components/PulsarLogo.vue";

type TopbarMode = "projects" | "project";

const props = withDefaults(
  defineProps<{
    mode?: TopbarMode;
    brandInteractive?: boolean;
    brandAriaLabel?: string;
    brandTrail?: string;
    brandTrailPixelArt?: PixelAvatarData | null;
    brandTrailLoading?: boolean;
    brandTrailInteractive?: boolean;
    brandTrailAriaLabel?: string;
    userInteractive?: boolean;
    userName?: string;
    userUsername?: string | null;
    userEmail?: string;
    userAvatarUrl?: string;
    userPixelAvatar?: PixelAvatarData | null;
    userLabel?: string;
    centerMaxWidth?: string;
  }>(),
  {
    mode: "projects",
    brandInteractive: false,
    brandAriaLabel: "Sefkira Studio",
    brandTrail: "",
    brandTrailPixelArt: null,
    brandTrailLoading: false,
    brandTrailInteractive: false,
    brandTrailAriaLabel: "Current project",
    userInteractive: false,
    userName: "",
    userUsername: null,
    userEmail: "",
    userAvatarUrl: "",
    userPixelAvatar: null,
    userLabel: "",
    centerMaxWidth: "min(660px, 42vw)",
  },
);

const emit = defineEmits<{
  "brand-click": [];
  "brand-trail-click": [];
  "user-click": [];
}>();

const hasAvatarLoadError = ref(false);

const topbarStyle = computed(() => ({
  "--studio-topbar-center-max": props.centerMaxWidth,
}));

const brandTrailText = computed(() => props.brandTrail.trim());
const canShowBrandTrailPixelArt = computed(() =>
  Boolean(props.brandTrailPixelArt?.pixels?.some((pixel) => pixel)),
);
const shouldShowBrandTrail = computed(
  () => Boolean(brandTrailText.value) || props.brandTrailLoading,
);
const brandTrailLabel = computed(() => brandTrailText.value || "Loading project");
const canInteractWithBrandTrail = computed(
  () => props.brandTrailInteractive && !props.brandTrailLoading && Boolean(brandTrailText.value),
);
const userAvatarUrl = computed(() => props.userAvatarUrl.trim());
const userLabelText = computed(
  () => props.userLabel || props.userEmail || props.userName || props.userUsername || "",
);
const canShowPixelAvatar = computed(() => Boolean(props.userPixelAvatar?.pixels?.length));
const canShowUserAvatar = computed(
  () => !canShowPixelAvatar.value && userAvatarUrl.value.length > 0 && !hasAvatarLoadError.value,
);
const userInitials = computed(() => {
  const trimmedName = (props.userUsername || props.userName || props.userEmail).trim();
  if (!trimmedName) {
    return "ME";
  }

  const [firstPart = ""] = trimmedName.split("@");
  const initials = firstPart
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  return initials || "ME";
});

watch(
  () => [props.userAvatarUrl, props.userPixelAvatar],
  () => {
    hasAvatarLoadError.value = false;
  },
);

const handleBrandClick = () => {
  if (props.brandInteractive) {
    emit("brand-click");
  }
};

const handleBrandTrailClick = () => {
  if (canInteractWithBrandTrail.value) {
    emit("brand-trail-click");
  }
};

const handleUserClick = () => {
  if (props.userInteractive) {
    emit("user-click");
  }
};
</script>

<template>
  <header class="studio-topbar" :class="`is-${mode}`" :style="topbarStyle">
    <div class="studio-topbar__brand">
      <component
        :is="brandInteractive ? 'button' : 'div'"
        class="studio-topbar__brand-main"
        :class="{ 'is-clickable': brandInteractive }"
        :type="brandInteractive ? 'button' : undefined"
        :aria-label="brandInteractive ? brandAriaLabel : 'Sefkira Studio'"
        @click="handleBrandClick"
      >
        <PulsarLogo class="studio-topbar__logo" />
        <span class="studio-topbar__brand-name">Sefkira Studio</span>
      </component>

      <span v-if="shouldShowBrandTrail" class="studio-topbar__brand-separator" aria-hidden="true">
        &gt;
      </span>
      <component
        :is="canInteractWithBrandTrail ? 'button' : 'span'"
        v-if="shouldShowBrandTrail"
        class="studio-topbar__brand-trail"
        :class="{
          'has-logo': canShowBrandTrailPixelArt || brandTrailLoading,
          'is-loading': brandTrailLoading && !canShowBrandTrailPixelArt,
          'is-clickable': canInteractWithBrandTrail,
        }"
        :type="canInteractWithBrandTrail ? 'button' : undefined"
        aria-current="page"
        :aria-label="canInteractWithBrandTrail ? brandTrailAriaLabel : brandTrailLabel"
        :data-tooltip="brandTrailText"
        :title="canShowBrandTrailPixelArt ? brandTrailText : undefined"
        @click="handleBrandTrailClick"
      >
        <svg
          v-if="canShowBrandTrailPixelArt"
          class="studio-topbar__project-logo"
          :viewBox="`0 0 ${brandTrailPixelArt?.size || 16} ${brandTrailPixelArt?.size || 16}`"
          preserveAspectRatio="none"
          shape-rendering="crispEdges"
          aria-hidden="true"
          focusable="false"
        >
          <template
            v-for="(pixel, index) in brandTrailPixelArt?.pixels || []"
            :key="`topbar-project-logo-${index}`"
          >
            <rect
              v-if="pixel"
              :x="index % (brandTrailPixelArt?.size || 16)"
              :y="Math.floor(index / (brandTrailPixelArt?.size || 16))"
              width="1"
              height="1"
              :fill="pixel"
            />
          </template>
        </svg>
        <span
          v-else-if="brandTrailLoading"
          class="studio-topbar__project-logo-loader"
          aria-hidden="true"
        ></span>
        <span v-else>{{ brandTrailText }}</span>
      </component>
    </div>

    <div class="studio-topbar__center">
      <slot name="center" />
    </div>

    <div class="studio-topbar__actions">
      <slot name="actions" />
      <component
        :is="userInteractive ? 'button' : 'div'"
        class="studio-topbar__user"
        :class="{ 'is-clickable': userInteractive }"
        :type="userInteractive ? 'button' : undefined"
        :aria-label="userInteractive ? 'Open profile editor' : 'Current user'"
        @click="handleUserClick"
      >
        <span class="studio-topbar__avatar">
          <svg
            v-if="canShowPixelAvatar"
            class="studio-topbar__pixel-avatar"
            :viewBox="`0 0 ${userPixelAvatar?.size || 16} ${userPixelAvatar?.size || 16}`"
            preserveAspectRatio="none"
            shape-rendering="crispEdges"
            aria-hidden="true"
            focusable="false"
          >
            <template
              v-for="(pixel, index) in userPixelAvatar?.pixels || []"
              :key="`topbar-avatar-${index}`"
            >
              <rect
                v-if="pixel"
                :x="index % (userPixelAvatar?.size || 16)"
                :y="Math.floor(index / (userPixelAvatar?.size || 16))"
                width="1"
                height="1"
                :fill="pixel"
              />
            </template>
          </svg>
          <img
            v-else-if="canShowUserAvatar"
            :src="userAvatarUrl"
            :alt="`${userName || 'Current user'} profile photo`"
            referrerpolicy="no-referrer"
            @error="hasAvatarLoadError = true"
          />
          <span v-else>{{ userInitials }}</span>
        </span>
        <span v-if="userLabelText" class="studio-topbar__user-label">
          {{ userLabelText }}
        </span>
      </component>
    </div>
  </header>
</template>

<style scoped>
  .studio-topbar {
    position: relative;
    z-index: 10;
    display: grid;
    flex: 0 0 auto;
    grid-template-areas: "brand center user";
    grid-template-columns: minmax(180px, 1fr) minmax(0, var(--studio-topbar-center-max)) minmax(180px, 1fr);
    gap: 18px;
    align-items: center;
    min-height: 72px;
    padding: 14px 22px;
    box-sizing: border-box;
    border-bottom: 1px solid var(--line);
    background: rgba(5, 5, 5, 0.72);
    backdrop-filter: blur(18px);
  }

  .studio-topbar__brand {
    display: inline-flex;
    grid-area: brand;
    gap: 6px;
    align-items: center;
    min-width: 0;
    max-width: 100%;
    padding: 0;
    color: inherit;
    font-size: 1.04rem;
    font-weight: 700;
    letter-spacing: 0;
    line-height: 1.2;
    justify-self: start;
    overflow: hidden;
  }

  .studio-topbar__brand-main {
    display: inline-flex;
    flex: 0 0 auto;
    gap: 10px;
    align-items: center;
    min-width: 0;
    padding: 0;
    color: inherit;
    font: inherit;
    background: transparent;
    border: 0;
  }

  .studio-topbar__brand-main.is-clickable {
    cursor: pointer;
  }

  .studio-topbar__logo {
    width: 30px;
    height: 30px;
    opacity: 0.94;
    filter:
      drop-shadow(0 0 8px rgba(225, 245, 236, 0.14))
      drop-shadow(0 8px 14px rgba(0, 0, 0, 0.24));
  }

  .studio-topbar__brand-name,
  .studio-topbar__brand-trail {
    display: block;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .studio-topbar__brand-name {
    flex: 0 0 auto;
  }

  .studio-topbar__brand-separator {
    flex: 0 0 auto;
    color: var(--quiet);
  }

  .studio-topbar__brand-trail {
    flex: 1 1 auto;
    color: rgba(247, 241, 231, 0.82);
  }

  .studio-topbar__brand-trail.has-logo {
    position: relative;
    display: inline-grid;
    flex: 0 0 auto;
    place-items: center;
    width: 44px;
    height: 44px;
    overflow: visible;
  }

  .studio-topbar__brand-trail.is-clickable {
    padding: 0;
    color: inherit;
    cursor: pointer;
    background: transparent;
    border: 0;
  }

  .studio-topbar__brand-trail.is-clickable:focus-visible {
    outline: 2px solid rgba(247, 241, 231, 0.42);
    outline-offset: 3px;
    border-radius: 8px;
  }

  .studio-topbar__brand-trail.has-logo::after {
    position: absolute;
    top: calc(100% + 9px);
    left: 50%;
    z-index: 20;
    max-width: 220px;
    padding: 7px 9px;
    overflow: hidden;
    color: var(--text);
    font-size: 0.76rem;
    font-weight: 700;
    line-height: 1;
    text-overflow: ellipsis;
    white-space: nowrap;
    pointer-events: none;
    content: attr(data-tooltip);
    background: rgba(10, 10, 10, 0.96);
    border: 1px solid rgba(247, 241, 231, 0.2);
    border-radius: 6px;
    box-shadow: 0 12px 34px rgba(0, 0, 0, 0.34);
    opacity: 0;
    transform: translate(-50%, -4px);
    transition:
      opacity 150ms ease,
      transform 150ms ease;
  }

  .studio-topbar__brand-trail.has-logo:hover::after {
    opacity: 1;
    transform: translate(-50%, 0);
  }

  .studio-topbar__project-logo {
    display: block;
    width: 42px;
    height: 42px;
    overflow: hidden;
    background: rgba(255, 252, 244, 0.045);
    border: 1px solid rgba(247, 241, 231, 0.18);
    border-radius: 8px;
    image-rendering: pixelated;
  }

  .studio-topbar__project-logo-loader {
    position: relative;
    display: block;
    width: 42px;
    height: 42px;
    overflow: hidden;
    background:
      linear-gradient(
        110deg,
        rgba(247, 241, 231, 0.08) 0%,
        rgba(247, 241, 231, 0.16) 42%,
        rgba(247, 241, 231, 0.08) 70%
      ),
      rgba(255, 252, 244, 0.045);
    background-size: 220% 100%;
    border: 1px solid rgba(247, 241, 231, 0.18);
    border-radius: 8px;
    animation: studio-project-logo-loading 1050ms ease-in-out infinite;
  }

  .studio-topbar__project-logo-loader::after {
    position: absolute;
    inset: 9px;
    content: "";
    border: 2px solid rgba(247, 241, 231, 0.28);
    border-top-color: rgba(247, 241, 231, 0.8);
    border-radius: 999px;
    animation: studio-project-logo-spin 760ms linear infinite;
  }

  .studio-topbar__center {
    display: grid;
    grid-area: center;
    justify-self: center;
    width: min(100%, var(--studio-topbar-center-max));
    min-width: 0;
  }

  .studio-topbar__actions {
    display: flex;
    grid-area: user;
    justify-content: flex-end;
    min-width: 0;
  }

  .studio-topbar__user {
    display: inline-flex;
    gap: 10px;
    align-items: center;
    justify-self: end;
    min-width: 0;
    max-width: min(360px, 30vw);
    padding: 0;
    color: inherit;
    background: transparent;
    border: 0;
  }

  .studio-topbar__user.is-clickable {
    cursor: pointer;
  }

  .studio-topbar__avatar {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    width: 42px;
    height: 42px;
    overflow: hidden;
    color: var(--text);
    font-size: 0.8rem;
    font-weight: 800;
    background: rgba(255, 252, 244, 0.06);
    border: 1px solid var(--line-strong);
    border-radius: 999px;
  }

  .studio-topbar__avatar img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .studio-topbar__avatar > span:not(.studio-topbar__pixel-avatar) {
    display: block;
    overflow: hidden;
    font-size: 0.72rem;
    text-overflow: ellipsis;
  }

  .studio-topbar__pixel-avatar {
    display: block;
    width: 100%;
    height: 100%;
    background: rgba(255, 252, 244, 0.045);
    image-rendering: pixelated;
  }

  .studio-topbar__user-label {
    display: block;
    min-width: 0;
    max-width: min(280px, 24vw);
    overflow: hidden;
    color: rgba(247, 241, 231, 0.76);
    font-size: 0.82rem;
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (max-width: 820px) {
    .studio-topbar {
      grid-template-areas:
        "brand user"
        "center center";
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px 14px;
      align-items: center;
      padding: 12px 14px;
      background: #050505;
    }

    .studio-topbar__center {
      justify-self: stretch;
      width: 100%;
    }

    .studio-topbar__user {
      max-width: min(280px, 100%);
    }

    .studio-topbar__user-label {
      max-width: min(220px, 48vw);
    }
  }

  @media (max-width: 520px) {
    .studio-topbar {
      gap: 14px 10px;
      min-height: 0;
      padding: 13px 12px 12px;
      background: #050505;
      backdrop-filter: blur(18px) saturate(110%);
    }

    .studio-topbar__logo {
      width: 26px;
      height: 26px;
    }

    .studio-topbar__brand-trail.has-logo {
      width: 36px;
      height: 36px;
    }

    .studio-topbar__project-logo {
      width: 34px;
      height: 34px;
      border-radius: 7px;
    }

    .studio-topbar__project-logo-loader {
      width: 34px;
      height: 34px;
      border-radius: 7px;
    }

    .studio-topbar__project-logo-loader::after {
      inset: 8px;
    }

    .studio-topbar__brand {
      gap: 6px;
      font-size: 0.98rem;
    }

    .studio-topbar__brand-main {
      gap: 9px;
    }

    .studio-topbar__avatar {
      width: 36px;
      height: 36px;
    }

    .studio-topbar__user {
      max-width: 36px;
    }

    .studio-topbar__user-label {
      display: none;
    }
  }

  @media (max-width: 380px) {
    .studio-topbar {
      gap: 12px 9px;
      padding: 12px 10px 11px;
    }

    .studio-topbar__brand-name {
      max-width: 118px;
    }

    .studio-topbar__brand-trail {
      max-width: 118px;
    }
  }

  @keyframes studio-project-logo-loading {
    0% {
      background-position: 180% 0;
    }

    100% {
      background-position: -80% 0;
    }
  }

  @keyframes studio-project-logo-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
