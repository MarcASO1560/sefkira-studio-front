import { describe, expect, it } from "vitest";
import { canBlockProjectMember, isShareLinkExpired, projectAccessFailureMessage, shareExpirationToUtc, shareLinkFailureMessage, shouldShareLinkRedirectToLogin, utcToLocalDateTimeInput } from "./shareLinkExpiration";

describe("share link expiration", () => {
  const now = Date.parse("2026-09-17T10:00:00Z");
  it("serializes all duration presets as UTC deadlines and never as explicit null", () => {
    expect(shareExpirationToUtc("1hour", "", now)).toBe("2026-09-17T11:00:00.000Z");
    expect(shareExpirationToUtc("24hours", "", now)).toBe("2026-09-18T10:00:00.000Z");
    expect(shareExpirationToUtc("7days", "", now)).toBe("2026-09-24T10:00:00.000Z");
    expect(shareExpirationToUtc("30days", "", now)).toBe("2026-10-17T10:00:00.000Z");
    expect(shareExpirationToUtc("never", "", now)).toBeNull();
  });
  it("converts datetime-local using the user's local timezone, with a round-trip", () => {
    const local = new Date(2026, 9, 20, 14, 35);
    expect(shareExpirationToUtc("custom", "2026-10-20T14:35", now)).toBe(local.toISOString());
    expect(utcToLocalDateTimeInput(local.toISOString())).toBe("2026-10-20T14:35");
  });
  it("rejects missing, impossible, past, current and timezone-suffixed custom deadlines", () => {
    for (const value of ["", "2026-02-30T14:35", "2020-01-01T10:00", "2026-10-20T14:35Z", "2026-10-20T25:00"]) {
      expect(() => shareExpirationToUtc("custom", value, now)).toThrow();
    }
    expect(() => shareExpirationToUtc("custom", utcToLocalDateTimeInput(new Date(now).toISOString()), now)).toThrow();
  });
  it("preserves never-expiring legacy links, expires at the exact deadline and respects server expiry", () => {
    expect(isShareLinkExpired({ expires_at: null, is_expired: false }, now)).toBe(false);
    expect(isShareLinkExpired({ expires_at: new Date(now).toISOString(), is_expired: false }, now)).toBe(true);
    expect(isShareLinkExpired({ expires_at: new Date(now + 1).toISOString(), is_expired: false }, now)).toBe(false);
    expect(isShareLinkExpired({ expires_at: null, is_expired: true }, now)).toBe(true);
    expect(isShareLinkExpired(null, now)).toBe(false);
  });
  it("provides distinct expired, blocked and revoked link messages", () => {
    expect(shareLinkFailureMessage(410)).toContain("expired");
    expect(shareLinkFailureMessage(403, { code: "project_user_blocked" })).toContain("blocked");
    expect(shareLinkFailureMessage(403)).toContain("access");
    expect(shareLinkFailureMessage(404)).toContain("active link");
    expect(projectAccessFailureMessage({ code: "project_block_owner_protected" }, 400)).toContain("role");
    expect(projectAccessFailureMessage({ code: "share_link_expiration_invalid" }, 400)).toContain("future");
  });
  it("does not offer blocking yourself, the original owner or a coowner until demoted", () => {
    const member = { email: "other@example.com", role: "editor" as const, is_owner: false };
    expect(canBlockProjectMember(member, "me@example.com")).toBe(true);
    expect(canBlockProjectMember({ ...member, role: "viewer" }, "me@example.com")).toBe(true);
    expect(canBlockProjectMember({ ...member, is_owner: true }, "me@example.com")).toBe(false);
    expect(canBlockProjectMember({ ...member, role: "owner" }, "me@example.com")).toBe(false);
    expect(canBlockProjectMember(member, " OTHER@example.com ")).toBe(false);
  });
  it("redirects only authentication failures to login, never blocked or generic 403 permission failures", () => {
    expect(shouldShareLinkRedirectToLogin(401)).toBe(true);
    expect(shouldShareLinkRedirectToLogin(403, "Could not validate credentials")).toBe(true);
    expect(shouldShareLinkRedirectToLogin(403, { code: "project_user_blocked", message: "Could not validate credentials" })).toBe(false);
    expect(shouldShareLinkRedirectToLogin(403, "Not enough permissions")).toBe(false);
    expect(shouldShareLinkRedirectToLogin(410, "Could not validate credentials")).toBe(false);
  });
  it.each([408, 429, 500, 503])("identifies temporary failures without claiming the link was revoked: %s", (status) => {
    expect(shareLinkFailureMessage(status)).toContain("try again");
    expect(shareLinkFailureMessage(status)).not.toContain("active link");
  });
});
