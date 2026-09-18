import type { PixelAvatarData } from "../../../lib/api";

type ChatPresentationMessage = {
  client_message_id: string;
  author: { id: string };
  created_at: string;
};

export const documentChatDayKey = (timestamp: string) => {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "unknown" : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};

export const groupDocumentChatMessages = <T extends ChatPresentationMessage>(messages: readonly T[]) => {
  const groups: Array<{ key: string; day: string; messages: T[] }> = [];
  for (const message of messages) {
    const group = groups[groups.length - 1];
    const previous = group?.messages[group.messages.length - 1];
    const difference = previous ? new Date(message.created_at).getTime() - new Date(previous.created_at).getTime() : Number.NaN;
    const day = documentChatDayKey(message.created_at);
    if (previous && previous.author.id === message.author.id && day === group?.day
      && difference >= 0 && difference <= 5 * 60 * 1000) {
      group.messages.push(message);
    } else {
      groups.push({ key: `${message.author.id}:${message.client_message_id}`, day, messages: [message] });
    }
  }
  return groups;
};

// Render only a bounded, valid bitmap; profiles can contain legacy data.
export const validatedDocumentChatAvatar = (avatar: PixelAvatarData | null | undefined) => {
  if (!avatar || !Number.isInteger(avatar.size) || avatar.size < 1 || avatar.size > 32
    || !Array.isArray(avatar.pixels) || avatar.pixels.length !== avatar.size * avatar.size
    || !avatar.pixels.every((color) => color === null || /^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(color))) return null;
  return avatar;
};
