import { describe, expect, it } from "vitest";
import { validateImageDimensionDrafts } from "./imageDimensionDrafts";

describe("image dimension drafts", () => {
  it.each([[1024, 1024], [2048, 2048], [4096, 1024], [1, 4096]])("accepts %i × %i without silently clamping", (width, height) => {
    expect(validateImageDimensionDrafts(width, height)).toBeNull();
  });
  it.each([[0, 32], [-1, 32], [2.5, 32], [NaN, 32], [32, Infinity]])("rejects invalid dimensions before allocation", (width, height) => {
    expect(validateImageDimensionDrafts(width, height)).toMatch(/positive whole numbers/);
  });
  it("explains the side limit", () => {
    expect(validateImageDimensionDrafts(5000, 10)).toContain("4,096 px");
  });
  it("explains the total area limit", () => {
    expect(validateImageDimensionDrafts(4096, 4096)).toContain("4,194,304 pixels");
  });
  it("checks total layer capacity before allocating a resized document", () => {
    expect(validateImageDimensionDrafts(1024, 1024, 16)).toBeNull();
    expect(validateImageDimensionDrafts(1024, 1024, 17)).toMatch(/fewer layers/);
    expect(validateImageDimensionDrafts(2048, 2048, 5)).toMatch(/fewer layers/);
  });
});
