import { describe, expect, it } from "vitest";
import { buildDocumentInfoDetails, groupDocumentInfoDetails } from "./documentInfo";

const baseInfo = { projectName: "Demo", typeLabel: "Image" };

describe("document information", () => {
  it("shows project and type for placeholder document kinds without image fields", () => {
    expect(buildDocumentInfoDetails({ ...baseInfo, typeLabel: "Text" })).toEqual([
      { label: "Project", value: "Demo" },
      { label: "Type", value: "Text" },
    ]);
  });
  it("shows current dimensions and layers for an image", () => {
    expect(buildDocumentInfoDetails({ ...baseInfo, image: { width: 32, height: 24, layerCount: 3 } })).toContainEqual(
      { label: "Size", value: "32 × 24 px" },
    );
    expect(buildDocumentInfoDetails({ ...baseInfo, image: { width: 32, height: 24, layerCount: 3 } })).toContainEqual(
      { label: "Layers", value: "3" },
    );
  });
  it("includes valid timestamps without guessing missing dates", () => {
    const createdAt = "2026-09-15T08:00:00Z";
    const details = buildDocumentInfoDetails({ ...baseInfo, createdAt, updatedAt: "invalid" });
    expect(details).toContainEqual({ label: "Created", value: new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium", timeStyle: "short",
    }).format(new Date(createdAt)) });
    expect(details.some(({ label }) => label === "Updated")).toBe(false);
  });
  it.each([undefined, null, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "does not invent a revision for %s",
    (revision) => {
      expect(buildDocumentInfoDetails({ ...baseInfo, revision }).some(({ label }) => label === "Revision")).toBe(false);
    },
  );
  it.each([0, 12])("shows a valid revision of %s", (revision) => {
    expect(buildDocumentInfoDetails({ ...baseInfo, revision })).toContainEqual({ label: "Revision", value: String(revision) });
  });
});

describe("document information sections", () => {
  it("groups every image detail once, keeping the input unchanged", () => {
    const details = buildDocumentInfoDetails({ ...baseInfo, image: { width: 32, height: 24, layerCount: 3 },
      createdAt: "2026-09-15T08:00:00Z", updatedAt: "2026-09-16T08:00:00Z", revision: 12 });
    const original = [...details];
    const sections = groupDocumentInfoDetails(details);
    expect(sections.map(({ id, details }) => [id, details.map(({ label }) => label)])).toEqual([
      ["document", ["Project", "Type"]],
      ["canvas", ["Size", "Layers"]],
      ["activity", ["Created", "Updated", "Revision"]],
    ]);
    expect(sections.flatMap(({ details }) => details)).toEqual(original);
    expect(details).toEqual(original);
  });

  it("omits empty sections for placeholder documents", () => {
    expect(groupDocumentInfoDetails(buildDocumentInfoDetails({ ...baseInfo, typeLabel: "Text" })))
      .toEqual([{ id: "document", title: "Document", details: [
        { label: "Project", value: "Demo" }, { label: "Type", value: "Text" },
      ] }]);
    expect(groupDocumentInfoDetails([])).toEqual([]);
  });

  it("keeps additional metadata in the document section", () => {
    const detail = { label: "Author", value: "Marc" };
    expect(groupDocumentInfoDetails([detail])).toEqual([{ id: "document", title: "Document", details: [detail] }]);
  });
});
