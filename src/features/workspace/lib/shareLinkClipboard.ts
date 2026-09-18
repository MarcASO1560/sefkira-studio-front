export type ShareLinkCopyResult = "copied" | "selected" | "unavailable";

/** Keep a selectable link available when a browser does not grant clipboard access. */
export const copyShareLinkText = async (
  text: string,
  input: HTMLInputElement | null,
  isCurrent: () => boolean = () => true,
): Promise<ShareLinkCopyResult> => {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return "copied";
    }
  } catch {
    // Older mobile browsers and restrictive browser settings need a selection.
  }

  if (!isCurrent() || !input?.isConnected || input.value !== text) return "unavailable";
  input.focus({ preventScroll: true });
  input.select();
  input.setSelectionRange(0, text.length);
  try {
    // This compatibility adapter is only used after modern clipboard copying fails.
    const legacyDocument = document as unknown as { execCommand?: (command: "copy") => boolean };
    if (legacyDocument.execCommand?.("copy")) return "copied";
  } catch {
    // Leave the link selected for the browser's native Copy action.
  }
  return "selected";
};
