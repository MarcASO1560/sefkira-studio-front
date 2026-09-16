export type PixelColor = string | null;

export type ImageResizeAnchor =
  | "top-left"
  | "top"
  | "top-right"
  | "left"
  | "center"
  | "right"
  | "bottom-left"
  | "bottom"
  | "bottom-right";

export type ImageTool =
  | "pencil"
  | "graffiti"
  | "erase"
  | "fill"
  | "picker"
  | "line"
  | "rectangle"
  | "ellipse"
  | "select"
  | "move"
  | "rotate";

export type SaveStatus = "saved" | "saving" | "dirty" | "error" | "offline";

export type ImageSelectionKind = "rectangle" | "lasso" | "wand";

export type ImageSelectionMode = "replace" | "add" | "subtract" | "intersect";

export type ImageSelectionMask = {
  width: number;
  height: number;
  data: Uint8Array;
};

export type PixelLayer = {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  pixels: PixelColor[];
};

export type PixelArtDocumentV2 = {
  version: 2;
  width: number;
  height: number;
  palette: string[];
  layers: PixelLayer[];
};

export type ImageSelection = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Missing on legacy collaboration messages, which are treated as rectangles. */
  kind?: ImageSelectionKind;
  /** Full-canvas, row-major binary mask. Missing legacy selections use the bounds. */
  mask?: ImageSelectionMask;
};

export type ImageEditorSnapshot = {
  document: PixelArtDocumentV2;
  activeLayerId: string;
  selection: ImageSelection | null;
};
