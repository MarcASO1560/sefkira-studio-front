import { describe, expect, it } from "vitest";

import type { ImageTool } from "../types";
import {
  getImagePointerColorChannel,
  getImageToolColorIntent,
  type ImageColorChannel,
} from "./pointerColorIntent";

describe("image pointer color channel", () => {
  it.each([
    ["left pointerdown", { button: 0, buttons: 1 }, "primary"],
    ["right pointerdown", { button: 2, buttons: 2 }, "secondary"],
    ["held left pointermove", { button: -1, buttons: 1 }, "primary"],
    ["held right pointermove", { button: -1, buttons: 2 }, "secondary"],
    ["released pointermove", { button: -1, buttons: 0 }, null],
    ["middle button", { button: 1, buttons: 4 }, null],
    ["ambiguous left/right chord", { button: -1, buttons: 3 }, null],
  ] as const)("maps %s to %s", (_label, input, expected) => {
    expect(getImagePointerColorChannel(input)).toBe(expected);
  });
});

describe("image tool color intent", () => {
  const primaryColor = "#112233";
  const secondaryColor = "#AABBCC";
  const colorTools: ImageTool[] = [
    "pencil",
    "fill",
    "line",
    "rectangle",
    "ellipse",
  ];

  it.each(colorTools)("uses primary for left-button %s", (tool) => {
    expect(
      getImageToolColorIntent({ tool, channel: "primary", primaryColor, secondaryColor }),
    ).toEqual({ kind: "paint", color: primaryColor });
  });

  it.each(colorTools)("uses secondary for right-button %s", (tool) => {
    expect(
      getImageToolColorIntent({ tool, channel: "secondary", primaryColor, secondaryColor }),
    ).toEqual({ kind: "paint", color: secondaryColor });
  });

  it.each([
    ["primary", false],
    ["secondary", true],
  ] satisfies Array<[ImageColorChannel, boolean]>)(
    "maps the %s button to the checker phase",
    (channel, inverted) => {
      expect(
        getImageToolColorIntent({
          tool: "graffiti",
          channel,
          primaryColor,
          secondaryColor,
        }),
      ).toEqual({
        kind: "checker",
        inverted,
        primaryColor,
        secondaryColor,
      });
    },
  );

  it.each(["primary", "secondary"] satisfies ImageColorChannel[])(
    "keeps the eraser transparent for the %s channel",
    (channel) => {
      expect(
        getImageToolColorIntent({ tool: "erase", channel, primaryColor, secondaryColor }),
      ).toEqual({ kind: "paint", color: null });
    },
  );

  it.each(["primary", "secondary"] satisfies ImageColorChannel[])(
    "targets the %s swatch with the picker",
    (channel) => {
      expect(
        getImageToolColorIntent({ tool: "picker", channel, primaryColor, secondaryColor }),
      ).toEqual({ kind: "pick", channel });
    },
  );

  it.each(["select", "move", "rotate"] satisfies ImageTool[])(
    "does not assign a color action to %s",
    (tool) => {
      expect(
        getImageToolColorIntent({ tool, channel: "secondary", primaryColor, secondaryColor }),
      ).toEqual({ kind: "none" });
    },
  );
});
