import { describe, expect, it } from "vitest";
import { getDocumentInfoViewportStyle } from "./documentInfoViewport";

describe("document information visible viewport", () => {
  it("follows the visible height and offset when the mobile keyboard opens", () => {
    expect(getDocumentInfoViewportStyle({ height: 420, offsetTop: 56 }, 844)).toEqual({
      "--document-info-viewport-height": "420px",
      "--document-info-viewport-top": "56px",
    });
    expect(getDocumentInfoViewportStyle({ height: 844, offsetTop: 0 }, 844)).toEqual({
      "--document-info-viewport-height": "844px",
      "--document-info-viewport-top": "0px",
    });
  });

  it("uses the window height when visual viewport is unavailable", () => {
    expect(getDocumentInfoViewportStyle(null, 568)).toEqual({
      "--document-info-viewport-height": "568px",
      "--document-info-viewport-top": "0px",
    });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects an invalid viewport height of %s", (height) => {
    expect(getDocumentInfoViewportStyle({ height, offsetTop: -20 }, 568)).toEqual({
      "--document-info-viewport-height": "568px",
      "--document-info-viewport-top": "0px",
    });
  });

  it("never puts non-finite dimensions in the stylesheet", () => {
    expect(getDocumentInfoViewportStyle({ height: Number.NaN, offsetTop: Number.POSITIVE_INFINITY }, Number.NaN))
      .toEqual({ "--document-info-viewport-height": "0px", "--document-info-viewport-top": "0px" });
  });
});
