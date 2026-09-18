import { describe, expect, it } from "vitest";

import type { PixelAvatarData } from "../../../lib/api";
import { documentChatDayKey, groupDocumentChatMessages, validatedDocumentChatAvatar } from "./documentChatPresentation";

const message = (id: string, author: string, date: Date) => ({
  client_message_id: id,
  author: { id: author },
  created_at: date.toISOString(),
});

describe("document chat message presentation", () => {
  it("groups consecutive messages from the same person within five minutes", () => {
    const messages = [
      message("one", "owner", new Date(2026, 0, 2, 12, 0)),
      message("two", "owner", new Date(2026, 0, 2, 12, 5)),
      message("three", "owner", new Date(2026, 0, 2, 12, 10)),
    ];
    expect(groupDocumentChatMessages(messages).map((group) => group.messages.length)).toEqual([3]);
    expect(groupDocumentChatMessages(messages)[0]?.key).toBe("owner:one");
  });

  it("starts a new group when another person speaks or the interval is longer", () => {
    const messages = [
      message("one", "owner", new Date(2026, 0, 2, 12, 0)),
      message("two", "editor", new Date(2026, 0, 2, 12, 1)),
      message("three", "owner", new Date(2026, 0, 2, 12, 2)),
      message("four", "owner", new Date(2026, 0, 2, 12, 7, 1)),
    ];
    expect(groupDocumentChatMessages(messages).map((group) => group.messages.length)).toEqual([1, 1, 1, 1]);
  });

  it("does not group across a local date boundary, even a minute apart", () => {
    const messages = [
      message("one", "owner", new Date(2026, 0, 2, 23, 59)),
      message("two", "owner", new Date(2026, 0, 3, 0, 0)),
    ];
    const groups = groupDocumentChatMessages(messages);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.day).not.toBe(groups[1]?.day);
  });

  it("does not group out-of-order or malformed dates and does not mutate the source", () => {
    const first = message("one", "owner", new Date(2026, 0, 2, 12, 1));
    const older = message("two", "owner", new Date(2026, 0, 2, 12, 0));
    const invalid = { ...first, client_message_id: "bad", created_at: "not a date" };
    const input = Object.freeze([first, older, invalid]);
    expect(groupDocumentChatMessages(input)).toHaveLength(3);
    expect(documentChatDayKey(invalid.created_at)).toBe("unknown");
    expect(input).toEqual([first, older, invalid]);
  });

  it("handles an empty conversation", () => {
    expect(groupDocumentChatMessages([])).toEqual([]);
  });

  it("keeps keys unique when two authors reuse a client message identifier", () => {
    const groups = groupDocumentChatMessages([
      message("same", "owner", new Date(2026, 0, 2, 12, 0)),
      message("same", "editor", new Date(2026, 0, 2, 12, 1)),
    ]);
    expect(groups.map((group) => group.key)).toEqual(["owner:same", "editor:same"]);
  });
});

describe("document chat pixel avatars", () => {
  const avatar: PixelAvatarData = { version: 1, size: 2, palette: ["#ffffff"], pixels: ["#ffffff", null, "#abcdef00", "#ABCDEF"] };

  it("accepts bounded bitmap data with valid colors", () => {
    expect(validatedDocumentChatAvatar(avatar)).toBe(avatar);
    const maximum = { ...avatar, size: 32, pixels: Array(1024).fill(null) };
    expect(validatedDocumentChatAvatar(maximum)).toBe(maximum);
  });

  it("rejects missing, malformed or oversized avatars", () => {
    expect(validatedDocumentChatAvatar(null)).toBeNull();
    expect(validatedDocumentChatAvatar(undefined)).toBeNull();
    for (const size of [0, -1, 2.5, 33, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validatedDocumentChatAvatar({ ...avatar, size })).toBeNull();
    }
    expect(validatedDocumentChatAvatar({ ...avatar, pixels: ["#ffffff"] })).toBeNull();
    expect(validatedDocumentChatAvatar({ ...avatar, pixels: ["url(javascript:alert(1))", null, null, null] })).toBeNull();
  });
});
