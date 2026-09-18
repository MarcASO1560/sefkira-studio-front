export type DocumentChatSticker = {
  readonly id: string;
  readonly label: string;
  readonly src: string;
  readonly width: number;
  readonly height: number;
  readonly frames: number;
  readonly durationMs: number;
  readonly columns: number;
  readonly rows: number;
  readonly previewFrame: number;
};

// The source sheets contain 16 frames, ordered left to right, then top to bottom.
// They occupy a 5×4 grid; its last four cells are transparent padding.
// Frame 9 shows the expression; the first and last frames only show a tiny bubble.
const tinyRpgStickers = [
  ["neutral", "Neutral", "Neutral"],
  ["angry", "Angry", "Angry"],
  ["sad", "Sad", "Crying"],
  ["laughing", "Laughing", "Laughing"],
  ["eager", "Eager", "Eager"],
  ["shocked", "Shocked", "OMG"],
  ["speechless", "Speechless", "Speechless"],
  ["sleepy", "Sleepy", "Sleepy"],
  ["quiet", "Quiet", "Silence"],
  ["dizzy", "Dizzy", "Dizzy"],
  ["love", "Love", "Love"],
  ["surprised", "Surprised", "Exclamation"],
  ["confused", "Confused", "Question"],
  ["thinking", "Thinking", "Thinking"],
  ["idea", "Idea", "Idea"],
  ["lit", "Lit", "Lit"],
  ["inviting", "Inviting", "Come"],
  ["pointing-up", "Pointing up", "up"],
  ["pointing-down", "Pointing down", "Down"],
  ["pointing-left", "Pointing left", "Left"],
  ["pointing-right", "Pointing right", "Right"],
  ["drooling", "Drooling", "Drooling"],
  ["kissing", "Kissing", "Kissing"],
  ["no", "No", "No"],
  ["yes", "Yes", "Yes"],
  ["tongue-out", "Tongue out", "Tongue"],
  ["prohibited", "Prohibited", "Cant"],
  ["headblown", "Mind blown", "Headblown"],
  ["adorable", "Adorable", "Cute"],
  ["thumbs-up", "Thumbs up", "Ok"],
  ["sweating", "Sweating", "Sweat"],
  ["frustrated", "Frustrated", "Frustrated"],
] as const;

export const DOCUMENT_CHAT_STICKERS: ReadonlyArray<DocumentChatSticker> = Object.freeze(
  tinyRpgStickers.map(([slug, label, sheet]) => Object.freeze({
    id: `tiny-rpg-${slug}`,
    label,
    src: `/stickers/tiny-rpg/20250405emoticons-Sheet${sheet}.png`,
    width: 32,
    height: 32,
    frames: 16,
    durationMs: 1600,
    columns: 5,
    rows: 4,
    previewFrame: 9,
  })),
);

const stickersById = new Map(DOCUMENT_CHAT_STICKERS.map((sticker) => [sticker.id, sticker]));

export const getDocumentChatSticker = (stickerId: unknown): DocumentChatSticker | null => {
  if (typeof stickerId !== "string" || stickerId.length > 80) return null;
  return stickersById.get(stickerId) || null;
};
