<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";

import { API_V1_URL, type ProjectPublic } from "../../../lib/api";
import { WORKSPACE_TRANSITION_STORAGE_KEY } from "../../../lib/routeTransition";
import { shareLinkFailureMessage, shouldShareLinkRedirectToLogin } from "../lib/shareLinkExpiration";

const props = defineProps<{
  token: string;
}>();

const status = ref<"joining" | "redirecting" | "error">("joining");
const message = ref("Joining shared project...");

const canRetry = computed(() => status.value === "error");
const controller = new AbortController();
let mounted = true;
let redirectTimeout: number | null = null;

const studioPath = "/studio";

const redirectToLogin = () => {
  const loginUrl = new URL("/login", window.location.origin);
  loginUrl.hash = `next=${encodeURIComponent(window.location.pathname)}`;
  window.location.assign(loginUrl.toString());
};

const redirectToStudio = () => {
  window.sessionStorage.setItem(WORKSPACE_TRANSITION_STORAGE_KEY, "pending");
  document.documentElement.classList.add("route-transition-pending");
  window.location.assign(studioPath);
};

const joinSharedProject = async () => {
  const timeout = window.setTimeout(() => controller.abort(), 18000);
  try {
    const response = await fetch(
      `${API_V1_URL}/projects/share-links/${encodeURIComponent(props.token)}/accept`,
      {
        method: "POST",
        signal: controller.signal,
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      },
    );

    if (!mounted) return;
    if (response.status === 401) {
      redirectToLogin();
      return;
    }

    const project = response.ok ? ((await response.json()) as ProjectPublic) : null;
    if (!mounted) return;

    if (!project) {
      let detail: unknown;
      try { detail = ((await response.json()) as { detail?: unknown }).detail; } catch { /* Empty error body. */ }
      if (!mounted) return;
      if (shouldShareLinkRedirectToLogin(response.status, detail)) {
        redirectToLogin();
        return;
      }
      status.value = "error";
      message.value = shareLinkFailureMessage(response.status, detail);
      return;
    }

    status.value = "redirecting";
    message.value = "Project added. Opening studio...";
    redirectTimeout = window.setTimeout(redirectToStudio, 260);
  } catch {
    if (mounted) {
      status.value = "error";
      message.value = "The project could not be opened. Check your connection and try the link again.";
    }
  } finally {
    window.clearTimeout(timeout);
  }
};

onMounted(() => {
  void joinSharedProject();
});
onUnmounted(() => {
  mounted = false;
  controller.abort();
  if (redirectTimeout !== null) window.clearTimeout(redirectTimeout);
});
</script>

<template>
  <section class="share-gate" aria-live="polite">
    <div class="share-gate__card">
      <p>Project sharing</p>
      <h1>{{ status === "error" ? "Could not join project" : "Opening shared project" }}</h1>
      <span>{{ message }}</span>
      <button v-if="canRetry" type="button" @click="redirectToStudio">Go to studio</button>
    </div>
  </section>
</template>

<style scoped>
.share-gate {
  position: relative;
  z-index: 5;
  display: grid;
  min-height: 100vh;
  min-height: 100dvh;
  place-items: center;
  padding: 24px;
}

.share-gate__card {
  width: min(420px, 100%);
  border: 1px solid rgba(255, 255, 255, 0.28);
  border-radius: 8px;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.06), rgba(255, 160, 145, 0.08)),
    rgba(18, 18, 17, 0.9);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.46);
  padding: 28px;
  color: #f7f1e7;
}

.share-gate__card p {
  margin: 0 0 8px;
  color: #ffa79b;
  font-size: 0.75rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.share-gate__card h1 {
  margin: 0 0 12px;
  font-size: clamp(1.45rem, 4vw, 1.9rem);
  line-height: 1.05;
}

.share-gate__card span {
  display: block;
  color: rgba(247, 241, 231, 0.72);
  font-weight: 700;
  line-height: 1.45;
}

.share-gate__card button {
  width: 100%;
  margin-top: 22px;
  border: 1px solid rgba(247, 241, 231, 0.78);
  border-radius: 7px;
  background: #f7f1e7;
  color: #171614;
  cursor: pointer;
  font: inherit;
  font-weight: 800;
  padding: 12px 16px;
}
</style>
