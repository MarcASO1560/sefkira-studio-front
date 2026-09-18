<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";

import {
  API_V1_URL,
  type PixelAvatarData,
  type ProjectAccessRole,
  type ProjectAccessUserPublic,
  type ProjectBlockedUserPublic,
  type ProjectPublic,
  type ProjectShareLinkPublic,
  type UserPublic,
  type WorkspaceBootstrap,
} from "../../../lib/api";
import {
  connectUserRealtime,
  type RealtimeConnection,
  type RealtimeEventPayload,
} from "../../../lib/realtime";
import { WORKSPACE_TRANSITION_STORAGE_KEY } from "../../../lib/routeTransition";
import { getAccessUserDisplayName, getUserDisplayName, getUserInitials } from "../../../lib/userDisplayName";
import { copyShareLinkText } from "../lib/shareLinkClipboard";
import {
  canBlockProjectMember,
  isShareLinkExpired,
  projectAccessFailureMessage,
  SHARE_EXPIRATION_OPTIONS,
  shareExpirationToUtc,
  shareLinkFailureMessage,
  utcToLocalDateTimeInput,
  type ShareExpirationPreset,
} from "../lib/shareLinkExpiration";
import StudioTopbarCommandBar from "../../navigation/components/StudioTopbarCommandBar.vue";
import StudioTopbar from "../../navigation/components/StudioTopbar.vue";
import { PIXEL_ART_PALETTE } from "../../pixel-art/lib/palette";
import LifeOscillatorPreview from "./LifeOscillatorPreview.vue";
import ProjectEditorDialog from "./ProjectEditorDialog.vue";
import ProjectPixelArtThumbnail from "./ProjectPixelArtThumbnail.vue";
import UserProfileDialog from "./UserProfileDialog.vue";

type ExplorerProject = {
  id: string;
  name: string;
  color: string;
  accessRole: ProjectAccessRole;
  accessCount: number;
  projectPixelArt: PixelAvatarData | null;
};

type ShareLinkRole = Extract<ProjectAccessRole, "viewer" | "editor">;

const props = defineProps<{
  initialWorkspace?: WorkspaceBootstrap | null;
  userName?: string;
  userUsername?: string | null;
  userAvatarUrl?: string;
  userEmail?: string;
  userPixelAvatar?: PixelAvatarData | null;
}>();

const PROJECT_PIXEL_SIZE = 16;
const DEFAULT_PROJECT_COLOR = "#f7f1e7";
const DELETE_LOADING_MIN_MS = 520;
const LOAD_MESSAGE_TIMEOUT_MS = 4200;
const WORKSPACE_SYNC_INTERVAL_MS = 30000;
const PROJECT_ACCESS_SYNC_INTERVAL_MS = 15000;
const REALTIME_REFRESH_DELAY_MS = 180;
const REQUEST_TIMEOUT_MS = 18000;
const STALE_SYNC_MS = REQUEST_TIMEOUT_MS + 5000;

const projects = ref<ExplorerProject[]>([]);
const selectedProjectId = ref<string | null>(null);
const searchQuery = ref("");
const isLoading = ref(true);
const isSyncingWorkspace = ref(false);
const workspaceSyncStartedAt = ref<number | null>(null);
const loadMessage = ref("");
const loadMessageTimeoutId = ref<number | null>(null);
const workspaceSyncIntervalId = ref<number | null>(null);
const projectAccessSyncIntervalId = ref<number | null>(null);
const realtimeConnection = ref<RealtimeConnection | null>(null);
const workspaceRefreshTimeoutId = ref<number | null>(null);
const accessRefreshTimeoutId = ref<number | null>(null);
const activeMenuProjectId = ref<string | null>(null);
const isProfileDialogOpen = ref(false);
const profileUserName = ref(getUserDisplayName({ username: props.userUsername, email: props.userEmail }, props.userName || ""));
const profileUsername = ref(props.userUsername || "");
const profileAvatarUrl = ref(props.userAvatarUrl || "");
const profileEmail = ref(props.userEmail || "");
const profilePixelAvatar = ref<PixelAvatarData | null>(props.userPixelAvatar || null);

const isCreateOpen = ref(false);
const isCreating = ref(false);
const projectPendingLeave = ref<ExplorerProject | null>(null);
const projectPendingDelete = ref<ExplorerProject | null>(null);
const isDeletingProject = ref(false);
const projectPendingShare = ref<ExplorerProject | null>(null);
const shareDialogRef = ref<HTMLElement | null>(null);
let shareOpener: HTMLElement | null = null;
let shareOpenerFallback: HTMLElement | null = null;
const projectShareLink = ref<ProjectShareLinkPublic | null>(null);
const shareLinkLoaded = ref(false);
const shareRole = ref<ShareLinkRole>("editor");
const shareMessage = ref("");
const isSharingProject = ref(false);
let isSyncingShareLink = false;
let shareSnapshotVersion = 0;
const shareExpirationPreset = ref<ShareExpirationPreset>("7days");
const shareCustomExpiration = ref("");
const shareExpirationDirty = ref(false);
const shareDisablePending = ref(false);
const shareNow = ref(Date.now());
let shareClockIntervalId: number | null = null;
let shareDialogVersion = 0;
let accessDialogVersion = 0;
let accessSyncVersion = 0;
const projectPendingInfo = ref<ExplorerProject | null>(null);
const projectAccessUsers = ref<ProjectAccessUserPublic[]>([]);
const projectBlockedUsers = ref<ProjectBlockedUserPublic[]>([]);
const blockedMessage = ref("");
const isLoadingBlockedUsers = ref(false);
const accessManagementDenied = ref(false);
const accessMessage = ref("");
const isLoadingProjectAccess = ref(false);
const isSyncingProjectAccess = ref(false);
const projectAccessSyncStartedAt = ref<number | null>(null);
const accessUpdatingUserId = ref<string | null>(null);
const accessRemovingUserId = ref<string | null>(null);
const accessUserPendingRemove = ref<ProjectAccessUserPublic | null>(null);
const accessBlockingUserId = ref<string | null>(null);
const accessUnblockingUserId = ref<string | null>(null);
const accessUserPendingBlock = ref<ProjectAccessUserPublic | null>(null);
const leavingProjectId = ref<string | null>(null);
const editingProjectId = ref<string | null>(null);
const createName = ref("");
const projectAvatarPixels = ref<Array<string | null>>([]);
const showProjectUnsavedConfirm = ref(false);
const initialProjectName = ref("");
const initialProjectPixelsKey = ref("");
const editingProjectHasRemoteChanges = ref(false);
const isEditingProject = computed(() => Boolean(editingProjectId.value));

const projectRoleOptions: Array<{
  value: ProjectAccessRole;
  label: string;
  description: string;
}> = [
  {
    value: "viewer",
    label: "View only",
    description: "Can open the project without editing it.",
  },
  {
    value: "editor",
    label: "Can edit",
    description: "Can update project content.",
  },
  {
    value: "owner",
    label: "Owner",
    description: "Can manage sharing and access.",
  },
];

const shareRoleOptions: Array<{
  value: ShareLinkRole;
  label: string;
  description: string;
}> = [
  {
    value: "viewer",
    label: "View only",
    description: "People can open the project, but they cannot edit it.",
  },
  {
    value: "editor",
    label: "Can edit",
    description: "People can open the project and save changes.",
  },
];

const currentUserAvatarUrl = computed(() => profileAvatarUrl.value.trim());
const currentUserEmail = computed(() => profileEmail.value.trim());

const projectPixelPalette = computed(() => PIXEL_ART_PALETTE);

const projectPixelArtPreview = computed<PixelAvatarData>(() => ({
  version: 1,
  size: PROJECT_PIXEL_SIZE,
  palette: projectPixelPalette.value,
  pixels: [...projectAvatarPixels.value],
}));

const shareProjectUrl = computed(() => {
  if (!projectShareLink.value) {
    return "";
  }

  const sharePath = `/share/${encodeURIComponent(projectShareLink.value.token)}`;
  if (typeof window === "undefined") {
    return sharePath;
  }

  return new URL(sharePath, window.location.origin).toString();
});

const shareExpired = computed(() => isShareLinkExpired(projectShareLink.value, shareNow.value));
const formatDateTime = (value: string) => new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium", timeStyle: "short",
}).format(new Date(value));
const shareExpirationLabel = computed(() => {
  const link = projectShareLink.value;
  if (!shareLinkLoaded.value) return isSharingProject.value ? "Loading share link..." : "Share link could not be loaded";
  if (!link) return "No active share link";
  if (!link.expires_at) return "No expiration";
  return `${shareExpired.value ? "Expired" : "Expires"} ${formatDateTime(link.expires_at)}`;
});
const accessMutationBusy = computed(() => Boolean(accessUpdatingUserId.value || accessRemovingUserId.value ||
  accessBlockingUserId.value || accessUnblockingUserId.value));

const projectAccessCountLabel = computed(() => {
  const count = projectAccessUsers.value.length;
  if (isLoadingProjectAccess.value) {
    return "Loading access...";
  }

  return count === 1 ? "1 person has access" : `${count} people have access`;
});

type AccessProfile = Pick<ProjectAccessUserPublic, "email" | "username">;
const accessUserName = (user: AccessProfile) => getAccessUserDisplayName(user);

const accessRoleLabel = (roleOrUser: ProjectAccessRole | ProjectAccessUserPublic) => {
  const role = typeof roleOrUser === "string" ? roleOrUser : roleOrUser.role;
  if (role === "owner") return "Owner";
  if (role === "viewer") return "Viewer";
  return "Editor";
};

const canManageProjectAccess = computed(
  () => projectPendingInfo.value?.accessRole === "owner" && !projectPendingInfo.value.id.startsWith("local-") && !accessManagementDenied.value,
);

const canLeaveProject = (project: ExplorerProject) => {
  if (project.id.startsWith("local-")) {
    return false;
  }

  return project.accessCount > 1;
};

const canDeleteProject = (project: ExplorerProject) => {
  if (project.id.startsWith("local-")) {
    return project.accessRole === "owner";
  }

  return project.accessRole === "owner" && project.accessCount <= 1;
};

const isCurrentAccessUser = (user: ProjectAccessUserPublic) =>
  user.email === currentUserEmail.value;

const accessUserInitials = (user: AccessProfile) => {
  const label = getUserDisplayName(user, "U").trim();
  const [firstPart = ""] = label.split("@");
  return getUserInitials(firstPart, "U", 1);
};

const handleProjectManagementError = (error: unknown) => {
  if (error instanceof ProjectRequestError && [401, 403, 404].includes(error.status)) {
    accessManagementDenied.value = true;
    projectBlockedUsers.value = [];
  }
};

const visibleProjects = computed(() => {
  const normalizedSearch = searchQuery.value.trim().toLowerCase();

  return projects.value.filter((project) => {
    if (!normalizedSearch) {
      return true;
    }

    return project.name.toLowerCase().includes(normalizedSearch);
  });
});

const emptyTitle = computed(() => {
  if (searchQuery.value.trim()) {
    return "No matches found";
  }

  return "No projects yet";
});

const emptyCopy = computed(() => {
  if (searchQuery.value.trim()) {
    return "Try another project name.";
  }

  return "Create your first project.";
});

const readSetting = <Value,>(
  settings: Record<string, unknown> | undefined,
  key: string,
  fallback: Value,
) => {
  const value = settings?.[key];
  return value === undefined ? fallback : (value as Value);
};

const createEmptyProjectPixels = () =>
  Array<string | null>(PROJECT_PIXEL_SIZE * PROJECT_PIXEL_SIZE).fill(null);

const pixelsKey = (pixels: Array<string | null>) => pixels.map((pixel) => pixel || "").join("|");

const hasProjectPixels = (pixels: Array<string | null> | undefined) =>
  Boolean(pixels?.some((pixel) => pixel));

const hasProjectPixelArt = (pixelArt: PixelAvatarData | null | undefined) =>
  hasProjectPixels(pixelArt?.pixels);

const buildProjectPixelArt = () =>
  hasProjectPixels(projectAvatarPixels.value) ? projectPixelArtPreview.value : null;

const mapProject = (
  project: ProjectPublic,
  overrides: Partial<ExplorerProject> = {},
): ExplorerProject => {
  const settings = project.settings || {};

  return {
    id: project.id,
    name: project.name,
    color: readSetting<string>(settings, "color", DEFAULT_PROJECT_COLOR),
    accessRole: project.access_role || "owner",
    accessCount: project.access_count || 1,
    projectPixelArt: readSetting<PixelAvatarData | null>(settings, "project_pixel_art", null),
    ...overrides,
  };
};

if (props.initialWorkspace) {
  projects.value = props.initialWorkspace.projects.map((project) => mapProject(project));
  selectedProjectId.value = projects.value[0]?.id || null;
  isLoading.value = false;
}

const buildLocalProject = (): ExplorerProject => {
  return {
    id: `local-${crypto.randomUUID()}`,
    name: createName.value.trim() || "New project",
    color: DEFAULT_PROJECT_COLOR,
    accessRole: "owner",
    accessCount: 1,
    projectPixelArt: buildProjectPixelArt(),
  };
};

class ProjectRequestError extends Error {
  constructor(public status: number, public detail: unknown) {
    super(projectAccessFailureMessage(detail, status));
  }
}

const requestJson = async <ResponseBody,>(
  path: string,
  init: RequestInit = {},
) => {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;

  try {
    response = await fetch(`${API_V1_URL}${path}`, {
      ...init,
      credentials: "same-origin",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("The connection took too long to respond.");
    }

    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }

  if (!response.ok) {
    let detail: unknown;
    try {
      const payload = (await response.json()) as { detail?: unknown };
      detail = payload.detail;
    } catch {
      // Keep the generic status message when the API returns an empty body.
    }

    throw new ProjectRequestError(response.status, detail);
  }

  if (response.status === 204) {
    return undefined as ResponseBody;
  }

  return (await response.json()) as ResponseBody;
};

const resetStaleWorkspaceSync = () => {
  if (
    isSyncingWorkspace.value &&
    workspaceSyncStartedAt.value &&
    Date.now() - workspaceSyncStartedAt.value > STALE_SYNC_MS
  ) {
    isSyncingWorkspace.value = false;
    workspaceSyncStartedAt.value = null;
    isLoading.value = false;
  }
};

const resetStaleProjectAccessSync = () => {
  if (
    isSyncingProjectAccess.value &&
    projectAccessSyncStartedAt.value &&
    Date.now() - projectAccessSyncStartedAt.value > STALE_SYNC_MS
  ) {
    isSyncingProjectAccess.value = false;
    projectAccessSyncStartedAt.value = null;
    isLoadingProjectAccess.value = false;
  }
};

const applyWorkspaceProjects = (nextProjects: ExplorerProject[]) => {
  projects.value = nextProjects;

  if (!nextProjects.some((project) => project.id === selectedProjectId.value)) {
    selectedProjectId.value = nextProjects[0]?.id || null;
  }

  if (activeMenuProjectId.value && !nextProjects.some((project) => project.id === activeMenuProjectId.value)) {
    activeMenuProjectId.value = null;
  }

  const syncPendingProject = (project: ExplorerProject | null) =>
    project ? nextProjects.find((nextProject) => nextProject.id === project.id) || null : null;

  if (projectPendingInfo.value) {
    const syncedProject = syncPendingProject(projectPendingInfo.value);
    if (syncedProject) {
      projectPendingInfo.value = syncedProject;
      if (syncedProject.accessRole !== "owner") {
        projectBlockedUsers.value = [];
        accessUserPendingBlock.value = null;
        accessUserPendingRemove.value = null;
      }
    } else {
      const projectName = projectPendingInfo.value.name;
      resetProjectInfoDialog();
      showLoadMessage(`You no longer have access to "${projectName}".`);
    }
  }

  if (projectPendingShare.value) {
    const syncedShareProject = syncPendingProject(projectPendingShare.value);
    if (syncedShareProject?.accessRole === "owner") projectPendingShare.value = syncedShareProject;
    else resetShareDialog();
  }
  projectPendingLeave.value = syncPendingProject(projectPendingLeave.value);
  projectPendingDelete.value = syncPendingProject(projectPendingDelete.value);

  if (editingProjectId.value) {
    const syncedProject = nextProjects.find((project) => project.id === editingProjectId.value);
    if (!syncedProject) {
      closeProjectDialogNow();
      showLoadMessage("This project is no longer available.");
    } else if (isCreateOpen.value && !hasProjectUnsavedChanges.value) {
      createName.value = syncedProject.name;
      projectAvatarPixels.value = syncedProject.projectPixelArt?.pixels
        ? [...syncedProject.projectPixelArt.pixels]
        : createEmptyProjectPixels();
      rememberProjectDialogState();
    }
  }
};

const refreshWorkspace = async ({
  showLoading = false,
  resetMessage = false,
  showError = false,
} = {}) => {
  resetStaleWorkspaceSync();
  if (isSyncingWorkspace.value) {
    return;
  }

  isSyncingWorkspace.value = true;
  workspaceSyncStartedAt.value = Date.now();
  if (showLoading) {
    isLoading.value = true;
  }
  if (resetMessage) {
    clearLoadMessage();
  }

  try {
    const workspace = await requestJson<WorkspaceBootstrap>("/workspace/");
    applyWorkspaceProjects(workspace.projects.map((project) => mapProject(project)));
  } catch {
    if (showError) {
      showLoadMessage("Remote projects could not be loaded. You can still create a local draft.");
    }
  } finally {
    if (showLoading) {
      isLoading.value = false;
    }
    isSyncingWorkspace.value = false;
    workspaceSyncStartedAt.value = null;
  }
};

const loadWorkspace = async () => {
  await refreshWorkspace({
    showLoading: true,
    resetMessage: true,
    showError: true,
  });
};

const acceptProjectShareFromUrl = async () => {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);
  const shareToken = url.searchParams.get("share");
  if (!shareToken) {
    return;
  }

  try {
    const sharedProject = await requestJson<ProjectPublic>(
      `/projects/share-links/${encodeURIComponent(shareToken)}/accept`,
      { method: "POST" },
    );
    const explorerProject = mapProject(sharedProject);
    projects.value = [
      explorerProject,
      ...projects.value.filter((project) => project.id !== explorerProject.id),
    ];
    selectedProjectId.value = explorerProject.id;
    showLoadMessage(`"${explorerProject.name}" has been added to your studio.`);
  } catch (error) {
    showLoadMessage(error instanceof ProjectRequestError ? shareLinkFailureMessage(error.status, error.detail) : "The shared project could not be opened. Check your connection and try again.");
  } finally {
    url.searchParams.delete("share");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }
};

const initializeWorkspace = async () => {
  if (!props.initialWorkspace) {
    await loadWorkspace();
  }
  await acceptProjectShareFromUrl();
};

const rememberProjectDialogState = () => {
  initialProjectName.value = createName.value.trim();
  initialProjectPixelsKey.value = pixelsKey(projectAvatarPixels.value);
  showProjectUnsavedConfirm.value = false;
  editingProjectHasRemoteChanges.value = false;
};

const hasProjectUnsavedChanges = computed(
  () =>
    createName.value.trim() !== initialProjectName.value ||
    pixelsKey(projectAvatarPixels.value) !== initialProjectPixelsKey.value,
);

const resetCreateForm = () => {
  createName.value = "New project";
  projectAvatarPixels.value = createEmptyProjectPixels();
  rememberProjectDialogState();
};

const buildProjectSettings = (project: ExplorerProject) => ({
  color: project.color,
  project_pixel_art: project.projectPixelArt,
});

const openCreateDialog = () => {
  resetCreateForm();
  editingProjectId.value = null;
  isCreateOpen.value = true;
};

const openEditDialog = (project: ExplorerProject) => {
  createName.value = project.name;
  projectAvatarPixels.value = project.projectPixelArt?.pixels
    ? [...project.projectPixelArt.pixels]
    : createEmptyProjectPixels();
  rememberProjectDialogState();
  editingProjectId.value = project.id;
  activeMenuProjectId.value = null;
  isCreateOpen.value = true;
};

const closeProjectDialogNow = () => {
  isCreateOpen.value = false;
  editingProjectId.value = null;
  showProjectUnsavedConfirm.value = false;
  editingProjectHasRemoteChanges.value = false;
};

const closeCreateDialog = () => {
  if (isCreating.value) {
    return;
  }

  if (hasProjectUnsavedChanges.value) {
    showProjectUnsavedConfirm.value = true;
    return;
  }

  closeProjectDialogNow();
};

const discardProjectChanges = () => {
  closeProjectDialogNow();
};

const createRemoteProject = async (localProject: ExplorerProject) => {
  const createdProject = await requestJson<ProjectPublic>("/projects/", {
    method: "POST",
    body: JSON.stringify({
      name: localProject.name,
      description: null,
      settings: buildProjectSettings(localProject),
      thumbnail_url: null,
    }),
  });

  return mapProject(createdProject, {
    projectPixelArt: localProject.projectPixelArt,
  });
};

const buildProjectFromForm = (project: ExplorerProject): ExplorerProject => ({
  ...project,
  name: createName.value.trim() || project.name,
  projectPixelArt: buildProjectPixelArt(),
});

const updateRemoteProject = async (
  originalProject: ExplorerProject,
  nextProject: ExplorerProject,
) => {
  const updatedProject = await requestJson<ProjectPublic>(`/projects/${originalProject.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      name: nextProject.name,
      description: null,
      settings: buildProjectSettings(nextProject),
      thumbnail_url: null,
    }),
  });

  return mapProject(updatedProject, {
    projectPixelArt: nextProject.projectPixelArt,
  });
};

const createProject = async () => {
  if (!createName.value.trim()) {
    return;
  }

  isCreating.value = true;
  const localProject = buildLocalProject();

  try {
    const remoteProject = await createRemoteProject(localProject);
    projects.value = [remoteProject, ...projects.value];
    selectedProjectId.value = remoteProject.id;
  } catch {
    projects.value = [localProject, ...projects.value];
    selectedProjectId.value = localProject.id;
    showLoadMessage("Project created locally for this session. The remote connection did not respond.");
  } finally {
    isCreating.value = false;
    closeProjectDialogNow();
  }
};

const updateProject = async () => {
  if (!createName.value.trim() || !editingProjectId.value) {
    return;
  }

  const existingProject = projects.value.find((project) => project.id === editingProjectId.value);

  if (!existingProject) {
    return;
  }

  isCreating.value = true;
  const localProject = buildProjectFromForm(existingProject);

  try {
    const nextProject = existingProject.id.startsWith("local-")
      ? localProject
      : await updateRemoteProject(existingProject, localProject);
    projects.value = projects.value.map((project) =>
      project.id === existingProject.id ? nextProject : project,
    );
    selectedProjectId.value = nextProject.id;
  } catch {
    projects.value = projects.value.map((project) =>
      project.id === existingProject.id ? localProject : project,
    );
    selectedProjectId.value = existingProject.id;
    showLoadMessage("Project updated locally for this session. The remote connection did not respond.");
  } finally {
    isCreating.value = false;
    closeProjectDialogNow();
  }
};

const saveProject = () => {
  if (editingProjectHasRemoteChanges.value) {
    showLoadMessage("This project changed in another session. Reopen it before saving.");
    return;
  }

  if (isEditingProject.value) {
    void updateProject();
    return;
  }

  void createProject();
};

const saveProjectUnsavedChanges = () => {
  if (!createName.value.trim()) {
    createName.value = "New project";
  }

  saveProject();
};

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });

const clearLoadMessageTimeout = () => {
  if (loadMessageTimeoutId.value === null) {
    return;
  }

  window.clearTimeout(loadMessageTimeoutId.value);
  loadMessageTimeoutId.value = null;
};

const clearLoadMessage = () => {
  clearLoadMessageTimeout();
  loadMessage.value = "";
};

const showLoadMessage = (message: string, autoDismiss = true) => {
  clearLoadMessageTimeout();
  loadMessage.value = message;

  if (!message || !autoDismiss) {
    return;
  }

  loadMessageTimeoutId.value = window.setTimeout(() => {
    loadMessage.value = "";
    loadMessageTimeoutId.value = null;
  }, LOAD_MESSAGE_TIMEOUT_MS);
};

const requestLeaveProject = (project: ExplorerProject) => {
  activeMenuProjectId.value = null;
  projectPendingLeave.value = project;
};

const closeLeaveDialog = () => {
  if (leavingProjectId.value) {
    return;
  }

  projectPendingLeave.value = null;
};

const requestDeleteProject = (project: ExplorerProject) => {
  activeMenuProjectId.value = null;
  projectPendingDelete.value = project;
};

const closeShareDialog = () => {
  if (isSharingProject.value) {
    return;
  }
  resetShareDialog();
};

const shareFocusableElements = () => Array.from(shareDialogRef.value?.querySelectorAll<HTMLElement>(
  'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
) || []).filter((element) => element.tabIndex >= 0 && !element.closest("[inert]") && element.getClientRects().length > 0);

const handleShareDialogKeydown = (event: KeyboardEvent) => {
  if (event.defaultPrevented || event.isComposing || !projectPendingShare.value) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeShareDialog();
    return;
  }
  if (event.key !== "Tab") return;
  const elements = shareFocusableElements();
  const first = elements[0];
  const last = elements[elements.length - 1];
  if (!first || !last) {
    event.preventDefault();
    shareDialogRef.value?.focus({ preventScroll: true });
  } else if (event.shiftKey && (document.activeElement === first || !elements.includes(document.activeElement as HTMLElement))) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && (document.activeElement === last || !elements.includes(document.activeElement as HTMLElement))) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
};

watch(shareMessage, async (message) => {
  if (!message || !projectPendingShare.value) return;
  const version = shareDialogVersion;
  await nextTick();
  if (version !== shareDialogVersion || !projectPendingShare.value || shareMessage.value !== message) return;
  shareDialogRef.value?.querySelector<HTMLElement>(".share-dialog__message")?.scrollIntoView({ block: "nearest", inline: "nearest" });
});

const resetShareDialog = () => {
  const focusTargets = [shareOpener, shareOpenerFallback];
  shareOpener = null;
  shareOpenerFallback = null;
  projectPendingShare.value = null;
  shareDialogVersion += 1;
  const version = shareDialogVersion;
  void nextTick(() => {
    if (version !== shareDialogVersion || projectPendingShare.value) return;
    const target = focusTargets.find((element) => element?.isConnected && !element.closest("[inert]") && element.getClientRects().length > 0);
    target?.focus({ preventScroll: true });
  });
  projectShareLink.value = null;
  shareRole.value = "editor";
  shareMessage.value = "";
  shareExpirationPreset.value = "7days";
  shareCustomExpiration.value = "";
  shareExpirationDirty.value = false;
  shareDisablePending.value = false;
  shareLinkLoaded.value = false;
  isSharingProject.value = false;
  isSyncingShareLink = false;
  shareSnapshotVersion += 1;
};

const normalizeShareRole = (role: ProjectAccessRole): ShareLinkRole =>
  role === "viewer" ? "viewer" : "editor";

const saveShareLink = async (project: ExplorerProject, changes: {
  role?: ShareLinkRole; expires_at?: string | null; rotate_token?: boolean;
}) =>
  requestJson<ProjectShareLinkPublic>(`/projects/${project.id}/share-link`, {
    method: "POST",
    body: JSON.stringify(changes),
  });

const applyShareLink = (link: ProjectShareLinkPublic | null) => {
  shareLinkLoaded.value = true;
  projectShareLink.value = link;
  shareRole.value = link ? normalizeShareRole(link.role) : "editor";
  shareExpirationPreset.value = link ? (link.expires_at ? "custom" : "never") : "7days";
  shareCustomExpiration.value = link?.expires_at ? utcToLocalDateTimeInput(link.expires_at) : "";
  shareExpirationDirty.value = false;
  shareNow.value = Date.now();
};

const openShareDialog = async (project: ExplorerProject) => {
  if (isSharingProject.value || project.accessRole !== "owner" || project.id.startsWith("local-")) return;
  if (!projectPendingShare.value) {
    shareOpener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const card = shareOpener?.closest<HTMLElement>(".project-card") ||
      document.querySelectorAll<HTMLElement>(".project-card")[visibleProjects.value.findIndex((item) => item.id === project.id)];
    shareOpenerFallback = card?.querySelector<HTMLElement>('.card-menu button[aria-label="Project actions"]') || card || null;
  }
  const version = ++shareDialogVersion;
  shareSnapshotVersion += 1;
  isSyncingShareLink = false;
  const isCurrent = () => shareDialogVersion === version && projectPendingShare.value?.id === project.id;
  activeMenuProjectId.value = null;
  projectPendingShare.value = project;
  applyShareLink(null);
  shareLinkLoaded.value = false;
  shareDisablePending.value = false;
  shareMessage.value = "";
  isSharingProject.value = true;
  void nextTick(() => {
    if (isCurrent()) (shareFocusableElements()[0] || shareDialogRef.value)?.focus({ preventScroll: true });
  });

  try {
    const existingShareLink = await requestJson<ProjectShareLinkPublic | null>(
      `/projects/${project.id}/share-link`,
    );
    if (isCurrent()) applyShareLink(existingShareLink);
  } catch (error) {
    if (isCurrent()) shareMessage.value =
      error instanceof Error ? error.message : "Share link could not be loaded.";
  } finally {
    if (isCurrent()) isSharingProject.value = false;
  }
};

const syncOpenShareLink = async () => {
  const project = projectPendingShare.value;
  if (!project || isSharingProject.value || isSyncingShareLink || !shareLinkLoaded.value ||
    shareDisablePending.value || shareExpirationDirty.value ||
    (shareExpired.value && projectShareLink.value && shareRole.value !== projectShareLink.value.role)) return;
  const version = shareDialogVersion;
  const snapshotVersion = ++shareSnapshotVersion;
  const isCurrent = () => version === shareDialogVersion && snapshotVersion === shareSnapshotVersion && projectPendingShare.value?.id === project.id;
  isSyncingShareLink = true;
  try {
    const link = await requestJson<ProjectShareLinkPublic | null>(`/projects/${project.id}/share-link`);
    if (!isCurrent()) return;
    if (shareExpirationDirty.value || shareDisablePending.value) return;
    const previous = projectShareLink.value;
    if (previous?.token !== link?.token || previous?.expires_at !== link?.expires_at || previous?.role !== link?.role || previous?.is_expired !== link?.is_expired) {
      applyShareLink(link);
      shareMessage.value = !link ? "This link was disabled in another session. Existing members keep their access." :
        previous && previous.token !== link.token ? "The link was renewed in another session. The previous link no longer works." : "Share link settings updated in another session.";
    }
  } catch (error) {
    if (isCurrent() && error instanceof ProjectRequestError && [401, 403, 404].includes(error.status)) {
      resetShareDialog();
      showLoadMessage("You no longer have permission to manage this project's sharing.");
    }
  } finally {
    if (isCurrent()) isSyncingShareLink = false;
  }
};

const updateShareRole = async (role: ShareLinkRole) => {
  const project = projectPendingShare.value;
  if (!project || !shareLinkLoaded.value || project.accessRole !== "owner" || isSharingProject.value || shareDisablePending.value || shareRole.value === role) {
    return;
  }
  const previousRole = shareRole.value;
  shareRole.value = role;
  shareMessage.value = "";
  shareSnapshotVersion += 1;
  isSyncingShareLink = false;
  // Inactive links require an explicit Create/Renew, never a permission click.
  if (!projectShareLink.value || isShareLinkExpired(projectShareLink.value, Date.now())) {
    shareNow.value = Date.now();
    return;
  }
  const version = shareDialogVersion;
  const isCurrent = () => shareDialogVersion === version && projectPendingShare.value?.id === project.id;
  isSharingProject.value = true;

  try {
    const link = await saveShareLink(project, { role }); // Omit expiry to preserve the actual deadline.
    if (isCurrent()) projectShareLink.value = link;
  } catch (error) {
    if (isCurrent()) {
      shareRole.value = previousRole;
      shareMessage.value = error instanceof Error ? error.message : "Share permission could not be updated.";
    }
  } finally {
    if (isCurrent()) isSharingProject.value = false;
  }
};

const updateShareExpiration = async (renew = false) => {
  const project = projectPendingShare.value;
  if (!project || !shareLinkLoaded.value || isSharingProject.value || shareDisablePending.value || project.accessRole !== "owner") return;
  const version = shareDialogVersion;
  shareSnapshotVersion += 1;
  isSyncingShareLink = false;
  const isCurrent = () => shareDialogVersion === version && projectPendingShare.value?.id === project.id;
  const oldToken = projectShareLink.value?.token;
  // Renewing an existing date, including an expired custom date, gets a fresh 7-day deadline.
  const preset = renew && !shareExpirationDirty.value && shareExpirationPreset.value === "custom" ? "7days" : shareExpirationPreset.value;
  let expiresAt: string | null;
  try {
    expiresAt = shareExpirationToUtc(preset, shareCustomExpiration.value);
  } catch (error) {
    shareMessage.value = error instanceof Error ? error.message : "Choose a valid expiration date.";
    return;
  }
  shareMessage.value = "";
  isSharingProject.value = true;
  try {
    const link = await saveShareLink(project, {
      ...(!oldToken || renew ? { role: shareRole.value } : {}),
      expires_at: expiresAt, ...(renew ? { rotate_token: true } : {}),
    });
    if (isCurrent()) {
      applyShareLink(link);
      shareMessage.value = oldToken && oldToken !== link.token ? "Link renewed. The previous link no longer works." :
        oldToken ? "Expiration updated." : "Share link created.";
    }
  } catch (error) {
    if (isCurrent()) shareMessage.value = error instanceof Error ? error.message : "Share link could not be updated.";
  } finally {
    if (isCurrent()) isSharingProject.value = false;
  }
};

const disableShareLink = async () => {
  const project = projectPendingShare.value;
  if (!project || !projectShareLink.value || isSharingProject.value || !shareDisablePending.value || project.accessRole !== "owner") return;
  const version = shareDialogVersion;
  shareSnapshotVersion += 1;
  isSyncingShareLink = false;
  const isCurrent = () => shareDialogVersion === version && projectPendingShare.value?.id === project.id;
  isSharingProject.value = true;
  shareMessage.value = "";
  try {
    await requestJson<void>(`/projects/${project.id}/share-link`, { method: "DELETE" });
    if (isCurrent()) {
      applyShareLink(null);
      shareDisablePending.value = false;
      shareMessage.value = "Link disabled. It no longer works. People already in the project keep their access.";
    }
  } catch (error) {
    if (isCurrent()) shareMessage.value = error instanceof Error ? error.message : "Share link could not be disabled.";
  } finally {
    if (isCurrent()) isSharingProject.value = false;
  }
};

const copyShareLink = async () => {
  const shareUrl = shareProjectUrl.value;
  if (!shareUrl || !shareLinkLoaded.value || isSharingProject.value || shareDisablePending.value || isShareLinkExpired(projectShareLink.value, Date.now())) {
    shareNow.value = Date.now();
    return;
  }
  const version = shareDialogVersion;
  const isCurrent = () => version === shareDialogVersion && shareProjectUrl.value === shareUrl;
  const result = await copyShareLinkText(
    shareUrl, document.getElementById("project-share-url") as HTMLInputElement | null, isCurrent,
  );
  if (!isCurrent()) return;
  shareMessage.value = result === "copied" ? "Link copied." : result === "selected" ?
    "The link is selected. Press and hold to copy on mobile, or press Ctrl+C / ⌘C." :
    "Copy is not available in this browser. Select the link and copy it manually.";
};

const buildLocalProjectAccess = (): ProjectAccessUserPublic => ({
  id: "local-current-user",
  username: profileUsername.value || null,
  email: currentUserEmail.value || "You",
  avatar_url: currentUserAvatarUrl.value || null,
  avatar_pixel_art: profilePixelAvatar.value,
  role: "owner",
  is_owner: true,
  joined_at: null,
});

const closeProjectInfoDialog = () => {
  if (accessMutationBusy.value) return;
  resetProjectInfoDialog();
};

const resetProjectInfoDialog = () => {
  accessDialogVersion += 1;
  accessSyncVersion += 1;
  projectPendingInfo.value = null;
  projectAccessUsers.value = [];
  projectBlockedUsers.value = [];
  blockedMessage.value = "";
  isLoadingBlockedUsers.value = false;
  accessManagementDenied.value = false;
  accessMessage.value = "";
  isLoadingProjectAccess.value = false;
  isSyncingProjectAccess.value = false;
  accessUpdatingUserId.value = null;
  accessRemovingUserId.value = null;
  accessUserPendingRemove.value = null;
  accessUserPendingBlock.value = null;
  accessBlockingUserId.value = null;
  accessUnblockingUserId.value = null;
};

const applyProjectAccessSnapshot = (
  projectId: string,
  accessUsers: ProjectAccessUserPublic[],
) => {
  if (projectPendingInfo.value?.id === projectId) {
    projectAccessUsers.value = accessUsers;
  }

  updateStoredProjectAccessCount(projectId, accessUsers.length);

  const currentUser = accessUsers.find((user) => isCurrentAccessUser(user));
  if (currentUser) {
    updateStoredProjectRole(projectId, currentUser.role);
  }
};

const syncOpenProjectAccess = async ({
  showLoading = false,
  showMissingMessage = true,
} = {}) => {
  const project = projectPendingInfo.value;
  resetStaleProjectAccessSync();
  if (
    !project ||
    project.id.startsWith("local-") ||
    isSyncingProjectAccess.value ||
    accessMutationBusy.value || accessUserPendingBlock.value || accessUserPendingRemove.value
  ) {
    return;
  }

  const version = accessDialogVersion;
  const syncVersion = ++accessSyncVersion;
  const isCurrent = () => accessDialogVersion === version && accessSyncVersion === syncVersion && projectPendingInfo.value?.id === project.id;
  isSyncingProjectAccess.value = true;
  projectAccessSyncStartedAt.value = Date.now();
  if (showLoading) {
    isLoadingProjectAccess.value = true;
  }

  try {
    const accessUsers = await requestJson<ProjectAccessUserPublic[]>(
      `/projects/${project.id}/access`,
    );
    if (!isCurrent()) return;
    applyProjectAccessSnapshot(project.id, accessUsers);
    accessMessage.value = "";
    accessManagementDenied.value = false;
    if (canManageProjectAccess.value) {
      isLoadingBlockedUsers.value = showLoading;
      try {
        const users = await requestJson<ProjectBlockedUserPublic[]>(`/projects/${project.id}/blocked-users`);
        if (isCurrent() && canManageProjectAccess.value) {
          projectBlockedUsers.value = users;
          blockedMessage.value = "";
        } else if (isCurrent()) projectBlockedUsers.value = [];
      } catch (error) {
        if (isCurrent()) {
          if (error instanceof ProjectRequestError && [401, 403, 404].includes(error.status)) {
            projectBlockedUsers.value = [];
            accessManagementDenied.value = true;
            accessMessage.value = "Project access has changed. Refreshing your permissions...";
          } else blockedMessage.value = error instanceof Error ? error.message : "Blocked people could not be loaded.";
        }
      } finally {
        if (isCurrent()) isLoadingBlockedUsers.value = false;
      }
    } else {
      projectBlockedUsers.value = [];
      blockedMessage.value = "";
    }
  } catch (error) {
    if (!isCurrent()) return;
    if (showLoading) {
      accessMessage.value =
        error instanceof Error ? error.message : "Project access could not be loaded.";
    } else if (showMissingMessage && error instanceof ProjectRequestError && [401, 403, 404].includes(error.status)) {
      closeProjectInfoDialog();
      projects.value = projects.value.filter((currentProject) => currentProject.id !== project.id);
      showLoadMessage(`You no longer have access to "${project.name}".`);
    }
  } finally {
    if (!isCurrent()) return;
    if (showLoading) {
      isLoadingProjectAccess.value = false;
    }
    isSyncingProjectAccess.value = false;
    projectAccessSyncStartedAt.value = null;
  }
};

const openProjectInfoDialog = async (project: ExplorerProject) => {
  if (accessMutationBusy.value) return;
  closeProjectInfoDialog();
  activeMenuProjectId.value = null;
  projectPendingInfo.value = project;
  projectAccessUsers.value = [];
  accessMessage.value = "";

  if (project.id.startsWith("local-")) {
    projectAccessUsers.value = [buildLocalProjectAccess()];
    return;
  }

  await syncOpenProjectAccess({ showLoading: true, showMissingMessage: false });
};

const updateStoredProjectRole = (projectId: string, role: ProjectAccessRole) => {
  projects.value = projects.value.map((project) =>
    project.id === projectId ? { ...project, accessRole: role } : project,
  );

  if (projectPendingInfo.value?.id === projectId) {
    projectPendingInfo.value = { ...projectPendingInfo.value, accessRole: role };
  }
};

const updateStoredProjectAccessCount = (projectId: string, accessCount: number) => {
  projects.value = projects.value.map((project) =>
    project.id === projectId ? { ...project, accessCount } : project,
  );

  if (projectPendingInfo.value?.id === projectId) {
    projectPendingInfo.value = { ...projectPendingInfo.value, accessCount };
  }
};

const updateAccessUserRole = async (user: ProjectAccessUserPublic, role: ProjectAccessRole) => {
  const project = projectPendingInfo.value;
  if (
    !project || !canManageProjectAccess.value ||
    user.role === role ||
    accessMutationBusy.value || isLoadingProjectAccess.value || accessUserPendingBlock.value || accessUserPendingRemove.value
  ) {
    return;
  }

  const version = accessDialogVersion;
  const isCurrent = () => version === accessDialogVersion && projectPendingInfo.value?.id === project.id;
  accessSyncVersion += 1; // Discard any periodic snapshot started before this mutation.
  isSyncingProjectAccess.value = false;
  accessUpdatingUserId.value = user.id;
  accessMessage.value = "";

  try {
    const updatedUser = await requestJson<ProjectAccessUserPublic>(
      `/projects/${project.id}/members/${user.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ role }),
      },
    );
    if (!isCurrent()) return;
    projectAccessUsers.value = projectAccessUsers.value.map((accessUser) =>
      accessUser.id === updatedUser.id ? updatedUser : accessUser,
    );

    if (isCurrentAccessUser(updatedUser)) {
      updateStoredProjectRole(project.id, updatedUser.role);
    }
  } catch (error) {
    if (isCurrent()) {
      handleProjectManagementError(error);
      accessMessage.value = error instanceof Error ? error.message : "Project access could not be updated.";
    }
  } finally {
    if (isCurrent()) {
      accessUpdatingUserId.value = null;
      void syncOpenProjectAccess({ showMissingMessage: false });
    }
  }
};

const changeAccessUserRole = (user: ProjectAccessUserPublic, event: Event) => {
  const select = event.target;
  if (!(select instanceof HTMLSelectElement)) return;
  const role = select.value;
  select.value = user.role;
  if (!projectRoleOptions.some((option) => option.value === role)) return;
  void updateAccessUserRole(user, role as ProjectAccessRole);
};

const requestRemoveAccessUser = (user: ProjectAccessUserPublic) => {
  if (!canManageProjectAccess.value || accessMutationBusy.value || accessUserPendingBlock.value || user.is_owner || isCurrentAccessUser(user)) {
    return;
  }

  accessUserPendingRemove.value = user;
};

const closeRemoveAccessUserDialog = () => {
  if (accessRemovingUserId.value) {
    return;
  }

  accessUserPendingRemove.value = null;
};

const removeAccessUser = async (user: ProjectAccessUserPublic) => {
  const project = projectPendingInfo.value;
  if (!project || !canManageProjectAccess.value || accessMutationBusy.value || user.is_owner || isCurrentAccessUser(user)) {
    return false;
  }

  const version = accessDialogVersion;
  const isCurrent = () => version === accessDialogVersion && projectPendingInfo.value?.id === project.id;
  accessSyncVersion += 1;
  isSyncingProjectAccess.value = false;
  accessRemovingUserId.value = user.id;
  accessMessage.value = "";

  try {
    await requestJson<void>(`/projects/${project.id}/members/${user.id}`, {
      method: "DELETE",
    });
    if (!isCurrent()) return false;
    projectAccessUsers.value = projectAccessUsers.value.filter(
      (accessUser) => accessUser.id !== user.id,
    );
    updateStoredProjectAccessCount(project.id, projectAccessUsers.value.length);
    return true;
  } catch (error) {
    if (isCurrent()) {
      handleProjectManagementError(error);
      accessMessage.value = error instanceof Error ? error.message : "Project access could not be removed.";
    }
    return false;
  } finally {
    if (isCurrent()) accessRemovingUserId.value = null;
  }
};

const confirmRemoveAccessUser = async () => {
  if (!accessUserPendingRemove.value || accessRemovingUserId.value) {
    return;
  }

  const didRemove = await removeAccessUser(accessUserPendingRemove.value);
  if (didRemove) {
    accessUserPendingRemove.value = null;
    void syncOpenProjectAccess({ showMissingMessage: false });
  }
};

const requestBlockAccessUser = (user: ProjectAccessUserPublic) => {
  if (!canManageProjectAccess.value || accessMutationBusy.value || accessUserPendingRemove.value ||
    !canBlockProjectMember(user, currentUserEmail.value)) return;
  accessMessage.value = "";
  accessUserPendingBlock.value = user;
};

const closeBlockAccessUserDialog = () => {
  if (!accessBlockingUserId.value) accessUserPendingBlock.value = null;
};

const confirmBlockAccessUser = async () => {
  const user = accessUserPendingBlock.value;
  const project = projectPendingInfo.value;
  if (!user || !project || !canManageProjectAccess.value || accessMutationBusy.value ||
    !canBlockProjectMember(user, currentUserEmail.value)) return;
  const version = accessDialogVersion;
  const isCurrent = () => version === accessDialogVersion && projectPendingInfo.value?.id === project.id;
  accessSyncVersion += 1;
  isSyncingProjectAccess.value = false;
  accessBlockingUserId.value = user.id;
  accessMessage.value = "";
  try {
    const blockedUser = await requestJson<ProjectBlockedUserPublic>(`/projects/${project.id}/blocked-users/${user.id}`, { method: "POST" });
    if (isCurrent()) {
      projectAccessUsers.value = projectAccessUsers.value.filter((member) => member.id !== user.id);
      projectBlockedUsers.value = [blockedUser, ...projectBlockedUsers.value.filter((member) => member.id !== user.id)];
      updateStoredProjectAccessCount(project.id, projectAccessUsers.value.length);
      accessUserPendingBlock.value = null;
      blockedMessage.value = `${accessUserName(user)} is blocked and can no longer join this project.`;
    }
  } catch (error) {
    if (isCurrent()) {
      handleProjectManagementError(error);
      accessMessage.value = error instanceof Error ? error.message : "This person could not be blocked.";
    }
  } finally {
    if (isCurrent()) {
      accessBlockingUserId.value = null;
      void syncOpenProjectAccess({ showMissingMessage: false });
    }
  }
};

const unblockAccessUser = async (user: ProjectBlockedUserPublic) => {
  const project = projectPendingInfo.value;
  if (!project || !canManageProjectAccess.value || accessMutationBusy.value || accessUserPendingBlock.value || accessUserPendingRemove.value) return;
  const version = accessDialogVersion;
  const isCurrent = () => version === accessDialogVersion && projectPendingInfo.value?.id === project.id;
  accessSyncVersion += 1;
  isSyncingProjectAccess.value = false;
  accessUnblockingUserId.value = user.id;
  blockedMessage.value = "";
  try {
    await requestJson<void>(`/projects/${project.id}/blocked-users/${user.id}`, { method: "DELETE" });
    if (isCurrent()) {
      projectBlockedUsers.value = projectBlockedUsers.value.filter((member) => member.id !== user.id);
      blockedMessage.value = `${accessUserName(user)} is unblocked. This does not restore project access; they can join again using a valid share link.`;
    }
  } catch (error) {
    if (isCurrent()) {
      handleProjectManagementError(error);
      accessMessage.value = error instanceof Error ? error.message : "This person could not be unblocked.";
      blockedMessage.value = accessMessage.value;
    }
  } finally {
    if (isCurrent()) accessUnblockingUserId.value = null;
  }
};

const leaveProject = async (project: ExplorerProject) => {
  if (!canLeaveProject(project) || leavingProjectId.value) {
    return false;
  }

  leavingProjectId.value = project.id;
  clearLoadMessage();

  try {
    await requestJson<void>(`/projects/${project.id}/members/me`, {
      method: "DELETE",
    });
    projects.value = projects.value.filter((currentProject) => currentProject.id !== project.id);
    if (selectedProjectId.value === project.id) {
      selectedProjectId.value = visibleProjects.value[0]?.id || null;
    }
    activeMenuProjectId.value = null;
    if (projectPendingInfo.value?.id === project.id) {
      closeProjectInfoDialog();
    }
    showLoadMessage(`You left "${project.name}".`);
    return true;
  } catch (error) {
    showLoadMessage(error instanceof Error ? error.message : "You could not leave this project.");
    return false;
  } finally {
    leavingProjectId.value = null;
  }
};

const confirmLeaveProject = async () => {
  if (!projectPendingLeave.value || leavingProjectId.value) {
    return;
  }

  const didLeave = await leaveProject(projectPendingLeave.value);
  if (didLeave) {
    projectPendingLeave.value = null;
  }
};

const closeDeleteDialog = () => {
  if (isDeletingProject.value) {
    return;
  }

  projectPendingDelete.value = null;
};

const deleteProject = async (project: ExplorerProject) => {
  activeMenuProjectId.value = null;

  if (!project.id.startsWith("local-")) {
    try {
      await requestJson<ProjectPublic>(`/projects/${project.id}`, {
        method: "DELETE",
      });
    } catch (error) {
      showLoadMessage(error instanceof Error ? error.message : "Project could not be deleted.");
      return false;
    }
  }

  projects.value = projects.value.filter((currentProject) => currentProject.id !== project.id);

  if (selectedProjectId.value === project.id) {
    selectedProjectId.value = visibleProjects.value[0]?.id || null;
  }

  return true;
};

const confirmDeleteProject = async () => {
  if (!projectPendingDelete.value || isDeletingProject.value) {
    return;
  }

  const project = projectPendingDelete.value;
  const startedAt = Date.now();
  isDeletingProject.value = true;

  try {
    const wasDeleted = await deleteProject(project);
    await wait(Math.max(0, DELETE_LOADING_MIN_MS - (Date.now() - startedAt)));
    if (wasDeleted) {
      projectPendingDelete.value = null;
    }
  } finally {
    isDeletingProject.value = false;
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

const openProject = (project: ExplorerProject) => {
  if (project.id.startsWith("local-")) {
    showLoadMessage("This project is only available in this session.");
    return;
  }

  selectedProjectId.value = project.id;
  activeMenuProjectId.value = null;

  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.removeItem(WORKSPACE_TRANSITION_STORAGE_KEY);
  } catch {
    // Optional transition storage must not block opening a project.
  }
  document.documentElement.classList.remove("route-transition-pending");
  window.location.assign(`/studio/${encodeURIComponent(project.id)}`);
};

const toggleProjectActions = (project: ExplorerProject) => {
  activeMenuProjectId.value = activeMenuProjectId.value === project.id ? null : project.id;
};

const handleProjectCardClick = (project: ExplorerProject) => {
  if (activeMenuProjectId.value === project.id) {
    activeMenuProjectId.value = null;
    return;
  }

  openProject(project);
};

const syncSharedState = () => {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    return;
  }

  resetStaleWorkspaceSync();
  resetStaleProjectAccessSync();
  if (!realtimeConnection.value) {
    connectRealtimeEvents();
  }
  void refreshWorkspace();
  void syncOpenProjectAccess({ showMissingMessage: false });
  void syncOpenShareLink();
};

const scheduleWorkspaceRefresh = () => {
  if (workspaceRefreshTimeoutId.value !== null) {
    window.clearTimeout(workspaceRefreshTimeoutId.value);
  }

  workspaceRefreshTimeoutId.value = window.setTimeout(() => {
    workspaceRefreshTimeoutId.value = null;
    void refreshWorkspace();
  }, REALTIME_REFRESH_DELAY_MS);
};

const scheduleProjectAccessRefresh = (projectId?: string) => {
  if (!projectPendingInfo.value || (projectId && projectPendingInfo.value.id !== projectId)) {
    return;
  }

  if (accessRefreshTimeoutId.value !== null) {
    window.clearTimeout(accessRefreshTimeoutId.value);
  }

  accessRefreshTimeoutId.value = window.setTimeout(() => {
    accessRefreshTimeoutId.value = null;
    void syncOpenProjectAccess({ showMissingMessage: false });
  }, REALTIME_REFRESH_DELAY_MS);
};

const handleRealtimeWorkspaceEvent = () => {
  scheduleWorkspaceRefresh();
};

const handleRealtimeProjectEvent = (payload: RealtimeEventPayload) => {
  scheduleWorkspaceRefresh();

  if (payload.project_id) {
    scheduleProjectAccessRefresh(payload.project_id);
  }

  if (
    payload.project_id &&
    editingProjectId.value === payload.project_id &&
    isCreateOpen.value &&
    hasProjectUnsavedChanges.value
  ) {
    editingProjectHasRemoteChanges.value = true;
    showLoadMessage("This project changed in another session. Reopen it before saving.");
  }
};

const connectRealtimeEvents = () => {
  if (typeof window === "undefined") {
    return;
  }

  realtimeConnection.value?.close();
  realtimeConnection.value = connectUserRealtime({
    "workspace.updated": handleRealtimeWorkspaceEvent,
    "project.updated": handleRealtimeProjectEvent,
    "project.deleted": handleRealtimeProjectEvent,
    "project.access.updated": handleRealtimeProjectEvent,
    "project.share.updated": (payload) => {
      handleRealtimeProjectEvent(payload);
      if (payload.project_id === projectPendingShare.value?.id) void syncOpenShareLink();
    },
  });
};

const disconnectRealtimeEvents = () => {
  realtimeConnection.value?.close();
  realtimeConnection.value = null;

  if (workspaceRefreshTimeoutId.value !== null) {
    window.clearTimeout(workspaceRefreshTimeoutId.value);
    workspaceRefreshTimeoutId.value = null;
  }

  if (accessRefreshTimeoutId.value !== null) {
    window.clearTimeout(accessRefreshTimeoutId.value);
    accessRefreshTimeoutId.value = null;
  }
};

onMounted(() => {
  void initializeWorkspace();
  connectRealtimeEvents();
  workspaceSyncIntervalId.value = window.setInterval(
    () => void refreshWorkspace(),
    WORKSPACE_SYNC_INTERVAL_MS,
  );
  projectAccessSyncIntervalId.value = window.setInterval(
    () => {
      void syncOpenProjectAccess({ showMissingMessage: false });
      void syncOpenShareLink();
    },
    PROJECT_ACCESS_SYNC_INTERVAL_MS,
  );
  shareClockIntervalId = window.setInterval(() => {
    if (projectPendingShare.value) shareNow.value = Date.now();
  }, 1000);
  window.addEventListener("focus", syncSharedState);
  document.addEventListener("visibilitychange", syncSharedState);
  document.addEventListener("keydown", handleShareDialogKeydown, true);
});

onUnmounted(() => {
  shareDialogVersion += 1;
  accessDialogVersion += 1;
  accessSyncVersion += 1;
  if (shareClockIntervalId !== null) window.clearInterval(shareClockIntervalId);
  clearLoadMessageTimeout();
  disconnectRealtimeEvents();
  if (workspaceSyncIntervalId.value !== null) {
    window.clearInterval(workspaceSyncIntervalId.value);
  }
  if (projectAccessSyncIntervalId.value !== null) {
    window.clearInterval(projectAccessSyncIntervalId.value);
  }
  window.removeEventListener("focus", syncSharedState);
  document.removeEventListener("visibilitychange", syncSharedState);
  document.removeEventListener("keydown", handleShareDialogKeydown, true);
});
</script>

<template>
  <section class="workspace-explorer" @click="activeMenuProjectId = null">
    <StudioTopbar
      mode="projects"
      center-max-width="min(660px, 42vw)"
      user-interactive
      :user-name="profileUserName"
      :user-username="profileUsername"
      :user-avatar-url="currentUserAvatarUrl"
      :user-email="currentUserEmail"
      :user-pixel-avatar="profilePixelAvatar"
      :user-label="currentUserEmail"
      @user-click="isProfileDialogOpen = true"
    >
      <template #center>
        <StudioTopbarCommandBar
          v-model="searchQuery"
          placeholder="Search projects"
          search-aria-label="Search projects"
          button-label="New"
          @new-click="openCreateDialog"
        />
      </template>
    </StudioTopbar>

    <div class="workspace-layout">
      <main class="studio-main">
        <p v-if="loadMessage" class="load-note">{{ loadMessage }}</p>

        <div
          v-if="isLoading"
          class="workspace-loader"
          role="status"
          aria-live="polite"
        >
          <span class="sr-only">Loading projects</span>
          <span class="workspace-loader__bar" aria-hidden="true"></span>
        </div>

        <div v-else-if="visibleProjects.length === 0" class="empty-state">
          <div class="empty-state__art" aria-hidden="true">
            <LifeOscillatorPreview />
          </div>
          <h2>{{ emptyTitle }}</h2>
          <p>{{ emptyCopy }}</p>
          <div class="empty-state__actions">
            <button type="button" class="primary-action" @click="openCreateDialog">
              Create project
            </button>
            <button type="button" class="secondary-action">
              Import folder
            </button>
          </div>
        </div>

        <div v-else class="project-surface">
          <article
            v-for="project in visibleProjects"
            :key="project.id"
            class="project-card"
            role="button"
            tabindex="0"
            :aria-label="`Open ${project.name}`"
            :class="{
              'is-selected': selectedProjectId === project.id,
              'is-menu-open': activeMenuProjectId === project.id,
            }"
            :style="{ '--project-color': project.color }"
            @click="handleProjectCardClick(project)"
            @keydown.enter.self.prevent="handleProjectCardClick(project)"
            @keydown.space.self.prevent="handleProjectCardClick(project)"
          >
            <div class="project-card__inner">
              <div
                class="project-card__face project-card__front"
                :aria-hidden="activeMenuProjectId === project.id"
                :inert="activeMenuProjectId === project.id"
              >
                <div class="project-card__body">
                  <h2>{{ project.name }}</h2>

                  <div class="card-menu">
                    <button
                      type="button"
                      :class="{ 'is-open': activeMenuProjectId === project.id }"
                      :aria-expanded="activeMenuProjectId === project.id"
                      aria-label="Project actions"
                      @click.stop="toggleProjectActions(project)"
                    >
                      <span class="card-menu__dots" aria-hidden="true">
                        <span></span>
                        <span></span>
                        <span></span>
                      </span>
                    </button>
                  </div>
                </div>

                <div
                  class="project-cover"
                  :class="{ 'has-pixel-art': hasProjectPixelArt(project.projectPixelArt) }"
                >
                  <ProjectPixelArtThumbnail
                    v-if="hasProjectPixelArt(project.projectPixelArt)"
                    class="project-cover__pixel-art"
                    :pixels="project.projectPixelArt?.pixels || []"
                    :size="project.projectPixelArt?.size || PROJECT_PIXEL_SIZE"
                  />
                  <span v-else class="project-cover__shine" aria-hidden="true"></span>
                </div>
              </div>

              <div
                class="project-card__face project-card__back"
                :aria-hidden="activeMenuProjectId !== project.id"
                :inert="activeMenuProjectId !== project.id"
                @click.stop
              >
                <header class="project-card__back-header">
                  <p>Project actions</p>
                  <button
                    type="button"
                    class="project-card__back-close"
                    aria-label="Back to project card"
                    @click="activeMenuProjectId = null"
                  >
                    <span aria-hidden="true"></span>
                  </button>
                </header>

                <div class="project-card__back-content">
                  <button
                    v-if="project.accessRole !== 'viewer'"
                    type="button"
                    class="card-menu__item"
                    @click="openEditDialog(project)"
                  >
                    <svg
                      class="card-menu__icon card-menu__icon--edit"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path d="M4 20h4.5L19 9.5 14.5 5 4 15.5V20Z" />
                      <path d="M13 6.5 17.5 11" />
                    </svg>
                    <span>Edit project</span>
                  </button>
                  <button
                    type="button"
                    class="card-menu__item"
                    @click="openProjectInfoDialog(project)"
                  >
                    <svg
                      class="card-menu__icon card-menu__icon--info"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <circle cx="12" cy="12" r="8" />
                      <path d="M12 11v5" />
                      <path d="M12 8h.01" />
                    </svg>
                    <span>Project info</span>
                  </button>
                  <button
                    v-if="canLeaveProject(project)"
                    type="button"
                    class="card-menu__item is-danger"
                    :disabled="leavingProjectId === project.id"
                    @click="requestLeaveProject(project)"
                  >
                    <svg
                      class="card-menu__icon card-menu__icon--leave"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path d="M10 5H6.5A1.5 1.5 0 0 0 5 6.5v11A1.5 1.5 0 0 0 6.5 19H10" />
                      <path d="M14 8l4 4-4 4" />
                      <path d="M18 12H9" />
                    </svg>
                    <span>{{ leavingProjectId === project.id ? "Leaving..." : "Leave project" }}</span>
                  </button>
                  <button
                    v-if="project.accessRole === 'owner' && !project.id.startsWith('local-')"
                    type="button"
                    class="card-menu__item"
                    @click="openShareDialog(project)"
                  >
                    <svg
                      class="card-menu__icon card-menu__icon--share"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path d="M8.5 12.5 15.5 16.5" />
                      <path d="M15.5 7.5 8.5 11.5" />
                      <circle cx="6" cy="12" r="2.5" />
                      <circle cx="18" cy="6" r="2.5" />
                      <circle cx="18" cy="18" r="2.5" />
                    </svg>
                    <span>Share project</span>
                  </button>
                  <button
                    v-if="canDeleteProject(project)"
                    type="button"
                    class="card-menu__item is-danger"
                    @click="requestDeleteProject(project)"
                  >
                    <svg
                      class="card-menu__icon card-menu__icon--delete"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path d="M4 7h16" />
                      <path d="M9 7V4h6v3" />
                      <path d="M7 7l1 13h8l1-13" />
                      <path d="M10.5 11v5" />
                      <path d="M13.5 11v5" />
                    </svg>
                    <span>Delete project</span>
                  </button>
                </div>
              </div>
            </div>
          </article>
        </div>
      </main>
    </div>

    <ProjectEditorDialog
      v-model:project-name="createName"
      v-model:pixels="projectAvatarPixels"
      :open="isCreateOpen"
      :palette="projectPixelPalette"
      :saving="isCreating"
      :editing="isEditingProject"
      :show-unsaved-confirm="showProjectUnsavedConfirm"
      @close="closeCreateDialog"
      @save="saveProject"
      @discard-unsaved="discardProjectChanges"
      @save-unsaved="saveProjectUnsavedChanges"
    />

    <div
      v-if="projectPendingInfo"
      class="modal-layer access-dialog-layer"
      role="presentation"
    >
      <section
        class="access-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-access-title"
        @click.stop
      >
        <header>
          <div>
            <p>Project info</p>
            <h2 id="project-access-title">Access</h2>
          </div>
          <button
            type="button"
            class="project-modal__close"
            aria-label="Close"
            :disabled="accessMutationBusy"
            @click="closeProjectInfoDialog"
          >
            <span aria-hidden="true"></span>
          </button>
        </header>

        <div class="access-dialog__body">
          <div class="access-dialog__summary">
            <h3>{{ projectPendingInfo.name }}</h3>
            <p>{{ projectAccessCountLabel }}</p>
          </div>

          <p v-if="accessMessage" class="access-dialog__message">{{ accessMessage }}</p>

          <div v-if="isLoadingProjectAccess" class="access-dialog__loading">
            <span class="button-spinner" aria-hidden="true"></span>
            <span>Loading people...</span>
          </div>

          <ul v-else-if="projectAccessUsers.length" class="access-list">
            <li v-for="user in projectAccessUsers" :key="user.id">
              <div class="access-user-identity">
                <div class="access-user-avatar" aria-hidden="true">
                  <ProjectPixelArtThumbnail
                    v-if="user.avatar_pixel_art?.pixels?.length"
                    class="access-user-avatar__pixels"
                    :pixels="user.avatar_pixel_art.pixels"
                    :size="user.avatar_pixel_art.size"
                  />
                  <img
                    v-else-if="user.avatar_url"
                    :src="user.avatar_url"
                    alt=""
                    loading="lazy"
                  />
                  <span v-else>{{ accessUserInitials(user) }}</span>
                </div>

                <div class="access-user-copy">
                  <strong>{{ accessUserName(user) }}</strong>
                  <span>{{ user.email }}</span>
                </div>
              </div>

              <div class="access-user-controls">
                <span v-if="!canManageProjectAccess" class="access-role">
                  {{ accessRoleLabel(user) }}
                </span>
                <select
                  v-else
                  class="access-role-select"
                  :value="user.role"
                  :aria-label="`Project role for ${accessUserName(user)}`"
                  :aria-busy="accessUpdatingUserId === user.id"
                  :disabled="accessMutationBusy || Boolean(accessUserPendingBlock || accessUserPendingRemove)"
                  @change="changeAccessUserRole(user, $event)"
                >
                  <option
                    v-for="option in projectRoleOptions"
                    :key="`member-role-${user.id}-${option.value}`"
                    :value="option.value"
                  >
                    {{ accessRoleLabel(option.value) }}
                  </option>
                </select>
                <div
                  v-if="canManageProjectAccess && !user.is_owner && !isCurrentAccessUser(user)"
                  class="access-user-actions"
                >
                  <button
                    type="button"
                    class="access-remove-button"
                    :aria-label="`Remove ${accessUserName(user)} from project`"
                    :disabled="accessMutationBusy || Boolean(accessUserPendingBlock || accessUserPendingRemove)"
                    @click="requestRemoveAccessUser(user)"
                  >
                    {{ accessRemovingUserId === user.id ? "Removing..." : "Remove" }}
                  </button>
                  <button
                    v-if="canManageProjectAccess && canBlockProjectMember(user, currentUserEmail)"
                    type="button"
                    class="access-remove-button"
                    :aria-label="`Block ${accessUserName(user)} from project`"
                    :disabled="accessMutationBusy || Boolean(accessUserPendingBlock || accessUserPendingRemove)"
                    @click="requestBlockAccessUser(user)"
                  >
                    Block
                  </button>
                </div>
              </div>
            </li>
          </ul>

          <section v-if="canManageProjectAccess" class="blocked-people-section" aria-labelledby="blocked-people-title">
            <h3 id="blocked-people-title">Blocked people <span>{{ projectBlockedUsers.length }}</span></h3>
            <p v-if="projectBlockedUsers.length || isLoadingBlockedUsers">Blocked people cannot join this project, even with a valid share link. Unblocking does not restore project access.</p>
            <p v-if="blockedMessage" class="access-dialog__message" role="status">{{ blockedMessage }}</p>
            <div v-if="isLoadingBlockedUsers" class="access-dialog__loading">
              <span class="button-spinner" aria-hidden="true"></span>
              <span>Loading blocked people...</span>
            </div>
            <ul v-else-if="projectBlockedUsers.length" class="access-list">
              <li v-for="user in projectBlockedUsers" :key="`blocked-${user.id}`">
                <div class="access-user-identity">
                  <div class="access-user-avatar" aria-hidden="true">
                    <ProjectPixelArtThumbnail
                      v-if="user.avatar_pixel_art?.pixels?.length"
                      class="access-user-avatar__pixels"
                      :pixels="user.avatar_pixel_art.pixels"
                      :size="user.avatar_pixel_art.size"
                    />
                    <img v-else-if="user.avatar_url" :src="user.avatar_url" alt="" loading="lazy" />
                    <span v-else>{{ accessUserInitials(user) }}</span>
                  </div>
                  <div class="access-user-copy">
                    <strong>{{ accessUserName(user) }}</strong>
                    <span>{{ user.email }}</span>
                    <span>Blocked {{ formatDateTime(user.blocked_at) }}</span>
                  </div>
                </div>
                <div class="access-user-controls">
                  <button type="button" class="secondary-action access-unblock-button"
                    :aria-label="`Unblock ${accessUserName(user)} from project`"
                    :disabled="accessMutationBusy || Boolean(accessUserPendingBlock || accessUserPendingRemove)"
                    @click="unblockAccessUser(user)">
                    {{ accessUnblockingUserId === user.id ? "Unblocking..." : "Unblock" }}
                  </button>
                </div>
              </li>
            </ul>
            <p v-else>No blocked people.</p>
          </section>
        </div>

        <footer>
          <button type="button" class="primary-action" :disabled="accessMutationBusy || Boolean(accessUserPendingBlock || accessUserPendingRemove)" @click="closeProjectInfoDialog">
            Done
          </button>
        </footer>
      </section>
    </div>

    <div
      v-if="accessUserPendingRemove"
      class="modal-layer remove-access-confirm-layer"
      role="presentation"
    >
      <section
        class="remove-access-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remove-access-title"
        @click.stop
      >
        <header>
          <div>
            <p>Project access</p>
            <h2 id="remove-access-title">Remove access?</h2>
          </div>
          <button
            type="button"
            class="project-modal__close"
            aria-label="Close"
            :disabled="accessRemovingUserId === accessUserPendingRemove.id"
            @click="closeRemoveAccessUserDialog"
          >
            <span aria-hidden="true"></span>
          </button>
        </header>

        <div class="remove-access-confirm-dialog__body">
          <p>
            <strong>{{ accessUserName(accessUserPendingRemove) }}</strong>
            will lose access to
            <strong>{{ projectPendingInfo?.name || "this project" }}</strong>.
            They can join again using a valid share link. To prevent rejoining, block them instead.
          </p>
          <p v-if="accessMessage" class="access-dialog__message" role="alert">{{ accessMessage }}</p>
        </div>

        <footer>
          <button
            type="button"
            class="secondary-action"
            :disabled="accessRemovingUserId === accessUserPendingRemove.id"
            @click="closeRemoveAccessUserDialog"
          >
            Cancel
          </button>
          <button
            type="button"
            class="danger-action"
            :disabled="accessRemovingUserId === accessUserPendingRemove.id"
            @click="confirmRemoveAccessUser"
          >
            <span
              v-if="accessRemovingUserId === accessUserPendingRemove.id"
              class="button-spinner"
              aria-hidden="true"
            ></span>
            <span>
              {{ accessRemovingUserId === accessUserPendingRemove.id ? "Removing..." : "Remove access" }}
            </span>
          </button>
        </footer>
      </section>
    </div>

    <div v-if="accessUserPendingBlock" class="modal-layer remove-access-confirm-layer" role="presentation">
      <section class="remove-access-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="block-access-title" @click.stop>
        <header>
          <div>
            <p>Project access</p>
            <h2 id="block-access-title">Block this person?</h2>
          </div>
          <button type="button" class="project-modal__close" aria-label="Close" :disabled="Boolean(accessBlockingUserId)" @click="closeBlockAccessUserDialog">
            <span aria-hidden="true"></span>
          </button>
        </header>
        <div class="remove-access-confirm-dialog__body">
          <p><strong>{{ accessUserName(accessUserPendingBlock) }}</strong> will be removed from <strong>{{ projectPendingInfo?.name }}</strong> and cannot rejoin, even with a valid share link, until a project owner unblocks them.</p>
          <p v-if="accessMessage" class="access-dialog__message" role="alert">{{ accessMessage }}</p>
        </div>
        <footer>
          <button type="button" class="secondary-action" :disabled="Boolean(accessBlockingUserId)" @click="closeBlockAccessUserDialog">Cancel</button>
          <button type="button" class="danger-action" :disabled="Boolean(accessBlockingUserId) || !canManageProjectAccess" @click="confirmBlockAccessUser">
            <span v-if="accessBlockingUserId" class="button-spinner" aria-hidden="true"></span>
            <span>{{ accessBlockingUserId ? "Blocking..." : "Block person" }}</span>
          </button>
        </footer>
      </section>
    </div>

    <div
      v-if="projectPendingShare"
      class="modal-layer share-dialog-layer"
      role="presentation"
    >
      <section
        class="share-dialog"
        ref="shareDialogRef"
        tabindex="-1"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-project-title"
        @click.stop
      >
        <header>
          <div>
            <p>Project info</p>
            <h2 id="share-project-title">Share project</h2>
          </div>
          <button
            type="button"
            class="project-modal__close"
            aria-label="Close"
            :disabled="isSharingProject"
            @click="closeShareDialog"
          >
            <span aria-hidden="true"></span>
          </button>
        </header>

        <div class="share-dialog__body" :aria-busy="isSharingProject">
          <div class="share-dialog__summary">
            <div class="share-dialog__project" aria-hidden="true">
              <ProjectPixelArtThumbnail
                v-if="hasProjectPixelArt(projectPendingShare.projectPixelArt)"
                :pixels="projectPendingShare.projectPixelArt?.pixels || []"
                :size="projectPendingShare.projectPixelArt?.size || PROJECT_PIXEL_SIZE"
              />
              <svg v-else class="share-dialog__project-fallback" viewBox="0 0 32 32" focusable="false">
                <path d="M8 4h16v4h4v16h-4v4H8v-4H4V8h4Z" />
                <path d="M12 12h8v8h-8Z" />
              </svg>
            </div>
            <div class="share-dialog__project-copy">
              <strong>{{ projectPendingShare.name }}</strong>
              <span role="status">{{ isSharingProject && shareLinkLoaded ? "Updating link…" : shareExpirationLabel }}</span>
            </div>
          </div>
          <p v-if="shareExpired" class="share-dialog__notice">This link has expired. Renew it to create a new link; the previous link will no longer work.</p>
          <section class="share-dialog__settings" aria-label="Share link settings">
            <div class="share-dialog__setting-row">
              <label for="project-share-permission">Permission</label>
              <select
                id="project-share-permission"
                class="share-setting-select"
                :value="shareRole"
                aria-label="Share link permission"
                aria-describedby="share-permission-hint"
                :disabled="isSharingProject || !shareLinkLoaded || shareDisablePending"
                @change="updateShareRole(($event.target as HTMLSelectElement).value as ShareLinkRole)"
              >
                <option v-for="option in shareRoleOptions" :key="option.value" :value="option.value" :selected="shareRole === option.value">{{ option.label }}</option>
              </select>
            </div>
            <p id="share-permission-hint" class="share-dialog__hint">{{ shareRoleOptions.find((option) => option.value === shareRole)?.description }}</p>
            <div class="share-dialog__setting-row">
              <label for="project-share-expiration">Expiration</label>
              <select id="project-share-expiration" class="share-setting-select" v-model="shareExpirationPreset" aria-label="Share link expiration" :disabled="isSharingProject || !shareLinkLoaded || shareDisablePending" @change="shareExpirationDirty = true">
                <option v-for="option in SHARE_EXPIRATION_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
            </div>
            <label v-if="shareExpirationPreset === 'custom'" class="share-dialog__date">
              <span class="share-dialog__label">Date and time</span>
              <input v-model="shareCustomExpiration" type="datetime-local" :disabled="isSharingProject || !shareLinkLoaded || shareDisablePending" aria-label="Share link expiration date and time" @input="shareExpirationDirty = true" />
            </label>
            <p v-if="shareExpirationPreset === 'custom'" class="share-dialog__hint">Dates use your device’s local timezone.</p>
            <div v-if="projectShareLink && !shareExpired && shareExpirationDirty" class="share-dialog__actions">
              <button type="button" class="secondary-action" :disabled="isSharingProject || shareDisablePending" @click="updateShareExpiration(false)">Save expiration</button>
            </div>
          </section>

          <section class="share-dialog__section share-dialog__link-section" aria-labelledby="share-link-title">
            <h3 id="share-link-title">
              <label for="project-share-url" class="share-dialog__section-title">
                Link
              </label>
            </h3>
            <div class="share-dialog__link-row">
              <input
                id="project-share-url"
                :value="shareProjectUrl"
                type="text"
                readonly
                spellcheck="false"
                inputmode="none"
                aria-label="Project share link"
                :placeholder="!shareLinkLoaded ? 'Share link not available' : 'No active share link'"
              />
              <button
                type="button"
                class="secondary-action share-copy-button"
                :disabled="isSharingProject || !shareLinkLoaded || !projectShareLink || shareExpired || shareDisablePending"
                @click="copyShareLink"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <rect x="8" y="8" width="10" height="10" rx="2" />
                  <path d="M6 16H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                <span>Copy</span>
              </button>
            </div>
            <div v-if="!shareDisablePending" class="share-dialog__actions">
              <button v-if="!shareLinkLoaded && !isSharingProject" type="button" class="secondary-action" @click="openShareDialog(projectPendingShare)">Retry loading</button>
              <button v-else-if="shareLinkLoaded && !projectShareLink" type="button" class="primary-action" :disabled="isSharingProject" @click="updateShareExpiration(false)">Create link</button>
              <template v-else-if="projectShareLink">
                <button type="button" class="secondary-action" :disabled="isSharingProject" @click="updateShareExpiration(true)">Renew link</button>
                <button type="button" class="secondary-action" :disabled="isSharingProject" @click="shareDisablePending = true">Disable link</button>
              </template>
            </div>
            <div v-else class="share-disable-confirmation">
              <h4>Disable this link?</h4>
              <p>People with this link will no longer be able to join <strong>{{ projectPendingShare.name }}</strong>. Existing members keep their access.</p>
              <div class="share-dialog__actions">
                <button type="button" class="secondary-action" :disabled="isSharingProject" @click="shareDisablePending = false">Cancel</button>
                <button type="button" class="secondary-action" :disabled="isSharingProject" @click="disableShareLink">Disable link</button>
              </div>
            </div>
            <p class="share-dialog__hint">Existing members keep their access when a link expires or is disabled.</p>
            <p v-if="projectShareLink && !shareDisablePending" class="share-dialog__hint">Renewing replaces the link. Dated links renew for 7 days unless you choose another expiration.</p>
          </section>
          <p v-if="shareMessage" class="share-dialog__message" role="status">{{ shareMessage }}</p>
        </div>
        <footer>
          <button
            type="button"
            class="primary-action"
            :disabled="isSharingProject"
            @click="closeShareDialog"
          >
            Done
          </button>
        </footer>
      </section>
    </div>

    <div
      v-if="projectPendingLeave"
      class="modal-layer leave-confirm-layer"
      role="presentation"
    >
      <section
        class="leave-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="leave-project-title"
        @click.stop
      >
        <header>
          <div>
            <p>Project access</p>
            <h2 id="leave-project-title">Leave this project?</h2>
          </div>
          <button
            type="button"
            class="project-modal__close"
            aria-label="Close"
            :disabled="leavingProjectId === projectPendingLeave.id"
            @click="closeLeaveDialog"
          >
            <span aria-hidden="true"></span>
          </button>
        </header>

        <div class="leave-confirm-dialog__body">
          <p>
            You will lose access to <strong>{{ projectPendingLeave.name }}</strong>.
            Someone with access will need to share it with you again.
          </p>
        </div>

        <footer>
          <button
            type="button"
            class="secondary-action"
            :disabled="leavingProjectId === projectPendingLeave.id"
            @click="closeLeaveDialog"
          >
            Cancel
          </button>
          <button
            type="button"
            class="danger-action"
            :disabled="leavingProjectId === projectPendingLeave.id"
            @click="confirmLeaveProject"
          >
            <span
              v-if="leavingProjectId === projectPendingLeave.id"
              class="button-spinner"
              aria-hidden="true"
            ></span>
            <span>{{ leavingProjectId === projectPendingLeave.id ? "Leaving..." : "Leave project" }}</span>
          </button>
        </footer>
      </section>
    </div>

    <div
      v-if="projectPendingDelete"
      class="modal-layer delete-confirm-layer"
      role="presentation"
    >
      <section
        class="delete-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-project-title"
        @click.stop
      >
        <header>
          <div>
            <p>Project deletion</p>
            <h2 id="delete-project-title">Delete this project?</h2>
          </div>
          <button
            type="button"
            class="project-modal__close"
            aria-label="Close"
            :disabled="isDeletingProject"
            @click="closeDeleteDialog"
          >
            <span aria-hidden="true"></span>
          </button>
        </header>

        <div class="delete-confirm-dialog__body">
          <p>
            This will permanently delete <strong>{{ projectPendingDelete.name }}</strong>.
            This action cannot be undone.
          </p>
        </div>

        <footer>
          <button
            type="button"
            class="secondary-action"
            :disabled="isDeletingProject"
            @click="closeDeleteDialog"
          >
            Cancel
          </button>
          <button
            type="button"
            class="danger-action"
            :disabled="isDeletingProject"
            @click="confirmDeleteProject"
          >
            <span v-if="isDeletingProject" class="button-spinner" aria-hidden="true"></span>
            <span>{{ isDeletingProject ? "Deleting..." : "Delete project" }}</span>
          </button>
        </footer>
      </section>
    </div>

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
  .workspace-explorer {
    --surface: rgba(12, 13, 13, 0.88);
    --surface-soft: rgba(255, 252, 244, 0.055);
    --surface-hover: rgba(255, 252, 244, 0.09);
    --line: rgba(255, 252, 244, 0.14);
    --line-strong: rgba(255, 252, 244, 0.22);
    --text: #f7f1e7;
    --muted: rgba(247, 241, 231, 0.62);
    --quiet: rgba(247, 241, 231, 0.42);
    --mint: #f7f1e7;
    --amber: #e8ca7a;
    --coral: #e18464;
    display: flex;
    position: relative;
    z-index: 5;
    flex-direction: column;
    height: 100vh;
    height: 100dvh;
    min-height: 0;
    color: var(--text);
  }

  button,
  input,
  textarea {
    font: inherit;
  }

  button {
    color: inherit;
  }

  .card-menu > button,
  .project-modal__close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 0;
    background: transparent;
    cursor: pointer;
  }

  .primary-action,
  .secondary-action,
  .danger-action {
    min-height: 40px;
    padding: 0 16px;
    border-radius: 8px;
    cursor: pointer;
    transition:
      transform 180ms ease,
      border-color 180ms ease,
      background 180ms ease,
      box-shadow 180ms ease;
  }

  .primary-action {
    color: #07100b;
    background: var(--mint);
    border: 1px solid rgba(255, 255, 255, 0.16);
    box-shadow: 0 12px 34px rgba(94, 168, 113, 0.17);
  }

  .primary-action:hover {
    transform: translateY(-1px);
    box-shadow: 0 16px 40px rgba(94, 168, 113, 0.24);
  }

  .primary-action:disabled {
    cursor: not-allowed;
    filter: grayscale(0.4);
    opacity: 0.62;
    transform: none;
  }

  .secondary-action {
    background: rgba(255, 252, 244, 0.045);
    border: 1px solid var(--line-strong);
  }

  .secondary-action:hover {
    background: var(--surface-hover);
    border-color: rgba(255, 252, 244, 0.32);
  }

  .danger-action {
    display: inline-flex;
    gap: 8px;
    align-items: center;
    justify-content: center;
    color: #180806;
    background: #ffb09f;
    border: 1px solid rgba(255, 176, 159, 0.2);
    box-shadow: 0 12px 34px rgba(255, 126, 103, 0.14);
  }

  .danger-action:hover:not(:disabled) {
    background: #ffd2c8;
    box-shadow: 0 16px 40px rgba(255, 126, 103, 0.2);
    transform: translateY(-1px);
  }

  .danger-action:disabled,
  .secondary-action:disabled,
  .project-modal__close:disabled {
    cursor: not-allowed;
    opacity: 0.58;
    transform: none;
  }

  .button-spinner {
    width: 15px;
    height: 15px;
    border: 2px solid rgba(24, 8, 6, 0.28);
    border-top-color: rgba(24, 8, 6, 0.9);
    border-radius: 999px;
    animation: button-spin 700ms linear infinite;
  }

  @keyframes button-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .workspace-layout {
    position: relative;
    z-index: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .studio-main {
    min-width: 0;
    min-height: 0;
    padding: 24px;
    overflow: auto;
  }

  .load-note {
    max-width: 760px;
    padding: 11px 13px;
    margin: 0 0 16px;
    color: rgba(255, 252, 244, 0.74);
    background: rgba(232, 202, 122, 0.08);
    border: 1px solid rgba(232, 202, 122, 0.18);
    border-radius: 8px;
  }

  .project-surface {
    gap: 18px;
  }

  .project-surface {
    display: flex;
    flex-wrap: wrap;
    align-content: flex-start;
    justify-content: center;
    width: min(100%, calc((196px * 5) + (16px * 4)));
    margin: 0 auto;
    gap: 16px;
  }

  .workspace-loader {
    display: grid;
    place-items: center;
    min-height: min(460px, calc(100dvh - 210px));
    padding: 36px 18px;
  }

  .workspace-loader__bar {
    position: relative;
    display: block;
    width: min(280px, 42vw);
    height: 2px;
    overflow: hidden;
    background: rgba(255, 252, 244, 0.12);
    border-radius: 999px;
  }

  .workspace-loader__bar::after {
    position: absolute;
    inset: 0 auto 0 0;
    width: 42%;
    content: "";
    background: linear-gradient(
      90deg,
      transparent,
      rgba(247, 241, 231, 0.86),
      transparent
    );
    border-radius: inherit;
    transform: translateX(-100%);
    animation: workspace-loader-bar 1200ms ease-in-out infinite;
  }

  @keyframes workspace-loader-bar {
    to {
      transform: translateX(240%);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .workspace-loader__bar::after {
      width: 100%;
      background: rgba(247, 241, 231, 0.42);
      animation: none;
      transform: none;
    }
  }

  .empty-state {
    display: grid;
    place-items: center;
    min-height: min(620px, calc(100dvh - 210px));
    padding: 36px 18px;
    text-align: center;
  }

  .empty-state__art {
    position: relative;
    display: grid;
    place-items: center;
    width: min(260px, 70vw);
    height: 150px;
    margin-bottom: 12px;
    overflow: hidden;
    border: 0;
    border-radius: 0;
    background: transparent;
  }

  .empty-state h2 {
    margin: 0;
    font-size: clamp(1.35rem, 2vw, 2rem);
  }

  .empty-state p {
    max-width: 560px;
    margin: 12px auto 0;
    color: var(--muted);
    line-height: 1.55;
  }

  .empty-state__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    justify-content: center;
    margin-top: 24px;
  }

  .project-card {
    position: relative;
    flex: 0 0 196px;
    min-width: 0;
    perspective: 1100px;
    cursor: pointer;
  }

  .project-card__inner {
    position: relative;
    display: grid;
    transform-style: preserve-3d;
    transition: transform 720ms cubic-bezier(0.2, 0.82, 0.22, 1);
    will-change: transform;
  }

  .project-card:hover .project-card__inner {
    transform: translateY(-2px);
  }

  .project-card.is-menu-open .project-card__inner {
    transform: rotateY(-180deg);
  }

  .project-card.is-menu-open:hover .project-card__inner {
    transform: translateY(-2px) rotateY(-180deg);
  }

  .project-card__face {
    grid-area: 1 / 1;
    width: 100%;
    min-width: 0;
    overflow: hidden;
    background:
      linear-gradient(180deg, rgba(255, 252, 244, 0.05), rgba(255, 252, 244, 0.025)),
      rgba(7, 7, 7, 0.72);
    border: 1px solid rgba(255, 252, 244, 0.2);
    border-radius: 7px;
    box-shadow: 0 12px 34px rgba(0, 0, 0, 0.24);
    backface-visibility: hidden;
    transform-style: preserve-3d;
    -webkit-backface-visibility: hidden;
    transition:
      border-color 180ms ease,
      background 180ms ease,
      box-shadow 180ms ease;
  }

  .project-card:hover .project-card__face,
  .project-card.is-selected .project-card__face {
    background:
      linear-gradient(180deg, rgba(255, 252, 244, 0.075), rgba(255, 252, 244, 0.035)),
      rgba(7, 7, 7, 0.78);
    border-color: color-mix(in srgb, var(--project-color) 42%, rgba(255, 252, 244, 0.34));
  }

  .project-card.is-selected .project-card__face {
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--project-color) 42%, transparent),
      0 14px 34px rgba(0, 0, 0, 0.3);
  }

  .project-card__front {
    position: relative;
    display: flex;
    flex-direction: column;
  }

  .project-card__back {
    position: absolute;
    inset: 0;
    display: grid;
    grid-template-rows: auto 1fr;
    gap: 12px;
    height: 100%;
    padding: 12px;
    background:
      radial-gradient(circle at 82% 18%, color-mix(in srgb, var(--project-color) 22%, transparent), transparent 42%),
      linear-gradient(180deg, rgba(255, 252, 244, 0.08), rgba(255, 252, 244, 0.035)),
      rgba(8, 8, 8, 0.86);
    transform: rotateY(180deg);
  }

  .project-cover {
    position: relative;
    display: grid;
    place-items: center;
    aspect-ratio: 1 / 1;
    overflow: hidden;
    background:
      linear-gradient(135deg, rgba(255, 255, 255, 0.13), transparent 42%),
      radial-gradient(circle at 78% 28%, color-mix(in srgb, var(--project-color) 58%, transparent), transparent 35%),
      color-mix(in srgb, var(--project-color) 28%, #101211);
  }

  .project-cover.has-pixel-art {
    background: transparent;
  }

  .project-cover__shine {
    position: absolute;
    inset: 12px;
    border: 1px solid rgba(255, 252, 244, 0.13);
    border-radius: 7px;
    background:
      linear-gradient(135deg, rgba(255, 252, 244, 0.09) 25%, transparent 25%) 0 0 / 18px 18px;
  }

  .project-cover__pixel-art {
    display: block;
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
  }

  .project-card__body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
    padding: 12px 13px;
    background:
      radial-gradient(circle at 92% 14%, rgba(255, 252, 244, 0.07), transparent 34%),
      rgba(8, 8, 8, 0.2);
  }

  .project-card h2 {
    margin: 0;
    overflow: hidden;
    font-size: 0.95rem;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .card-menu {
    position: relative;
    z-index: 3;
  }

  .card-menu > button {
    width: 24px;
    height: 24px;
    color: rgba(255, 252, 244, 0.78);
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    box-shadow: none;
    backdrop-filter: none;
    transition:
      color 160ms ease,
      border-color 160ms ease,
      background 160ms ease,
      box-shadow 160ms ease,
      transform 160ms ease;
  }

  .card-menu > button:hover,
  .card-menu > button:focus-visible,
  .card-menu > button.is-open {
    color: #fff;
    border-color: rgba(255, 252, 244, 0.16);
    background: rgba(255, 252, 244, 0.08);
    box-shadow:
      inset 0 1px 0 rgba(255, 252, 244, 0.1),
      0 8px 18px rgba(0, 0, 0, 0.14);
    backdrop-filter: blur(10px);
  }

  .card-menu > button:hover {
    transform: translateY(-1px);
  }

  .card-menu > button:focus-visible {
    outline: 2px solid rgba(255, 252, 244, 0.28);
    outline-offset: 2px;
  }

  .card-menu__dots {
    display: inline-flex;
    gap: 2px;
    align-items: center;
    justify-content: center;
  }

  .card-menu__dots span {
    width: 2.5px;
    height: 2.5px;
    background: currentColor;
    border-radius: 999px;
  }

  .project-card__back-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .project-card__back-header p {
    margin: 0;
    color: rgba(255, 252, 244, 0.56);
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    line-height: 1;
    text-transform: uppercase;
  }

  .project-card__back-close {
    position: relative;
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    color: rgba(255, 252, 244, 0.64);
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    cursor: pointer;
    transition:
      color 160ms ease,
      background 160ms ease,
      border-color 160ms ease;
  }

  .project-card__back-close:hover,
  .project-card__back-close:focus-visible {
    color: #fff;
    border-color: rgba(255, 252, 244, 0.16);
    background: rgba(255, 252, 244, 0.08);
  }

  .project-card__back-close:focus-visible {
    outline: 2px solid rgba(255, 252, 244, 0.24);
    outline-offset: 2px;
  }

  .project-card__back-close span,
  .project-card__back-close span::after {
    display: block;
    width: 12px;
    height: 1.5px;
    content: "";
    background: currentColor;
    border-radius: 999px;
  }

  .project-card__back-close span {
    transform: rotate(45deg);
  }

  .project-card__back-close span::after {
    transform: rotate(90deg);
  }

  .project-card__back-content {
    display: grid;
    gap: 8px;
    align-content: start;
    min-height: 0;
    padding: 6px 4px;
  }

  .card-menu__item {
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: center;
    width: 100%;
    min-height: 34px;
    padding: 7px 10px;
    color: var(--text);
    font: inherit;
    font-size: 0.8rem;
    font-weight: 700;
    text-align: center;
    background: rgba(255, 252, 244, 0.055);
    border: 1px solid rgba(255, 252, 244, 0.12);
    border-radius: 7px;
    cursor: pointer;
    box-shadow: inset 0 1px 0 rgba(255, 252, 244, 0.08);
    transition:
      border-color 160ms ease,
      box-shadow 160ms ease,
      color 160ms ease,
      background 160ms ease,
      transform 160ms ease;
  }

  .card-menu__item:hover {
    border-color: rgba(255, 252, 244, 0.22);
    background: rgba(255, 252, 244, 0.09);
    box-shadow:
      inset 0 1px 0 rgba(255, 252, 244, 0.1),
      0 10px 22px rgba(0, 0, 0, 0.2);
    transform: translateY(-1px);
  }

  .card-menu__item:disabled {
    cursor: wait;
    opacity: 0.62;
    transform: none;
  }

  .card-menu__item.is-danger {
    color: #ffb09f;
  }

  .card-menu__item.is-danger:hover {
    color: #ffd2c8;
    border-color: rgba(255, 176, 159, 0.26);
    background: rgba(255, 126, 103, 0.13);
  }

  .card-menu__icon {
    position: relative;
    display: inline-block;
    flex: 0 0 auto;
    width: 15px;
    height: 15px;
    color: currentColor;
  }

  .card-menu__icon--delete,
  .card-menu__icon--edit,
  .card-menu__icon--info,
  .card-menu__icon--leave,
  .card-menu__icon--share {
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 2;
  }

  .modal-layer {
    position: fixed;
    inset: 0;
    z-index: 70;
    display: grid;
    place-items: center;
    padding: 20px;
    background: rgba(2, 2, 2, 0.64);
    backdrop-filter: blur(10px);
  }

  .leave-confirm-layer,
  .delete-confirm-layer,
  .remove-access-confirm-layer {
    z-index: 80;
  }

  .remove-access-confirm-layer {
    z-index: 90;
  }

  .access-dialog-layer,
  .share-dialog-layer {
    z-index: 80;
  }

  .access-dialog,
  .share-dialog,
  .leave-confirm-dialog,
  .remove-access-confirm-dialog,
  .delete-confirm-dialog {
    width: min(420px, 100%);
    overflow: hidden;
    color: var(--text);
    border: 1px solid rgba(255, 252, 244, 0.24);
    border-radius: 8px;
    background:
      radial-gradient(circle at 92% 14%, rgba(255, 126, 103, 0.12), transparent 38%),
      #101111;
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.5);
  }

  .access-dialog,
  .share-dialog {
    display: flex;
    flex-direction: column;
    max-height: calc(100dvh - 48px);
  }

  .access-dialog > header,
  .access-dialog > footer,
  .share-dialog > header,
  .share-dialog > footer {
    flex-shrink: 0;
  }

  .share-dialog .project-modal__close {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
  }

  .share-dialog .primary-action,
  .share-dialog .secondary-action {
    min-width: 0;
    min-height: 44px;
    font-weight: 550;
    box-shadow: none;
    transform: none;
    touch-action: manipulation;
    transition: background-color 130ms ease, opacity 100ms ease;
  }

  .share-dialog .secondary-action {
    padding: 0 8px;
    color: var(--muted);
    font-size: 0.8125rem;
    line-height: 1.3;
    background: transparent;
    border: 0;
    border-radius: 6px;
  }

  .share-dialog button:active:not(:disabled) {
    opacity: 0.7;
  }

  .share-dialog button:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 2px;
    box-shadow: none;
  }

  .access-dialog__body,
  .share-dialog__body {
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .access-dialog,
  .share-dialog {
    width: min(540px, 100%);
    background: rgba(16, 17, 17, 0.98);
    border-color: rgba(255, 252, 244, 0.18);
  }

  .access-dialog .project-modal__close {
    flex: 0 0 auto;
    width: 44px;
    height: 44px;
  }

  .access-dialog header,
  .share-dialog header,
  .leave-confirm-dialog header,
  .remove-access-confirm-dialog header,
  .delete-confirm-dialog header {
    display: flex;
    gap: 16px;
    align-items: flex-start;
    justify-content: space-between;
    padding: 20px 20px 18px;
    border-bottom: 1px solid var(--line);
  }

  .access-dialog > header,
  .share-dialog > header {
    align-items: center;
    padding: 12px 18px;
  }

  .access-dialog header p,
  .share-dialog header p,
  .leave-confirm-dialog header p,
  .remove-access-confirm-dialog header p,
  .delete-confirm-dialog header p {
    margin: 0 0 8px;
    color: rgba(255, 176, 159, 0.76);
    font-size: 0.7rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    line-height: 1;
    text-transform: uppercase;
  }

  .access-dialog h2,
  .share-dialog h2,
  .leave-confirm-dialog h2,
  .remove-access-confirm-dialog h2,
  .delete-confirm-dialog h2 {
    margin: 0;
    font-size: 1.2rem;
    line-height: 1.18;
    letter-spacing: 0;
  }

  .access-dialog__body,
  .share-dialog__body,
  .leave-confirm-dialog__body,
  .remove-access-confirm-dialog__body,
  .delete-confirm-dialog__body {
    padding: 18px 20px 6px;
  }

  .access-dialog__body {
    display: grid;
    flex: 1 1 auto;
    align-content: start;
    gap: 12px;
    padding: 14px 18px;
  }

  .access-dialog__summary {
    display: grid;
    gap: 4px;
  }

  .access-dialog__body h3 {
    max-width: 100%;
    margin: 0 0 6px;
    overflow: hidden;
    font-size: 1rem;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .access-dialog__summary h3,
  .blocked-people-section h3 {
    margin-bottom: 0;
  }

  .access-dialog__body p {
    margin: 0;
    color: rgba(247, 241, 231, 0.64);
    font-size: 0.8125rem;
    line-height: 1.45;
  }

  .access-dialog__body .access-dialog__message,
  .access-dialog__message {
    color: #ffb09f;
  }

  .access-dialog__loading {
    display: inline-flex;
    gap: 10px;
    align-items: center;
    color: rgba(247, 241, 231, 0.68);
    font-size: 0.9rem;
    font-weight: 700;
  }

  .access-list {
    display: grid;
    gap: 0;
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .access-list li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 6px 10px;
    align-items: center;
    min-height: 0;
    padding: 8px 0;
    color: #fff;
  }

  .access-list li + li {
    border-top: 1px solid rgba(255, 252, 244, 0.08);
  }

  .access-user-identity {
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr);
    gap: 10px;
    align-items: center;
    min-width: 0;
  }

  .access-user-avatar {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    overflow: hidden;
    color: #fff;
    font-size: 0.72rem;
    font-weight: 900;
    background: #282a2a;
    border: 1px solid #505252;
    border-radius: 999px;
  }

  .access-user-avatar img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .access-user-avatar__pixels {
    display: block;
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
  }

  .access-user-copy {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .access-user-copy strong,
  .access-user-copy span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .access-user-copy strong {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: #fff;
    font-size: 0.9rem;
    line-height: 1.4;
  }

  .access-user-copy span {
    color: rgba(247, 241, 231, 0.64);
    font-size: 0.78rem;
    font-weight: 400;
    line-height: 1.45;
  }

  .access-role {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    padding: 0 8px;
    color: rgba(247, 241, 231, 0.76);
    font-size: 0.8125rem;
    font-weight: 550;
  }

  .access-user-controls {
    display: flex;
    gap: 4px;
    align-items: center;
    justify-content: flex-start;
    min-width: 0;
  }

  .access-user-actions {
    display: flex;
    gap: 2px;
    min-width: 0;
  }

  .access-user-controls .access-role {
    justify-self: start;
  }

  .access-role-select {
    flex: 0 0 auto;
    max-width: 100%;
    min-width: 92px;
    min-height: 44px;
    padding: 0 6px;
    color: #fff;
    font: inherit;
    font-size: 0.8125rem;
    font-weight: 550;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    cursor: pointer;
    color-scheme: dark;
  }

  .access-role-select:focus-visible {
    outline: 2px solid #fff;
    outline-offset: -2px;
  }

  .access-role-select option {
    color: #fff;
    background: #161717;
  }

  .access-role-select:disabled {
    cursor: wait;
    opacity: 0.52;
  }

  .access-remove-button {
    min-height: 30px;
    padding: 0 8px;
    color: #ffb09f;
    font: inherit;
    font-size: 0.78rem;
    font-weight: 760;
    background: transparent;
    border: 0;
    border-radius: 7px;
    cursor: pointer;
  }

  .access-remove-button:focus-visible {
    outline: 2px solid rgba(255, 176, 159, 0.34);
    outline-offset: 2px;
  }

  .access-remove-button:disabled {
    cursor: wait;
    opacity: 0.6;
  }

  .access-unblock-button {
    min-height: 44px;
    padding: 8px 14px;
  }

  .access-list .access-remove-button,
  .access-list .access-unblock-button {
    transform: none;
    min-width: 44px;
    min-height: 44px;
    padding: 0 8px;
    color: rgba(247, 241, 231, 0.76);
    background: transparent;
    border: 0;
    border-radius: 6px;
    box-shadow: none;
    font-size: 0.8rem;
    font-weight: 550;
    line-height: 1.3;
    transition: background-color 130ms ease, opacity 100ms ease;
    touch-action: manipulation;
  }

  @media (hover: hover) and (pointer: fine) {
    .access-role-select:hover:not(:disabled),
    .access-list .access-remove-button:hover:not(:disabled),
    .access-list .access-unblock-button:hover:not(:disabled),
    .share-setting-select:hover:not(:disabled),
    .share-dialog .secondary-action:hover:not(:disabled) {
      color: #fff;
      background: rgba(255, 252, 244, 0.06);
      box-shadow: none;
      transform: none;
    }
  }

  .access-list .access-remove-button:focus-visible,
  .access-list .access-unblock-button:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 2px;
  }

  .access-list .access-remove-button:active:not(:disabled),
  .access-list .access-unblock-button:active:not(:disabled) {
    opacity: 0.7;
  }

  .blocked-people-section {
    display: grid;
    gap: 8px;
    border-top: 1px solid var(--line);
    padding-top: 14px;
  }

  .blocked-people-section h3 {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .blocked-people-section h3 span {
    color: rgba(247, 241, 231, 0.58);
    font-size: 0.85rem;
  }

  @media (max-width: 560px) {
    .access-list li {
      gap: 0 8px;
    }

    .access-user-controls {
      display: contents;
    }

    .access-user-actions {
      grid-column: 1 / -1;
      justify-content: flex-end;
    }
  }

  .share-dialog__body {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    flex: 1 1 auto;
    align-content: start;
    gap: 16px;
    padding: 14px 18px;
  }

  .share-dialog__summary {
    display: grid;
    grid-template-columns: 32px minmax(0, 1fr);
    gap: 10px;
    align-items: center;
  }

  .share-dialog__project {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    overflow: hidden;
    border-radius: 4px;
  }

  .share-dialog__project-fallback {
    width: 28px;
    height: 28px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linejoin: miter;
  }

  .share-dialog__project-copy {
    display: grid;
    gap: 4px;
    min-width: 0;
  }

  .share-dialog__summary strong {
    overflow-wrap: anywhere;
    font-size: 1rem;
    line-height: 1.35;
  }

  .share-dialog__project-copy > span,
  .share-dialog__hint {
    margin: 0;
    color: var(--muted);
    font-size: 0.8125rem;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }

  .share-dialog__notice,
  .share-dialog__message {
    margin: 0;
    color: rgba(255, 176, 159, 0.9);
    font-size: 0.8125rem;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }

  .share-dialog__settings {
    display: grid;
    gap: 4px;
    min-width: 0;
    padding-top: 10px;
    border-top: 1px solid var(--line);
  }

  .share-dialog__setting-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
  }

  .share-dialog__setting-row > label,
  .share-dialog__section-title,
  .share-dialog__label {
    color: var(--text);
    font-size: 0.875rem;
    font-weight: 550;
    line-height: 1.4;
  }

  .share-setting-select {
    justify-self: end;
    min-width: 0;
    max-width: 100%;
    min-height: 44px;
    padding: 0 6px;
    color: var(--text);
    font: inherit;
    font-size: 0.8125rem;
    font-weight: 550;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    cursor: pointer;
    color-scheme: dark;
  }

  .share-setting-select option {
    color: var(--text);
    background: #161717;
  }

  .share-setting-select:disabled {
    cursor: wait;
    opacity: 0.52;
  }

  .share-setting-select:focus-visible {
    outline: 2px solid var(--text);
    outline-offset: -2px;
  }

  .share-dialog__date {
    display: grid;
    gap: 8px;
    min-width: 0;
    margin-top: 8px;
  }

  .share-dialog__date input {
    color-scheme: dark;
  }

  .share-dialog__link-section {
    display: grid;
    gap: 10px;
    min-width: 0;
    padding-top: 16px;
    border-top: 1px solid var(--line);
  }

  .share-dialog__link-section h3 {
    margin: 0;
    line-height: 1.4;
  }

  .share-dialog__link-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
  }

  .share-dialog__body input {
    width: 100%;
    min-width: 0;
    height: 44px;
    box-sizing: border-box;
    padding: 0 12px;
    color: var(--text);
    font: inherit;
    font-size: 0.875rem;
    background: rgba(255, 252, 244, 0.045);
    border: 1px solid var(--line);
    border-radius: 6px;
  }

  .share-dialog__body input::placeholder {
    color: var(--muted);
  }

  .share-dialog__body input:focus-visible {
    outline: 2px solid var(--text);
    outline-offset: -2px;
    box-shadow: none;
  }

  .share-copy-button {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    justify-content: center;
  }

  .share-copy-button svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.8;
  }

  .share-dialog__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    justify-content: flex-end;
  }

  .share-disable-confirmation {
    display: grid;
    gap: 8px;
    padding-top: 8px;
  }

  .share-disable-confirmation p {
    margin: 0;
    color: var(--muted);
    font-size: 0.8125rem;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }

  .share-disable-confirmation h4 {
    margin: 0;
    font-size: 0.875rem;
    line-height: 1.4;
  }

  .leave-confirm-dialog__body p,
  .remove-access-confirm-dialog__body p,
  .delete-confirm-dialog__body p {
    margin: 0;
    color: rgba(247, 241, 231, 0.68);
    line-height: 1.5;
  }

  .leave-confirm-dialog__body strong,
  .remove-access-confirm-dialog__body strong,
  .delete-confirm-dialog__body strong {
    color: var(--text);
  }

  .leave-confirm-dialog footer,
  .remove-access-confirm-dialog footer,
  .delete-confirm-dialog footer {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    padding: 20px;
  }

  .access-dialog footer,
  .share-dialog footer {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
    padding: 8px 18px;
    border-top: 1px solid var(--line);
    background: #101111;
  }

  .access-dialog footer .primary-action,
  .share-dialog footer .primary-action {
    min-height: 44px;
    padding: 0 16px;
    border-radius: 6px;
    box-shadow: none;
    transform: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .access-list .access-remove-button,
    .access-list .access-unblock-button,
    .share-dialog button {
      transition: none;
    }
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .project-modal__close {
    width: 32px;
    height: 32px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 7px;
  }

  .project-modal__close:hover {
    border-color: var(--line);
    background: rgba(255, 252, 244, 0.08);
  }

  .project-modal__close span {
    position: relative;
    display: block;
    width: 16px;
    height: 16px;
  }

  .project-modal__close span::before,
  .project-modal__close span::after {
    position: absolute;
    top: 7px;
    left: 0;
    width: 16px;
    height: 2px;
    content: "";
    background: var(--muted);
    border-radius: 999px;
  }

  .project-modal__close span::before {
    transform: rotate(45deg);
  }

  .project-modal__close span::after {
    transform: rotate(-45deg);
  }

  @media (max-width: 1120px) {
    .workspace-layout {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  @media (max-width: 820px) {
    .workspace-layout {
      grid-template-columns: 1fr;
    }

    .studio-main {
      padding: 18px 14px 26px;
    }

  }

  @media (max-width: 520px) {
    .studio-main {
      padding: 12px 12px 24px;
    }

    .project-surface {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      justify-content: center;
      width: min(100%, 430px);
      max-width: 100%;
      gap: 10px;
    }

    .project-card {
      width: 100%;
      justify-self: stretch;
    }

    .project-cover__shine {
      inset: 10px;
      background-size: 16px 16px;
    }

    .project-cover__pixel-art {
      width: 100%;
      height: 100%;
    }

    .project-card__body {
      padding: 10px 11px;
    }

    .project-card h2 {
      font-size: 0.86rem;
    }

    .empty-state__actions {
      flex-direction: column;
    }

    .empty-state__actions button {
      width: 100%;
    }

    @media (max-width: 380px) {
      .studio-main {
        padding: 10px 10px 22px;
      }

      .project-surface {
        gap: 8px;
      }

      .project-card h2 {
        font-size: 0.8rem;
      }

      .card-menu > button {
        width: 22px;
        height: 22px;
      }

      .project-card__back {
        gap: 8px;
        padding: 9px;
      }

      .project-card__back-content {
        gap: 6px;
      }

      .card-menu__item {
        gap: 6px;
        min-height: 31px;
        padding: 6px 7px;
        font-size: 0.72rem;
      }

      .card-menu__icon {
        width: 13px;
        height: 13px;
      }
    }

    .modal-layer {
      display: block;
      padding: 0;
    }

    .access-dialog-layer,
    .share-dialog-layer,
    .leave-confirm-layer,
    .remove-access-confirm-layer,
    .delete-confirm-layer {
      display: grid;
      place-items: center;
      padding: 16px;
    }

    .access-dialog,
    .share-dialog,
    .leave-confirm-dialog,
    .remove-access-confirm-dialog,
    .delete-confirm-dialog {
      width: min(420px, 100%);
    }

  }

  @media (max-width: 560px) {
    .access-dialog-layer,
    .share-dialog-layer {
      display: flex;
      align-items: stretch;
      padding: 0;
      background: #101111;
      backdrop-filter: none;
    }

    .access-dialog,
    .share-dialog {
      width: 100%;
      height: 100vh;
      height: 100dvh;
      max-height: none;
      min-height: 0;
      border: 0;
      border-radius: 0;
      background: #101111;
      box-shadow: none;
    }

    .access-dialog > header,
    .share-dialog > header {
      padding: calc(10px + env(safe-area-inset-top, 0px)) max(16px, env(safe-area-inset-right, 0px)) 10px max(16px, env(safe-area-inset-left, 0px));
    }

    .access-dialog header p,
    .share-dialog header p {
      margin-bottom: 4px;
    }

    .access-dialog__body,
    .share-dialog__body {
      flex: 1 1 0%;
      gap: 10px;
      padding: 12px max(16px, env(safe-area-inset-right, 0px)) 12px max(16px, env(safe-area-inset-left, 0px));
    }

    .access-dialog .access-list li {
      padding-block: 6px;
    }

    .access-dialog > footer,
    .share-dialog > footer {
      padding: 8px max(16px, env(safe-area-inset-right, 0px)) calc(8px + env(safe-area-inset-bottom, 0px)) max(16px, env(safe-area-inset-left, 0px));
    }

  }
</style>
