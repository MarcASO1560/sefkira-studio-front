import type { ProjectFolderPublic, ProjectResourcePublic } from "../../../lib/api";

/** Each document contributes once to every ancestor, including nested folders. */
export const aggregateProjectChatUnread = (
  counts: Readonly<Record<string, number>>,
  folders: ReadonlyArray<Pick<ProjectFolderPublic, "id" | "parent_id">>,
  resources: ReadonlyArray<Pick<ProjectResourcePublic, "id" | "folder_id">>,
) => {
  const totals: Record<string, number> = {};
  const parents = new Map(folders.map((folder) => [folder.id, folder.parent_id || null]));
  for (const resource of resources) {
    const count = counts[resource.id];
    if (!count || !Number.isSafeInteger(count) || count < 0) continue;
    let folder = resource.folder_id || null;
    const visited = new Set<string>();
    while (folder && parents.has(folder) && !visited.has(folder)) {
      visited.add(folder);
      totals[folder] = (totals[folder] || 0) + count;
      folder = parents.get(folder) || null;
    }
  }
  return totals;
};
