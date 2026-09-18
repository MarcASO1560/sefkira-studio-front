type UserDisplayProfile = {
  username?: string | null;
  email?: string | null;
};

export const hasVisibleUserName = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** Check for visible text without changing the name chosen by the user. */
export const getUserDisplayName = (user: UserDisplayProfile, fallback = "Project member") => {
  if (hasVisibleUserName(user.username)) return user.username;
  if (hasVisibleUserName(user.email)) return user.email;
  return fallback;
};

export const getAccessUserDisplayName = (user: UserDisplayProfile) => {
  const name = getUserDisplayName(user, "User");
  return hasVisibleUserName(user.username) && !user.username.trimStart().startsWith("@")
    ? `@${name}` : name;
};

const initialsSegmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
const nameCharacters = (value: string) => initialsSegmenter
  ? Array.from(initialsSegmenter.segment(value), ({ segment }) => segment) : Array.from(value);

export const getUserInitials = (name: string, fallback = "?", singleWordLength: 1 | 2 = 2) => {
  const source = name.trim();
  const words = source.split(/[\s._-]+/u).filter(Boolean);
  const initials = words.length > 1
    ? words.slice(0, 2).map((word) => nameCharacters(word)[0] || "").join("")
    : nameCharacters(source).slice(0, singleWordLength).join("");
  return initials.toUpperCase() || fallback;
};
