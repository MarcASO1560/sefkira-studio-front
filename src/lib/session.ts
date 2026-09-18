export const ACCESS_TOKEN_COOKIE_NAME = "sefkira_access_token";
export const ACCESS_TOKEN_STORAGE_KEY = "sefkira_access_token";
export const LEGACY_ACCESS_TOKEN_STORAGE_KEY = "pixel_access_token";
export const ACCESS_TOKEN_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

const AUTH_PATHS = new Set(["/", "/login"]);
const PROTECTED_PATH_PREFIXES = ["/studio", "/app", "/projects"];
const API_PATH_PREFIXES = ["/api/"];

export const isAuthPath = (pathname: string) => AUTH_PATHS.has(pathname);

export const isProtectedPath = (pathname: string) =>
  PROTECTED_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

export const isApiPath = (pathname: string) =>
  API_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));

export const isFrameworkAssetPath = (pathname: string) =>
  pathname.startsWith("/_astro") ||
  pathname.startsWith("/favicon") ||
  pathname.includes(".");

export const createLoginRedirectUrl = (requestUrl: URL) => {
  const loginUrl = new URL("/login", requestUrl);
  loginUrl.hash = `next=${encodeURIComponent(`${requestUrl.pathname}${requestUrl.search}`)}`;
  return loginUrl;
};

export const createSafeRedirectPath = (rawPath: string | null) => {
  if (!rawPath || !rawPath.startsWith("/") || rawPath.startsWith("//")) {
    return "/studio";
  }

  if (rawPath === "/workspace" || rawPath.startsWith("/workspace/")) {
    return rawPath.replace(/^\/workspace/, "/studio");
  }

  return rawPath;
};

export const readClientAccessToken = () => {
  return "";
};

export const clearStoredAccessTokens = () => {
  if (typeof window === "undefined") {
    return;
  }

  for (const key of [ACCESS_TOKEN_STORAGE_KEY, LEGACY_ACCESS_TOKEN_STORAGE_KEY]) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Legacy storage is optional; the active session uses an HttpOnly cookie.
    }
  }
};

export const clearClientSession = async () => {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return false;
  }

  clearStoredAccessTokens();

  let response: Response;
  try {
    response = await fetch("/api/v1/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
      },
      body: "{}",
    });
  } catch {
    return false;
  }

  if (!response.ok) {
    return false;
  }

  document.cookie = `${ACCESS_TOKEN_COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax`;
  window.dispatchEvent(new CustomEvent("pixel:auth", { detail: { authenticated: false } }));
  return true;
};
