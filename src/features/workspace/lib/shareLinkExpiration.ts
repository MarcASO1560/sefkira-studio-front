import type { ProjectAccessUserPublic, ProjectShareLinkPublic } from "../../../lib/api";

export const canBlockProjectMember = (
  user: Pick<ProjectAccessUserPublic, "email" | "role" | "is_owner">,
  currentUserEmail: string,
): boolean => !user.is_owner && user.role !== "owner" &&
  user.email.trim().toLowerCase() !== currentUserEmail.trim().toLowerCase();

export type ShareExpirationPreset = "1hour" | "24hours" | "7days" | "30days" | "never" | "custom";
export const SHARE_EXPIRATION_OPTIONS: ReadonlyArray<{ value: ShareExpirationPreset; label: string }> = [
  { value: "1hour", label: "1 hour" },
  { value: "24hours", label: "24 hours" },
  { value: "7days", label: "7 days" },
  { value: "30days", label: "30 days" },
  { value: "never", label: "No expiration" },
  { value: "custom", label: "Custom date and time" },
];

const PRESET_MILLISECONDS = {
  "1hour": 60 * 60 * 1000,
  "24hours": 24 * 60 * 60 * 1000,
  "7days": 7 * 24 * 60 * 60 * 1000,
  "30days": 30 * 24 * 60 * 60 * 1000,
};

/** datetime-local values are LOCAL wall-clock times, never UTC strings. */
export const shareExpirationToUtc = (
  preset: ShareExpirationPreset,
  customLocalDate: string,
  now = Date.now(),
): string | null => {
  if (preset === "never") return null;
  if (preset !== "custom") return new Date(now + PRESET_MILLISECONDS[preset]).toISOString();
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(customLocalDate);
  if (!parts) throw new Error("Choose an expiration date and time.");
  const [, year, month, day, hours, minutes, seconds = "0"] = parts;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hours), Number(minutes), Number(seconds));
  // Reject impossible dates and DST gaps instead of silently moving the deadline.
  if (date.getFullYear() !== Number(year) || date.getMonth() !== Number(month) - 1 ||
    date.getDate() !== Number(day) || date.getHours() !== Number(hours) ||
    date.getMinutes() !== Number(minutes) || date.getSeconds() !== Number(seconds)) {
    throw new Error("Choose a valid expiration date and time in your local timezone.");
  }
  if (!Number.isFinite(date.getTime()) || date.getTime() <= now) {
    throw new Error("The expiration date and time must be in the future.");
  }
  return date.toISOString();
};

export const utcToLocalDateTimeInput = (utc: string): string => {
  const date = new Date(utc);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export const isShareLinkExpired = (
  link: Pick<ProjectShareLinkPublic, "expires_at" | "is_expired"> | null,
  now = Date.now(),
): boolean => Boolean(link && (link.is_expired || (link.expires_at && new Date(link.expires_at).getTime() <= now)));

export const shareLinkFailureMessage = (status: number, detail?: unknown): string => {
  const code = typeof detail === "object" && detail !== null && "code" in detail ? detail.code : detail;
  if (status === 410 || code === "share_link_expired") {
    return "This share link has expired. Ask a project owner for a renewed link.";
  }
  if (code === "project_user_blocked") {
    return "You are blocked from this project. A project owner must unblock you before you can join.";
  }
  if (status === 403) return "You cannot join this project. Ask a project owner to check your access or unblock you.";
  return "This share link is not available anymore. Ask a project owner for an active link.";
};

export const shouldShareLinkRedirectToLogin = (status: number, detail?: unknown): boolean =>
  status === 401 || (status === 403 && detail === "Could not validate credentials");

export const projectAccessFailureMessage = (detail: unknown, status: number): string => {
  if (typeof detail === "string") return detail;
  if (typeof detail === "object" && detail !== null) {
    const value = detail as { code?: unknown; message?: unknown };
    if (value.code === "share_link_expiration_invalid") return "The expiration date and time must be in the future.";
    if (value.code === "share_link_rotation_required") return "Renew this expired link to create a new token.";
    if (value.code === "project_block_owner_protected") return "Change this owner's role to editor or viewer before blocking them.";
    if (typeof value.message === "string") return value.message;
  }
  return `API request failed: ${status}`;
};
