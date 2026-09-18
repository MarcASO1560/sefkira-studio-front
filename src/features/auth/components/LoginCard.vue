<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import {
  clearStoredAccessTokens,
  createSafeRedirectPath,
} from "../../../lib/session";
import { WORKSPACE_TRANSITION_STORAGE_KEY } from "../../../lib/routeTransition";
import PulsarLogo from "./PulsarLogo.vue";

type GoogleCredentialResponse = {
  credential?: string;
};

type GooglePromptMomentNotification = {
  getNotDisplayedReason?: () => string;
  getSkippedReason?: () => string;
  isDismissedMoment?: () => boolean;
  isNotDisplayed?: () => boolean;
  isSkippedMoment?: () => boolean;
};

type AuthSessionResponse = {
  status: string;
  token_type?: string;
};

type PasswordResetRequestResponse = {
  status: string;
};

type ApiErrorPayload = {
  detail?: string | Array<{ msg?: string }>;
};

const props = withDefaults(
  defineProps<{
    redirectPath?: string;
  }>(),
  {
    redirectPath: "",
  },
);

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          cancel: () => void;
          initialize: (config: {
            client_id: string;
            callback: (response: GoogleCredentialResponse) => void;
            auto_select?: boolean;
            ux_mode?: "popup" | "redirect";
            use_fedcm_for_button?: boolean;
            button_auto_select?: boolean;
          }) => void;
          renderButton: (
            parent: HTMLElement,
            options: {
              click_listener?: () => void;
              locale?: string;
              logo_alignment?: "left" | "center";
              shape?: "rectangular" | "pill" | "circle" | "square";
              size?: "large" | "medium" | "small";
              text?: "signin_with" | "signup_with" | "continue_with" | "signin";
              theme?: "outline" | "filled_blue" | "filled_black";
              type?: "standard" | "icon";
              width?: number;
            },
          ) => void;
          prompt: (
            momentListener?: (notification: GooglePromptMomentNotification) => void,
          ) => void;
        };
      };
    };
  }
}

const status = ref<"idle" | "loading" | "ready" | "success" | "error">("idle");
const message = ref("");
const email = ref("");
const password = ref("");
const signUpUsername = ref("");
const signUpEmail = ref("");
const signUpPassword = ref("");
const signUpRepeatPassword = ref("");
const resetEmail = ref("");
const resetToken = ref("");
const resetPassword = ref("");
const resetRepeatPassword = ref("");
const isPasswordVisible = ref(false);
const isSignUpMode = ref(false);
const isPasswordResetMode = ref(false);
const isSignUpPasswordVisible = ref(false);
const isSignUpRepeatPasswordVisible = ref(false);
const isResetPasswordVisible = ref(false);
const isResetRepeatPasswordVisible = ref(false);
const returningFrom = ref<"signup" | "reset" | null>(null);
const googleButtonHost = ref<HTMLElement | null>(null);

let toastTimer = 0;
let cardReturnTimer = 0;
let redirectTimer = 0;
let googlePromptTimer = 0;
const CARD_FLIP_MS = 720;
const WORKSPACE_TRANSITION_MS = 80;
const MAX_USERNAME_LENGTH = 255;

const googleClientId = import.meta.env.PUBLIC_GOOGLE_CLIENT_ID || "";
const isGoogleConfigured = computed(() => googleClientId.trim().length > 0);
const canUseEmail = computed(
  () => email.value.trim().length > 0 && password.value.length > 0,
);
const canCreateAccount = computed(
  () =>
    signUpEmail.value.trim().length > 0 &&
    signUpPassword.value.length > 0 &&
    signUpRepeatPassword.value.length > 0,
);
const canRequestPasswordReset = computed(() => resetEmail.value.trim().length > 0);
const canConfirmPasswordReset = computed(
  () =>
    resetToken.value.length > 0 &&
    resetPassword.value.length > 0 &&
    resetRepeatPassword.value.length > 0,
);

const loadGoogleIdentityScript = () =>
  new Promise<void>((resolve, reject) => {
    if (window.google?.accounts?.id) {
      resolve();
      return;
    }

    const existingScript = document.querySelector<HTMLScriptElement>(
      'script[src="https://accounts.google.com/gsi/client"]',
    );

    if (existingScript) {
      existingScript.addEventListener("load", () => resolve(), { once: true });
      existingScript.addEventListener("error", () => reject(), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(), { once: true });
    document.head.appendChild(script);
  });

const persistSession = () => {
  clearStoredAccessTokens();
  window.dispatchEvent(
    new CustomEvent("pixel:auth", {
      detail: { authenticated: true },
    }),
  );
};

const readHashRedirectPath = () => {
  const hashValue = window.location.hash.replace(/^#/, "");
  return new URLSearchParams(hashValue).get("next");
};

const redirectAfterSignIn = () => {
  const redirectPath = createSafeRedirectPath(
    props.redirectPath ||
      new URLSearchParams(window.location.search).get("next") ||
      readHashRedirectPath(),
  );
  redirectTimer = window.setTimeout(() => {
    window.location.assign(redirectPath);
  }, WORKSPACE_TRANSITION_MS);
};

const readApiError = async (response: Response, fallbackMessage: string) => {
  try {
    const errorPayload = (await response.json()) as ApiErrorPayload;
    if (typeof errorPayload.detail === "string") {
      return errorPayload.detail;
    }

    if (Array.isArray(errorPayload.detail) && errorPayload.detail[0]?.msg) {
      return errorPayload.detail[0].msg;
    }
  } catch {
    return fallbackMessage;
  }

  return fallbackMessage;
};

const postJson = async <ResponseBody,>(path: string, body: unknown, fallbackMessage: string) => {
  const apiResponse = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!apiResponse.ok) {
    throw new Error(await readApiError(apiResponse, fallbackMessage));
  }

  return (await apiResponse.json()) as ResponseBody;
};

const completeSession = () => {
  persistSession();
  status.value = "success";
  hideToast();
  window.sessionStorage.setItem(WORKSPACE_TRANSITION_STORAGE_KEY, "pending");
  document.documentElement.classList.add("route-transition-pending");
  redirectAfterSignIn();
};

const handleGoogleCredential = async (response: GoogleCredentialResponse) => {
  window.clearTimeout(googlePromptTimer);

  if (!response.credential) {
    showToast("Could not connect.", "error");
    return;
  }

  status.value = "loading";
  hideToast();

  try {
    await postJson<AuthSessionResponse>(
      "/api/v1/auth/google",
      {
        credential: response.credential,
      },
      "Could not verify your Google account.",
    );
    completeSession();
  } catch (error) {
    status.value = "error";
    showToast(error instanceof Error ? error.message : "Could not connect.", "error");
  }
};

const initializeGoogleIdentity = () => {
  if (!window.google?.accounts?.id || !isGoogleConfigured.value) {
    return;
  }

  window.google.accounts.id.initialize({
    client_id: googleClientId,
    callback: handleGoogleCredential,
    auto_select: false,
    ux_mode: "popup",
    use_fedcm_for_button: true,
    button_auto_select: false,
  });

  const buttonHost = googleButtonHost.value;
  if (buttonHost) {
    buttonHost.replaceChildren();
    window.google.accounts.id.renderButton(buttonHost, {
      click_listener: startGoogleButtonFeedback,
      logo_alignment: "left",
      shape: "rectangular",
      size: "large",
      text: "continue_with",
      theme: "outline",
      type: "standard",
      width: Math.min(Math.max(Math.round(buttonHost.clientWidth || 320), 240), 360),
    });
  }

  status.value = "ready";
  hideToast();
};

const startGoogleButtonFeedback = () => {
  status.value = "loading";
  hideToast();
  googlePromptTimer = window.setTimeout(() => {
    if (status.value === "loading") {
      status.value = "ready";
      showToast("Google could not open. Check the authorized JavaScript origin.", "error");
    }
  }, 4200);
};

const signInWithEmail = async () => {
  if (!canUseEmail.value) {
    showToast("Enter your email and password.", "error");
    return;
  }

  if (password.value.length < 8) {
    showToast("Password must be at least 8 characters.", "error");
    return;
  }

  status.value = "loading";
  hideToast();

  try {
    await postJson<AuthSessionResponse>(
      "/api/v1/auth/login",
      {
        email: email.value.trim(),
        password: password.value,
      },
      "Could not sign in.",
    );
    completeSession();
  } catch (error) {
    status.value = "error";
    showToast(error instanceof Error ? error.message : "Could not sign in.", "error");
  }
};

const showSignUp = () => {
  hideToast();
  window.clearTimeout(cardReturnTimer);
  returningFrom.value = null;
  isPasswordResetMode.value = false;
  isSignUpMode.value = true;
};

const showSignIn = () => {
  hideToast();
  window.clearTimeout(cardReturnTimer);

  if (isSignUpMode.value) {
    returningFrom.value = "signup";
    isSignUpMode.value = false;
    isPasswordResetMode.value = false;
    cardReturnTimer = window.setTimeout(() => {
      if (returningFrom.value === "signup") {
        returningFrom.value = null;
      }
    }, CARD_FLIP_MS + 80);
    return;
  }

  if (isPasswordResetMode.value) {
    returningFrom.value = "reset";
    isSignUpMode.value = false;
    isPasswordResetMode.value = false;
    cardReturnTimer = window.setTimeout(() => {
      if (returningFrom.value === "reset") {
        returningFrom.value = null;
      }
    }, CARD_FLIP_MS + 80);
    return;
  }

  returningFrom.value = null;
  isSignUpMode.value = false;
  isPasswordResetMode.value = false;
};

const showPasswordReset = () => {
  hideToast();
  window.clearTimeout(cardReturnTimer);
  resetToken.value = "";
  resetPassword.value = "";
  resetRepeatPassword.value = "";
  isResetPasswordVisible.value = false;
  isResetRepeatPasswordVisible.value = false;
  returningFrom.value = null;
  isSignUpMode.value = false;
  isPasswordResetMode.value = true;
};

const createAccount = async () => {
  if (!canCreateAccount.value) {
    showToast("Enter your email and password, then repeat your password.", "error");
    return;
  }

  if (signUpUsername.value.trim() && Array.from(signUpUsername.value).length > MAX_USERNAME_LENGTH) {
    showToast(`Username must be ${MAX_USERNAME_LENGTH} characters or fewer.`, "error");
    return;
  }

  if (signUpPassword.value.length < 8) {
    showToast("Password must be at least 8 characters.", "error");
    return;
  }

  if (signUpPassword.value !== signUpRepeatPassword.value) {
    showToast("Passwords do not match.", "error");
    return;
  }

  status.value = "loading";
  hideToast();

  try {
    await postJson<AuthSessionResponse>(
      "/api/v1/auth/register",
      {
        username: signUpUsername.value.trim() ? signUpUsername.value : null,
        email: signUpEmail.value.trim(),
        password: signUpPassword.value,
        password_confirmation: signUpRepeatPassword.value,
      },
      "Could not create the account.",
    );
    completeSession();
  } catch (error) {
    status.value = "error";
    showToast(
      error instanceof Error ? error.message : "Could not create the account.",
      "error",
    );
  }
};

const blockRepeatPasswordPaste = () => {
  showToast("Type the password again manually.", "error");
};

const openPasswordResetWithToken = (nextResetToken: string) => {
  hideToast();
  window.clearTimeout(cardReturnTimer);
  resetToken.value = nextResetToken;
  resetPassword.value = "";
  resetRepeatPassword.value = "";
  isResetPasswordVisible.value = false;
  isResetRepeatPasswordVisible.value = false;
  returningFrom.value = null;
  isSignUpMode.value = false;
  isPasswordResetMode.value = true;
};

const readPasswordResetLink = () => {
  const url = new URL(window.location.href);
  const urlResetToken = url.searchParams.get("reset_token");
  if (!urlResetToken) {
    return;
  }

  openPasswordResetWithToken(urlResetToken);
  url.searchParams.delete("reset_token");
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
};

const requestPasswordReset = async () => {
  if (!canRequestPasswordReset.value) {
    showToast("Enter your email.", "error");
    return;
  }

  status.value = "loading";
  hideToast();

  try {
    await postJson<PasswordResetRequestResponse>(
      "/api/v1/auth/password-reset/request",
      {
        email: resetEmail.value.trim(),
      },
      "Could not request the reset link.",
    );
    status.value = "ready";
    showToast("If the account exists, reset instructions were sent.", "success");
  } catch (error) {
    status.value = "error";
    showToast(
      error instanceof Error ? error.message : "Could not request the reset link.",
      "error",
    );
  }
};

const confirmPasswordReset = async () => {
  if (!canConfirmPasswordReset.value) {
    showToast("Complete both password fields.", "error");
    return;
  }

  if (resetPassword.value.length < 8) {
    showToast("Password must be at least 8 characters.", "error");
    return;
  }

  if (resetPassword.value !== resetRepeatPassword.value) {
    showToast("Passwords do not match.", "error");
    return;
  }

  status.value = "loading";
  hideToast();

  try {
    await postJson<AuthSessionResponse>(
      "/api/v1/auth/password-reset/confirm",
      {
        token: resetToken.value,
        password: resetPassword.value,
        password_confirmation: resetRepeatPassword.value,
      },
      "Could not reset the password.",
    );
    resetToken.value = "";
    resetPassword.value = "";
    resetRepeatPassword.value = "";
    completeSession();
  } catch (error) {
    status.value = "error";
    showToast(
      error instanceof Error ? error.message : "Could not reset the password.",
      "error",
    );
  }
};

onMounted(async () => {
  readPasswordResetLink();

  if (!isGoogleConfigured.value) {
    status.value = "ready";
    return;
  }

  status.value = "loading";
  hideToast();

  try {
    await loadGoogleIdentityScript();
    initializeGoogleIdentity();
  } catch {
    status.value = "error";
    showToast("Could not load Google.", "error");
  }
});

onBeforeUnmount(() => {
  window.clearTimeout(toastTimer);
  window.clearTimeout(cardReturnTimer);
  window.clearTimeout(redirectTimer);
  window.clearTimeout(googlePromptTimer);
  window.google?.accounts?.id.cancel();
});

const showToast = (nextMessage: string, nextStatus: "success" | "error") => {
  window.clearTimeout(toastTimer);
  status.value = nextStatus;
  message.value = nextMessage;
  toastTimer = window.setTimeout(hideToast, 4200);
};

const hideToast = () => {
  window.clearTimeout(toastTimer);
  message.value = "";
};
</script>

<template>
  <section class="login-layer" aria-label="Sign in">
    <div class="login-shell">
      <div class="brand-lockup" aria-label="Sefkira Studio">
        <PulsarLogo />
        <div class="brand-copy">
          <p class="app-title">Sefkira Studio</p>
          <p class="app-tagline">The creative engine</p>
        </div>
      </div>

      <div
        class="login-card-frame"
        :class="{
          'is-signup-frame': isSignUpMode,
          'is-reset-frame': isPasswordResetMode,
          'is-returning-from-signup': returningFrom === 'signup',
          'is-returning-from-reset': returningFrom === 'reset',
        }"
      >
        <section
          class="login-card"
          :class="{
            'is-flipped': isSignUpMode,
            'is-reset-flipped': isPasswordResetMode,
          }"
          :aria-label="
            isSignUpMode ? 'Sign up' : isPasswordResetMode ? 'Reset password' : 'Sign in'
          "
        >
          <div
            class="login-card-face login-card-front"
            :aria-hidden="isSignUpMode || isPasswordResetMode"
            :inert="isSignUpMode || isPasswordResetMode"
          >
            <header class="login-header">
              <button class="signup-link" type="button" @click="showSignUp">
                Sign up
              </button>
            </header>

            <div class="welcome-copy">
              <p class="welcome-title">Welcome</p>
              <p class="welcome-subtitle">Sign in to your studio</p>
            </div>

            <form class="email-form" @submit.prevent="signInWithEmail">
              <label class="field-group">
                <span class="sr-only">Email</span>
                <span class="text-input-control">
                  <input
                    v-model="email"
                    autocomplete="email"
                    inputmode="email"
                    name="email"
                    placeholder="Email"
                    type="email"
                  />
                  <span class="field-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" focusable="false">
                      <path d="M4 6h16v12H4z" />
                      <path d="m4 7 8 6 8-6" />
                    </svg>
                  </span>
                </span>
              </label>

              <label class="field-group">
                <span class="sr-only">Password</span>
                <span class="password-control">
                  <input
                    v-model="password"
                    autocomplete="current-password"
                    name="password"
                    placeholder="Password"
                    :type="isPasswordVisible ? 'text' : 'password'"
                  />
                  <span class="field-icon password-field-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" focusable="false">
                      <path d="M7 10V8a5 5 0 0 1 10 0v2" />
                      <path d="M6 10h12v10H6z" />
                    </svg>
                  </span>
                  <button
                    class="password-toggle"
                    type="button"
                    :aria-label="isPasswordVisible ? 'Hide password' : 'Show password'"
                    @click="isPasswordVisible = !isPasswordVisible"
                  >
                    <svg
                      v-if="isPasswordVisible"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path d="M3 3l18 18" />
                      <path d="M10.58 10.58a2 2 0 0 0 2.84 2.84" />
                      <path
                        d="M9.88 4.24A9.92 9.92 0 0 1 12 4c5.4 0 9 5 9 8a6.76 6.76 0 0 1-1.37 3.67"
                      />
                      <path
                        d="M6.47 6.48C4.28 7.88 3 10.2 3 12c0 3 3.6 8 9 8 1.56 0 2.96-.42 4.16-1.09"
                      />
                    </svg>
                    <svg v-else viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <path
                        d="M3 12c0-3 3.6-8 9-8s9 5 9 8-3.6 8-9 8-9-5-9-8z"
                      />
                      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
                    </svg>
                  </button>
                </span>
              </label>

              <button class="email-submit-button" type="submit" :disabled="status === 'loading'">
                <span>Sign in</span>
              </button>
            </form>

            <div class="auth-divider" aria-hidden="true">
              <span></span>
              <p>or</p>
              <span></span>
            </div>

            <div class="google-button-frame">
              <button
                class="google-app-button"
                type="button"
                :disabled="status === 'idle' || status === 'loading'"
                aria-hidden="true"
                tabindex="-1"
              >
                <span class="google-icon-box" aria-hidden="true">
                  <svg viewBox="0 0 533.5 544.3" focusable="false">
                    <path
                      fill="#4285f4"
                      d="M533.5 278.4c0-18.5-1.5-37.1-4.7-55.3H272.1v104.8h147c-6.1 33.8-25.7 63.7-54.4 82.7v68h87.7c51.5-47.4 81.1-117.4 81.1-200.2z"
                    />
                    <path
                      fill="#34a853"
                      d="M272.1 544.3c73.4 0 135.3-24.1 180.4-65.7l-87.7-68c-24.4 16.6-55.9 26-92.6 26-71 0-131.2-47.9-152.8-112.3H28.9v70.1c46.2 91.9 140.3 149.9 243.2 149.9z"
                    />
                    <path
                      fill="#fbbc05"
                      d="M119.3 324.3c-11.4-33.8-11.4-70.4 0-104.2V150H28.9c-38.6 76.9-38.6 167.5 0 244.4l90.4-70.1z"
                    />
                    <path
                      fill="#ea4335"
                      d="M272.1 107.7c38.8-.6 76.3 14 104.4 40.8l77.7-77.7C405 24.6 339.7-.8 272.1 0 169.2 0 75.1 58 28.9 150l90.4 70.1c21.5-64.5 81.8-112.4 152.8-112.4z"
                    />
                  </svg>
                </span>
                <span>{{ status === "loading" ? "Connecting" : "Continue with Google" }}</span>
              </button>
              <div
                ref="googleButtonHost"
                class="google-button-host"
                :class="{ 'is-hidden': status === 'idle' || status === 'loading' }"
              ></div>
            </div>

            <button class="forgot-password-link" type="button" @click="showPasswordReset">
              Forgot your password?
            </button>
          </div>

          <div
            class="login-card-face login-card-back login-card-signup"
            :aria-hidden="!isSignUpMode"
            :inert="!isSignUpMode"
          >
            <header class="login-header">
              <button class="signup-link" type="button" @click="showSignIn">
                Sign in
              </button>
            </header>

            <div class="welcome-copy">
              <p class="welcome-title">Create account</p>
              <p class="welcome-subtitle">Start building your studio</p>
            </div>

            <form class="email-form" @submit.prevent="createAccount">
              <label class="field-group">
                <span class="sr-only">Username (optional)</span>
                <span class="text-input-control">
                  <input
                    v-model="signUpUsername"
                    autocomplete="username"
                    name="signup-username"
                    placeholder="Username (optional)"
                    type="text"
                  />
                  <span class="field-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" focusable="false">
                      <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" />
                      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
                    </svg>
                  </span>
                </span>
              </label>

              <label class="field-group">
                <span class="sr-only">Email</span>
                <span class="text-input-control">
                  <input
                    v-model="signUpEmail"
                    autocomplete="email"
                    inputmode="email"
                    name="signup-email"
                    placeholder="Email"
                    type="email"
                  />
                  <span class="field-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" focusable="false">
                      <path d="M4 6h16v12H4z" />
                      <path d="m4 7 8 6 8-6" />
                    </svg>
                  </span>
                </span>
              </label>

              <label class="field-group">
                <span class="sr-only">Password</span>
                <span class="password-control">
                  <input
                    v-model="signUpPassword"
                    autocomplete="new-password"
                    name="signup-password"
                    placeholder="Password"
                    :type="isSignUpPasswordVisible ? 'text' : 'password'"
                  />
                  <span class="field-icon password-field-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" focusable="false">
                      <path d="M7 10V8a5 5 0 0 1 10 0v2" />
                      <path d="M6 10h12v10H6z" />
                    </svg>
                  </span>
                  <button
                    class="password-toggle"
                    type="button"
                    :aria-label="isSignUpPasswordVisible ? 'Hide password' : 'Show password'"
                    @click="isSignUpPasswordVisible = !isSignUpPasswordVisible"
                  >
                    <svg
                      v-if="isSignUpPasswordVisible"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path d="M3 3l18 18" />
                      <path d="M10.58 10.58a2 2 0 0 0 2.84 2.84" />
                      <path
                        d="M9.88 4.24A9.92 9.92 0 0 1 12 4c5.4 0 9 5 9 8a6.76 6.76 0 0 1-1.37 3.67"
                      />
                      <path
                        d="M6.47 6.48C4.28 7.88 3 10.2 3 12c0 3 3.6 8 9 8 1.56 0 2.96-.42 4.16-1.09"
                      />
                    </svg>
                    <svg v-else viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <path
                        d="M3 12c0-3 3.6-8 9-8s9 5 9 8-3.6 8-9 8-9-5-9-8z"
                      />
                      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
                    </svg>
                  </button>
                </span>
              </label>

              <label class="field-group">
                <span class="sr-only">Repeat password</span>
                <span class="password-control">
                  <input
                    v-model="signUpRepeatPassword"
                    autocomplete="new-password"
                    name="signup-repeat-password"
                    placeholder="Repeat password"
                    :type="isSignUpRepeatPasswordVisible ? 'text' : 'password'"
                    @drop.prevent
                    @paste.prevent="blockRepeatPasswordPaste"
                  />
                  <span class="field-icon password-field-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" focusable="false">
                      <path d="M7 10V8a5 5 0 0 1 10 0v2" />
                      <path d="M6 10h12v10H6z" />
                    </svg>
                  </span>
                  <button
                    class="password-toggle"
                    type="button"
                    :aria-label="isSignUpRepeatPasswordVisible ? 'Hide password' : 'Show password'"
                    @click="isSignUpRepeatPasswordVisible = !isSignUpRepeatPasswordVisible"
                  >
                    <svg
                      v-if="isSignUpRepeatPasswordVisible"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path d="M3 3l18 18" />
                      <path d="M10.58 10.58a2 2 0 0 0 2.84 2.84" />
                      <path
                        d="M9.88 4.24A9.92 9.92 0 0 1 12 4c5.4 0 9 5 9 8a6.76 6.76 0 0 1-1.37 3.67"
                      />
                      <path
                        d="M6.47 6.48C4.28 7.88 3 10.2 3 12c0 3 3.6 8 9 8 1.56 0 2.96-.42 4.16-1.09"
                      />
                    </svg>
                    <svg v-else viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <path
                        d="M3 12c0-3 3.6-8 9-8s9 5 9 8-3.6 8-9 8-9-5-9-8z"
                      />
                      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
                    </svg>
                  </button>
                </span>
              </label>

              <button class="email-submit-button" type="submit" :disabled="status === 'loading'">
                <span>Create account</span>
              </button>
            </form>

          </div>

          <div
            class="login-card-face login-card-reset"
            :aria-hidden="!isPasswordResetMode"
            :inert="!isPasswordResetMode"
          >
            <header class="login-header reset-header">
              <button class="back-icon-link" type="button" aria-label="Back to sign in" @click="showSignIn">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M15 6l-6 6 6 6" />
                </svg>
                <span>Back</span>
              </button>
            </header>

            <div class="welcome-copy">
              <p class="welcome-title">Reset password</p>
              <p class="welcome-subtitle">
                {{ resetToken ? "Choose a new password" : "Enter the email for your account" }}
              </p>
            </div>

            <form v-if="!resetToken" class="email-form" @submit.prevent="requestPasswordReset">
              <label class="field-group">
                <span class="sr-only">Email</span>
                <span class="text-input-control">
                  <input
                    v-model="resetEmail"
                    autocomplete="email"
                    inputmode="email"
                    name="reset-email"
                    placeholder="Email"
                    type="email"
                  />
                  <span class="field-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" focusable="false">
                      <path d="M4 6h16v12H4z" />
                      <path d="m4 7 8 6 8-6" />
                    </svg>
                  </span>
                </span>
              </label>

              <button class="email-submit-button" type="submit" :disabled="status === 'loading'">
                <span>Send reset link</span>
              </button>
            </form>

            <form v-else class="email-form" @submit.prevent="confirmPasswordReset">
              <label class="field-group">
                <span class="sr-only">New password</span>
                <span class="password-control">
                  <input
                    v-model="resetPassword"
                    autocomplete="new-password"
                    name="reset-password"
                    placeholder="New password"
                    :type="isResetPasswordVisible ? 'text' : 'password'"
                  />
                  <span class="field-icon password-field-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" focusable="false">
                      <path d="M7 10V8a5 5 0 0 1 10 0v2" />
                      <path d="M6 10h12v10H6z" />
                    </svg>
                  </span>
                  <button
                    class="password-toggle"
                    type="button"
                    :aria-label="isResetPasswordVisible ? 'Hide password' : 'Show password'"
                    @click="isResetPasswordVisible = !isResetPasswordVisible"
                  >
                    <svg
                      v-if="isResetPasswordVisible"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path d="M3 3l18 18" />
                      <path d="M10.58 10.58a2 2 0 0 0 2.84 2.84" />
                      <path
                        d="M9.88 4.24A9.92 9.92 0 0 1 12 4c5.4 0 9 5 9 8a6.76 6.76 0 0 1-1.37 3.67"
                      />
                      <path
                        d="M6.47 6.48C4.28 7.88 3 10.2 3 12c0 3 3.6 8 9 8 1.56 0 2.96-.42 4.16-1.09"
                      />
                    </svg>
                    <svg v-else viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <path
                        d="M3 12c0-3 3.6-8 9-8s9 5 9 8-3.6 8-9 8-9-5-9-8z"
                      />
                      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
                    </svg>
                  </button>
                </span>
              </label>

              <label class="field-group">
                <span class="sr-only">Repeat new password</span>
                <span class="password-control">
                  <input
                    v-model="resetRepeatPassword"
                    autocomplete="new-password"
                    name="reset-repeat-password"
                    placeholder="Repeat new password"
                    :type="isResetRepeatPasswordVisible ? 'text' : 'password'"
                    @drop.prevent
                    @paste.prevent="blockRepeatPasswordPaste"
                  />
                  <span class="field-icon password-field-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" focusable="false">
                      <path d="M7 10V8a5 5 0 0 1 10 0v2" />
                      <path d="M6 10h12v10H6z" />
                    </svg>
                  </span>
                  <button
                    class="password-toggle"
                    type="button"
                    :aria-label="isResetRepeatPasswordVisible ? 'Hide password' : 'Show password'"
                    @click="isResetRepeatPasswordVisible = !isResetRepeatPasswordVisible"
                  >
                    <svg
                      v-if="isResetRepeatPasswordVisible"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path d="M3 3l18 18" />
                      <path d="M10.58 10.58a2 2 0 0 0 2.84 2.84" />
                      <path
                        d="M9.88 4.24A9.92 9.92 0 0 1 12 4c5.4 0 9 5 9 8a6.76 6.76 0 0 1-1.37 3.67"
                      />
                      <path
                        d="M6.47 6.48C4.28 7.88 3 10.2 3 12c0 3 3.6 8 9 8 1.56 0 2.96-.42 4.16-1.09"
                      />
                    </svg>
                    <svg v-else viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <path
                        d="M3 12c0-3 3.6-8 9-8s9 5 9 8-3.6 8-9 8-9-5-9-8z"
                      />
                      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
                    </svg>
                  </button>
                </span>
              </label>

              <button class="email-submit-button" type="submit" :disabled="status === 'loading'">
                <span>Reset password</span>
              </button>
            </form>
          </div>
        </section>
      </div>
    </div>

    <div v-if="message" class="app-toast" :class="status" role="status">
      {{ message }}
    </div>
  </section>
</template>

<style scoped>
.login-layer {
  position: fixed;
  inset: 0;
  z-index: 4;
  display: grid;
  place-items: center;
  min-height: 100svh;
  padding: clamp(16px, 5vw, 24px);
  overflow-y: auto;
  pointer-events: none;
}

.login-shell {
  display: grid;
  width: min(100%, 426px);
  justify-items: center;
  gap: 18px;
}

.login-card-frame {
  width: 100%;
  perspective: 1300px;
  pointer-events: auto;
}

.login-card-frame:not(.is-signup-frame):not(.is-reset-frame) .login-card-front,
.login-card-frame.is-signup-frame .login-card-back {
  position: relative;
  inset: auto;
}

.login-card-frame.is-reset-frame .login-card-reset {
  position: relative;
  inset: auto;
}

.login-card-frame:not(.is-signup-frame):not(.is-reset-frame) .login-card-front,
.login-card-frame.is-signup-frame .login-card-front,
.login-card-frame.is-signup-frame .login-card-back,
.login-card-frame.is-reset-frame .login-card-front,
.login-card-frame.is-reset-frame .login-card-reset,
.login-card-frame.is-returning-from-signup .login-card-back,
.login-card-frame.is-returning-from-reset .login-card-reset {
  visibility: visible;
  opacity: 1;
}

.login-card {
  width: 100%;
  display: grid;
  position: relative;
  transform-style: preserve-3d;
  transition: transform 720ms cubic-bezier(0.2, 0.82, 0.22, 1);
  will-change: transform;
}

.login-card.is-flipped {
  transform: rotateY(-180deg);
}

.login-card.is-reset-flipped {
  transform: rotateX(180deg);
}

.login-card-face {
  position: absolute;
  inset: 0;
  grid-area: 1 / 1;
  width: 100%;
  padding: 18px 32px 32px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 8px;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.055)),
    rgba(9, 10, 12, 0.56);
  box-shadow:
    0 28px 90px rgba(0, 0, 0, 0.48),
    inset 0 1px 0 rgba(255, 255, 255, 0.14);
  color: #f4f1f6;
  pointer-events: auto;
  backdrop-filter: blur(22px) saturate(112%);
  backface-visibility: hidden;
  transform-style: preserve-3d;
  -webkit-backface-visibility: hidden;
  visibility: hidden;
  opacity: 0;
}

.login-card-back {
  transform: rotateY(180deg);
}

.login-card-reset {
  transform: rotateX(180deg);
}

.login-card.is-flipped .login-card-front,
.login-card.is-reset-flipped .login-card-front,
.login-card:not(.is-flipped) .login-card-back,
.login-card:not(.is-reset-flipped) .login-card-reset {
  pointer-events: none;
}

.login-header {
  margin-bottom: 20px;
  display: flex;
  justify-content: flex-end;
}

.reset-header {
  justify-content: flex-start;
}

.brand-lockup {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 15px;
  color: #f4f1f6;
  filter: drop-shadow(0 16px 30px rgba(0, 0, 0, 0.44));
}

.brand-lockup :deep(.pulsar-logo) {
  width: clamp(58px, 13vw, 70px);
  height: clamp(58px, 13vw, 70px);
  margin-bottom: 0;
  flex: 0 0 auto;
  opacity: 0.92;
}

.brand-copy {
  display: grid;
  min-width: 0;
  gap: 6px;
  justify-items: start;
}

.app-title {
  margin: 0;
  color: rgba(255, 252, 255, 0.98);
  font-size: clamp(1.78rem, 5.4vw, 2.22rem);
  font-weight: 650;
  letter-spacing: 0;
  line-height: 1;
  text-align: left;
  white-space: nowrap;
}

.app-tagline {
  margin: 0;
  color: rgba(255, 252, 255, 0.56);
  font-size: clamp(0.64rem, 1.8vw, 0.74rem);
  font-weight: 550;
  letter-spacing: 0;
  line-height: 1;
  text-align: left;
}

.signup-link,
.forgot-password-link {
  position: relative;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  font-size: 0.92rem;
  font-weight: 600;
  letter-spacing: 0;
  line-height: 1.2;
  color: rgba(255, 252, 255, 0.86);
  cursor: pointer;
  font-family: inherit;
}

.forgot-password-link {
  display: block;
  margin: 18px auto 0;
  color: rgba(255, 252, 255, 0.64);
  font-size: 0.88rem;
}

.signup-link::after,
.forgot-password-link::after {
  position: absolute;
  left: 0;
  bottom: -3px;
  width: 100%;
  height: 1px;
  content: "";
  background: currentColor;
  opacity: 0;
  transform: scaleX(0.4);
  transform-origin: left;
  transition:
    opacity 160ms ease,
    transform 180ms ease;
}

.signup-link:hover::after,
.forgot-password-link:hover::after {
  opacity: 0.8;
  transform: scaleX(1);
}

.back-icon-link {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 28px;
  margin: -5px 0 -5px;
  padding: 0;
  border: 0;
  background: transparent;
  color: rgba(255, 252, 255, 0.72);
  cursor: pointer;
  font-family: inherit;
  font-size: 0.9rem;
  font-weight: 600;
  letter-spacing: 0;
  transition:
    color 160ms ease,
    transform 160ms ease;
}

.back-icon-link::after {
  position: absolute;
  left: 0;
  bottom: -3px;
  width: 100%;
  height: 1px;
  content: "";
  background: currentColor;
  opacity: 0;
  transform: scaleX(0.4);
  transform-origin: left;
  transition:
    opacity 160ms ease,
    transform 180ms ease;
}

.back-icon-link:hover {
  color: rgba(255, 252, 255, 0.94);
}

.back-icon-link:hover::after {
  opacity: 0.8;
  transform: scaleX(1);
}

.back-icon-link:active {
  transform: translateX(-1px);
}

.back-icon-link svg {
  width: 20px;
  height: 20px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2.1;
}

.welcome-copy {
  margin-bottom: 22px;
  text-align: center;
}

.welcome-title {
  margin: 0 0 8px;
  color: rgba(255, 252, 255, 0.97);
  font-size: clamp(1.66rem, 4.7vw, 1.98rem);
  font-weight: 650;
  letter-spacing: 0;
  line-height: 1;
}

.welcome-subtitle {
  margin: 0;
  color: rgba(255, 252, 255, 0.68);
  font-size: clamp(0.92rem, 2.55vw, 1rem);
  font-weight: 500;
  letter-spacing: 0;
  line-height: 1.25;
}

.google-button-frame {
  position: relative;
  width: 100%;
  min-height: 52px;
  display: grid;
  place-items: center;
}

.google-button-host {
  position: absolute;
  inset: 0;
  z-index: 2;
  width: 100%;
  min-height: 52px;
  display: grid;
  place-items: center;
  opacity: 0.001;
}

.google-button-host.is-hidden {
  display: none;
}

.google-app-button {
  position: relative;
  z-index: 1;
  width: 100%;
  min-height: 52px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  overflow: hidden;
  border: 1px solid rgba(225, 245, 236, 0.17);
  border-radius: 8px;
  background:
    linear-gradient(135deg, rgba(236, 250, 241, 0.055), rgba(235, 218, 244, 0.055)),
    rgba(4, 5, 8, 0.48);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.095),
    inset 0 -1px 0 rgba(0, 0, 0, 0.38);
  color: rgba(250, 248, 252, 0.92);
  cursor: pointer;
  font: inherit;
  font-size: 0.96rem;
  font-weight: 650;
  letter-spacing: 0;
  pointer-events: none;
  transition:
    border-color 180ms ease,
    background 180ms ease,
    box-shadow 180ms ease,
    transform 180ms ease;
}

.google-app-button::before {
  position: absolute;
  inset: 0;
  content: "";
  background: linear-gradient(
    110deg,
    transparent,
    rgba(226, 247, 237, 0.07),
    transparent
  );
  opacity: 0;
  transform: translateX(-42%);
  transition:
    opacity 180ms ease,
    transform 260ms ease;
}

.google-button-frame:hover .google-app-button:not(:disabled) {
  border-color: rgba(225, 245, 236, 0.3);
  background:
    linear-gradient(135deg, rgba(236, 250, 241, 0.085), rgba(235, 218, 244, 0.08)),
    rgba(6, 7, 11, 0.6);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.12),
    inset 0 -1px 0 rgba(0, 0, 0, 0.4);
}

.google-button-frame:hover .google-app-button:not(:disabled)::before {
  opacity: 1;
  transform: translateX(42%);
}

.google-app-button:active {
  transform: translateY(1px);
}

.google-app-button:disabled {
  opacity: 0.72;
}

.google-icon-box {
  position: relative;
  display: grid;
  place-items: center;
  width: 25px;
  height: 25px;
  flex: 0 0 auto;
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.98);
  box-shadow: 0 1px 5px rgba(0, 0, 0, 0.18);
}

.google-icon-box svg {
  width: 19px;
  height: 19px;
}

.google-app-button span:last-child {
  position: relative;
}

.auth-divider {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 16px;
  margin: 22px 0 20px;
  color: rgba(255, 252, 255, 0.56);
}

.auth-divider span {
  height: 1px;
  background: linear-gradient(
    90deg,
    transparent,
    rgba(255, 252, 255, 0.22),
    transparent
  );
}

.auth-divider p {
  margin: 0;
  font-size: 0.86rem;
  font-weight: 600;
  line-height: 1;
}

.email-form {
  display: grid;
  gap: 12px;
}

.login-card-signup .welcome-copy {
  margin-bottom: 18px;
}

.login-card-signup .email-form {
  gap: 10px;
}

.login-card-signup .field-group input {
  height: 46px;
}

.login-card-signup .email-submit-button {
  min-height: 48px;
  margin-top: 8px;
}

.field-group {
  display: grid;
  color: rgba(255, 252, 255, 0.72);
  font-size: 0.82rem;
  font-weight: 600;
  line-height: 1;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}

.field-group input {
  width: 100%;
  height: 49px;
  border: 1px solid rgba(225, 245, 236, 0.14);
  border-radius: 8px;
  background:
    linear-gradient(135deg, rgba(236, 250, 241, 0.055), rgba(235, 218, 244, 0.045)),
    rgba(3, 4, 7, 0.42);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.08),
    inset 0 -1px 0 rgba(0, 0, 0, 0.34);
  color: rgba(255, 252, 255, 0.94);
  font: inherit;
  font-size: 0.96rem;
  font-weight: 500;
  letter-spacing: 0;
  outline: none;
  padding: 0 13px;
  transition:
    border-color 160ms ease,
    background 160ms ease,
    box-shadow 160ms ease;
}

.field-group input::placeholder {
  color: rgba(255, 252, 255, 0.52);
}

.field-group input:focus {
  border-color: rgba(225, 245, 236, 0.32);
  background:
    linear-gradient(135deg, rgba(236, 250, 241, 0.075), rgba(235, 218, 244, 0.06)),
    rgba(5, 6, 10, 0.54);
  box-shadow:
    0 0 0 3px rgba(225, 245, 236, 0.07),
    inset 0 1px 0 rgba(255, 255, 255, 0.09);
}

.text-input-control,
.password-control {
  position: relative;
  display: block;
}

.text-input-control input {
  padding-left: 44px;
  padding-right: 13px;
}

.password-control input {
  padding-left: 44px;
  padding-right: 48px;
}

.field-icon {
  position: absolute;
  top: 50%;
  left: 14px;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  color: rgba(255, 252, 255, 0.48);
  pointer-events: none;
  transform: translateY(-50%);
}

.password-field-icon {
  left: 14px;
}

.field-icon svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.8;
}

.password-toggle {
  position: absolute;
  top: 50%;
  right: 7px;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: rgba(255, 252, 255, 0.54);
  cursor: pointer;
  transform: translateY(-50%);
  transition:
    background 160ms ease,
    color 160ms ease,
    transform 160ms ease;
}

.password-toggle:hover {
  background: rgba(255, 252, 255, 0.06);
  color: rgba(255, 252, 255, 0.84);
}

.password-toggle:active {
  transform: translateY(-50%) scale(0.96);
}

.password-toggle svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.9;
}

.email-submit-button {
  position: relative;
  width: 100%;
  min-height: 50px;
  margin-top: 8px;
  overflow: hidden;
  border: 1px solid rgba(255, 252, 255, 0.16);
  border-radius: 8px;
  background:
    linear-gradient(135deg, rgba(225, 245, 236, 0.2), rgba(235, 218, 244, 0.16)),
    rgba(255, 252, 255, 0.04);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.14),
    0 16px 34px rgba(0, 0, 0, 0.22);
  color: rgba(255, 252, 255, 0.95);
  cursor: pointer;
  font: inherit;
  font-size: 0.96rem;
  font-weight: 650;
  letter-spacing: 0;
  transition:
    border-color 180ms ease,
    background 180ms ease,
    box-shadow 180ms ease,
    transform 180ms ease;
}

.email-submit-button::before {
  position: absolute;
  inset: 0;
  content: "";
  background: linear-gradient(
    110deg,
    transparent,
    rgba(255, 252, 255, 0.11),
    transparent
  );
  opacity: 0;
  transform: translateX(-42%);
  transition:
    opacity 180ms ease,
    transform 260ms ease;
}

.email-submit-button:hover {
  border-color: rgba(255, 252, 255, 0.24);
  background:
    linear-gradient(135deg, rgba(225, 245, 236, 0.26), rgba(235, 218, 244, 0.2)),
    rgba(255, 252, 255, 0.05);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.18),
    0 18px 38px rgba(0, 0, 0, 0.26);
}

.email-submit-button:hover::before {
  opacity: 1;
  transform: translateX(42%);
}

.email-submit-button:active {
  transform: translateY(1px);
}

.email-submit-button:disabled {
  cursor: wait;
  opacity: 0.72;
}

.email-submit-button span {
  position: relative;
}

@media (max-width: 460px) {
  .login-layer {
    align-items: center;
    padding: 18px;
  }

  .login-card-face {
    width: 100%;
    padding: 17px 24px 26px;
  }

  .login-header {
    margin-bottom: 18px;
  }

  .brand-lockup {
    gap: 12px;
  }

  .brand-lockup :deep(.pulsar-logo) {
    width: clamp(48px, 14vw, 58px);
    height: clamp(48px, 14vw, 58px);
  }

  .app-title {
    font-size: clamp(1.52rem, 7.2vw, 1.84rem);
  }

  .app-tagline {
    font-size: clamp(0.62rem, 3vw, 0.7rem);
  }

  .signup-link,
  .forgot-password-link {
    font-size: 0.9rem;
  }

  .forgot-password-link {
    margin-top: 16px;
  }

  .welcome-copy {
    margin-bottom: 20px;
  }

  .welcome-title {
    font-size: clamp(1.48rem, 7vw, 1.72rem);
  }

  .welcome-subtitle {
    font-size: clamp(0.9rem, 4vw, 0.98rem);
  }

  .auth-divider {
    gap: 13px;
    margin: 20px 0 18px;
  }

  .email-form {
    gap: 12px;
  }

  .field-group input {
    height: 48px;
  }
}

.app-toast {
  position: fixed;
  top: 22px;
  left: 50%;
  z-index: 6;
  max-width: min(320px, calc(100vw - 32px));
  padding: 13px 15px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 8px;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0.035)),
    rgba(8, 9, 11, 0.78);
  box-shadow:
    0 18px 44px rgba(0, 0, 0, 0.38),
    inset 0 1px 0 rgba(255, 255, 255, 0.1);
  color: rgba(248, 246, 250, 0.9);
  font-size: 0.88rem;
  font-weight: 600;
  line-height: 1.3;
  pointer-events: none;
  transform: translateX(-50%);
  backdrop-filter: blur(18px) saturate(112%);
  animation: toast-in 180ms ease-out;
}

.app-toast.error {
  border-color: rgba(255, 196, 205, 0.2);
  color: rgba(255, 207, 216, 0.94);
}

.app-toast.success {
  border-color: rgba(211, 247, 223, 0.2);
  color: rgba(220, 250, 230, 0.96);
}

@keyframes toast-in {
  from {
    opacity: 0;
    transform: translate(-50%, -8px);
  }

  to {
    opacity: 1;
    transform: translate(-50%, 0);
  }
}

@media (max-width: 460px) {
  .app-toast {
    top: 14px;
    width: calc(100vw - 28px);
    max-width: 360px;
  }
}

@media (max-width: 360px) {
  .login-layer {
    padding: 12px;
  }

  .login-card-face {
    padding: 15px 20px 22px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .login-card {
    transition: none;
  }
}
</style>
