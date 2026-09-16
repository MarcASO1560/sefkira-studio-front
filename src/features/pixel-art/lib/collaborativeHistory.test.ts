import { describe, expect, it } from "vitest";
import { clonePixelArtDocument, createPixelArtDocument, createPixelLayer } from "./document";
import { rebaseImageHistoryDocument } from "./collaborativeHistory";

const initial = () => createPixelArtDocument(2, 1, {
  layers: [createPixelLayer(2, 1, { id: "layer", pixels: [null, null] })],
});

describe("collaborative image history", () => {
  it("undoes our pixels without undoing an external edit on another pixel", () => {
    const oldSnapshot = initial();
    const previous = initial();
    previous.layers[0]!.pixels[0] = "#FF0000";
    const next = clonePixelArtDocument(previous);
    next.layers[0]!.pixels[1] = "#00FF00";
    expect(rebaseImageHistoryDocument(oldSnapshot, previous, next).layers[0]!.pixels)
      .toEqual([null, "#00FF00"]);
    expect(oldSnapshot.layers[0]!.pixels).toEqual([null, null]);
  });

  it("preserves a later external change on the same pixel", () => {
    const previous = initial();
    previous.layers[0]!.pixels[0] = "#FF0000";
    const next = clonePixelArtDocument(previous);
    next.layers[0]!.pixels[0] = "#0000FF";
    expect(rebaseImageHistoryDocument(initial(), previous, next).layers[0]!.pixels)
      .toEqual(["#0000FF", null]);
  });

  it("does not turn our own acknowledgement into an external history change", () => {
    const previous = initial();
    previous.layers[0]!.pixels[0] = "#FF0000";
    expect(rebaseImageHistoryDocument(initial(), previous, clonePixelArtDocument(previous))
      .layers[0]!.pixels).toEqual([null, null]);
  });

  it("preserves remote layer additions and property changes through undo", () => {
    const previous = initial();
    const next = clonePixelArtDocument(previous);
    next.layers[0]!.name = "Remote name";
    next.layers.push(createPixelLayer(2, 1, { id: "other" }));
    const result = rebaseImageHistoryDocument(initial(), previous, next);
    expect(result.layers.map((layer) => layer.id)).toEqual(["layer", "other"]);
    expect(result.layers[0]!.name).toBe("Remote name");
  });

  it("does not resurrect a layer removed externally", () => {
    const previous = initial();
    previous.layers.push(createPixelLayer(2, 1, { id: "other" }));
    const next = clonePixelArtDocument(previous);
    next.layers.splice(0, 1);
    expect(rebaseImageHistoryDocument(previous, previous, next).layers.map((layer) => layer.id))
      .toEqual(["other"]);
  });

  it("does not undo a layer creation once someone else has used that layer", () => {
    const oldSnapshot = initial();
    const previous = initial();
    previous.layers.push(createPixelLayer(2, 1, { id: "our-new-layer" }));
    const next = clonePixelArtDocument(previous);
    next.layers[1]!.pixels[0] = "#00FF00";
    const rebased = rebaseImageHistoryDocument(oldSnapshot, previous, next);
    expect(rebased.layers.map((layer) => layer.id)).toEqual(["layer", "our-new-layer"]);
    expect(rebased.layers[1]!.pixels).toEqual(["#00FF00", null]);
  });

  it("safely replaces dimension-dependent history after a resize", () => {
    const next = createPixelArtDocument(3, 1);
    expect(rebaseImageHistoryDocument(initial(), initial(), next)).toEqual(next);
  });
});
