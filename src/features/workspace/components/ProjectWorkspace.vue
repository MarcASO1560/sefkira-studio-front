<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import {
  ArrowUpDown,
  ChevronRight,
  ClipboardPaste,
  Copy,
  MoreHorizontal,
  Pencil,
  Plus,
  Scissors,
  Trash2,
} from "@lucide/vue";
import { Icon, type IconifyIcon } from "@iconify/vue";
import fileDocumentOutlineIcon from "@iconify-icons/mdi/file-document-outline";
import fileImageIcon from "@iconify-icons/mdi/file-image";
import filmstripIcon from "@iconify-icons/mdi/filmstrip";
import folderIcon from "@iconify-icons/mdi/folder";
import folderPlusIcon from "@iconify-icons/mdi/folder-plus";
import volumeHighIcon from "@iconify-icons/mdi/volume-high";

import {
  API_V1_URL,
  type PixelAvatarData,
  type ProjectFolderPublic,
  type ProjectPublic,
  type ProjectResourceDetail,
  type ProjectResourcePublic,
  type ProjectTree,
  type ProjectWorkspaceBootstrap,
  type UserPublic,
} from "../../../lib/api";
import {
  aggregateProjectPresenceByFolder,
  connectProjectPresence,
  connectUserRealtime,
  type ProjectPresenceConnection,
  type ProjectPresenceSnapshot,
  type RealtimeConnection,
  type RealtimeEventPayload,
} from "../../../lib/realtime";
import { getUserDisplayName } from "../../../lib/userDisplayName";
import StudioTopbarCommandBar from "../../navigation/components/StudioTopbarCommandBar.vue";
import StudioTopbar from "../../navigation/components/StudioTopbar.vue";
import { createPixelArtDocument } from "../../pixel-art/lib/document";
import { PIXEL_ART_PALETTE } from "../../pixel-art/lib/palette";
import ProjectEditorDialog from "./ProjectEditorDialog.vue";
import ProjectPresenceAvatars from "./ProjectPresenceAvatars.vue";
import UserProfileDialog from "./UserProfileDialog.vue";

type ResourceCreateType = "pixel_art" | "pixel_animation" | "sound_effect" | "text";
type ExplorerCreateType = "folder" | ResourceCreateType;
type ExplorerItemKind = "folder" | "resource";
type ExplorerSortKey = "name" | "updatedAt" | "type";
type ExplorerSortDirection = "asc" | "desc";
type ExplorerClipboardAction = "copy" | "cut";

type ExplorerClipboardEntry = {
  action: ExplorerClipboardAction;
  itemKey: string;
  itemId: string;
  itemKind: ExplorerItemKind;
};

type ExplorerContextMenu = {
  x: number;
  y: number;
  itemKey: string | null;
};

type ResourceTypeOption = {
  type: ResourceCreateType;
  label: string;
  description: string;
  defaultName: string;
  color: string;
  icon: IconifyIcon;
};

type CreateItemOption = {
  type: ExplorerCreateType;
  kind: ExplorerItemKind;
  label: string;
  description: string;
  defaultName: string;
  color: string;
  icon: IconifyIcon;
};

type ExplorerItem = {
  key: string;
  id: string;
  kind: ExplorerItemKind;
  name: string;
  type: string;
  typeLabel: string;
  updatedAt: string;
  position: number;
  parentId: string | null;
  color: string;
  icon: IconifyIcon;
};

const props = defineProps<{
  projectId: string;
  userName?: string;
  userUsername?: string | null;
  userAvatarUrl?: string;
  userEmail?: string;
  userPixelAvatar?: PixelAvatarData | null;
  initialProjectWorkspace?: ProjectWorkspaceBootstrap | null;
}>();

const REQUEST_TIMEOUT_MS = 18000;
const PROJECT_PIXEL_SIZE = 16;
const DEFAULT_RESOURCE_IMAGE_SIZE = 32;
const DEFAULT_ITEM_COLOR = "#f7f1e7";
const EXPLORER_ITEM_AUTOSAVE_MS = 420;
const PROJECT_SYNC_INTERVAL_MS = 30000;
const PROJECT_SYNC_FOCUS_COOLDOWN_MS = PROJECT_SYNC_INTERVAL_MS;
const REALTIME_REFRESH_DELAY_MS = 180;
const STALE_SYNC_MS = REQUEST_TIMEOUT_MS + 5000;
const project = ref<ProjectPublic | null>(props.initialProjectWorkspace?.project || null);
const isProjectAccessRevoked = ref(false);
const tree = ref<ProjectTree | null>(props.initialProjectWorkspace?.tree || null);
const localFolders = ref<ProjectFolderPublic[]>([]);
const localResources = ref<ProjectResourcePublic[]>([]);
const currentFolderId = ref<string | null>(null);
const selectedExplorerItemKey = ref<string | null>(null);
const hoveredExplorerItemKey = ref<string | null>(null);
const projectSearchQuery = ref("");
const explorerSortKey = ref<ExplorerSortKey>("name");
const explorerSortDirection = ref<ExplorerSortDirection>("asc");
const activeExplorerItemMenuKey = ref<string | null>(null);
const explorerContextMenu = ref<ExplorerContextMenu | null>(null);
const explorerClipboard = ref<ExplorerClipboardEntry | null>(null);
const editingExplorerItemKey = ref<string | null>(null);
const editingExplorerItemName = ref("");
const editingExplorerItemColor = ref(DEFAULT_ITEM_COLOR);
const editingExplorerItemAutosaveTimeout = ref<number | null>(null);
const editingExplorerItemAutosaveVersion = ref(0);
const draggedExplorerItemKey = ref<string | null>(null);
const dropTargetFolderKey = ref<string | null>(null);
const dropTargetBreadcrumbKey = ref<string | null>(null);
const isMovingExplorerItem = ref(false);
const isApplyingExplorerClipboard = ref(false);
const deletingExplorerItemKey = ref<string | null>(null);
const suppressNextExplorerRowClick = ref(false);
const suppressNextExplorerRowClickTimeout = ref<number | null>(null);
const explorerDropErrorMessage = ref("");
const itemNameOverrides = ref<Record<string, string>>({});
const itemColorOverrides = ref<Record<string, string>>({});
const isLoading = ref(!props.initialProjectWorkspace);
const isSyncingProject = ref(false);
const projectSyncStartedAt = ref<number | null>(null);
const lastProjectSyncAt = ref(props.initialProjectWorkspace ? Date.now() : 0);
const projectSyncIntervalId = ref<number | null>(null);
const realtimeConnection = ref<RealtimeConnection | null>(null);
const projectPresenceConnection = ref<ProjectPresenceConnection | null>(null);
const projectPresenceByResource = ref<ProjectPresenceSnapshot>({});
const projectRefreshTimeoutId = ref<number | null>(null);
const errorMessage = ref("");
const isCreateResourceOpen = ref(false);
const isCreateResourceNameEditing = ref(false);
const isCreatingResource = ref(false);
const createResourceErrorMessage = ref("");
const createResourceType = ref<ExplorerCreateType>("pixel_art");
const createResourceName = ref("Untitled image");
const createResourceColor = ref(DEFAULT_ITEM_COLOR);
const createResourceNameInput = ref<HTMLInputElement | null>(null);
const isProjectEditOpen = ref(false);
const isProjectSaving = ref(false);
const projectEditName = ref("");
const projectEditPixels = ref<Array<string | null>>([]);
const projectEditErrorMessage = ref("");
const isProfileDialogOpen = ref(false);
const profileUserName = ref(getUserDisplayName({ username: props.userUsername, email: props.userEmail }, props.userName || ""));
const profileUsername = ref(props.userUsername || "");
const profileAvatarUrl = ref(props.userAvatarUrl || "");
const profileEmail = ref(props.userEmail || "");
const profilePixelAvatar = ref<PixelAvatarData | null>(props.userPixelAvatar || null);
const explorerDateFormatter = new Intl.DateTimeFormat("es-ES", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const itemColorOptions = [
  DEFAULT_ITEM_COLOR,
  "#ffd76f",
  "#ffb35c",
  "#ff8a72",
  "#ff6fae",
  "#d88cff",
  "#9d8cff",
  "#79b8ff",
  "#5ed7f2",
  "#66e0c4",
  "#8eea7c",
  "#c9f56a",
];

const resourceTypeOptions: ResourceTypeOption[] = [
  {
    type: "pixel_art",
    label: "Image",
    description: "Still pixel artwork",
    defaultName: "Untitled image",
    color: DEFAULT_ITEM_COLOR,
    icon: fileImageIcon,
  },
  {
    type: "pixel_animation",
    label: "Animation",
    description: "Frame-based motion",
    defaultName: "Untitled animation",
    color: DEFAULT_ITEM_COLOR,
    icon: filmstripIcon,
  },
  {
    type: "sound_effect",
    label: "Sound",
    description: "Short audio effect",
    defaultName: "Untitled sound",
    color: DEFAULT_ITEM_COLOR,
    icon: volumeHighIcon,
  },
  {
    type: "text",
    label: "Text",
    description: "Plain text document",
    defaultName: "Untitled text",
    color: DEFAULT_ITEM_COLOR,
    icon: fileDocumentOutlineIcon,
  },
];

const createItemOptions: CreateItemOption[] = [
  {
    type: "folder",
    kind: "folder",
    label: "Folder",
    description: "Group project resources",
    defaultName: "Untitled folder",
    color: DEFAULT_ITEM_COLOR,
    icon: folderPlusIcon,
  },
  ...resourceTypeOptions.map((option) => ({
    ...option,
    kind: "resource" as const,
  })),
];

const projectName = computed(() => project.value?.name || "");
const projectPixelArt = computed<PixelAvatarData | null>(() => {
  const pixelArt = project.value?.settings?.project_pixel_art;
  if (!pixelArt || typeof pixelArt !== "object") {
    return null;
  }

  return pixelArt as PixelAvatarData;
});
const projectPixelPalette = computed(() => PIXEL_ART_PALETTE);
const projectEditPixelArtPreview = computed<PixelAvatarData>(() => ({
  version: 1,
  size: PROJECT_PIXEL_SIZE,
  palette: projectPixelPalette.value,
  pixels: [...projectEditPixels.value],
}));
const normalizedProjectSearch = computed(() => projectSearchQuery.value.trim().toLowerCase());
const allProjectFolders = computed(() => [
  ...(tree.value?.folders ?? []),
  ...localFolders.value,
]);
const allProjectResources = computed(() => [
  ...(tree.value?.resources ?? []),
  ...localResources.value,
]);
const projectResourceTypesById = computed<Record<string, string>>(() =>
  Object.fromEntries(
    allProjectResources.value.map((resource) => [resource.id, resource.type]),
  ),
);
const projectPresenceByFolder = computed(() =>
  aggregateProjectPresenceByFolder(
    projectPresenceByResource.value,
    allProjectFolders.value,
    allProjectResources.value,
  ),
);
const currentFolder = computed(
  () => allProjectFolders.value.find((folder) => folder.id === currentFolderId.value) || null,
);
const currentFolderPath = computed(() => {
  const foldersById = new Map(allProjectFolders.value.map((folder) => [folder.id, folder]));
  const path: ProjectFolderPublic[] = [];
  let nextFolderId = currentFolderId.value;
  const visitedFolderIds = new Set<string>();

  while (nextFolderId && !visitedFolderIds.has(nextFolderId)) {
    visitedFolderIds.add(nextFolderId);
    const folder = foldersById.get(nextFolderId);
    if (!folder) {
      break;
    }

    path.unshift(folder);
    nextFolderId = folder.parent_id || null;
  }

  return path;
});
const selectedCreateOption = computed<CreateItemOption>(
  () =>
    createItemOptions.find((option) => option.type === createResourceType.value) ||
    createItemOptions[0]!,
);
const allExplorerItems = computed<ExplorerItem[]>(() => {
  const folderItems: ExplorerItem[] = allProjectFolders.value.map((folder) => ({
    key: `folder-${folder.id}`,
    id: folder.id,
    kind: "folder",
    name: itemNameOverrides.value[`folder-${folder.id}`] || folder.name,
    type: "folder",
    typeLabel: "Folder",
    updatedAt: folder.updated_at,
    position: folder.position,
    parentId: folder.parent_id || null,
    color: itemColorOverrides.value[`folder-${folder.id}`] || folder.color || DEFAULT_ITEM_COLOR,
    icon: folderIcon,
  }));
  const resourceItems: ExplorerItem[] = allProjectResources.value.map((resource) => {
    const meta = resourceTypeMeta(resource.type);

    return {
      key: `resource-${resource.id}`,
      id: resource.id,
      kind: "resource",
      name: itemNameOverrides.value[`resource-${resource.id}`] || resource.name,
      type: resource.type,
      typeLabel: meta.label,
      updatedAt: resource.updated_at,
      position: resource.position,
      parentId: resource.folder_id || null,
      color: itemColorOverrides.value[`resource-${resource.id}`] || resource.color || meta.color,
      icon: meta.icon,
    };
  });

  return [...folderItems, ...resourceItems];
});
const createResourceTitleInputWidth = computed(() => {
  const visibleCharacters = Math.max(createResourceName.value.length + 1, 13);
  return `${Math.min(visibleCharacters, 38)}ch`;
});
const createResourceNameAriaLabel = computed(
  () => `${selectedCreateOption.value.label} name`,
);
const canCreateResource = computed(() => createResourceName.value.trim().length > 0);
const visibleExplorerItems = computed<ExplorerItem[]>(() => {
  const normalizedSearch = normalizedProjectSearch.value;
  const currentItems = normalizedSearch
    ? allExplorerItems.value.filter((item) =>
        `${item.name} ${item.typeLabel}`.toLowerCase().includes(normalizedSearch),
      )
    : allExplorerItems.value.filter((item) => item.parentId === currentFolderId.value);

  return [...currentItems].sort(sortExplorerItems);
});
const projectPresenceForExplorerItem = (item: ExplorerItem) =>
  item.kind === "folder"
    ? projectPresenceByFolder.value[item.id] || []
    : projectPresenceByResource.value[item.id] || [];
const hasVisibleProjectItems = computed(() => visibleExplorerItems.value.length > 0);
const emptyExplorerTitle = computed(() => {
  if (normalizedProjectSearch.value) {
    return "No results";
  }

  return currentFolder.value ? "This folder is empty" : "No resources";
});

const resourceTypeMeta = (type: string) =>
  resourceTypeOptions.find((option) => option.type === type) || {
    type: "pixel_art",
    label: type,
    description: "Resource",
    defaultName: "Untitled resource",
    color: DEFAULT_ITEM_COLOR,
    icon: fileImageIcon,
  };
const createDefaultImageResourceData = () => ({
  pixel_art: createPixelArtDocument(DEFAULT_RESOURCE_IMAGE_SIZE, DEFAULT_RESOURCE_IMAGE_SIZE),
});

const createEmptyProjectPixels = () =>
  Array<string | null>(PROJECT_PIXEL_SIZE * PROJECT_PIXEL_SIZE).fill(null);

const hasProjectPixels = (pixels: Array<string | null> | undefined) =>
  Boolean(pixels?.some((pixel) => pixel));

const buildProjectPixelArt = () =>
  hasProjectPixels(projectEditPixels.value) ? projectEditPixelArtPreview.value : null;

function sortExplorerItems(firstItem: ExplorerItem, secondItem: ExplorerItem) {
  if (firstItem.kind !== secondItem.kind) {
    return firstItem.kind === "folder" ? -1 : 1;
  }

  const directionMultiplier = explorerSortDirection.value === "asc" ? 1 : -1;
  const readSortValue = (item: ExplorerItem) => {
    if (explorerSortKey.value === "updatedAt") {
      return new Date(item.updatedAt).getTime() || 0;
    }

    if (explorerSortKey.value === "type") {
      return item.typeLabel.toLowerCase();
    }

    return item.name.toLowerCase();
  };
  const firstValue = readSortValue(firstItem);
  const secondValue = readSortValue(secondItem);

  if (typeof firstValue === "number" && typeof secondValue === "number") {
    const diff = firstValue - secondValue;
    if (diff !== 0) {
      return diff * directionMultiplier;
    }
  } else {
    const diff = String(firstValue).localeCompare(String(secondValue), "es", {
      sensitivity: "base",
      numeric: true,
    });

    if (diff !== 0) {
      return diff * directionMultiplier;
    }
  }

  return firstItem.position - secondItem.position;
}

const setExplorerSort = (sortKey: ExplorerSortKey) => {
  if (explorerSortKey.value === sortKey) {
    explorerSortDirection.value = explorerSortDirection.value === "asc" ? "desc" : "asc";
    return;
  }

  explorerSortKey.value = sortKey;
  explorerSortDirection.value = sortKey === "updatedAt" ? "desc" : "asc";
};

const formatExplorerDate = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return explorerDateFormatter.format(date);
};

const openRootFolder = () => {
  closeEditingExplorerItem();
  currentFolderId.value = null;
  selectedExplorerItemKey.value = null;
  activeExplorerItemMenuKey.value = null;
  projectSearchQuery.value = "";
};

const openFolder = (folderId: string) => {
  closeEditingExplorerItem();
  currentFolderId.value = folderId;
  selectedExplorerItemKey.value = null;
  activeExplorerItemMenuKey.value = null;
  projectSearchQuery.value = "";
};

const resourceRouteKind = (resourceType: string) => {
  if (resourceType === "pixel_animation") {
    return "animation";
  }

  if (resourceType === "sound_effect") {
    return "melody";
  }

  if (resourceType === "text") {
    return "text";
  }

  return "image";
};

const openResourceEditor = (item: Pick<ExplorerItem, "id" | "type">) => {
  window.location.assign(
    `/studio/${encodeURIComponent(props.projectId)}/${resourceRouteKind(item.type)}/${encodeURIComponent(
      item.id,
    )}`,
  );
};

const openExplorerItem = (item: ExplorerItem) => {
  selectedExplorerItemKey.value = item.key;
  activeExplorerItemMenuKey.value = null;

  if (item.kind === "folder") {
    openFolder(item.id);
    return;
  }

  openResourceEditor(item);
};

const closeExplorerContextMenu = () => {
  explorerContextMenu.value = null;
};

const closeExplorerFloatingMenus = () => {
  activeExplorerItemMenuKey.value = null;
  closeExplorerContextMenu();
};

const openExplorerContextMenu = (
  event: MouseEvent,
  itemKey: string | null,
  dimensions: { width: number; height: number },
) => {
  const padding = 8;
  const viewportWidth =
    typeof window === "undefined" ? event.clientX + dimensions.width : window.innerWidth;
  const viewportHeight =
    typeof window === "undefined" ? event.clientY + dimensions.height : window.innerHeight;

  explorerContextMenu.value = {
    x: Math.max(padding, Math.min(event.clientX, viewportWidth - dimensions.width - padding)),
    y: Math.max(padding, Math.min(event.clientY, viewportHeight - dimensions.height - padding)),
    itemKey,
  };
};

const handleProjectExplorerClick = (event: MouseEvent) => {
  closeExplorerFloatingMenus();

  const target = event.target;
  if (
    !(target instanceof Element) ||
    target.closest(".project-explorer-row, .project-breadcrumb, .project-explorer-header")
  ) {
    return;
  }

  if (editingExplorerItemKey.value) {
    closeEditingExplorerItem();
  }
};

const handleProjectExplorerContextMenu = (event: MouseEvent) => {
  const target = event.target;
  if (
    target instanceof Element &&
    target.closest("input, textarea, select, button, .project-explorer-item-menu")
  ) {
    return;
  }

  event.preventDefault();
  if (editingExplorerItemKey.value) {
    closeEditingExplorerItem();
  }

  activeExplorerItemMenuKey.value = null;
  openExplorerContextMenu(event, null, {
    width: 154,
    height: explorerClipboard.value ? 88 : 48,
  });
};

const createItemFromExplorerContextMenu = () => {
  closeExplorerContextMenu();
  void openCreateResourceDialog();
};

const handleExplorerRowContextMenu = (event: MouseEvent, item: ExplorerItem) => {
  const target = event.target;
  if (
    target instanceof Element &&
    target.closest("input, textarea, select, .project-explorer-row__edit-fields")
  ) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  if (editingExplorerItemKey.value) {
    closeEditingExplorerItem();
  }

  selectedExplorerItemKey.value = item.key;
  activeExplorerItemMenuKey.value = null;
  openExplorerContextMenu(event, item.key, { width: 154, height: 154 });
};

const handleExplorerRowClick = (event: MouseEvent, item: ExplorerItem) => {
  if (
    suppressNextExplorerRowClick.value ||
    isMovingExplorerItem.value
  ) {
    return;
  }

  if (editingExplorerItemKey.value === item.key) {
    const target = event.target;
    if (target instanceof Element && target.closest(".project-explorer-row__edit-fields")) {
      return;
    }

    closeEditingExplorerItem();
    return;
  }

  if (editingExplorerItemKey.value) {
    closeEditingExplorerItem();
  }

  openExplorerItem(item);
};

const handleExplorerRowKeydown = (event: KeyboardEvent, item: ExplorerItem) => {
  if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) {
    return;
  }

  event.preventDefault();
  handleExplorerRowClick(event, item);
};

const enterExplorerRowHover = (item: ExplorerItem) => {
  hoveredExplorerItemKey.value = item.key;
};

const leaveExplorerRowHover = (item: ExplorerItem) => {
  if (hoveredExplorerItemKey.value === item.key) {
    hoveredExplorerItemKey.value = null;
  }
};

const toggleExplorerItemMenu = (item: ExplorerItem) => {
  selectedExplorerItemKey.value = item.key;
  activeExplorerItemMenuKey.value =
    activeExplorerItemMenuKey.value === item.key ? null : item.key;
};

const findProjectFolderById = (folderId: string) =>
  allProjectFolders.value.find((folder) => folder.id === folderId) || null;

const findProjectResourceById = (resourceId: string) =>
  allProjectResources.value.find((resource) => resource.id === resourceId) || null;

const setExplorerClipboardItem = (item: ExplorerItem, action: ExplorerClipboardAction) => {
  closeEditingExplorerItem();
  selectedExplorerItemKey.value = item.key;
  activeExplorerItemMenuKey.value = null;
  closeExplorerContextMenu();
  explorerClipboard.value = {
    action,
    itemKey: item.key,
    itemId: item.id,
    itemKind: item.kind,
  };
};

const copyExplorerItem = (item: ExplorerItem) => {
  setExplorerClipboardItem(item, "copy");
};

const cutExplorerItem = (item: ExplorerItem) => {
  setExplorerClipboardItem(item, "cut");
};

const getExplorerPasteTargetFolderId = (targetItem: ExplorerItem) =>
  targetItem.kind === "folder" ? targetItem.id : currentFolderId.value;

const canCopyExplorerItemToFolder = (item: ExplorerItem | null, targetFolderId: string | null) => {
  if (!item) {
    return false;
  }

  if (item.kind === "resource") {
    return true;
  }

  return targetFolderId === null
    ? true
    : item.id !== targetFolderId && !folderContainsFolder(item.id, targetFolderId);
};

const canPasteExplorerClipboard = (targetItem: ExplorerItem) => {
  const targetFolderId = getExplorerPasteTargetFolderId(targetItem);
  return canPasteExplorerClipboardToFolder(targetFolderId);
};

const canPasteExplorerClipboardToFolder = (targetFolderId: string | null) => {
  const clipboardItem = explorerClipboard.value;
  const sourceItem = findExplorerItemByKey(clipboardItem?.itemKey || null);
  if (!clipboardItem || !sourceItem || isApplyingExplorerClipboard.value) {
    return false;
  }

  if (clipboardItem.action === "cut") {
    return canMoveExplorerItemToFolder(sourceItem, targetFolderId);
  }

  return canCopyExplorerItemToFolder(sourceItem, targetFolderId);
};

const buildCopiedItemName = (
  sourceName: string,
  itemKind: ExplorerItemKind,
  targetFolderId: string | null,
) => {
  const baseName = sourceName.trim() || "Untitled item";
  const existingNames = new Set(
    allExplorerItems.value
      .filter((item) => item.kind === itemKind && item.parentId === targetFolderId)
      .map((item) => item.name.trim().toLowerCase()),
  );
  const copyBaseName = `${baseName} copy`;
  let candidateName = copyBaseName;
  let copyIndex = 2;

  while (existingNames.has(candidateName.toLowerCase())) {
    candidateName = `${copyBaseName} ${copyIndex}`;
    copyIndex += 1;
  }

  return candidateName;
};

const duplicateProjectResource = async (
  sourceResource: ProjectResourcePublic,
  targetFolderId: string | null,
  nextName: string,
  nextPosition: number,
) => {
  const resourceDetail = await requestJson<ProjectResourceDetail>(
    `/projects/${encodeURIComponent(props.projectId)}/resources/${encodeURIComponent(sourceResource.id)}`,
  );
  const savedResource = await requestJson<ProjectResourcePublic>(
    `/projects/${encodeURIComponent(props.projectId)}/resources`,
    {
      method: "POST",
      body: JSON.stringify({
        name: nextName,
        type: resourceDetail.type,
        resource_metadata: resourceDetail.resource_metadata || {},
        data: resourceDetail.data || {},
        thumbnail_url: resourceDetail.thumbnail_url || null,
        color: resourceDetail.color || sourceResource.color || DEFAULT_ITEM_COLOR,
        position: nextPosition,
        folder_id: targetFolderId,
      }),
    },
  );

  appendSavedResource(savedResource);
  return savedResource;
};

const duplicateProjectFolder = async (
  sourceItem: ExplorerItem,
  targetFolderId: string | null,
) => {
  const sourceFolder = findProjectFolderById(sourceItem.id);
  if (!sourceFolder) {
    throw new Error("Folder not found");
  }

  let nextFolderPosition = allProjectFolders.value.length + 1;
  let nextResourcePosition = allProjectResources.value.length + 1;
  const foldersByParentId = new Map<string | null, ProjectFolderPublic[]>();
  const resourcesByFolderId = new Map<string | null, ProjectResourcePublic[]>();

  for (const folder of allProjectFolders.value) {
    const parentId = folder.parent_id || null;
    foldersByParentId.set(parentId, [...(foldersByParentId.get(parentId) || []), folder]);
  }

  for (const resource of allProjectResources.value) {
    const folderId = resource.folder_id || null;
    resourcesByFolderId.set(folderId, [...(resourcesByFolderId.get(folderId) || []), resource]);
  }

  const sortedByPositionAndName = <Item extends { position: number; name: string }>(
    items: Item[],
  ) =>
    [...items].sort(
      (firstItem, secondItem) =>
        firstItem.position - secondItem.position ||
        firstItem.name.localeCompare(secondItem.name, "es", {
          sensitivity: "base",
          numeric: true,
        }),
    );

  const copyFolderBranch = async (
    folder: ProjectFolderPublic,
    nextParentId: string | null,
    nextName: string,
  ) => {
    const savedFolder = await requestJson<ProjectFolderPublic>(
      `/projects/${encodeURIComponent(props.projectId)}/folders`,
      {
        method: "POST",
        body: JSON.stringify({
          name: nextName,
          color: folder.color || DEFAULT_ITEM_COLOR,
          position: nextFolderPosition,
          parent_id: nextParentId,
        }),
      },
    );
    nextFolderPosition += 1;
    appendSavedFolder(savedFolder);

    const childFolders = sortedByPositionAndName(foldersByParentId.get(folder.id) || []);
    for (const childFolder of childFolders) {
      await copyFolderBranch(childFolder, savedFolder.id, childFolder.name);
    }

    const childResources = sortedByPositionAndName(resourcesByFolderId.get(folder.id) || []);
    for (const childResource of childResources) {
      await duplicateProjectResource(
        childResource,
        savedFolder.id,
        childResource.name,
        nextResourcePosition,
      );
      nextResourcePosition += 1;
    }

    return savedFolder;
  };

  return copyFolderBranch(
    sourceFolder,
    targetFolderId,
    buildCopiedItemName(sourceItem.name, "folder", targetFolderId),
  );
};

const pasteExplorerClipboardToFolder = async (
  targetFolderId: string | null,
  selectedItemKey: string | null,
) => {
  const clipboardItem = explorerClipboard.value;
  const sourceItem = findExplorerItemByKey(clipboardItem?.itemKey || null);
  if (!clipboardItem || !sourceItem || !canPasteExplorerClipboardToFolder(targetFolderId)) {
    return;
  }

  selectedExplorerItemKey.value = selectedItemKey;
  activeExplorerItemMenuKey.value = null;
  closeExplorerContextMenu();
  closeEditingExplorerItem();
  explorerDropErrorMessage.value = "";
  isApplyingExplorerClipboard.value = true;

  try {
    if (clipboardItem.action === "cut") {
      await moveExplorerItemToFolder(sourceItem, targetFolderId);
      explorerClipboard.value = null;
      return;
    }

    if (sourceItem.kind === "folder") {
      const savedFolder = await duplicateProjectFolder(sourceItem, targetFolderId);
      selectedExplorerItemKey.value = `folder-${savedFolder.id}`;
      return;
    }

    const sourceResource = findProjectResourceById(sourceItem.id);
    if (!sourceResource) {
      throw new Error("Resource not found");
    }

    const savedResource = await duplicateProjectResource(
      sourceResource,
      targetFolderId,
      buildCopiedItemName(sourceItem.name, "resource", targetFolderId),
      allProjectResources.value.length + 1,
    );
    selectedExplorerItemKey.value = `resource-${savedResource.id}`;
  } catch {
    explorerDropErrorMessage.value = "Item could not be pasted. Please try again.";
  } finally {
    isApplyingExplorerClipboard.value = false;
  }
};

const pasteExplorerItem = async (targetItem: ExplorerItem) => {
  await pasteExplorerClipboardToFolder(
    getExplorerPasteTargetFolderId(targetItem),
    targetItem.key,
  );
};

const pasteExplorerClipboardInCurrentFolder = async () => {
  await pasteExplorerClipboardToFolder(currentFolderId.value, null);
};

const removeRecordKeys = <Value,>(record: Record<string, Value>, keysToRemove: Set<string>) =>
  Object.fromEntries(
    Object.entries(record).filter(([key]) => !keysToRemove.has(key)),
  ) as Record<string, Value>;

const collectRemovedExplorerItemKeys = (item: ExplorerItem) => {
  const folderIds = new Set<string>();
  const resourceIds = new Set<string>();

  if (item.kind === "folder") {
    folderIds.add(item.id);
    let changed = true;
    while (changed) {
      changed = false;
      for (const folder of allProjectFolders.value) {
        const parentId = folder.parent_id || null;
        if (parentId && folderIds.has(parentId) && !folderIds.has(folder.id)) {
          folderIds.add(folder.id);
          changed = true;
        }
      }
    }

    for (const resource of allProjectResources.value) {
      const folderId = resource.folder_id || null;
      if (folderId && folderIds.has(folderId)) {
        resourceIds.add(resource.id);
      }
    }
  } else {
    resourceIds.add(item.id);
  }

  return new Set<string>([
    ...Array.from(folderIds, (folderId) => `folder-${folderId}`),
    ...Array.from(resourceIds, (resourceId) => `resource-${resourceId}`),
  ]);
};

const removeExplorerItemLocally = (item: ExplorerItem) => {
  const itemKeysToRemove = collectRemovedExplorerItemKeys(item);
  const folderIdsToRemove = new Set(
    Array.from(itemKeysToRemove)
      .filter((itemKey) => itemKey.startsWith("folder-"))
      .map((itemKey) => itemKey.replace("folder-", "")),
  );
  const resourceIdsToRemove = new Set(
    Array.from(itemKeysToRemove)
      .filter((itemKey) => itemKey.startsWith("resource-"))
      .map((itemKey) => itemKey.replace("resource-", "")),
  );

  if (tree.value) {
    tree.value = {
      ...tree.value,
      folders: tree.value.folders.filter((folder) => !folderIdsToRemove.has(folder.id)),
      resources: tree.value.resources.filter(
        (resource) => !resourceIdsToRemove.has(resource.id),
      ),
    };
  }

  localFolders.value = localFolders.value.filter((folder) => !folderIdsToRemove.has(folder.id));
  localResources.value = localResources.value.filter(
    (resource) => !resourceIdsToRemove.has(resource.id),
  );
  itemNameOverrides.value = removeRecordKeys(itemNameOverrides.value, itemKeysToRemove);
  itemColorOverrides.value = removeRecordKeys(itemColorOverrides.value, itemKeysToRemove);

  if (currentFolderId.value && folderIdsToRemove.has(currentFolderId.value)) {
    currentFolderId.value = item.parentId;
  }

  if (selectedExplorerItemKey.value && itemKeysToRemove.has(selectedExplorerItemKey.value)) {
    selectedExplorerItemKey.value = null;
  }

  if (hoveredExplorerItemKey.value && itemKeysToRemove.has(hoveredExplorerItemKey.value)) {
    hoveredExplorerItemKey.value = null;
  }

  if (activeExplorerItemMenuKey.value && itemKeysToRemove.has(activeExplorerItemMenuKey.value)) {
    activeExplorerItemMenuKey.value = null;
  }

  if (editingExplorerItemKey.value && itemKeysToRemove.has(editingExplorerItemKey.value)) {
    editingExplorerItemKey.value = null;
  }

  if (explorerClipboard.value && itemKeysToRemove.has(explorerClipboard.value.itemKey)) {
    explorerClipboard.value = null;
  }
};

const deleteExplorerItem = async (item: ExplorerItem) => {
  if (deletingExplorerItemKey.value) {
    return;
  }

  selectedExplorerItemKey.value = item.key;
  activeExplorerItemMenuKey.value = null;
  closeExplorerContextMenu();
  closeEditingExplorerItem();
  deletingExplorerItemKey.value = item.key;
  explorerDropErrorMessage.value = "";

  try {
    const itemPath =
      item.kind === "folder"
        ? `/projects/${encodeURIComponent(props.projectId)}/folders/${encodeURIComponent(item.id)}`
        : `/projects/${encodeURIComponent(props.projectId)}/resources/${encodeURIComponent(item.id)}`;
    await requestJson<void>(itemPath, { method: "DELETE" });
    removeExplorerItemLocally(item);
  } catch {
    explorerDropErrorMessage.value = "Item could not be deleted. Please try again.";
  } finally {
    deletingExplorerItemKey.value = null;
  }
};

const startEditingExplorerItem = async (item: ExplorerItem) => {
  if (editingExplorerItemKey.value && editingExplorerItemKey.value !== item.key) {
    closeEditingExplorerItem();
  }

  selectedExplorerItemKey.value = item.key;
  activeExplorerItemMenuKey.value = null;
  editingExplorerItemKey.value = item.key;
  editingExplorerItemName.value = item.name;
  editingExplorerItemColor.value = item.color;

  await nextTick();
  const input = document.querySelector<HTMLInputElement>(
    `[data-project-item-name-input="${item.key}"]`,
  );
  input?.focus();
  input?.select();
};

const findExplorerItemByKey = (itemKey: string | null) =>
  itemKey ? allExplorerItems.value.find((item) => item.key === itemKey) || null : null;

const contextExplorerItem = computed(() =>
  findExplorerItemByKey(explorerContextMenu.value?.itemKey || null),
);

const folderContainsFolder = (folderId: string, possibleDescendantId: string) => {
  const foldersById = new Map(allProjectFolders.value.map((folder) => [folder.id, folder]));
  let nextFolderId: string | null = possibleDescendantId;
  const visitedFolderIds = new Set<string>();

  while (nextFolderId && !visitedFolderIds.has(nextFolderId)) {
    if (nextFolderId === folderId) {
      return true;
    }

    visitedFolderIds.add(nextFolderId);
    nextFolderId = foldersById.get(nextFolderId)?.parent_id || null;
  }

  return false;
};

const canMoveExplorerItemToFolder = (item: ExplorerItem | null, targetFolderId: string | null) => {
  if (!item || isMovingExplorerItem.value || item.parentId === targetFolderId) {
    return false;
  }

  if (item.kind === "resource") {
    return true;
  }

  return targetFolderId === null
    ? true
    : item.id !== targetFolderId && !folderContainsFolder(item.id, targetFolderId);
};

const breadcrumbDropKey = (folderId: string | null) =>
  folderId ? `folder-${folderId}` : "root";

const readDraggedExplorerItem = (event?: DragEvent) => {
  const itemKey =
    draggedExplorerItemKey.value ||
    event?.dataTransfer?.getData("application/x-sefkira-project-item") ||
    null;

  return findExplorerItemByKey(itemKey);
};

const updateProjectFolderLocally = (
  folderId: string,
  updateFolder: (folder: ProjectFolderPublic) => ProjectFolderPublic,
) => {
  if (tree.value) {
    tree.value = {
      ...tree.value,
      folders: tree.value.folders.map((folder) =>
        folder.id === folderId ? updateFolder(folder) : folder,
      ),
    };
    return;
  }

  localFolders.value = localFolders.value.map((folder) =>
    folder.id === folderId ? updateFolder(folder) : folder,
  );
};

const updateProjectResourceLocally = (
  resourceId: string,
  updateResource: (resource: ProjectResourcePublic) => ProjectResourcePublic,
) => {
  if (tree.value) {
    tree.value = {
      ...tree.value,
      resources: tree.value.resources.map((resource) =>
        resource.id === resourceId ? updateResource(resource) : resource,
      ),
    };
    return;
  }

  localResources.value = localResources.value.map((resource) =>
    resource.id === resourceId ? updateResource(resource) : resource,
  );
};

const replaceProjectFolder = (nextFolder: ProjectFolderPublic) => {
  updateProjectFolderLocally(nextFolder.id, () => nextFolder);
};

const replaceProjectResource = (nextResource: ProjectResourcePublic) => {
  updateProjectResourceLocally(nextResource.id, () => nextResource);
};

const startExplorerItemDrag = (event: DragEvent, item: ExplorerItem) => {
  if (editingExplorerItemKey.value === item.key || isMovingExplorerItem.value) {
    event.preventDefault();
    return;
  }

  draggedExplorerItemKey.value = item.key;
  dropTargetFolderKey.value = null;
  dropTargetBreadcrumbKey.value = null;
  explorerDropErrorMessage.value = "";
  selectedExplorerItemKey.value = item.key;
  activeExplorerItemMenuKey.value = null;

  event.dataTransfer?.setData("application/x-sefkira-project-item", item.key);
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
  }
};

const suppressNextExplorerRowClickBriefly = () => {
  if (suppressNextExplorerRowClickTimeout.value !== null) {
    window.clearTimeout(suppressNextExplorerRowClickTimeout.value);
  }

  suppressNextExplorerRowClick.value = true;
  suppressNextExplorerRowClickTimeout.value = window.setTimeout(() => {
    suppressNextExplorerRowClick.value = false;
    suppressNextExplorerRowClickTimeout.value = null;
  }, 120);
};

const finishExplorerItemDrag = () => {
  if (draggedExplorerItemKey.value) {
    suppressNextExplorerRowClickBriefly();
  }

  draggedExplorerItemKey.value = null;
  dropTargetFolderKey.value = null;
  dropTargetBreadcrumbKey.value = null;
  isMovingExplorerItem.value = false;
};

const handleWindowDragEnd = () => {
  if (isMovingExplorerItem.value) {
    return;
  }

  finishExplorerItemDrag();
};

const handleWindowDrop = (event: DragEvent) => {
  if (draggedExplorerItemKey.value) {
    event.preventDefault();
  }

  if (isMovingExplorerItem.value) {
    return;
  }

  finishExplorerItemDrag();
};

const handleWindowBlur = () => {
  if (isMovingExplorerItem.value) {
    return;
  }

  finishExplorerItemDrag();
};

const handleWindowClick = () => {
  closeExplorerFloatingMenus();
};

const handleWindowKeydown = (event: KeyboardEvent) => {
  if (event.key !== "Escape") {
    return;
  }

  closeExplorerFloatingMenus();
};

const handleExplorerRowDragOver = (event: DragEvent, targetItem: ExplorerItem) => {
  const draggedItem = readDraggedExplorerItem(event);
  if (!canMoveExplorerItemToFolder(draggedItem, targetItem.kind === "folder" ? targetItem.id : null)) {
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "none";
    }
    return;
  }

  event.preventDefault();
  dropTargetFolderKey.value = targetItem.key;
  dropTargetBreadcrumbKey.value = null;
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "move";
  }
};

const handleExplorerRowDragLeave = (event: DragEvent, targetItem: ExplorerItem) => {
  const currentTarget = event.currentTarget;
  const relatedTarget = event.relatedTarget;
  if (
    currentTarget instanceof HTMLElement &&
    relatedTarget instanceof Node &&
    currentTarget.contains(relatedTarget)
  ) {
    return;
  }

  if (dropTargetFolderKey.value === targetItem.key) {
    dropTargetFolderKey.value = null;
  }
};

const handleExplorerBreadcrumbDragOver = (event: DragEvent, targetFolderId: string | null) => {
  const draggedItem = readDraggedExplorerItem(event);
  if (!canMoveExplorerItemToFolder(draggedItem, targetFolderId)) {
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "none";
    }
    return;
  }

  event.preventDefault();
  dropTargetFolderKey.value = null;
  dropTargetBreadcrumbKey.value = breadcrumbDropKey(targetFolderId);
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "move";
  }
};

const handleExplorerBreadcrumbDragLeave = (event: DragEvent, targetFolderId: string | null) => {
  const currentTarget = event.currentTarget;
  const relatedTarget = event.relatedTarget;
  if (
    currentTarget instanceof HTMLElement &&
    relatedTarget instanceof Node &&
    currentTarget.contains(relatedTarget)
  ) {
    return;
  }

  if (dropTargetBreadcrumbKey.value === breadcrumbDropKey(targetFolderId)) {
    dropTargetBreadcrumbKey.value = null;
  }
};

const moveExplorerItemToFolder = async (item: ExplorerItem, targetFolderId: string | null) => {
  const previousParentId = item.parentId;
  const now = new Date().toISOString();

  isMovingExplorerItem.value = true;
  activeExplorerItemMenuKey.value = null;
  closeEditingExplorerItem();
  explorerDropErrorMessage.value = "";

  if (item.kind === "folder") {
    updateProjectFolderLocally(item.id, (folder) => ({
      ...folder,
      parent_id: targetFolderId,
      updated_at: now,
    }));
  } else {
    updateProjectResourceLocally(item.id, (resource) => ({
      ...resource,
      folder_id: targetFolderId,
      updated_at: now,
    }));
  }

  try {
    if (item.kind === "folder") {
      const movedFolder = await requestJson<ProjectFolderPublic>(
        `/projects/${encodeURIComponent(props.projectId)}/folders/${encodeURIComponent(item.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ parent_id: targetFolderId }),
        },
      );
      replaceProjectFolder(movedFolder);
    } else {
      const movedResource = await requestJson<ProjectResourcePublic>(
        `/projects/${encodeURIComponent(props.projectId)}/resources/${encodeURIComponent(item.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ folder_id: targetFolderId }),
        },
      );
      replaceProjectResource(movedResource);
    }
  } catch {
    if (item.kind === "folder") {
      updateProjectFolderLocally(item.id, (folder) => ({
        ...folder,
        parent_id: previousParentId,
        updated_at: now,
      }));
    } else {
      updateProjectResourceLocally(item.id, (resource) => ({
        ...resource,
        folder_id: previousParentId,
        updated_at: now,
      }));
    }
    explorerDropErrorMessage.value = "Item could not be moved. Please try again.";
  } finally {
    isMovingExplorerItem.value = false;
    finishExplorerItemDrag();
  }
};

const dropExplorerItemOnFolder = async (event: DragEvent, targetItem: ExplorerItem) => {
  const draggedItem = readDraggedExplorerItem(event);
  const targetFolderId = targetItem.kind === "folder" ? targetItem.id : null;

  if (draggedItem) {
    event.preventDefault();
    event.stopPropagation();
  }

  if (!canMoveExplorerItemToFolder(draggedItem, targetFolderId) || !draggedItem || !targetFolderId) {
    finishExplorerItemDrag();
    return;
  }

  await moveExplorerItemToFolder(draggedItem, targetFolderId);
};

const dropExplorerItemOnBreadcrumb = async (event: DragEvent, targetFolderId: string | null) => {
  const draggedItem = readDraggedExplorerItem(event);

  if (draggedItem) {
    event.preventDefault();
    event.stopPropagation();
  }

  if (!canMoveExplorerItemToFolder(draggedItem, targetFolderId) || !draggedItem) {
    finishExplorerItemDrag();
    return;
  }

  await moveExplorerItemToFolder(draggedItem, targetFolderId);
};

const clearEditingExplorerItemAutosave = () => {
  if (editingExplorerItemAutosaveTimeout.value !== null) {
    window.clearTimeout(editingExplorerItemAutosaveTimeout.value);
    editingExplorerItemAutosaveTimeout.value = null;
  }
};

const applyExplorerItemEditLocally = (
  item: ExplorerItem,
  nextName: string,
  nextColor: string,
) => {
  itemNameOverrides.value = {
    ...itemNameOverrides.value,
    [item.key]: nextName,
  };
  itemColorOverrides.value = {
    ...itemColorOverrides.value,
    [item.key]: nextColor,
  };

  const now = new Date().toISOString();
  if (item.kind === "folder") {
    updateProjectFolderLocally(item.id, (folder) => ({
      ...folder,
      name: nextName,
      color: nextColor,
      updated_at: now,
    }));
    return;
  }

  updateProjectResourceLocally(item.id, (resource) => ({
    ...resource,
    name: nextName,
    color: nextColor,
    updated_at: now,
  }));
};

const saveExplorerItemEdit = async (
  item: ExplorerItem,
  nextName: string,
  nextColor: string,
  autosaveVersion: number,
) => {
  if (item.kind === "folder" && item.id.startsWith("local-folder-")) {
    return;
  }

  if (item.kind === "resource" && item.id.startsWith("local-resource-")) {
    return;
  }

  try {
    if (item.kind === "folder") {
      const savedFolder = await requestJson<ProjectFolderPublic>(
        `/projects/${encodeURIComponent(props.projectId)}/folders/${encodeURIComponent(item.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ name: nextName, color: nextColor }),
        },
      );

      if (autosaveVersion === editingExplorerItemAutosaveVersion.value) {
        replaceProjectFolder(savedFolder);
        explorerDropErrorMessage.value = "";
      }
      return;
    }

    const savedResource = await requestJson<ProjectResourcePublic>(
      `/projects/${encodeURIComponent(props.projectId)}/resources/${encodeURIComponent(item.id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ name: nextName, color: nextColor }),
      },
    );

    if (autosaveVersion === editingExplorerItemAutosaveVersion.value) {
      replaceProjectResource(savedResource);
      explorerDropErrorMessage.value = "";
    }
  } catch {
    if (autosaveVersion === editingExplorerItemAutosaveVersion.value) {
      explorerDropErrorMessage.value = "Item changes could not be saved. Please try again.";
    }
  }
};

const scheduleEditingExplorerItemAutosave = (item: ExplorerItem) => {
  const nextName = editingExplorerItemName.value.trim();
  const nextColor = editingExplorerItemColor.value;
  if (!nextName) {
    return;
  }

  explorerDropErrorMessage.value = "";
  applyExplorerItemEditLocally(item, nextName, nextColor);
  clearEditingExplorerItemAutosave();

  const autosaveVersion = editingExplorerItemAutosaveVersion.value + 1;
  editingExplorerItemAutosaveVersion.value = autosaveVersion;
  editingExplorerItemAutosaveTimeout.value = window.setTimeout(() => {
    editingExplorerItemAutosaveTimeout.value = null;
    void saveExplorerItemEdit(item, nextName, nextColor, autosaveVersion);
  }, EXPLORER_ITEM_AUTOSAVE_MS);
};

const flushEditingExplorerItemAutosave = () => {
  const item = findExplorerItemByKey(editingExplorerItemKey.value);
  const nextName = editingExplorerItemName.value.trim();
  const nextColor = editingExplorerItemColor.value;
  if (!item || !nextName) {
    clearEditingExplorerItemAutosave();
    return;
  }

  applyExplorerItemEditLocally(item, nextName, nextColor);
  clearEditingExplorerItemAutosave();

  const autosaveVersion = editingExplorerItemAutosaveVersion.value + 1;
  editingExplorerItemAutosaveVersion.value = autosaveVersion;
  void saveExplorerItemEdit(item, nextName, nextColor, autosaveVersion);
};

const closeEditingExplorerItem = () => {
  flushEditingExplorerItemAutosave();
  editingExplorerItemKey.value = null;
  editingExplorerItemName.value = "";
  editingExplorerItemColor.value = DEFAULT_ITEM_COLOR;
};

const selectEditingExplorerItemColor = (item: ExplorerItem, color: string) => {
  editingExplorerItemColor.value = color;
  scheduleEditingExplorerItemAutosave(item);
};

const updateEditingExplorerItemName = (item: ExplorerItem, event: Event) => {
  const input = event.target;
  if (input instanceof HTMLInputElement) {
    editingExplorerItemName.value = input.value;
  }

  scheduleEditingExplorerItemAutosave(item);
};

const resetEditingExplorerItemState = () => {
  clearEditingExplorerItemAutosave();
  editingExplorerItemKey.value = null;
  editingExplorerItemName.value = "";
  editingExplorerItemColor.value = DEFAULT_ITEM_COLOR;
};

const resetStaleProjectSync = () => {
  if (
    isSyncingProject.value &&
    projectSyncStartedAt.value &&
    Date.now() - projectSyncStartedAt.value > STALE_SYNC_MS
  ) {
    isSyncingProject.value = false;
    projectSyncStartedAt.value = null;
    isLoading.value = false;
  }
};

const projectTreeItemKeys = (nextTree: ProjectTree) =>
  new Set<string>([
    ...nextTree.folders.map((folder) => `folder-${folder.id}`),
    ...nextTree.resources.map((resource) => `resource-${resource.id}`),
  ]);

const pruneExplorerOverrides = (itemKeys: Set<string>) => {
  const keepOverride = ([itemKey]: [string, string]) =>
    itemKeys.has(itemKey) && itemKey === editingExplorerItemKey.value;

  itemNameOverrides.value = Object.fromEntries(
    Object.entries(itemNameOverrides.value).filter(keepOverride),
  );
  itemColorOverrides.value = Object.fromEntries(
    Object.entries(itemColorOverrides.value).filter(keepOverride),
  );
};

const reconcileExplorerState = (nextTree: ProjectTree) => {
  const itemKeys = projectTreeItemKeys(nextTree);
  const folderIds = new Set(nextTree.folders.map((folder) => folder.id));

  if (currentFolderId.value && !folderIds.has(currentFolderId.value)) {
    currentFolderId.value = null;
  }

  const clearMissingItemKey = (itemKey: string | null) =>
    itemKey && itemKeys.has(itemKey) ? itemKey : null;

  selectedExplorerItemKey.value = clearMissingItemKey(selectedExplorerItemKey.value);
  hoveredExplorerItemKey.value = clearMissingItemKey(hoveredExplorerItemKey.value);
  activeExplorerItemMenuKey.value = clearMissingItemKey(activeExplorerItemMenuKey.value);
  draggedExplorerItemKey.value = clearMissingItemKey(draggedExplorerItemKey.value);
  dropTargetFolderKey.value = clearMissingItemKey(dropTargetFolderKey.value);

  if (editingExplorerItemKey.value && !itemKeys.has(editingExplorerItemKey.value)) {
    resetEditingExplorerItemState();
  }

  if (explorerClipboard.value && !itemKeys.has(explorerClipboard.value.itemKey)) {
    explorerClipboard.value = null;
  }

  pruneExplorerOverrides(itemKeys);
};

const applyProjectSnapshot = (nextProject: ProjectPublic, nextTree: ProjectTree) => {
  if (isProjectAccessRevoked.value) return;
  project.value = nextProject;
  tree.value = nextTree;
  localFolders.value = [];
  localResources.value = [];
  errorMessage.value = "";
  lastProjectSyncAt.value = Date.now();
  reconcileExplorerState(nextTree);
};

class ProjectRequestError extends Error {
  constructor(readonly status: number) {
    super(`Request failed: ${status}`);
  }
}

const requestJson = async <ResponseBody,>(path: string, init: RequestInit = {}) => {
  if (isProjectAccessRevoked.value && (init.method || "GET").toUpperCase() !== "GET") {
    throw new ProjectRequestError(403);
  }
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${API_V1_URL}${path}`, {
      ...init,
      credentials: "same-origin",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });

    if (!response.ok) {
      throw new ProjectRequestError(response.status);
    }

    if (response.status === 204) {
      return undefined as ResponseBody;
    }

    return (await response.json()) as ResponseBody;
  } finally {
    window.clearTimeout(timeoutId);
  }
};

const returnToStudio = () => {
  if (typeof window === "undefined") {
    return;
  }

  window.location.assign("/studio");
};

const openCreateResourceDialog = async () => {
  createResourceType.value = "pixel_art";
  createResourceName.value = resourceTypeOptions[0]?.defaultName || "Untitled image";
  createResourceColor.value = resourceTypeOptions[0]?.color || DEFAULT_ITEM_COLOR;
  createResourceErrorMessage.value = "";
  isCreateResourceNameEditing.value = false;
  isCreateResourceOpen.value = true;
};

const openRequestedResourceCreation = () => {
  const parameters = new URLSearchParams(window.location.search);
  if (parameters.get("create") !== "pixel_animation") {
    return;
  }

  void openCreateResourceDialog();
  selectCreateResourceType("pixel_animation");
  const suggestedName = parameters.get("name")?.trim();
  if (suggestedName) {
    createResourceName.value = suggestedName.slice(0, 80);
  }

  parameters.delete("create");
  parameters.delete("name");
  const query = parameters.toString();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
  );
};

const closeCreateResourceDialog = (force = false) => {
  if (isCreatingResource.value && force !== true) {
    return;
  }

  isCreateResourceNameEditing.value = false;
  createResourceErrorMessage.value = "";
  isCreateResourceOpen.value = false;
};

const focusCreateResourceNameInput = () => {
  isCreateResourceNameEditing.value = true;
  void nextTick(() => {
    createResourceNameInput.value?.focus();
    createResourceNameInput.value?.select();
  });
};

const finishCreateResourceNameEditing = () => {
  if (!createResourceName.value.trim()) {
    createResourceName.value = selectedCreateOption.value.defaultName;
  }

  isCreateResourceNameEditing.value = false;
};

const openProjectEditDialog = async () => {
  if (!project.value || isLoading.value) {
    return;
  }

  projectEditName.value = project.value.name;
  projectEditPixels.value = projectPixelArt.value?.pixels
    ? [...projectPixelArt.value.pixels]
    : createEmptyProjectPixels();
  projectEditErrorMessage.value = "";
  isProjectEditOpen.value = true;
};

const closeProjectEditDialog = () => {
  if (isProjectSaving.value) {
    return;
  }

  isProjectEditOpen.value = false;
  projectEditErrorMessage.value = "";
};

const saveProjectEdit = async () => {
  if (!project.value || !projectEditName.value.trim()) {
    return;
  }

  const currentProject = project.value;
  const nextSettings = {
    ...(currentProject.settings || {}),
    project_pixel_art: buildProjectPixelArt(),
  };
  const localProject: ProjectPublic = {
    ...currentProject,
    name: projectEditName.value.trim(),
    settings: nextSettings,
    updated_at: new Date().toISOString(),
  };

  isProjectSaving.value = true;
  projectEditErrorMessage.value = "";

  try {
    project.value = await requestJson<ProjectPublic>(
      `/projects/${encodeURIComponent(props.projectId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          name: localProject.name,
          description: currentProject.description || null,
          settings: nextSettings,
          thumbnail_url: currentProject.thumbnail_url || null,
        }),
      },
    );
    isProjectEditOpen.value = false;
  } catch {
    project.value = localProject;
    projectEditErrorMessage.value =
      "Project updated locally for this session. The remote connection did not respond.";
    isProjectEditOpen.value = false;
  } finally {
    isProjectSaving.value = false;
  }
};

const selectCreateResourceType = (type: ExplorerCreateType) => {
  const selectedOption = createItemOptions.find((option) => option.type === type);
  if (!selectedOption) {
    return;
  }

  const currentName = createResourceName.value.trim();
  const shouldUseDefaultName =
    !currentName || createItemOptions.some((option) => option.defaultName === currentName);

  createResourceType.value = type;
  createResourceColor.value = selectedOption.color;
  if (shouldUseDefaultName) {
    createResourceName.value = selectedOption.defaultName;
  }
};

const selectCreateResourceColor = (color: string) => {
  createResourceColor.value = color;
};

const appendSavedFolder = (folder: ProjectFolderPublic) => {
  if (tree.value) {
    tree.value = {
      ...tree.value,
      folders: [
        ...tree.value.folders.filter((existingFolder) => existingFolder.id !== folder.id),
        folder,
      ],
    };
  } else {
    localFolders.value = [
      ...localFolders.value.filter((existingFolder) => existingFolder.id !== folder.id),
      folder,
    ];
  }
};

const appendSavedResource = (resource: ProjectResourcePublic) => {
  if (tree.value) {
    tree.value = {
      ...tree.value,
      resources: [
        ...tree.value.resources.filter((existingResource) => existingResource.id !== resource.id),
        resource,
      ],
    };
  } else {
    localResources.value = [
      ...localResources.value.filter((existingResource) => existingResource.id !== resource.id),
      resource,
    ];
  }
};

const createProjectItem = async () => {
  const resourceName = createResourceName.value.trim();
  const selectedOption = createItemOptions.find(
    (option) => option.type === createResourceType.value,
  );

  if (!resourceName || !selectedOption || isCreatingResource.value) {
    return;
  }

  isCreatingResource.value = true;
  createResourceErrorMessage.value = "";

  try {
    if (selectedOption.kind === "folder") {
      const savedFolder = await requestJson<ProjectFolderPublic>(
        `/projects/${encodeURIComponent(props.projectId)}/folders`,
        {
          method: "POST",
          body: JSON.stringify({
            name: resourceName,
            color: createResourceColor.value,
            position: allProjectFolders.value.length + 1,
            parent_id: currentFolderId.value,
          }),
        },
      );

      appendSavedFolder(savedFolder);
      closeCreateResourceDialog(true);
      openFolder(savedFolder.id);
      return;
    }

    const resourceType =
      selectedOption.type === "folder" ? "pixel_art" : selectedOption.type;
    const resourceData =
      resourceType === "pixel_art" ? createDefaultImageResourceData() : {};
    const savedResource = await requestJson<ProjectResourcePublic>(
      `/projects/${encodeURIComponent(props.projectId)}/resources`,
      {
        method: "POST",
        body: JSON.stringify({
          name: resourceName,
          type: resourceType,
          resource_metadata: {
            kind: selectedOption.label.toLowerCase(),
          },
          data: resourceData,
          thumbnail_url: null,
          color: createResourceColor.value,
          position: allProjectResources.value.length + 1,
          folder_id: currentFolderId.value,
        }),
      },
    );

    appendSavedResource(savedResource);
    closeCreateResourceDialog(true);
    openResourceEditor(savedResource);
  } catch {
    createResourceErrorMessage.value = "Item could not be saved. Please try again.";
  } finally {
    isCreatingResource.value = false;
  }
};

const updateProfile = (user: UserPublic) => {
  profileUsername.value = user.username || "";
  profileUserName.value = getUserDisplayName(user);
  profileAvatarUrl.value = user.avatar_url || "";
  profileEmail.value = user.email;
  profilePixelAvatar.value = user.avatar_pixel_art || null;
  isProfileDialogOpen.value = false;
};

const refreshProject = async ({
  showLoading = false,
  showError = false,
} = {}) => {
  if (isProjectAccessRevoked.value) return;
  resetStaleProjectSync();
  if (isSyncingProject.value) {
    return;
  }

  isSyncingProject.value = true;
  projectSyncStartedAt.value = Date.now();
  if (showLoading) {
    isLoading.value = true;
  }

  try {
    const snapshot = await requestJson<ProjectWorkspaceBootstrap>(
      `/workspace/projects/${encodeURIComponent(props.projectId)}`,
    );
    applyProjectSnapshot(snapshot.project, snapshot.tree);
  } catch (error) {
    if (error instanceof ProjectRequestError && [401, 403, 404].includes(error.status)) {
      revokeProjectAccess();
      return;
    }
    if (showError || !project.value) {
      errorMessage.value = "This project is not available.";
    }
  } finally {
    if (showLoading) {
      isLoading.value = false;
    }
    isSyncingProject.value = false;
    projectSyncStartedAt.value = null;
  }
};

const scheduleProjectRefresh = ({ showError = false } = {}) => {
  if (projectRefreshTimeoutId.value !== null) {
    window.clearTimeout(projectRefreshTimeoutId.value);
  }

  projectRefreshTimeoutId.value = window.setTimeout(() => {
    projectRefreshTimeoutId.value = null;
    void refreshProject({ showError });
  }, REALTIME_REFRESH_DELAY_MS);
};

const isCurrentProjectRealtimeEvent = (payload: RealtimeEventPayload) => {
  return payload.project_id === props.projectId;
};

const handleRealtimeProjectUpdated = (payload: RealtimeEventPayload) => {
  if (isCurrentProjectRealtimeEvent(payload)) {
    scheduleProjectRefresh();
  }
};

const handleRealtimeProjectUnavailable = (payload: RealtimeEventPayload) => {
  if (!isCurrentProjectRealtimeEvent(payload)) {
    return;
  }

  isProjectAccessRevoked.value = true;
  projectPresenceConnection.value?.close();
  projectPresenceConnection.value = null;
  projectPresenceByResource.value = {};

  closeCreateResourceDialog(true);
  closeProjectEditDialog();
  isProfileDialogOpen.value = false;
  tree.value = { folders: [], resources: [] };
  localFolders.value = [];
  localResources.value = [];
  selectedExplorerItemKey.value = null;
  hoveredExplorerItemKey.value = null;
  activeExplorerItemMenuKey.value = null;
  explorerClipboard.value = null;
  resetEditingExplorerItemState();
  isLoading.value = false;
  errorMessage.value = "This project is no longer available.";
};

const handleRealtimeProjectAccessUpdated = (payload: RealtimeEventPayload) => {
  if (isCurrentProjectRealtimeEvent(payload)) {
    void projectPresenceConnection.value?.refresh();
    scheduleProjectRefresh({ showError: true });
  }
};

const revokeProjectAccess = () => {
  if (isProjectAccessRevoked.value) return;
  isProjectAccessRevoked.value = true;
  if (project.value) project.value = { ...project.value, access_role: "viewer" };
  projectPresenceConnection.value?.close();
  projectPresenceConnection.value = null;
  projectPresenceByResource.value = {};
  handleRealtimeProjectUnavailable({ project_id: props.projectId });
};

const connectRealtimeEvents = () => {
  if (typeof window === "undefined" || isProjectAccessRevoked.value) {
    return;
  }

  realtimeConnection.value?.close();
  realtimeConnection.value = connectUserRealtime({
    "project.updated": handleRealtimeProjectUpdated,
    "project.deleted": handleRealtimeProjectUnavailable,
    "project.access.updated": handleRealtimeProjectAccessUpdated,
  });

  projectPresenceConnection.value?.close();
  projectPresenceConnection.value = connectProjectPresence(
    props.projectId,
    (snapshot) => {
      projectPresenceByResource.value = snapshot;
    },
    null,
    undefined,
    revokeProjectAccess,
  );
};

const disconnectRealtimeEvents = () => {
  realtimeConnection.value?.close();
  realtimeConnection.value = null;
  projectPresenceConnection.value?.close();
  projectPresenceConnection.value = null;
  projectPresenceByResource.value = {};

  if (projectRefreshTimeoutId.value !== null) {
    window.clearTimeout(projectRefreshTimeoutId.value);
    projectRefreshTimeoutId.value = null;
  }
};

const syncSharedProjectState = () => {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    return;
  }

  resetStaleProjectSync();
  if (!realtimeConnection.value) {
    connectRealtimeEvents();
  }
  if (Date.now() - lastProjectSyncAt.value < PROJECT_SYNC_FOCUS_COOLDOWN_MS) {
    return;
  }
  void refreshProject({ showError: Boolean(errorMessage.value) });
};

onMounted(() => {
  window.addEventListener("dragend", handleWindowDragEnd);
  window.addEventListener("drop", handleWindowDrop);
  window.addEventListener("blur", handleWindowBlur);
  window.addEventListener("click", handleWindowClick);
  window.addEventListener("keydown", handleWindowKeydown);
  window.addEventListener("focus", syncSharedProjectState);
  document.addEventListener("visibilitychange", syncSharedProjectState);
  connectRealtimeEvents();
  projectSyncIntervalId.value = window.setInterval(
    () => void refreshProject(),
    PROJECT_SYNC_INTERVAL_MS,
  );
  const initialLoad = props.initialProjectWorkspace
    ? Promise.resolve()
    : refreshProject({ showLoading: true, showError: true });
  void initialLoad.then(() => {
    if (project.value) {
      openRequestedResourceCreation();
    }
  });
});

onUnmounted(() => {
  window.removeEventListener("dragend", handleWindowDragEnd);
  window.removeEventListener("drop", handleWindowDrop);
  window.removeEventListener("blur", handleWindowBlur);
  window.removeEventListener("click", handleWindowClick);
  window.removeEventListener("keydown", handleWindowKeydown);
  window.removeEventListener("focus", syncSharedProjectState);
  document.removeEventListener("visibilitychange", syncSharedProjectState);
  disconnectRealtimeEvents();

  if (projectSyncIntervalId.value !== null) {
    window.clearInterval(projectSyncIntervalId.value);
  }

  if (suppressNextExplorerRowClickTimeout.value !== null) {
    window.clearTimeout(suppressNextExplorerRowClickTimeout.value);
  }
});
</script>

<template>
  <section class="project-workspace">
    <StudioTopbar
      mode="project"
      center-max-width="min(660px, 42vw)"
      brand-interactive
      brand-aria-label="Back to studio"
      :brand-trail="projectName"
      :brand-trail-pixel-art="projectPixelArt"
      :brand-trail-loading="isLoading"
      brand-trail-interactive
      brand-trail-aria-label="Edit project"
      user-interactive
      :user-name="profileUserName"
      :user-username="profileUsername"
      :user-avatar-url="profileAvatarUrl"
      :user-email="profileEmail"
      :user-pixel-avatar="profilePixelAvatar"
      :user-label="profileEmail || profileUserName"
      @brand-click="returnToStudio"
      @brand-trail-click="openProjectEditDialog"
      @user-click="isProfileDialogOpen = true"
    >
      <template #center>
        <StudioTopbarCommandBar
          v-model="projectSearchQuery"
          placeholder="Search item"
          search-aria-label="Search item"
          button-label="New"
          @new-click="openCreateResourceDialog"
        />
      </template>
    </StudioTopbar>

    <main class="project-stage">
      <div v-if="isLoading" class="project-loader" aria-label="Loading project" role="status">
        <span></span>
      </div>

      <div v-else-if="errorMessage" class="project-error">
        <p>{{ errorMessage }}</p>
        <button type="button" @click="returnToStudio">Back to studio</button>
      </div>

      <div
        v-else
        class="project-explorer"
        aria-label="Project workspace"
        :data-items="visibleExplorerItems.length"
        @click="handleProjectExplorerClick"
        @contextmenu="handleProjectExplorerContextMenu"
      >
        <div
          v-if="explorerContextMenu"
          class="project-explorer-context-menu"
          :style="{
            left: `${explorerContextMenu.x}px`,
            top: `${explorerContextMenu.y}px`,
          }"
          role="menu"
          @click.stop
          @contextmenu.prevent.stop
        >
          <template v-if="contextExplorerItem">
            <button type="button" role="menuitem" @click="copyExplorerItem(contextExplorerItem)">
              <Copy :size="15" :stroke-width="2.1" aria-hidden="true" />
              <span>Copy</span>
            </button>
            <button type="button" role="menuitem" @click="cutExplorerItem(contextExplorerItem)">
              <Scissors :size="15" :stroke-width="2.1" aria-hidden="true" />
              <span>Cut</span>
            </button>
            <button
              type="button"
              role="menuitem"
              :disabled="!canPasteExplorerClipboard(contextExplorerItem)"
              @click="pasteExplorerItem(contextExplorerItem)"
            >
              <ClipboardPaste :size="15" :stroke-width="2.1" aria-hidden="true" />
              <span>Paste</span>
            </button>
            <button
              type="button"
              class="is-danger"
              role="menuitem"
              :disabled="deletingExplorerItemKey === contextExplorerItem.key"
              @click="deleteExplorerItem(contextExplorerItem)"
            >
              <Trash2 :size="15" :stroke-width="2.1" aria-hidden="true" />
              <span>Delete</span>
            </button>
          </template>
          <template v-else>
            <button type="button" role="menuitem" @click="createItemFromExplorerContextMenu">
              <Plus :size="15" :stroke-width="2.2" aria-hidden="true" />
              <span>New item</span>
            </button>
            <button
              v-if="explorerClipboard"
              type="button"
              role="menuitem"
              :disabled="!canPasteExplorerClipboardToFolder(currentFolderId)"
              @click="pasteExplorerClipboardInCurrentFolder"
            >
              <ClipboardPaste :size="15" :stroke-width="2.1" aria-hidden="true" />
              <span>Paste</span>
            </button>
          </template>
        </div>
        <div class="project-explorer-shell">
          <div class="project-explorer-toolbar">
            <nav class="project-breadcrumb" aria-label="Current folder">
              <button
                type="button"
                class="project-breadcrumb__item"
                :class="{
                  'is-current': !currentFolderId,
                  'is-drop-target': dropTargetBreadcrumbKey === breadcrumbDropKey(null),
                }"
                @click="openRootFolder"
                @dragenter="handleExplorerBreadcrumbDragOver($event, null)"
                @dragover="handleExplorerBreadcrumbDragOver($event, null)"
                @dragleave="handleExplorerBreadcrumbDragLeave($event, null)"
                @drop="dropExplorerItemOnBreadcrumb($event, null)"
              >
                {{ projectName }}
              </button>
              <template v-for="folder in currentFolderPath" :key="folder.id">
                <ChevronRight :size="14" :stroke-width="2" aria-hidden="true" />
                <button
                  type="button"
                  class="project-breadcrumb__item"
                  :class="{
                    'is-current': folder.id === currentFolderId,
                    'is-drop-target': dropTargetBreadcrumbKey === breadcrumbDropKey(folder.id),
                  }"
                  @click="openFolder(folder.id)"
                  @dragenter="handleExplorerBreadcrumbDragOver($event, folder.id)"
                  @dragover="handleExplorerBreadcrumbDragOver($event, folder.id)"
                  @dragleave="handleExplorerBreadcrumbDragLeave($event, folder.id)"
                  @drop="dropExplorerItemOnBreadcrumb($event, folder.id)"
                >
                  {{ folder.name }}
                </button>
              </template>
            </nav>
            <span class="project-explorer-count">
              {{ visibleExplorerItems.length }} item{{ visibleExplorerItems.length === 1 ? "" : "s" }}
            </span>
            <span v-if="explorerDropErrorMessage" class="project-explorer-drop-error">
              {{ explorerDropErrorMessage }}
            </span>
          </div>

          <div v-if="hasVisibleProjectItems" class="project-explorer-table" role="table">
            <div class="project-explorer-header" role="row">
              <button
                type="button"
                class="project-explorer-column project-explorer-column--name"
                :class="{ 'is-active': explorerSortKey === 'name' }"
                role="columnheader"
                @click="setExplorerSort('name')"
              >
                <span>Name</span>
                <ArrowUpDown :size="13" :stroke-width="2" aria-hidden="true" />
              </button>
              <button
                type="button"
                class="project-explorer-column"
                :class="{ 'is-active': explorerSortKey === 'updatedAt' }"
                role="columnheader"
                @click="setExplorerSort('updatedAt')"
              >
                <span>Modified</span>
                <ArrowUpDown :size="13" :stroke-width="2" aria-hidden="true" />
              </button>
              <button
                type="button"
                class="project-explorer-column"
                :class="{ 'is-active': explorerSortKey === 'type' }"
                role="columnheader"
                @click="setExplorerSort('type')"
              >
                <span>Type</span>
                <ArrowUpDown :size="13" :stroke-width="2" aria-hidden="true" />
              </button>
              <span
                class="project-explorer-column project-explorer-column--actions"
                role="columnheader"
                aria-label="Actions"
              ></span>
            </div>

            <div
              v-for="item in visibleExplorerItems"
              :key="item.key"
              class="project-explorer-row"
              :class="[
                `is-${item.kind}`,
                {
                  'is-selected': selectedExplorerItemKey === item.key,
                  'is-menu-open': activeExplorerItemMenuKey === item.key,
                  'is-editing': editingExplorerItemKey === item.key,
                  'is-dragging': draggedExplorerItemKey === item.key,
                  'is-cut': explorerClipboard?.action === 'cut' && explorerClipboard.itemKey === item.key,
                  'is-drop-target': dropTargetFolderKey === item.key,
                  'is-hovered': hoveredExplorerItemKey === item.key,
                  'is-moving': isMovingExplorerItem,
                },
              ]"
              :style="{
                '--resource-color':
                  editingExplorerItemKey === item.key ? editingExplorerItemColor : item.color,
              }"
              :draggable="editingExplorerItemKey !== item.key && !isMovingExplorerItem"
              role="row"
              :tabindex="editingExplorerItemKey === item.key ? -1 : 0"
              @dragstart="startExplorerItemDrag($event, item)"
              @dragend="finishExplorerItemDrag"
              @dragenter="handleExplorerRowDragOver($event, item)"
              @dragover="handleExplorerRowDragOver($event, item)"
              @dragleave="handleExplorerRowDragLeave($event, item)"
              @drop="dropExplorerItemOnFolder($event, item)"
              @click="handleExplorerRowClick($event, item)"
              @contextmenu="handleExplorerRowContextMenu($event, item)"
              @keydown="handleExplorerRowKeydown($event, item)"
              @mouseenter="enterExplorerRowHover(item)"
              @mouseleave="leaveExplorerRowHover(item)"
            >
              <span class="project-explorer-cell project-explorer-cell--name" role="cell">
                <span
                  class="project-explorer-row__icon"
                  :data-resource-type="item.type"
                  aria-hidden="true"
                >
                  <Icon :icon="item.icon" width="21" height="21" />
                </span>
                <span
                  v-if="editingExplorerItemKey === item.key"
                  class="project-explorer-row__edit-fields"
                >
                  <input
                    v-model="editingExplorerItemName"
                    class="project-explorer-row__name-input"
                    type="text"
                    maxlength="80"
                    :aria-label="`Edit ${item.name} name`"
                    :data-project-item-name-input="item.key"
                    @input="updateEditingExplorerItemName(item, $event)"
                    @blur="flushEditingExplorerItemAutosave"
                    @keydown.enter.prevent="closeEditingExplorerItem"
                    @keydown.escape.prevent="closeEditingExplorerItem"
                  />
                  <span class="project-explorer-row__color-picker" aria-label="Item color">
                    <button
                      v-for="color in itemColorOptions"
                      :key="color"
                      type="button"
                      class="project-explorer-row__color"
                      :class="{ 'is-selected': editingExplorerItemColor === color }"
                      :style="{ '--item-color': color }"
                      :aria-label="`Use color ${color}`"
                      :aria-pressed="editingExplorerItemColor === color"
                      @click.stop="selectEditingExplorerItemColor(item, color)"
                    ></button>
                  </span>
                </span>
                <span v-else class="project-explorer-row__name-group">
                  <span class="project-explorer-row__name">
                    {{ item.name }}
                  </span>
                  <button
                    type="button"
                    class="project-explorer-inline-edit-button"
                    :aria-label="`Edit ${item.name}`"
                    title="Edit"
                    draggable="false"
                    @click.stop="startEditingExplorerItem(item)"
                    @dragstart.stop.prevent
                  >
                    <Pencil :size="15" :stroke-width="2.2" aria-hidden="true" />
                  </button>
                  <ProjectPresenceAvatars
                    v-if="projectPresenceForExplorerItem(item).length > 0"
                    :members="projectPresenceForExplorerItem(item)"
                    :resource-types-by-id="projectResourceTypesById"
                  />
                </span>
              </span>
              <span class="project-explorer-cell" role="cell">
                {{ formatExplorerDate(item.updatedAt) }}
              </span>
              <span class="project-explorer-cell" role="cell">{{ item.typeLabel }}</span>
              <span class="project-explorer-cell project-explorer-cell--actions" role="cell">
                <template v-if="editingExplorerItemKey !== item.key">
                  <span class="project-explorer-options">
                    <button
                      type="button"
                      class="project-explorer-options-button"
                      :class="{ 'is-open': activeExplorerItemMenuKey === item.key }"
                      :aria-label="`Options for ${item.name}`"
                      aria-haspopup="menu"
                      :aria-expanded="activeExplorerItemMenuKey === item.key"
                      :aria-controls="`project-item-menu-${item.key}`"
                      title="Options"
                      @click.stop="toggleExplorerItemMenu(item)"
                    >
                      <MoreHorizontal :size="19" :stroke-width="2.2" aria-hidden="true" />
                    </button>
                    <div
                      v-if="activeExplorerItemMenuKey === item.key"
                      :id="`project-item-menu-${item.key}`"
                      class="project-explorer-item-menu"
                      role="menu"
                      @click.stop
                    >
                      <button type="button" role="menuitem" @click="copyExplorerItem(item)">
                        <Copy :size="15" :stroke-width="2.1" aria-hidden="true" />
                        <span>Copy</span>
                      </button>
                      <button type="button" role="menuitem" @click="cutExplorerItem(item)">
                        <Scissors :size="15" :stroke-width="2.1" aria-hidden="true" />
                        <span>Cut</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        :disabled="!canPasteExplorerClipboard(item)"
                        @click="pasteExplorerItem(item)"
                      >
                        <ClipboardPaste :size="15" :stroke-width="2.1" aria-hidden="true" />
                        <span>Paste</span>
                      </button>
                      <button
                        type="button"
                        class="is-danger"
                        role="menuitem"
                        :disabled="deletingExplorerItemKey === item.key"
                        @click="deleteExplorerItem(item)"
                      >
                        <Trash2 :size="15" :stroke-width="2.1" aria-hidden="true" />
                        <span>Delete</span>
                      </button>
                    </div>
                  </span>
                </template>
              </span>
            </div>
          </div>

          <div v-else class="project-explorer-empty">
            <p>{{ emptyExplorerTitle }}</p>
            <button
              v-if="!normalizedProjectSearch"
              type="button"
              @click="openCreateResourceDialog"
            >
              New item
            </button>
          </div>
        </div>
      </div>
    </main>

    <div
      v-if="isCreateResourceOpen"
      class="resource-modal-backdrop"
      role="presentation"
      @click.self="closeCreateResourceDialog"
    >
      <form
        class="resource-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-resource-title"
        @submit.prevent="createProjectItem"
      >
        <header>
          <div class="resource-modal-title">
            <input
              v-if="isCreateResourceNameEditing"
              id="create-resource-title"
              ref="createResourceNameInput"
              v-model="createResourceName"
              type="text"
              maxlength="80"
              placeholder="Item name"
              :aria-label="createResourceNameAriaLabel"
              :style="{ width: createResourceTitleInputWidth }"
              @blur="finishCreateResourceNameEditing"
              @keydown.enter.prevent="finishCreateResourceNameEditing"
              @keydown.escape.prevent="finishCreateResourceNameEditing"
            />
            <h2 v-else id="create-resource-title">{{ createResourceName }}</h2>
            <button
              type="button"
              class="resource-modal-title__button"
              :aria-label="`Edit ${selectedCreateOption.label.toLowerCase()} name`"
              @click="focusCreateResourceNameInput"
            >
              <Pencil :size="18" :stroke-width="2.2" aria-hidden="true" />
            </button>
          </div>
          <button
            class="resource-modal__close"
            type="button"
            aria-label="Close"
            :disabled="isCreatingResource"
            @click="closeCreateResourceDialog"
          >
            <span aria-hidden="true"></span>
          </button>
        </header>

        <fieldset class="resource-type-picker" aria-label="Type">
          <div class="resource-type-picker__grid">
            <button
              v-for="option in createItemOptions"
              :key="option.type"
              class="resource-type-option"
              :class="{ 'is-selected': createResourceType === option.type }"
              type="button"
              :aria-pressed="createResourceType === option.type"
              @click="selectCreateResourceType(option.type)"
            >
              <span
                class="resource-type-option__icon"
                :data-resource-type="option.type"
                :style="{ '--resource-color': option.color }"
                aria-hidden="true"
              >
                <Icon :icon="option.icon" width="24" height="24" />
              </span>
              <span class="resource-type-option__copy">
                <span>{{ option.label }}</span>
              </span>
            </button>
          </div>
        </fieldset>

        <fieldset class="resource-color-picker" aria-label="Color">
          <div class="resource-color-picker__row">
            <button
              v-for="color in itemColorOptions"
              :key="color"
              type="button"
              class="resource-color-option"
              :class="{ 'is-selected': createResourceColor === color }"
              :style="{ '--item-color': color }"
              :aria-label="`Use color ${color}`"
              :aria-pressed="createResourceColor === color"
              @click="selectCreateResourceColor(color)"
            ></button>
          </div>
        </fieldset>

        <p v-if="createResourceErrorMessage" class="resource-modal__message">
          {{ createResourceErrorMessage }}
        </p>

        <footer>
          <button
            type="button"
            class="resource-modal__secondary"
            :disabled="isCreatingResource"
            @click="closeCreateResourceDialog"
          >
            Cancel
          </button>
          <button
            type="submit"
            class="resource-modal__primary"
            :disabled="!canCreateResource || isCreatingResource"
          >
            {{ isCreatingResource ? "Saving" : "Create" }}
          </button>
        </footer>
      </form>
    </div>

    <ProjectEditorDialog
      v-model:project-name="projectEditName"
      v-model:pixels="projectEditPixels"
      :open="isProjectEditOpen"
      :palette="projectPixelPalette"
      :saving="isProjectSaving"
      editing
      :message="projectEditErrorMessage"
      @close="closeProjectEditDialog"
      @save="saveProjectEdit"
    />

    <UserProfileDialog
      :open="isProfileDialogOpen"
      :user-name="profileUserName"
      :user-username="profileUsername"
      :user-email="profileEmail"
      :user-avatar-url="profileAvatarUrl"
      :user-pixel-avatar="profilePixelAvatar"
      @close="isProfileDialogOpen = false"
      @saved="updateProfile"
    />
  </section>
</template>

<style scoped>
  .project-workspace {
    --surface: rgba(12, 13, 13, 0.88);
    --surface-soft: rgba(255, 252, 244, 0.055);
    --line: rgba(255, 252, 244, 0.14);
    --line-strong: rgba(255, 252, 244, 0.22);
    --text: #f7f1e7;
    --muted: rgba(247, 241, 231, 0.62);
    --quiet: rgba(247, 241, 231, 0.42);
    --mint: #f7f1e7;
    position: relative;
    z-index: 5;
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    max-height: 100dvh;
    color: var(--text);
  }

  button {
    font: inherit;
    color: inherit;
  }

  .project-stage {
    position: relative;
    flex: 1;
    min-height: 0;
  }

  .project-explorer {
    position: absolute;
    inset: 0;
    overflow: auto;
    padding: 18px 22px;
  }

  .project-explorer-shell {
    display: grid;
    gap: 10px;
    width: 100%;
  }

  .project-explorer-toolbar {
    display: flex;
    gap: 16px;
    align-items: center;
    justify-content: space-between;
    min-height: 32px;
  }

  .project-breadcrumb {
    display: flex;
    gap: 6px;
    align-items: center;
    min-width: 0;
    color: var(--quiet);
  }

  .project-breadcrumb svg {
    flex: 0 0 auto;
    opacity: 0.62;
  }

  .project-breadcrumb__item {
    min-width: 0;
    max-width: 220px;
    padding: 0;
    overflow: hidden;
    color: inherit;
    font-size: 0.78rem;
    font-weight: 700;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
    background: transparent;
    border: 0;
    text-decoration: underline;
    text-decoration-color: transparent;
    text-decoration-thickness: 2px;
    text-underline-offset: 4px;
    transition:
      color 160ms ease,
      text-decoration-color 160ms ease;
  }

  .project-breadcrumb__item:hover,
  .project-breadcrumb__item:focus-visible,
  .project-breadcrumb__item.is-drop-target {
    color: var(--text);
    text-decoration-color: currentColor;
  }

  .project-breadcrumb__item.is-drop-target {
    border-radius: 5px;
    box-shadow: 0 0 0 6px rgba(247, 241, 231, 0.08);
  }

  .project-breadcrumb__item.is-current {
    color: var(--text);
  }

  .project-explorer-count {
    flex: 0 0 auto;
    color: var(--quiet);
    font-size: 0.76rem;
    font-weight: 700;
  }

  .project-explorer-drop-error {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    color: #ffb7a8;
    font-size: 0.74rem;
    font-weight: 700;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .project-explorer-table {
    display: grid;
    overflow: visible;
    background: transparent;
    border: 0;
    border-radius: 0;
  }

  .project-explorer-header,
  .project-explorer-row {
    display: grid;
    grid-template-columns: minmax(240px, 1fr) 180px 150px 64px;
    min-width: 0;
  }

  .project-explorer-header {
    min-height: 36px;
    background: transparent;
    border-bottom: 1px solid rgba(255, 252, 244, 0.12);
  }

  .project-explorer-column {
    display: flex;
    gap: 7px;
    align-items: center;
    min-width: 0;
    padding: 0 12px;
    color: var(--quiet);
    font-size: 0.72rem;
    font-weight: 750;
    text-align: left;
    cursor: pointer;
    background: transparent;
    border: 0;
    border-right: 0;
  }

  .project-explorer-column:last-child {
    border-right: 0;
  }

  .project-explorer-column--actions {
    cursor: default;
  }

  .project-explorer-column span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .project-explorer-column svg {
    flex: 0 0 auto;
    opacity: 0;
    transition: opacity 160ms ease;
  }

  .project-explorer-column:hover,
  .project-explorer-column.is-active {
    color: var(--text);
  }

  .project-explorer-column:hover svg,
  .project-explorer-column.is-active svg {
    opacity: 0.75;
  }

  .project-explorer-row {
    position: relative;
    min-height: 58px;
    color: inherit;
    text-align: left;
    background: transparent;
    border: 0;
    border-bottom: 1px solid rgba(255, 252, 244, 0.07);
    outline: none;
    transition:
      background 160ms ease,
      box-shadow 160ms ease,
      opacity 160ms ease;
  }

  .project-explorer-row:last-child {
    border-bottom: 0;
  }

  .project-explorer-row:hover,
  .project-explorer-row:focus-visible,
  .project-explorer-row.is-selected {
    background: rgba(255, 252, 244, 0.045);
  }

  .project-explorer-row.is-selected {
    box-shadow: inset 2px 0 0 rgba(247, 241, 231, 0.72);
  }

  .project-explorer-row.is-menu-open {
    z-index: 10;
  }

  .project-explorer-row[draggable="true"] {
    cursor: pointer;
  }

  .project-explorer-row.is-dragging {
    opacity: 0.44;
  }

  .project-explorer-row.is-cut {
    opacity: 0.5;
  }

  .project-explorer-row.is-dragging,
  .project-explorer-row[draggable="true"]:active,
  .project-explorer-row.is-moving {
    cursor: grabbing;
  }

  .project-explorer-row.is-folder.is-drop-target {
    background: color-mix(in srgb, var(--resource-color, #ffd76f) 16%, transparent);
    box-shadow:
      inset 2px 0 0 var(--resource-color, #ffd76f),
      inset 0 0 0 1px color-mix(in srgb, var(--resource-color, #ffd76f) 52%, transparent);
  }

  .project-explorer-row.is-editing {
    min-height: 96px;
    background: rgba(255, 252, 244, 0.045);
  }

  .project-explorer-cell {
    display: flex;
    align-items: center;
    min-width: 0;
    padding: 0 12px;
    overflow: hidden;
    color: var(--muted);
    font-size: 0.79rem;
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .project-explorer-cell--name {
    gap: 14px;
    color: var(--text);
    font-size: 0.94rem;
    font-weight: 750;
    line-height: 1.15;
  }

  .project-explorer-row.is-editing .project-explorer-cell--name {
    align-items: flex-start;
    padding-block: 13px;
  }

  .project-explorer-row__icon {
    display: grid;
    flex: 0 0 auto;
    place-items: center;
    width: 40px;
    height: 40px;
    color: var(--resource-color, #f7f1e7);
  }

  .project-explorer-row__icon svg {
    display: block;
    width: 27px;
    height: 27px;
    color: var(--resource-color, #f7f1e7);
  }

  .resource-type-option__icon svg {
    display: block;
    color: var(--resource-color, #f7f1e7);
  }

  .project-explorer-row__name-group {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    max-width: 100%;
  }

  .project-explorer-row__name {
    display: inline-flex;
    align-items: center;
    min-width: 0;
    max-width: 100%;
    padding: 0;
    overflow: hidden;
    color: inherit;
    font: inherit;
    cursor: inherit;
    background: transparent;
    border: 0;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    outline: none;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: left;
    transition:
      border-color 160ms ease,
      color 160ms ease,
      text-decoration-color 160ms ease;
  }

  .project-explorer-row.is-hovered .project-explorer-row__name,
  .project-explorer-row:hover .project-explorer-row__name,
  .project-explorer-cell--name:hover .project-explorer-row__name,
  .project-explorer-row:focus-visible .project-explorer-row__name,
  .project-explorer-row__name:hover,
  .project-explorer-row__name:focus-visible {
    border-bottom-color: currentColor;
    color: #ffffff;
  }

  .project-explorer-inline-edit-button {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    padding: 0;
    color: rgba(247, 241, 231, 0.64);
    cursor: pointer;
    background: transparent;
    border: 0;
    border-radius: 6px;
    outline: none;
    transition:
      background 160ms ease,
      color 160ms ease,
      opacity 160ms ease,
      transform 160ms ease;
  }

  .project-explorer-inline-edit-button:hover,
  .project-explorer-inline-edit-button:focus-visible {
    color: var(--text);
    background: rgba(255, 252, 244, 0.07);
    transform: translateY(-1px);
  }

  .project-explorer-row__edit-fields {
    display: grid;
    gap: 8px;
    min-width: 0;
  }

  .project-explorer-row__name-input {
    width: min(420px, 100%);
    min-width: 0;
    height: 34px;
    padding: 0 10px;
    color: var(--text);
    font: inherit;
    font-size: 0.94rem;
    font-weight: 750;
    background: rgba(255, 252, 244, 0.06);
    border: 1px solid rgba(247, 241, 231, 0.34);
    border-radius: 7px;
    outline: none;
  }

  .project-explorer-row__color-picker {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    max-width: 420px;
    margin-top: 8px;
  }

  .project-explorer-row__color {
    --item-color: #f7f1e7;
    width: 21px;
    height: 21px;
    padding: 0;
    cursor: pointer;
    background: var(--item-color);
    border: 2px solid rgba(255, 252, 244, 0.28);
    border-radius: 999px;
    outline: none;
    transition:
      border-color 160ms ease,
      box-shadow 160ms ease,
      transform 160ms ease;
  }

  .project-explorer-row__color:hover,
  .project-explorer-row__color:focus-visible {
    border-color: rgba(247, 241, 231, 0.72);
    transform: translateY(-1px);
  }

  .project-explorer-row__color.is-selected {
    box-shadow:
      0 0 0 2px rgba(16, 17, 17, 1),
      0 0 0 4px rgba(255, 252, 244, 0.72);
  }

  .project-explorer-cell--actions {
    position: relative;
    gap: 8px;
    justify-content: flex-end;
    overflow: visible;
  }

  .project-explorer-options-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 34px;
    padding: 0;
    cursor: pointer;
    border: 0;
    outline: none;
    transition:
      background 160ms ease,
      border-color 160ms ease,
      color 160ms ease,
      transform 160ms ease;
  }

  .project-explorer-options-button {
    width: 34px;
    color: rgba(247, 241, 231, 0.66);
    background: transparent;
    border-radius: 7px;
  }

  .project-explorer-options-button:hover,
  .project-explorer-options-button:focus-visible,
  .project-explorer-options-button.is-open {
    color: var(--text);
    background: rgba(255, 252, 244, 0.055);
  }

  .project-explorer-options {
    position: relative;
    display: inline-flex;
  }

  .project-explorer-item-menu {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    z-index: 20;
    display: grid;
    gap: 2px;
    min-width: 150px;
    padding: 6px;
    background: rgba(18, 19, 19, 0.96);
    border: 1px solid rgba(255, 252, 244, 0.16);
    border-radius: 8px;
    box-shadow: 0 18px 44px rgba(0, 0, 0, 0.42);
  }

  .project-explorer-item-menu button {
    display: flex;
    gap: 9px;
    align-items: center;
    width: 100%;
    min-height: 34px;
    padding: 0 10px;
    color: var(--text);
    font-size: 0.78rem;
    font-weight: 700;
    text-align: left;
    cursor: pointer;
    background: transparent;
    border: 0;
    border-radius: 6px;
  }

  .project-explorer-item-menu button svg {
    flex: 0 0 auto;
    color: rgba(247, 241, 231, 0.74);
  }

  .project-explorer-item-menu button span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .project-explorer-item-menu button:hover,
  .project-explorer-item-menu button:focus-visible {
    background: rgba(255, 252, 244, 0.08);
  }

  .project-explorer-item-menu button:disabled {
    color: rgba(247, 241, 231, 0.32);
    cursor: default;
  }

  .project-explorer-item-menu button:disabled svg {
    color: rgba(247, 241, 231, 0.28);
  }

  .project-explorer-item-menu button:disabled:hover,
  .project-explorer-item-menu button:disabled:focus-visible {
    background: transparent;
  }

  .project-explorer-item-menu button.is-danger {
    color: #ffb2a3;
  }

  .project-explorer-item-menu button.is-danger svg {
    color: #ff8f7d;
  }

  .project-explorer-item-menu button.is-danger:hover,
  .project-explorer-item-menu button.is-danger:focus-visible {
    background: rgba(255, 102, 84, 0.12);
  }

  .project-explorer-context-menu {
    position: fixed;
    z-index: 60;
    display: grid;
    gap: 2px;
    min-width: 154px;
    padding: 6px;
    background: rgba(18, 19, 19, 0.96);
    border: 1px solid rgba(255, 252, 244, 0.16);
    border-radius: 8px;
    box-shadow: 0 18px 44px rgba(0, 0, 0, 0.42);
  }

  .project-explorer-context-menu button {
    display: flex;
    gap: 9px;
    align-items: center;
    width: 100%;
    min-height: 34px;
    padding: 0 10px;
    color: var(--text);
    font-size: 0.78rem;
    font-weight: 700;
    text-align: left;
    cursor: pointer;
    background: transparent;
    border: 0;
    border-radius: 6px;
  }

  .project-explorer-context-menu button svg {
    flex: 0 0 auto;
    color: rgba(247, 241, 231, 0.78);
  }

  .project-explorer-context-menu button span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .project-explorer-context-menu button:hover,
  .project-explorer-context-menu button:focus-visible {
    background: rgba(255, 252, 244, 0.08);
  }

  .project-explorer-context-menu button:disabled {
    color: rgba(247, 241, 231, 0.32);
    cursor: default;
  }

  .project-explorer-context-menu button:disabled svg {
    color: rgba(247, 241, 231, 0.28);
  }

  .project-explorer-context-menu button:disabled:hover,
  .project-explorer-context-menu button:disabled:focus-visible {
    background: transparent;
  }

  .project-explorer-context-menu button.is-danger {
    color: #ffb2a3;
  }

  .project-explorer-context-menu button.is-danger svg {
    color: #ff8f7d;
  }

  .project-explorer-context-menu button.is-danger:hover,
  .project-explorer-context-menu button.is-danger:focus-visible {
    background: rgba(255, 102, 84, 0.12);
  }

  .project-explorer-empty {
    position: absolute;
    top: 50%;
    left: 50%;
    display: grid;
    gap: 14px;
    justify-items: center;
    width: min(340px, calc(100vw - 40px));
    transform: translate(-50%, -50%);
  }

  .project-explorer-empty p {
    margin: 0;
    color: var(--muted);
    font-weight: 650;
  }

  .project-explorer-empty button,
  .resource-modal__primary,
  .resource-modal__secondary {
    min-height: 40px;
    padding: 0 16px;
    border-radius: 8px;
    cursor: pointer;
    transition:
      transform 180ms ease,
      background 180ms ease,
      border-color 180ms ease,
      box-shadow 180ms ease;
  }

  .project-explorer-empty button,
  .resource-modal__primary {
    color: #07100b;
    background: var(--mint);
    border: 1px solid rgba(255, 255, 255, 0.16);
    box-shadow: 0 12px 34px rgba(94, 168, 113, 0.17);
  }

  .project-explorer-empty button:hover,
  .resource-modal__primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 16px 40px rgba(94, 168, 113, 0.24);
  }

  .project-loader {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
  }

  .project-loader span {
    width: min(180px, 42vw);
    height: 3px;
    overflow: hidden;
    background: rgba(247, 241, 231, 0.12);
    border-radius: 999px;
  }

  .project-loader span::after {
    display: block;
    width: 42%;
    height: 100%;
    content: "";
    background: rgba(247, 241, 231, 0.84);
    border-radius: inherit;
    animation: project-loader 920ms ease-in-out infinite;
  }

  .project-error {
    position: absolute;
    top: 50%;
    left: 50%;
    display: grid;
    gap: 18px;
    justify-items: center;
    width: min(360px, calc(100vw - 40px));
    padding: 24px;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: 8px;
    transform: translate(-50%, -50%);
  }

  .project-error p {
    margin: 0;
    color: var(--muted);
  }

  .project-error button {
    min-height: 40px;
    padding: 0 16px;
    color: #07100b;
    background: var(--text);
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 8px;
    cursor: pointer;
  }

  .resource-modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 30;
    display: grid;
    place-items: center;
    padding: 20px;
    background: rgba(2, 2, 2, 0.64);
    backdrop-filter: blur(10px);
  }

  .resource-modal {
    display: grid;
    gap: 0;
    width: min(720px, calc(100vw - 40px));
    max-height: min(720px, calc(100dvh - 32px));
    overflow: auto;
    color: var(--text);
    background: #101111;
    border: 1px solid rgba(255, 252, 244, 0.24);
    border-radius: 8px;
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.48);
  }

  .resource-modal header {
    display: flex;
    gap: 16px;
    align-items: center;
    justify-content: space-between;
    padding: 22px;
    border-bottom: 1px solid var(--line);
  }

  .resource-modal-title {
    display: flex;
    flex: 1 1 auto;
    gap: 4px;
    align-items: center;
    min-width: 0;
  }

  .resource-modal-title h2 {
    max-width: min(440px, calc(100vw - 150px));
    margin: 0;
    overflow: hidden;
    font-size: clamp(1.25rem, 2vw, 1.55rem);
    font-weight: 800;
    line-height: 1.2;
    letter-spacing: 0;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .resource-modal-title input {
    max-width: min(440px, calc(100vw - 150px));
    height: 44px;
    min-width: 0;
    padding: 0 10px;
    overflow: hidden;
    color: var(--text);
    font: inherit;
    font-size: clamp(1.25rem, 2vw, 1.55rem);
    font-weight: 800;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 8px;
    outline: none;
    transition:
      background 180ms ease,
      border-color 180ms ease,
      box-shadow 180ms ease,
      color 180ms ease;
  }

  .resource-modal-title input:hover,
  .resource-modal-title input:focus {
    background: rgba(255, 252, 244, 0.055);
    border-color: rgba(255, 252, 244, 0.18);
  }

  .resource-modal-title input:focus {
    color: #fffaf1;
    box-shadow: 0 0 0 3px rgba(247, 241, 231, 0.1);
  }

  .resource-modal-title input::placeholder {
    color: rgba(247, 241, 231, 0.58);
  }

  .resource-modal-title__button {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    color: var(--muted);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 7px;
    cursor: pointer;
    transition:
      background 180ms ease,
      border-color 180ms ease,
      color 180ms ease;
  }

  .resource-modal-title__button:hover,
  .resource-modal-title__button:focus-visible {
    color: var(--text);
    background: rgba(255, 252, 244, 0.08);
    border-color: var(--line);
  }

  .resource-modal__close {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    color: inherit;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 7px;
    cursor: pointer;
  }

  .resource-modal__close:hover {
    background: rgba(255, 252, 244, 0.08);
    border-color: var(--line);
  }

  .resource-modal__close:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .resource-modal__close span {
    position: relative;
    display: block;
    width: 16px;
    height: 16px;
  }

  .resource-modal__close span::before,
  .resource-modal__close span::after {
    position: absolute;
    top: 7px;
    left: 0;
    width: 16px;
    height: 2px;
    content: "";
    background: var(--muted);
    border-radius: 999px;
  }

  .resource-modal__close span::before {
    transform: rotate(45deg);
  }

  .resource-modal__close span::after {
    transform: rotate(-45deg);
  }

  .resource-type-picker,
  .resource-color-picker {
    display: grid;
    gap: 0;
    padding: 18px 22px 0;
    margin: 0;
    border: 0;
  }

  .resource-color-picker {
    padding: 22px 22px 18px;
  }

  .resource-type-picker__grid {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 8px;
  }

  .resource-type-option {
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: center;
    min-width: 0;
    min-height: 46px;
    padding: 8px 10px;
    color: var(--text);
    text-align: center;
    background: transparent;
    border: 1px solid rgba(255, 252, 244, 0.13);
    border-radius: 8px;
    cursor: pointer;
    transition:
      background 160ms ease,
      border-color 160ms ease,
      color 160ms ease;
  }

  .resource-type-option:hover {
    background: rgba(255, 252, 244, 0.045);
    border-color: rgba(247, 241, 231, 0.24);
  }

  .resource-type-option.is-selected {
    background: rgba(255, 252, 244, 0.065);
    border-color: rgba(247, 241, 231, 0.52);
    box-shadow: none;
  }

  .resource-type-option__icon {
    --resource-color: #f7f1e7;
    display: grid;
    flex: 0 0 auto;
    place-items: center;
    width: 26px;
    height: 26px;
    color: var(--resource-color, #f7f1e7);
  }

  .resource-type-option__copy {
    min-width: 0;
  }

  .resource-type-option__copy span {
    overflow: hidden;
    font-size: 0.84rem;
    font-weight: 750;
    line-height: 1.1;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .resource-color-picker__row {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    align-items: center;
    justify-content: center;
    width: min(100%, 576px);
    margin: 0 auto;
  }

  .resource-color-option {
    --item-color: #f7f1e7;
    width: 34px;
    height: 34px;
    padding: 0;
    cursor: pointer;
    background: var(--item-color);
    border: 2px solid rgba(255, 252, 244, 0.34);
    border-radius: 999px;
    outline: none;
    transition:
      border-color 160ms ease,
      box-shadow 160ms ease,
      transform 160ms ease;
  }

  .resource-color-option:hover,
  .resource-color-option:focus-visible {
    border-color: rgba(247, 241, 231, 0.72);
    transform: translateY(-1px);
  }

  .resource-color-option.is-selected {
    box-shadow:
      0 0 0 3px rgba(16, 17, 17, 1),
      0 0 0 5px rgba(255, 252, 244, 0.72);
  }

  .resource-modal__message {
    margin: 0;
    padding: 14px 22px 0;
    color: #ffb7aa;
    font-size: 0.78rem;
    font-weight: 700;
  }

  .resource-modal footer {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
    padding: 18px 22px 22px;
    border-top: 1px solid rgba(255, 252, 244, 0.08);
  }

  .resource-modal__secondary {
    background: rgba(255, 252, 244, 0.045);
    border: 1px solid var(--line-strong);
  }

  .resource-modal__secondary:hover {
    background: rgba(255, 252, 244, 0.075);
    border-color: rgba(247, 241, 231, 0.3);
  }

  .resource-modal__secondary:disabled,
  .resource-modal__primary:disabled {
    cursor: not-allowed;
    filter: grayscale(0.4);
    opacity: 0.62;
    transform: none;
  }

  @keyframes project-loader {
    0% {
      transform: translateX(-120%);
    }

    100% {
      transform: translateX(260%);
    }
  }

  @media (max-width: 720px) {
    .project-explorer {
      padding: 16px;
    }

    .project-explorer-shell {
      width: 100%;
    }

    .project-explorer-toolbar {
      align-items: flex-start;
      flex-direction: column;
      gap: 8px;
    }

    .project-explorer-header,
    .project-explorer-row {
      grid-template-columns: minmax(0, 1fr) 96px 54px;
    }

    .project-explorer-column:nth-child(2),
    .project-explorer-cell:nth-child(2) {
      display: none;
    }

    .project-explorer-column,
    .project-explorer-cell {
      padding: 0 10px;
    }

    .resource-type-picker__grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 520px) {
    .resource-modal-backdrop {
      padding: 12px;
    }

    .resource-modal {
      width: min(100%, 430px);
      max-height: calc(100dvh - 24px);
    }

    .resource-modal header {
      gap: 8px;
      padding: 14px;
    }

    .resource-modal-title input {
      max-width: calc(100vw - 116px);
      height: 38px;
      font-size: clamp(1.05rem, 5.2vw, 1.2rem);
    }

    .resource-modal-title h2 {
      max-width: calc(100vw - 116px);
      font-size: clamp(1.05rem, 5.2vw, 1.2rem);
    }

    .resource-type-picker,
    .resource-color-picker {
      padding: 14px 14px 0;
    }

    .resource-color-picker {
      padding-bottom: 16px;
    }

    .resource-type-picker__grid {
      grid-template-columns: 1fr;
      gap: 8px;
    }

    .resource-type-option {
      min-height: 58px;
      padding: 9px 10px;
    }

    .resource-modal footer {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      padding: 14px;
    }

    .resource-modal footer button {
      min-width: 0;
      padding-inline: 8px;
    }
  }

</style>
