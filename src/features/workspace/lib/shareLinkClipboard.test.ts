import { afterEach, describe, expect, it, vi } from "vitest";
import { copyShareLinkText } from "./shareLinkClipboard";

const text = "https://www.sefkirastudio.com/share/token";
const setup = (clipboard?: { writeText: (text: string) => Promise<void> }, legacyCopies = false) => {
  vi.stubGlobal("navigator", { clipboard });
  const execCommand = vi.fn(() => legacyCopies);
  vi.stubGlobal("document", { execCommand });
  const input = { value: text, isConnected: true, focus: vi.fn(), select: vi.fn(), setSelectionRange: vi.fn() };
  return { input, element: input as unknown as HTMLInputElement, execCommand };
};
afterEach(() => vi.unstubAllGlobals());

describe("share link clipboard", () => {
  it("copies with the modern clipboard without changing focus or selection", async () => {
    const writeText = vi.fn(async () => {});
    const { element, input, execCommand } = setup({ writeText });
    expect(await copyShareLinkText(text, element)).toBe("copied");
    expect(writeText).toHaveBeenCalledWith(text);
    expect(input.focus).not.toHaveBeenCalled();
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("uses the selected readonly link when a mobile browser has no Clipboard API", async () => {
    const { element, input, execCommand } = setup(undefined, true);
    expect(await copyShareLinkText(text, element)).toBe("copied");
    expect(input.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(input.select).toHaveBeenCalled();
    expect(input.setSelectionRange).toHaveBeenCalledWith(0, text.length);
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("keeps the link selected for manual copying when permission is denied", async () => {
    const { element, input } = setup({ writeText: vi.fn(async () => { throw new Error("Permission denied"); }) });
    expect(await copyShareLinkText(text, element)).toBe("selected");
    expect(input.select).toHaveBeenCalled();
  });

  it("offers manual copying when a browser also rejects legacy copying", async () => {
    const { element, execCommand } = setup();
    execCommand.mockImplementation(() => { throw new Error("Unsupported"); });
    expect(await copyShareLinkText(text, element)).toBe("selected");
  });

  it.each(["closed", "changed", "detached"])("does not select an obsolete link after async clipboard denial: %s", async (reason) => {
    const { element, input, execCommand } = setup({ writeText: vi.fn(async () => { throw new Error("Permission denied"); }) });
    if (reason === "changed") input.value = "new link";
    if (reason === "detached") input.isConnected = false;
    expect(await copyShareLinkText(text, element, () => reason !== "closed")).toBe("unavailable");
    expect(input.focus).not.toHaveBeenCalled();
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("returns unavailable when the link input is absent", async () => {
    setup();
    expect(await copyShareLinkText(text, null)).toBe("unavailable");
  });
});
