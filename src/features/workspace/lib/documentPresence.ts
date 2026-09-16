import type { ProjectPresenceMember } from "../../../lib/realtime";

const presenceTimestamp = (member: ProjectPresenceMember) => {
  const timestamp = Date.parse(member.online_at || "");
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
};

const comparePresenceMembers = (
  left: ProjectPresenceMember,
  right: ProjectPresenceMember,
) =>
  (left.username || left.email || left.id).localeCompare(
    right.username || right.email || right.id,
  ) || left.id.localeCompare(right.id);

/** Counts people in the document, not their tabs or recent cursor activity. */
export const getDocumentPresenceMembers = (
  members: ProjectPresenceMember[],
  currentUserId: string,
  currentUser?: ProjectPresenceMember | null,
): {
  members: ProjectPresenceMember[];
  others: ProjectPresenceMember[];
} => {
  // Identity can arrive after the first presence snapshot. Do not count ourself
  // as another person while that request is still loading.
  if (!currentUserId) return { members: [], others: [] };

  const uniqueMembers = new Map<string, ProjectPresenceMember>();
  for (const member of members) {
    const existing = uniqueMembers.get(member.id);
    if (!existing || presenceTimestamp(member) >= presenceTimestamp(existing)) {
      uniqueMembers.set(member.id, member);
    }
  }

  const others = [...uniqueMembers.values()]
    .filter((member) => member.id !== currentUserId)
    .sort(comparePresenceMembers);
  // The local user is already in the open document, even before their realtime
  // presence is echoed back. Keep the indicator and their list entry visible.
  const self = currentUser?.id === currentUserId ? currentUser : uniqueMembers.get(currentUserId);

  return { members: self ? [self, ...others] : [...others], others };
};
