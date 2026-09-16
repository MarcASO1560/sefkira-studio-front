<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, triggerRef, watch } from "vue";
import {
  ChevronsLeftRight,
  ChevronsUpDown,
  Download,
  Layers3,
  Link2,
  Link2Off,
  LockKeyhole,
  MousePointer2,
  Plus,
  Ruler,
  SlidersHorizontal,
  X,
} from "@lucide/vue";
import { Icon, type IconifyIcon } from "@iconify/vue";
import fileDocumentOutlineIcon from "@iconify-icons/mdi/file-document-outline";
import fileImageIcon from "@iconify-icons/mdi/file-image";
import filmstripIcon from "@iconify-icons/mdi/filmstrip";
import musicNoteIcon from "@iconify-icons/mdi/music-note";

import {
  fetchApi,
  getResourceEditorState,
  patchCurrentUser,
  patchProjectResource,
  putResourceEditorState,
  type PixelAvatarData,
  type ProjectPublic,
  type ProjectResourceDetail,
  type ResourceEditorStatePublic,
  type UserPublic,
  type WorkspaceBootstrap,
} from "../../../lib/api";
import {
  connectProjectPresence,
  type ProjectEditorActivity,
  type ProjectPresenceConnection,
  type ProjectPresenceMember,
  type ProjectPresenceSnapshot,
} from "../../../lib/realtime";
import StudioTopbar from "../../navigation/components/StudioTopbar.vue";
import ImageDocumentPresence from "./ImageDocumentPresence.vue";
import ResourceDocumentInfoDialog from "./ResourceDocumentInfoDialog.vue";
import { buildDocumentInfoDetails } from "../lib/documentInfo";
import { getDocumentPresenceMembers } from "../lib/documentPresence";
import {
  clonePixelArtDocument,
  compositeVisibleLayers,
  createPixelArtDocument,
  createPixelLayer,
  normalizePixelColor,
} from "../../pixel-art/lib/document";
import {
  isCompleteImageColor,
  normalizeImageColorDraft,
} from "../../pixel-art/lib/color";
import { createImageCanvasRenderPlan } from "../../pixel-art/lib/canvasRendering";
import {
  clampCanvasMirrorAxis,
  expandCanvasMirrorPoints,
  wrapCanvasPoint,
  wrapCanvasPoints,
} from "../../pixel-art/lib/canvasModes";
import {
  brushPoints,
  clearRect,
  constrainPointToEightDirections,
  ellipsePoints,
  extractBlock,
  flipBlock,
  linePoints,
  moveLayer,
  paintPixels,
  placeBlock,
  rectanglePoints,
  rotateBlock90,
  strokePoints,
  type BrushShape,
  type PixelBlock,
  type PixelBuffer,
  type Point,
} from "../../pixel-art/lib/drawing";
import { createHistory, type SnapshotHistory } from "../../pixel-art/lib/history";
import {
  createImageGridOverlayPlan,
  getImageGridKeylineColor,
  type ImageGridLineStyle,
} from "../../pixel-art/lib/gridOverlay";
import {
  graffitiBrushStamp,
  graffitiCheckerColorAt,
} from "../../pixel-art/lib/graffitiBrush";
import {
  canMutateImageLayerPixels,
  isImagePixelMutationTool,
  reorderImageLayersByDisplayDrop,
  resolveImageActiveLayerAfterHistory,
  type ImageLayerDropPosition,
} from "../../pixel-art/lib/layerEditing";
import {
  getImagePixelIndexFromClientPoint,
  getImagePixelSegmentFromClientSegment,
} from "../../pixel-art/lib/hitTesting";
import { getImagePointerIntent } from "../../pixel-art/lib/pointerIntent";
import {
  applyImageTwoFingerTransformDelta,
  normalizeImageRotationRadians,
  rotateImageClientPoint,
  type ImageViewportTransform,
} from "../../pixel-art/lib/pinchZoom";
import {
  createTouchViewportGesture,
  type TouchViewportGesture,
  type TouchViewportGestureFrame,
} from "../../pixel-art/lib/touchViewportGesture";
import {
  getImagePointerColorChannel,
  getImageToolColorIntent,
  type ImageColorChannel,
} from "../../pixel-art/lib/pointerColorIntent";
import { isSinglePixelSelectionGesture } from "../../pixel-art/lib/selectionInteraction";
import {
  combineSelectionMasks,
  createLassoSelectionMask,
  createMagicWandSelectionMask,
  createPixelSelectionMask,
  createPointSelectionMask,
  createRectangleSelectionMask,
  isPixelSelected,
  type PixelSelectionMask,
} from "../../pixel-art/lib/selectionMask";
import {
  getPixelRotationDelta,
  getPixelRotationPivot,
  rotateImagePixelSelection,
  snapPixelRotationDegrees,
} from "../../pixel-art/lib/selectionRotation";
import {
  calculateImagePreviewSize,
  clipImagePreviewPolygonToBounds,
  IMAGE_PREVIEW_MAX_SIZE,
} from "../../pixel-art/lib/previewSizing";
import {
  parsePixelArtResourceData,
  PixelArtMigrationError,
  serializePixelArtResourceData,
} from "../../pixel-art/lib/migrations";
import {
  addPinnedPaletteColor,
  deletePinnedPaletteColor,
  deriveUsedPaletteColors,
  editPinnedPaletteColor,
  normalizePinnedPaletteColors,
  PIXEL_ART_PALETTE,
  type PinnedPaletteColor,
} from "../../pixel-art/lib/palette";
import { resizePixelArtDocument } from "../../pixel-art/lib/resize";
import {
  applyCollaborativePixelPatch,
  canSendCollaborativeActivity,
  collaboratorColor,
  readCollaborativeCursor,
  readCollaborativeDocument,
  readCollaborativePixelPatch,
  readCollaborativeSelection,
  serializeCollaborativeSelection,
} from "../../pixel-art/lib/collaboration";
import {
  exportPixelArtJsonBlob,
  exportPixelArtPng,
  importPixelArtJson,
  importRasterImage,
  importRasterImageReduced,
  RasterImageTooLargeError,
  sanitizeImageFileName,
  type PngExportScale,
} from "../../pixel-art/lib/importExport";
import { useImageAutosave } from "../../pixel-art/composables/useImageAutosave";
import {
  normalizeImagePreferences,
  useImagePreferences,
  type ImagePreferences,
} from "../../pixel-art/composables/useImagePreferences";
import {
  getImageKeyboardAction,
  isEditableKeyboardTarget,
  type ImageKeyboardAction,
} from "../../pixel-art/composables/useImageKeyboardShortcuts";
import type {
  ImageEditorSnapshot,
  ImageResizeAnchor,
  ImageSelection,
  ImageSelectionKind,
  ImageSelectionMode,
  ImageTool,
  PixelArtDocumentV2,
  PixelColor,
  PixelLayer,
} from "../../pixel-art/types";
import {
  IMAGE_EDITOR_SESSION_VERSION,
  normalizeImageEditorSession,
  type ImageEditorSession,
  type ImageInspectorPanel,
  type ImageZoomMode,
} from "../../pixel-art/lib/editorSession";
import ImageImportExportPanel from "../../pixel-art/components/ImageImportExportPanel.vue";
import ImageCanvasModesMenu from "../../pixel-art/components/ImageCanvasModesMenu.vue";
import ImageLayersPanel from "../../pixel-art/components/ImageLayersPanel.vue";
import ImageOptionsDialog from "../../pixel-art/components/ImageOptionsDialog.vue";
import ImageOptionsToolbar from "../../pixel-art/components/ImageOptionsToolbar.vue";
import ImageSaveStatus from "../../pixel-art/components/ImageSaveStatus.vue";
import ImageToolbar from "../../pixel-art/components/ImageToolbar.vue";
import ImageToolOptions from "../../pixel-art/components/ImageToolOptions.vue";
import ImageTransformPanel from "../../pixel-art/components/ImageTransformPanel.vue";
import ImageZoomControls from "../../pixel-art/components/ImageZoomControls.vue";
import ImageColorSwatches from "../../pixel-art/components/ImageColorSwatches.vue";
import ImagePalettePanel from "../../pixel-art/components/ImagePalettePanel.vue";
import type {
  ImagePaletteEditRequest,
  ImagePalettePinRequest,
  ImagePaletteRemoveRequest,
} from "../../pixel-art/components/ImagePalettePanel.types";
import ImageEditorNotice from "../../pixel-art/components/ImageEditorNotice.vue";
import ImageConflictNotice from "../../pixel-art/components/ImageConflictNotice.vue";
import UserProfileDialog from "./UserProfileDialog.vue";

type ResourceRouteKind = "image" | "animation" | "melody" | "text";

type EditorMeta = {
  routeKind: ResourceRouteKind;
  label: string;
  icon: IconifyIcon;
  color: string;
};

type ImagePixelSnapshot = PixelColor[];
type ImageAnchorArrowDirection = "down" | "left" | "right" | "up";
type ImageMirrorAxis = "horizontal" | "vertical";
type ImageGridGap = 1 | 2 | 3;
type ImageGridSubdivisionThickness = 1 | 2 | 3;
type ImageSubdivisionLine = {
  index: number;
  style: Record<string, string>;
};
type ImageResizeAnchorOption = {
  arrows: ImageAnchorArrowDirection[];
  column: number;
  label: string;
  row: number;
  value: ImageResizeAnchor;
};
type ImagePreviewViewport = {
  height: number;
  left: number;
  top: number;
  visible: boolean;
  width: number;
};
type ImageFloatingPreview = {
  size: number;
  visible: boolean;
};
type ImageConflictOperation =
  | { kind: "document" }
  | { kind: "rename"; name: string };
type ImageGraffitiPreviewGesture = Readonly<{
  inverted: boolean;
  primaryColor: string;
  secondaryColor: string;
}>;
type ImageTouchPointer = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startsOnArtboard: boolean;
};
type ImageTransformGesture = {
  initialStageCenter: Readonly<{ x: number; y: number }>;
  initialView: ImageViewportTransform;
  lastFrame: TouchViewportGestureFrame;
};
type ImageDesktopRotationGesture = {
  buttonMask: number;
  captureTarget: HTMLElement;
  center: Readonly<{ x: number; y: number }>;
  hasPointerAngle: boolean;
  pointerId: number;
  previousPointerAngleRadians: number;
};
type RemoteImageCollaborator = {
  avatarUrl: string;
  clientId: string;
  color: string;
  height: number;
  lastSeenAt: number;
  name: string;
  pixelAvatar: PixelAvatarData | null;
  selection: ImageSelection | null;
  tool: string;
  userId: string;
  visible: boolean;
  width: number;
  x: number;
  y: number;
};
type ImageSelectionClipboard = {
  block: PixelBlock;
  kind: ImageSelectionKind;
  mask: PixelSelectionMask;
};

const props = defineProps<{
  projectId: string;
  resourceId: string;
  resourceKind: string;
  userName?: string;
  userUsername?: string | null;
  userAvatarUrl?: string;
  userEmail?: string;
  userPixelAvatar?: PixelAvatarData | null;
}>();

const editorMetaByType: Record<string, EditorMeta> = {
  pixel_art: {
    routeKind: "image",
    label: "Image",
    icon: fileImageIcon,
    color: "#79b8ff",
  },
  pixel_animation: {
    routeKind: "animation",
    label: "Animation",
    icon: filmstripIcon,
    color: "#ff6fae",
  },
  sound_effect: {
    routeKind: "melody",
    label: "Melody",
    icon: musicNoteIcon,
    color: "#ffd76f",
  },
  text: {
    routeKind: "text",
    label: "Text",
    icon: fileDocumentOutlineIcon,
    color: "#f7f1e7",
  },
};

const fallbackEditorMeta: EditorMeta = {
  routeKind: "image",
  label: "Item",
  icon: fileImageIcon,
  color: "#f7f1e7",
};

const DEFAULT_IMAGE_WIDTH = 32;
const DEFAULT_IMAGE_HEIGHT = 32;
const MIN_IMAGE_DIMENSION = 1;
const MAX_IMAGE_DIMENSION = 256;
const MIN_IMAGE_ZOOM = 0.25;
const MAX_IMAGE_ZOOM = 64;
const IMAGE_ZOOM_WHEEL_STEP = 0.0018;
const IMAGE_TOUCH_COMMIT_THRESHOLD = 8;
const IMAGE_ROTATION_STEP_RADIANS = Math.PI / 12;
const IMAGE_ROTATION_MIN_POINTER_RADIUS = 24;
const IMAGE_AUTOSAVE_MS = 420;
const IMAGE_COLLABORATION_CURSOR_INTERVAL_MS = 32;
const IMAGE_COLLABORATION_PIXEL_INTERVAL_MS = 24;
const IMAGE_COLLABORATION_SELECTION_INTERVAL_MS = 64;
const IMAGE_COLLABORATOR_STALE_MS = 12000;
const IMAGE_PALETTE = PIXEL_ART_PALETTE;
const DEFAULT_PENCIL_COLOR = IMAGE_PALETTE[0] || "#ffffff";
const IMAGE_COLOR_PICKER_SIZE = 292;
const IMAGE_COLOR_PICKER_CENTER = IMAGE_COLOR_PICKER_SIZE / 2;
const IMAGE_COLOR_PICKER_RADIUS = 136;
const IMAGE_COLOR_PICKER_RING_WIDTH = 28;
const IMAGE_COLOR_TRIANGLE_TOP = { x: 146, y: 28 };
const IMAGE_COLOR_TRIANGLE_LEFT = { x: 48, y: 212 };
const IMAGE_COLOR_TRIANGLE_RIGHT = { x: 244, y: 212 };
const DEFAULT_CUSTOM_IMAGE_BACKGROUND = "#101111";
const DEFAULT_CUSTOM_IMAGE_GRID_COLOR = "#f7f1e7";
const DEFAULT_CUSTOM_IMAGE_SUBDIVISION_COLOR = "#ff4d4d";
const MIN_IMAGE_GRID_SUBDIVISION = 1;
const MAX_IMAGE_GRID_SUBDIVISION = 64;
const DEFAULT_IMAGE_RESIZE_ANCHOR: ImageResizeAnchor = "center";
const IMAGE_RESIZE_ANCHORS: ImageResizeAnchorOption[] = [
  { arrows: ["right", "down"], column: 0, label: "Top left", row: 0, value: "top-left" },
  { arrows: ["left", "right", "down"], column: 1, label: "Top", row: 0, value: "top" },
  { arrows: ["left", "down"], column: 2, label: "Top right", row: 0, value: "top-right" },
  { arrows: ["right", "up", "down"], column: 0, label: "Left", row: 1, value: "left" },
  { arrows: ["left", "right", "up", "down"], column: 1, label: "Center", row: 1, value: "center" },
  { arrows: ["left", "up", "down"], column: 2, label: "Right", row: 1, value: "right" },
  { arrows: ["right", "up"], column: 0, label: "Bottom left", row: 2, value: "bottom-left" },
  { arrows: ["left", "right", "up"], column: 1, label: "Bottom", row: 2, value: "bottom" },
  { arrows: ["left", "up"], column: 2, label: "Bottom right", row: 2, value: "bottom-right" },
];
const IMAGE_GRID_GAP_OPTIONS: ImageGridGap[] = [1, 2, 3];
const IMAGE_GRID_LINE_STYLE_OPTIONS: { label: string; value: ImageGridLineStyle }[] = [
  { label: "Solid", value: "solid" },
  { label: "Dash", value: "dashed" },
  { label: "Dots", value: "dots" },
];
const IMAGE_GRID_SUBDIVISION_THICKNESS_OPTIONS: ImageGridSubdivisionThickness[] = [1, 2, 3];

const isLoading = ref(true);
const errorMessage = ref("");
const project = ref<ProjectPublic | null>(null);
const resource = ref<ProjectResourceDetail | null>(null);
const imageGridWidth = ref(DEFAULT_IMAGE_WIDTH);
const imageGridHeight = ref(DEFAULT_IMAGE_HEIGHT);
const imageHorizontalMirrorAxisY = ref(DEFAULT_IMAGE_HEIGHT / 2);
const imageVerticalMirrorAxisX = ref(DEFAULT_IMAGE_WIDTH / 2);
const imageGridWidthDraft = ref(String(DEFAULT_IMAGE_WIDTH));
const imageGridHeightDraft = ref(String(DEFAULT_IMAGE_HEIGHT));
const initialImageDocument = createPixelArtDocument(DEFAULT_IMAGE_WIDTH, DEFAULT_IMAGE_HEIGHT);
const imageLayers = shallowRef<PixelLayer[]>(initialImageDocument.layers);
const activeImageLayerId = ref(initialImageDocument.layers[0]?.id || "");
const imageSelection = ref<ImageSelection | null>(null);
const imageSelectionKind = ref<ImageSelectionKind>("rectangle");
const imageSelectionMode = ref<ImageSelectionMode>("replace");
const isImageSelectionContiguous = ref(true);
const selectedImageColor = ref(DEFAULT_PENCIL_COLOR);
const selectedImageColorDraft = ref(DEFAULT_PENCIL_COLOR.toUpperCase());
const secondaryImageColor = ref("#000000");
const personalImagePalette = ref<PinnedPaletteColor[]>([]);
const imagePaletteUserId = ref("");
const currentPresenceUserId = ref("");
const isPersonalImagePaletteSaving = ref(false);
const activeImageTool = ref<ImageTool>("pencil");
const imageBrushSize = ref(1);
const imageBrushShape = ref<BrushShape>("square");
const isImageShapeFilled = ref(false);
const imageShapePreviewPoints = shallowRef<Point[]>([]);
const imagePointerStart = ref<Point | null>(null);
const imagePointerEnd = ref<Point | null>(null);
const imageClipboard = ref<ImageSelectionClipboard | null>(null);
const imageResizeAnchor = ref<ImageResizeAnchor>(DEFAULT_IMAGE_RESIZE_ANCHOR);
const activeImageInspectorPanel = ref<ImageInspectorPanel | null>(null);
const lastImageInspectorPanel = ref<ImageInspectorPanel>("resize");
const isImageMobileColorControlsOpen = ref(false);
const isImageLayersDialogOpen = ref(false);
const imageMobileColorCloseRef = ref<HTMLButtonElement | null>(null);
const imageMobileColorTriggerRef = ref<HTMLButtonElement | null>(null);
const imageLayersCloseRef = ref<HTMLButtonElement | null>(null);
const imageLayersTriggerRef = ref<HTMLButtonElement | null>(null);
const customImageBackground = ref(DEFAULT_CUSTOM_IMAGE_BACKGROUND);
const isImageGridVisible = ref(true);
const isImageHorizontalMirrorEnabled = ref(false);
const isImageVerticalMirrorEnabled = ref(false);
const isImageHorizontalMirrorLineVisible = ref(true);
const isImageVerticalMirrorLineVisible = ref(true);
const isImageHorizontalMirrorLineLocked = ref(false);
const isImageVerticalMirrorLineLocked = ref(false);
const isImageWrapAroundEnabled = ref(false);
const imageWrapTileDataUrl = ref("");
const customImageGridColor = ref(DEFAULT_CUSTOM_IMAGE_GRID_COLOR);
const customImageSubdivisionColor = ref(DEFAULT_CUSTOM_IMAGE_SUBDIVISION_COLOR);
const imageGridLineStyle = ref<ImageGridLineStyle>("solid");
const imageGridSubdivision = ref(1);
const imageGridSubdivisionDraft = ref("1");
const imageGridSubdivisionThickness = ref<ImageGridSubdivisionThickness>(1);
const imageGridGap = ref<ImageGridGap>(1);
const imageGridLineOpacity = ref(0.18);
const imageGridLineOpacityDraft = ref("0.18");
const imageZoom = ref(1);
const imageZoomMode = ref<ImageZoomMode>("fit");
const imageRotationRadians = ref(0);
const selectedImageHue = ref(0);
const selectedImageSaturation = ref(0);
const selectedImageValue = ref(1);
const imagePanX = ref(0);
const imagePanY = ref(0);
const imageViewportWidth = ref(0);
const imageViewportHeight = ref(0);
const isImageMobileViewport = computed(
  () => imageViewportWidth.value > 0 && imageViewportWidth.value <= 768,
);
const imageStageWidth = ref(0);
const imageStageHeight = ref(0);
const areImageDimensionsLinked = ref(true);
const isPaintingImage = ref(false);
const isPanningImage = ref(false);
const isRotatingImage = ref(false);
const isImagePinching = ref(false);
const draggingImageMirrorAxis = ref<ImageMirrorAxis | null>(null);
const isImageSpacePressed = ref(false);
const isImageShiftPressed = ref(false);
const imageInteractionKind = ref<"paint" | "shape" | "select" | "move" | "rotate" | null>(null);
const imagePixelRotationDegrees = ref(0);
const imagePixelRotationGesture = shallowRef<{
  buffer: PixelBuffer;
  selection: ImageSelection | null;
  layerId: string;
  pivot: Point;
  lastAngle: number | null;
  rawDegrees: number;
  didChange: boolean;
} | null>(null);
const hoveredImagePixelIndex = ref<number | null>(null);
const hoveredImageVirtualPoint = ref<Point | null>(null);
const remoteImageCollaborators = ref<Record<string, RemoteImageCollaborator>>({});
const failedRemoteImageAvatarClientIds = ref(new Set<string>());
const imageGraffitiPreviewGesture = ref<ImageGraffitiPreviewGesture | null>(null);
const imageStageRef = ref<HTMLElement | null>(null);
const imageArtboardRef = ref<HTMLElement | null>(null);
const imageCanvasRef = ref<HTMLCanvasElement | null>(null);
const imagePreviewCanvasRef = ref<HTMLCanvasElement | null>(null);
const imageColorTriangleCanvasRef = ref<HTMLCanvasElement | null>(null);
const imageColorPickerRef = ref<HTMLElement | null>(null);
const imagePreviewViewport = ref<ImagePreviewViewport>({
  height: 100,
  left: 0,
  top: 0,
  visible: false,
  width: 100,
});
const imageFloatingPreview = ref<ImageFloatingPreview>({
  size: IMAGE_PREVIEW_MAX_SIZE,
  visible: false,
});
const imageHistory = shallowRef<SnapshotHistory<ImageEditorSnapshot> | null>(null);
const isImageTransferBusy = ref(false);
const imageTransferNotice = ref("");
const imageTransferNoticeTone = ref<"error" | "info" | "success">("info");
const isImageConflictOpen = ref(false);
const imageConflictRemoteRevision = ref<number | null>(null);
const imageConflictOperation = ref<ImageConflictOperation | null>(null);
const isImageConflictResolving = ref(false);
const isRenamingResource = ref(false);
const isDocumentInfoOpen = ref(false);
const isResourceNameSaving = ref(false);
const isDocumentNameSubmitting = ref(false);
const resourceNameSaveError = ref("");
const resourceNameDraft = ref("");
const resourceNameInput = ref<HTMLInputElement | null>(null);
const resourceRenameButton = ref<HTMLButtonElement | null>(null);
let imageMoveSourceBuffer: PixelBuffer | null = null;
let imageMoveSourceSelection: ImageSelection | null = null;
let imageMoveDidChange = false;
let imageSelectionDidDrag = false;
let imageSelectionGestureBase: ImageSelection | null = null;
let imageSelectionGestureKind: ImageSelectionKind = "rectangle";
let imageSelectionGestureMode: ImageSelectionMode = "replace";
let imageSelectionLassoPoints: Point[] = [];
let imageSelectionGestureTileOffset: Point | null = null;
let imagePanPointerId: number | null = null;
let imagePanPointerClientX = 0;
let imagePanPointerClientY = 0;
let imageDesktopRotationGesture: ImageDesktopRotationGesture | null = null;
let imageViewportPaintPointerId: number | null = null;
let imageMirrorAxisPointerId: number | null = null;
let imageMirrorAxisCaptureTarget: HTMLElement | null = null;
let imageMirrorAxisDragStartValue: number | null = null;
let imageViewportPaintButtonMask = 0;
let imagePointerColorChannel: ImageColorChannel = "primary";
let imageInteractionColor: PixelColor = DEFAULT_PENCIL_COLOR;
let imageInteractionTool: ImageTool | null = null;
let imageInteractionPrimaryColor = DEFAULT_PENCIL_COLOR;
let imageInteractionSecondaryColor = "#000000";
let imageInteractionGraffitiInverted = false;
let isImageViewportPaintAwaitingArtboard = false;
let imageViewportPaintClientX = 0;
let imageViewportPaintClientY = 0;
const imageTouchPointers = new Map<number, ImageTouchPointer>();
let imagePendingTouchPointerId: number | null = null;
let imageTransformGesture: ImageTransformGesture | null = null;
let imageTouchNavigationActive = false;
let imageTouchViewportGesture: TouchViewportGesture | null = null;
let imageGestureView: ImageViewportTransform | null = null;
const imageViewportTransformRevision = ref(0);
let imageSingleTouchStartSnapshot: ImageEditorSnapshot | null = null;
let imageSingleTouchStartHistory: SnapshotHistory<ImageEditorSnapshot> | null = null;
let imageSingleTouchStartTool: ImageTool | null = null;
let imageSingleTouchStartPrimaryColor: string | null = null;
let imageSingleTouchStartSecondaryColor: string | null = null;
let imagePreferencesController: ReturnType<typeof useImagePreferences> | null = null;
let isApplyingImagePreferences = false;
let isImageEditorSessionReady = false;
let imageEditorSessionSaveTimeout: ReturnType<typeof setTimeout> | null = null;
let imageEditorSessionSaveInFlight: Promise<void> | null = null;
let imageEditorSessionSaveQueued = false;
let lastSavedImageEditorSession = "";
let projectPresenceConnection: ProjectPresenceConnection | null = null;
const projectPresenceMembers = shallowRef<ProjectPresenceMember[]>([]);
let imageCollaborationCursorTimeout: ReturnType<typeof setTimeout> | null = null;
let imageCollaborationSelectionTimeout: ReturnType<typeof setTimeout> | null = null;
let imageCollaborationCleanupInterval: ReturnType<typeof setInterval> | null = null;
let pendingImageCollaborationCursor: Record<string, unknown> | null = null;
let pendingImageCollaborationSelection: Readonly<{
  mode: ImageSelectionMode;
  selection: ImageSelection | null;
}> | null = null;
let lastImageCollaborationCursorPosition: Readonly<{ x: number; y: number }> | null = null;
let lastImageCollaborationCursorAt = 0;
let lastImageCollaborationSelectionAt = 0;
const pendingImageCollaborationPixels = new Map<string, Map<number, PixelColor>>();
let imageCollaborationPixelsTimeout: ReturnType<typeof setTimeout> | null = null;
const lastImageCollaborationSequence = new Map<string, number>();
const pendingProjectEditorActivities: ProjectEditorActivity[] = [];
let lastRemoteImageMutationAt = 0;
let imageAutosaveSequence = 0;
let resourceMutationQueue: Promise<void> = Promise.resolve();
let personalImagePaletteMutationQueue: Promise<void> = Promise.resolve();
let pendingPersonalImagePaletteMutations = 0;
let resourceNameCommitPromise: Promise<void> | null = null;
let allowImageUnload = false;
const isProfileDialogOpen = ref(false);
const profileUserName = ref(props.userName || "");
const profileUsername = ref(props.userUsername || "");
const profileAvatarUrl = ref(props.userAvatarUrl || "");
const profileEmail = ref(props.userEmail || "");
const profilePixelAvatar = ref<PixelAvatarData | null>(props.userPixelAvatar || null);

const editorMeta = computed(() =>
  resource.value ? editorMetaByType[resource.value.type] || fallbackEditorMeta : fallbackEditorMeta,
);
const isImageEditor = computed(() => editorMeta.value.routeKind === "image");
const currentImagePresenceMember = computed<ProjectPresenceMember | null>(() => {
  if (!currentPresenceUserId.value || !resource.value) return null;
  return {
    id: currentPresenceUserId.value,
    email: profileEmail.value,
    username: profileUsername.value || profileUserName.value,
    avatar_url: profileAvatarUrl.value || null,
    avatar_pixel_art: profilePixelAvatar.value,
    resource_id: props.resourceId,
  };
});
const hasImageDocumentPresence = computed(
  () =>
    isImageEditor.value &&
    getDocumentPresenceMembers(
      projectPresenceMembers.value,
      currentPresenceUserId.value,
      currentImagePresenceMember.value,
    ).members.length > 0,
);
const projectName = computed(() => project.value?.name || "Project");
const resourceName = computed(() => resource.value?.name || "Loading item");
const resourceColor = computed(() => resource.value?.color || editorMeta.value.color);
const projectPixelArt = computed<PixelAvatarData | null>(() => {
  const pixelArt = project.value?.settings?.project_pixel_art;
  if (!pixelArt || typeof pixelArt !== "object") {
    return null;
  }

  return pixelArt as PixelAvatarData;
});

const editorStyle = computed(() => ({
  "--resource-editor-color": resourceColor.value,
}));

const imagePixelCount = computed(() => imageGridWidth.value * imageGridHeight.value);
const activeImageLayer = computed(
  () =>
    imageLayers.value.find((layer) => layer.id === activeImageLayerId.value) ||
    imageLayers.value[imageLayers.value.length - 1] ||
    null,
);
const imagePixels = computed<PixelColor[]>({
  get: () =>
    activeImageLayer.value?.pixels ||
    Array<PixelColor>(imageGridWidth.value * imageGridHeight.value).fill(null),
  set: (pixels) => {
    const activeLayerId = activeImageLayer.value?.id;
    if (!activeLayerId) return;
    imageLayers.value = imageLayers.value.map((layer) =>
      layer.id === activeLayerId ? { ...layer, pixels } : layer,
    );
  },
});
const usedImagePaletteColors = computed(() => deriveUsedPaletteColors(imageLayers.value));
const canEditImage = computed(
  () =>
    isImageEditor.value &&
    (project.value?.access_role === "owner" || project.value?.access_role === "editor"),
);
const canManagePersonalImagePalette = computed(
  () => Boolean(imagePaletteUserId.value) && !isPersonalImagePaletteSaving.value,
);
const canMutateActiveImageLayerPixels = computed(
  () => canEditImage.value && canMutateImageLayerPixels(activeImageLayer.value),
);
const isActiveImagePixelMutationTool = computed(() =>
  isImagePixelMutationTool(activeImageTool.value),
);
const isImagePixelMutationBlocked = computed(
  () => isActiveImagePixelMutationTool.value && !canMutateActiveImageLayerPixels.value,
);
const canUndoImage = computed(() => Boolean(imageHistory.value?.canUndo) && canEditImage.value);
const canRedoImage = computed(() => Boolean(imageHistory.value?.canRedo) && canEditImage.value);
const getRgbFromHexColor = (color: string) => {
  const hex = color.replace("#", "");

  return {
    blue: Number.parseInt(hex.slice(4, 6), 16),
    green: Number.parseInt(hex.slice(2, 4), 16),
    red: Number.parseInt(hex.slice(0, 2), 16),
  };
};
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const colorComponentToHex = (value: number) =>
  Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, "0");
const normalizeHexColorInput = normalizeImageColorDraft;
const isCompleteHexColor = isCompleteImageColor;
const hsvToHexColor = (hue: number, saturation: number, value: number) => {
  const chroma = value * saturation;
  const huePrime = ((hue % 360) + 360) % 360 / 60;
  const x = chroma * (1 - Math.abs((huePrime % 2) - 1));
  const match = value - chroma;
  const [red, green, blue] =
    huePrime < 1
      ? [chroma, x, 0]
      : huePrime < 2
        ? [x, chroma, 0]
        : huePrime < 3
          ? [0, chroma, x]
          : huePrime < 4
            ? [0, x, chroma]
            : huePrime < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];

  return `#${colorComponentToHex((red + match) * 255)}${colorComponentToHex(
    (green + match) * 255,
  )}${colorComponentToHex((blue + match) * 255)}`;
};
const hexColorToHsv = (color: string) => {
  const { blue, green, red } = getRgbFromHexColor(color);
  const normalizedRed = red / 255;
  const normalizedGreen = green / 255;
  const normalizedBlue = blue / 255;
  const max = Math.max(normalizedRed, normalizedGreen, normalizedBlue);
  const min = Math.min(normalizedRed, normalizedGreen, normalizedBlue);
  const delta = max - min;
  let hue = selectedImageHue.value;

  if (delta > 0) {
    if (max === normalizedRed) {
      hue = 60 * (((normalizedGreen - normalizedBlue) / delta) % 6);
    } else if (max === normalizedGreen) {
      hue = 60 * ((normalizedBlue - normalizedRed) / delta + 2);
    } else {
      hue = 60 * ((normalizedRed - normalizedGreen) / delta + 4);
    }
  }

  return {
    hue: (hue + 360) % 360,
    saturation: max === 0 ? 0 : delta / max,
    value: max,
  };
};
const syncSelectedImageHsvFromColor = (color: string) => {
  const hsv = hexColorToHsv(color);
  selectedImageHue.value = hsv.hue;
  selectedImageSaturation.value = hsv.saturation;
  selectedImageValue.value = hsv.value;
};
const setSelectedImageColor = (color: string, options: { syncHsv?: boolean } = {}) => {
  selectedImageColor.value = color;
  selectedImageColorDraft.value = color.toUpperCase();

  if (options.syncHsv !== false) {
    syncSelectedImageHsvFromColor(color);
  }
};
const applySelectedImageHsv = () => {
  const alpha = selectedImageColor.value.length === 9 ? selectedImageColor.value.slice(7) : "";
  setSelectedImageColor(
    `${hsvToHexColor(
      selectedImageHue.value,
      selectedImageSaturation.value,
      selectedImageValue.value,
    )}${alpha}`,
    { syncHsv: false },
  );
};
const updateSelectedImageColorFromInput = (event: Event) => {
  if (!canEditImage.value) return;
  const input = event.currentTarget as HTMLInputElement;
  const normalized = normalizeHexColorInput(input.value);
  selectedImageColorDraft.value = normalized;
  input.value = normalized;

  if (isCompleteHexColor(normalized)) {
    setSelectedImageColor(normalized);
  }
};
const commitSelectedImageColorInput = () => {
  if (!canEditImage.value) {
    selectedImageColorDraft.value = selectedImageColor.value.toUpperCase();
    return;
  }
  if (isCompleteHexColor(selectedImageColorDraft.value)) {
    setSelectedImageColor(selectedImageColorDraft.value);
    return;
  }

  selectedImageColorDraft.value = selectedImageColor.value.toUpperCase();
};
const imagePinnedPalettesAreEqual = (
  left: readonly PinnedPaletteColor[],
  right: readonly PinnedPaletteColor[],
) =>
  left.length === right.length &&
  left.every(
    (entry, index) =>
      entry.id === right[index]?.id &&
      entry.color === right[index]?.color &&
      entry.name === right[index]?.name,
  );

const enqueuePersonalImagePaletteMutation = <T,>(mutation: () => Promise<T>) => {
  pendingPersonalImagePaletteMutations += 1;
  isPersonalImagePaletteSaving.value = true;

  const settleMutation = () => {
    pendingPersonalImagePaletteMutations = Math.max(
      0,
      pendingPersonalImagePaletteMutations - 1,
    );
    isPersonalImagePaletteSaving.value = pendingPersonalImagePaletteMutations > 0;
  };
  const operation = personalImagePaletteMutationQueue
    .then(mutation, mutation)
    .then(
      (result) => {
        settleMutation();
        return result;
      },
      (error: unknown) => {
        settleMutation();
        throw error;
      },
    );
  personalImagePaletteMutationQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
};

const waitForPersonalImagePaletteMutations = async () => {
  let pendingQueue = personalImagePaletteMutationQueue;
  await pendingQueue;

  while (pendingQueue !== personalImagePaletteMutationQueue) {
    pendingQueue = personalImagePaletteMutationQueue;
    await pendingQueue;
  }
};

const persistPersonalImagePalette = (
  nextPalette: readonly PinnedPaletteColor[],
  successMessage: string,
) => {
  if (!canManagePersonalImagePalette.value) {
    return false;
  }

  const normalized = normalizePinnedPaletteColors(nextPalette);
  if (imagePinnedPalettesAreEqual(normalized, personalImagePalette.value)) {
    return false;
  }

  const previousPalette = personalImagePalette.value;
  personalImagePalette.value = normalized;

  return enqueuePersonalImagePaletteMutation(async () => {
    try {
      const user = await patchCurrentUser({ pixel_art_palette: normalized });
      personalImagePalette.value = normalizePinnedPaletteColors(user.pixel_art_palette);
      showImageNotice(successMessage, "success");
      return true;
    } catch (error) {
      personalImagePalette.value = previousPalette;
      showImageNotice(
        error instanceof Error ? error.message : "Your personal palette could not be saved.",
        "error",
      );
      return false;
    }
  });
};

const pinImagePaletteColor = async (
  request: ImagePalettePinRequest = { color: selectedImageColor.value },
) => {
  const nextPalette = addPinnedPaletteColor(personalImagePalette.value, request);
  if (imagePinnedPalettesAreEqual(nextPalette, personalImagePalette.value)) {
    showImageNotice("That color is already pinned to your palette.", "info");
    return false;
  }
  return persistPersonalImagePalette(nextPalette, "Color pinned to your palette.");
};
const selectImagePaletteColor = (color: string) => {
  if (!canEditImage.value) return;
  setSelectedImageColor(color);
};
const selectSecondaryImagePaletteColor = (color: string) => {
  if (!canEditImage.value) return;
  setSecondaryImageColor(color);
};
const editImagePaletteColor = (request: ImagePaletteEditRequest) => {
  const normalizedColor = normalizePixelColor(request.color);
  const hasColorCollision = Boolean(
    request.id &&
      normalizedColor &&
      personalImagePalette.value.some(
        (entry) => entry.id !== request.id && entry.color === normalizedColor,
      ),
  );
  if (hasColorCollision) {
    showImageNotice(
      "That color is already pinned. Choose another color or edit its existing swatch.",
      "info",
    );
    return false;
  }

  const nextPalette = request.id
    ? editPinnedPaletteColor(personalImagePalette.value, request.id, request)
    : addPinnedPaletteColor(personalImagePalette.value, request);
  return persistPersonalImagePalette(nextPalette, "Saved color updated.");
};
const unpinImagePaletteColor = ({ id }: ImagePaletteRemoveRequest) =>
  persistPersonalImagePalette(
    deletePinnedPaletteColor(personalImagePalette.value, id),
    "Color unpinned. Pixels using it were not changed.",
  );
const getImageGridLineBackground = (color: string) => {
  const { blue, green, red } = getRgbFromHexColor(color);

  return `rgba(${red}, ${green}, ${blue}, var(--image-grid-line-opacity, 0.18))`;
};
const activeImageInspectorLabel = computed(() => {
  if (activeImageInspectorPanel.value === "resize") {
    return "Resize";
  }

  if (activeImageInspectorPanel.value === "preferences") {
    return "View";
  }

  if (activeImageInspectorPanel.value === "transform") {
    return "Transform";
  }

  if (activeImageInspectorPanel.value === "transfer") {
    return "Files";
  }

  return "Options";
});
const imageArtboardMetricsForZoom = (zoom: number) => {
  const gridWidth = imageGridWidth.value;
  const gridHeight = imageGridHeight.value;
  const cellSize = clampImageZoom(zoom);
  const renderPlan = createImageCanvasRenderPlan({ cellSize, gridHeight, gridWidth });

  return {
    cellSize,
    height: renderPlan.cssHeight,
    width: renderPlan.cssWidth,
  };
};
const imageArtboardMetrics = computed(() => imageArtboardMetricsForZoom(imageZoom.value));
const imageArtboardWidth = computed(() => imageArtboardMetrics.value.width);
const imageArtboardHeight = computed(() => imageArtboardMetrics.value.height);
const getImageViewportTransform = (): ImageViewportTransform => {
  // Remote cursors live outside the transformed artboard. Reading this revision
  // makes Vue reproject them for every imperative touch-transform frame.
  void imageViewportTransformRevision.value;
  return imageGestureView || {
    panX: imagePanX.value,
    panY: imagePanY.value,
    rotationRadians: imageRotationRadians.value,
    zoom: imageZoom.value,
  };
};
const imageArtboardCenterYRatio = computed(() =>
  imageViewportWidth.value <= 520 ? 0.46 : 0.5,
);
const getImageLiveGestureScale = () =>
  imageZoom.value > 0 && imageGestureView ? imageGestureView.zoom / imageZoom.value : 1;
const imageGridOverlayPlan = computed(() =>
  createImageGridOverlayPlan({
    cellSize: imageArtboardMetrics.value.cellSize,
    gridHeight: imageGridHeight.value,
    gridWidth: imageGridWidth.value,
    lineStyle: imageGridLineStyle.value,
  }),
);
const imageGridOverlayPath = computed(() =>
  [
    ...imageGridOverlayPlan.value.verticalLines,
    ...imageGridOverlayPlan.value.horizontalLines,
  ]
    .map(({ x1, x2, y1, y2 }) => `M ${x1} ${y1} L ${x2} ${y2}`)
    .join(" "),
);
const imageGridOverlayOpacity = computed(() => {
  if (!isImageGridVisible.value) {
    return 0;
  }

  const lowZoomVisibility = clamp01((imageGridOverlayPlan.value.step - 4) / 2);

  return clamp01(imageGridLineOpacity.value) * lowZoomVisibility;
});
const imageGridStrokeWidth = computed(() =>
  Math.min(imageGridGap.value, Math.max(0.75, imageGridOverlayPlan.value.step * 0.25)),
);
const imageGridDashArray = computed(() => {
  const step = imageGridOverlayPlan.value.step;
  const dashLength = Math.min(6, Math.max(3, step * 0.35));
  const gapLength = Math.min(4, Math.max(2, step * 0.25));

  return `${dashLength.toFixed(2)} ${gapLength.toFixed(2)}`;
});
const imageGridDotRadius = computed(() => Math.max(0.75, imageGridStrokeWidth.value / 2));
const imageGridDotPatternId = computed(
  () => `image-grid-dots-${props.resourceId.replace(/[^a-zA-Z0-9_-]/g, "")}`,
);
const imageGridDotClipRect = computed(() => {
  const inset = imageGridDotRadius.value + 0.01;

  return {
    height: Math.max(0, imageGridOverlayPlan.value.cssHeight - inset * 2),
    width: Math.max(0, imageGridOverlayPlan.value.cssWidth - inset * 2),
    x: inset,
    y: inset,
  };
});
const hasImageGridDotIntersections = computed(
  () =>
    imageGridWidth.value > 1 &&
    imageGridHeight.value > 1 &&
    imageGridDotClipRect.value.width > 0 &&
    imageGridDotClipRect.value.height > 0,
);
const imageSubdivisionLinePosition = (lineIndex: number) => {
  const cellSize = imageArtboardMetrics.value.cellSize;
  const thickness = imageGridSubdivisionThickness.value;
  const lineCenter = lineIndex * cellSize;

  return Math.max(0, lineCenter - thickness / 2);
};
const createImageSubdivisionLines = (count: number, axis: "horizontal" | "vertical") => {
  if (imageGridOverlayOpacity.value <= 0 || imageGridSubdivision.value <= 1) {
    return [];
  }

  const lines: ImageSubdivisionLine[] = [];
  for (let lineIndex = imageGridSubdivision.value; lineIndex < count; lineIndex += imageGridSubdivision.value) {
    const position = imageSubdivisionLinePosition(lineIndex);
    lines.push({
      index: lineIndex,
      style:
        axis === "vertical"
          ? { left: `${position}px`, width: `${imageGridSubdivisionThickness.value}px` }
          : { height: `${imageGridSubdivisionThickness.value}px`, top: `${position}px` },
    });
  }

  return lines;
};
const imageSubdivisionVerticalLines = computed(() =>
  createImageSubdivisionLines(imageGridWidth.value, "vertical"),
);
const imageSubdivisionHorizontalLines = computed(() =>
  createImageSubdivisionLines(imageGridHeight.value, "horizontal"),
);
const imageBrushPreviewTools: ReadonlySet<ImageTool> = new Set([
  "pencil",
  "erase",
  "line",
  "rectangle",
  "ellipse",
]);
const imageCanvasBounds = computed(() => ({
  height: imageGridHeight.value,
  width: imageGridWidth.value,
}));
const cloneImageSelection = (selection: ImageSelection | null): ImageSelection | null =>
  selection
    ? {
        ...selection,
        mask: selection.mask
          ? {
              width: selection.mask.width,
              height: selection.mask.height,
              data: selection.mask.data.slice(),
            }
          : undefined,
      }
    : null;
const imageSelectionToPixelMask = (
  selection: ImageSelection | null,
  dimensions = imageCanvasBounds.value,
): PixelSelectionMask | null => {
  if (!selection || selection.width <= 0 || selection.height <= 0) return null;
  const mask = selection.mask;
  if (
    mask &&
    mask.width === dimensions.width &&
    mask.height === dimensions.height &&
    mask.data.length === mask.width * mask.height
  ) {
    return {
      width: mask.width,
      height: mask.height,
      data: mask.data,
      bounds: {
        x: selection.x,
        y: selection.y,
        width: selection.width,
        height: selection.height,
      },
    };
  }

  return createRectangleSelectionMask(
    { x: selection.x, y: selection.y },
    {
      x: selection.x + selection.width - 1,
      y: selection.y + selection.height - 1,
    },
    dimensions,
  );
};
const imageSelectionFromPixelMask = (
  mask: PixelSelectionMask,
  kind: ImageSelectionKind,
): ImageSelection | null =>
  mask.bounds
    ? {
        ...mask.bounds,
        kind,
        mask: {
          width: mask.width,
          height: mask.height,
          data: mask.data,
        },
      }
    : null;
const activeImageSelectionMask = computed(() =>
  imageSelectionToPixelMask(imageSelection.value),
);
const imageSelectionMasksAreEqual = (
  left: ImageSelection | null,
  right: ImageSelection | null,
) => {
  if (!left || !right) return left === right;
  if (
    left.x !== right.x ||
    left.y !== right.y ||
    left.width !== right.width ||
    left.height !== right.height ||
    left.kind !== right.kind
  ) {
    return false;
  }
  const leftMask = left.mask;
  const rightMask = right.mask;
  if (!leftMask || !rightMask) return !leftMask && !rightMask;
  if (
    leftMask.width !== rightMask.width ||
    leftMask.height !== rightMask.height ||
    leftMask.data.length !== rightMask.data.length
  ) {
    return false;
  }
  return leftMask.data.every((value, index) => value === rightMask.data[index]);
};
const applyImageSelectionCandidate = (
  candidate: PixelSelectionMask,
  kind: ImageSelectionKind,
  mode: ImageSelectionMode,
  baseSelection: ImageSelection | null = imageSelection.value,
) => {
  const effectiveMode =
    !baseSelection && (mode === "subtract" || mode === "intersect")
      ? "replace"
      : mode;
  const combined = combineSelectionMasks(
    imageSelectionToPixelMask(baseSelection, candidate),
    candidate,
    effectiveMode,
  );
  imageSelection.value = imageSelectionFromPixelMask(combined, kind);
};
const resolveImageSelectionMode = (event: PointerEvent): ImageSelectionMode => {
  if (event.shiftKey && event.altKey) return "intersect";
  if (event.shiftKey) return "add";
  if (event.altKey) return "subtract";
  return imageSelectionMode.value;
};
const clampImageSelectionPoint = (point: Point): Point => ({
  x: Math.max(0, Math.min(imageGridWidth.value - 1, Math.round(point.x))),
  y: Math.max(0, Math.min(imageGridHeight.value - 1, Math.round(point.y))),
});
const imageSelectionPointWithinGestureTile = (
  virtualPoint: Point | undefined,
  fallbackPoint: Point,
) => {
  if (!virtualPoint || !imageSelectionGestureTileOffset) return fallbackPoint;
  return clampImageSelectionPoint({
    x: virtualPoint.x - imageSelectionGestureTileOffset.x,
    y: virtualPoint.y - imageSelectionGestureTileOffset.y,
  });
};
const filterImagePointsToSelection = (points: ReadonlyArray<Point>): Point[] => {
  const selection = activeImageSelectionMask.value;
  return selection ? points.filter((point) => isPixelSelected(selection, point)) : [...points];
};
const isImagePixelIndexWithinSelection = (index: number) => {
  const selection = activeImageSelectionMask.value;
  return (
    !selection ||
    isPixelSelected(selection, {
      x: index % imageGridWidth.value,
      y: Math.floor(index / imageGridWidth.value),
    })
  );
};
const createImageSelectionOutlinePath = (selection: ImageSelection | null) => {
  const mask = imageSelectionToPixelMask(selection);
  const bounds = mask?.bounds;
  if (!mask || !bounds) return "";

  const segments: string[] = [];
  const selected = (x: number, y: number) =>
    x >= 0 &&
    x < mask.width &&
    y >= 0 &&
    y < mask.height &&
    mask.data[y * mask.width + x] === 1;
  for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) {
    for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
      if (!selected(x, y)) continue;
      if (!selected(x, y - 1)) segments.push(`M${x} ${y}h1`);
      if (!selected(x + 1, y)) segments.push(`M${x + 1} ${y}v1`);
      if (!selected(x, y + 1)) segments.push(`M${x + 1} ${y + 1}h-1`);
      if (!selected(x - 1, y)) segments.push(`M${x} ${y + 1}v-1`);
    }
  }
  return segments.join("");
};
const imageSelectionOutlinePath = computed(() =>
  createImageSelectionOutlinePath(imageSelection.value),
);
const imageMirrorModes = computed(() => ({
  horizontal: isImageHorizontalMirrorEnabled.value,
  horizontalAxisY: imageHorizontalMirrorAxisY.value,
  vertical: isImageVerticalMirrorEnabled.value,
  verticalAxisX: imageVerticalMirrorAxisX.value,
}));
const prepareImageCanvasStrokePoints = (points: ReadonlyArray<Point>) =>
  expandCanvasMirrorPoints(
    isImageWrapAroundEnabled.value
      ? wrapCanvasPoints(points, imageCanvasBounds.value)
      : points,
    imageCanvasBounds.value,
    imageMirrorModes.value,
    { wrapAround: isImageWrapAroundEnabled.value },
  );
const expandImageCanvasPreviewPoints = (points: ReadonlyArray<Point>) => {
  if (!isImageWrapAroundEnabled.value) {
    return expandCanvasMirrorPoints(
      points,
      imageCanvasBounds.value,
      imageMirrorModes.value,
    );
  }

  const width = imageGridWidth.value;
  const height = imageGridHeight.value;
  const seen = new Set<string>();
  const result: Point[] = [];
  for (const point of points) {
    const tileX = Math.floor(point.x / width);
    const tileY = Math.floor(point.y / height);
    const wrapped = wrapCanvasPoint(point, imageCanvasBounds.value);
    const mirrored = expandCanvasMirrorPoints(
      [wrapped],
      imageCanvasBounds.value,
      imageMirrorModes.value,
      { wrapAround: true },
    );
    for (const copy of mirrored) {
      const virtualCopy = {
        x: copy.x + tileX * width,
        y: copy.y + tileY * height,
      };
      const key = `${virtualCopy.x},${virtualCopy.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(virtualCopy);
    }
  }
  return result;
};
const isImageBrushHoverPreview = computed(
  () =>
    hoveredImagePixelIndex.value !== null &&
    imageBrushPreviewTools.has(activeImageTool.value),
);
const imageBrushHoverCells = computed(() => {
  const hoveredIndex = hoveredImagePixelIndex.value;
  if (
    hoveredIndex === null ||
    !isImageBrushHoverPreview.value ||
    !canMutateActiveImageLayerPixels.value
  ) {
    return [];
  }

  const cellSize = imageArtboardMetrics.value.cellSize;
  const center =
    isImageWrapAroundEnabled.value && hoveredImageVirtualPoint.value
      ? hoveredImageVirtualPoint.value
      : {
          x: hoveredIndex % imageGridWidth.value,
          y: Math.floor(hoveredIndex / imageGridWidth.value),
        };
  const points = brushPoints(
    center,
    imageBrushSize.value,
    imageBrushShape.value,
    isImageWrapAroundEnabled.value ? undefined : imageCanvasBounds.value,
  );
  return expandImageCanvasPreviewPoints(points).map((point) => ({
    key: `${point.x}-${point.y}`,
    style: {
      height: `${cellSize}px`,
      left: `${point.x * cellSize}px`,
      top: `${point.y * cellSize}px`,
      width: `${cellSize}px`,
    },
  }));
});
const imageSingleHoverCells = computed(() => {
  const hoveredIndex = hoveredImagePixelIndex.value;
  if (hoveredIndex === null) return [];

  const cellSize = imageArtboardMetrics.value.cellSize;
  const point =
    isImageWrapAroundEnabled.value && hoveredImageVirtualPoint.value
      ? hoveredImageVirtualPoint.value
      : {
          x: hoveredIndex % imageGridWidth.value,
          y: Math.floor(hoveredIndex / imageGridWidth.value),
        };
  return [point].map((copy) => ({
    key: `${copy.x}-${copy.y}`,
    style: {
      height: `${cellSize}px`,
      left: `${copy.x * cellSize}px`,
      top: `${copy.y * cellSize}px`,
      width: `${cellSize}px`,
    },
  }));
});
const isImageGraffitiHoverPreview = computed(
  () =>
    hoveredImagePixelIndex.value !== null &&
    (imageGraffitiPreviewGesture.value !== null || activeImageTool.value === "graffiti"),
);
const imageGraffitiHoverCells = computed(() => {
  const hoveredIndex = hoveredImagePixelIndex.value;
  if (
    hoveredIndex === null ||
    !isImageGraffitiHoverPreview.value ||
    !canMutateActiveImageLayerPixels.value
  ) {
    return [];
  }

  const cellSize = imageArtboardMetrics.value.cellSize;
  const gesture = imageGraffitiPreviewGesture.value;
  const center =
    isImageWrapAroundEnabled.value && hoveredImageVirtualPoint.value
      ? hoveredImageVirtualPoint.value
      : {
          x: hoveredIndex % imageGridWidth.value,
          y: Math.floor(hoveredIndex / imageGridWidth.value),
        };
  const options = {
    bounds: isImageWrapAroundEnabled.value ? undefined : imageCanvasBounds.value,
    brushSize: imageBrushSize.value,
    brushShape: imageBrushShape.value,
    inverted: gesture?.inverted ?? false,
    primaryColor: gesture?.primaryColor ?? selectedImageColor.value,
    secondaryColor: gesture?.secondaryColor ?? secondaryImageColor.value,
  };
  const pixels = graffitiBrushStamp(center, options);

  return pixels.flatMap((pixel) => {
    const basePoint = isImageWrapAroundEnabled.value
      ? wrapCanvasPoint(pixel, imageCanvasBounds.value)
      : pixel;
    const color = isImageWrapAroundEnabled.value
      ? graffitiCheckerColorAt(basePoint, options)
      : pixel.color;
    return expandImageCanvasPreviewPoints([pixel]).map((copy) => ({
      key: `${copy.x}-${copy.y}`,
      style: {
        backgroundColor: color,
        borderColor: getImageGridKeylineColor(color),
        borderWidth: cellSize >= 4 ? "1px" : "0",
        height: `${cellSize}px`,
        left: `${copy.x * cellSize}px`,
        top: `${copy.y * cellSize}px`,
        width: `${cellSize}px`,
      },
    }));
  });
});
const imageArtboardAriaLabel = computed(() => {
  const base = `Pixel art drawing grid, ${imageGridWidth.value} by ${imageGridHeight.value} pixels. ${activeImageTool.value} tool on ${activeImageLayer.value?.name || "active layer"}, primary color ${selectedImageColor.value}, secondary color ${secondaryImageColor.value}.`;
  const toolDescription =
    activeImageTool.value === "graffiti"
      ? " Alternates both colors in a 1 by 1 checker pattern. The right button reverses the pattern."
      : activeImageTool.value === "select"
        ? ` ${imageSelectionKind.value} selection in ${imageSelectionMode.value} mode.${
            imageSelectionKind.value === "wand"
              ? ` ${isImageSelectionContiguous.value ? "Contiguous" : "Global"} exact-color matching.`
              : ""
          }`
        : activeImageTool.value === "rotate"
          ? " Drag around the white center cross to rotate pixels, or enter exact degrees and Apply. Shift snaps to 15 degrees. Pixels outside the canvas are clipped."
          : "";
  const layerState =
    activeImageLayer.value && !activeImageLayer.value.visible
      ? " The active layer is hidden; show it to edit pixels."
      : activeImageLayer.value?.locked
        ? " The active layer is locked; unlock it to edit pixels."
        : "";

  const canvasModes = [
    isImageHorizontalMirrorEnabled.value ? "horizontal mirror enabled" : "",
    isImageVerticalMirrorEnabled.value ? "vertical mirror enabled" : "",
    isImageWrapAroundEnabled.value ? "wrap-around enabled" : "",
  ].filter(Boolean);
  const modeDescription = canvasModes.length > 0 ? ` Canvas modes: ${canvasModes.join(", ")}.` : "";

  return `${base}${toolDescription}${layerState}${modeDescription}`;
});
const imageViewportAriaLabel = computed(() => {
  const navigation =
    "Hold Space to pan, hold Shift and Space while dragging to rotate, use the mouse wheel to zoom, or use two fingers to move, zoom, and rotate.";
  if (isImagePixelMutationBlocked.value) {
    const reason =
      activeImageLayer.value && !activeImageLayer.value.visible
        ? "The active layer is hidden; show it to edit pixels."
        : activeImageLayer.value?.locked
          ? "The active layer is locked; unlock it to edit pixels."
          : "Pixel editing is unavailable.";
    return `Drawing workspace. ${reason} ${navigation}`;
  }

  return `Drawing workspace. Start a stroke here and move onto the canvas. ${navigation}`;
});
const remoteImageCollaboratorList = computed(() =>
  Object.values(remoteImageCollaborators.value).filter(
    (collaborator) =>
      collaborator.width === imageGridWidth.value &&
      collaborator.height === imageGridHeight.value,
  ),
);
const remoteImageCursorStyle = (collaborator: RemoteImageCollaborator) => {
  const clientSpace = getImageArtboardClientSpace();
  const viewportRect = imageStageRef.value?.getBoundingClientRect();
  if (!clientSpace || !viewportRect) return { display: "none" };

  const cellSize = imageArtboardMetrics.value.cellSize * clientSpace.scale;
  const unrotatedPoint = {
    x: clientSpace.rectLeft + clientSpace.borderLeft + collaborator.x * cellSize,
    y: clientSpace.rectTop + clientSpace.borderTop + collaborator.y * cellSize,
  };
  const clientPoint = rotateImageClientPoint({
    center: clientSpace.center,
    point: unrotatedPoint,
    rotationRadians: clientSpace.rotationRadians,
  });

  return {
    "--image-collaborator-color": collaborator.color,
    left: `${clientPoint.x - viewportRect.left}px`,
    top: `${clientPoint.y - viewportRect.top}px`,
  };
};
const remoteImageSelectionOutlinePath = (collaborator: RemoteImageCollaborator) =>
  createImageSelectionOutlinePath(collaborator.selection);
const imageHorizontalMirrorAxisStyle = computed(() => ({
  top: `${imageHorizontalMirrorAxisY.value * imageArtboardMetrics.value.cellSize}px`,
}));
const imageVerticalMirrorAxisStyle = computed(() => ({
  left: `${imageVerticalMirrorAxisX.value * imageArtboardMetrics.value.cellSize}px`,
}));
const describeImageMirrorAxisPosition = (
  axis: ImageMirrorAxis,
  position: number,
  dimension: number,
) => {
  const unit = axis === "horizontal" ? "row" : "column";
  if (position <= 0) return `Before the first ${unit}`;
  if (position >= dimension) return `After the last ${unit}`;
  if (Number.isInteger(position)) {
    return `Between ${unit}s ${position} and ${position + 1}`;
  }

  return `Through ${unit} ${Math.floor(position) + 1}`;
};
const imageHorizontalMirrorAxisValueText = computed(
  () =>
    describeImageMirrorAxisPosition(
      "horizontal",
      imageHorizontalMirrorAxisY.value,
      imageGridHeight.value,
    ),
);
const imageVerticalMirrorAxisValueText = computed(
  () =>
    describeImageMirrorAxisPosition(
      "vertical",
      imageVerticalMirrorAxisX.value,
      imageGridWidth.value,
    ),
);
const imageCanvasGridStyle = computed(() => {
  return {
    gap: "0px",
    gridTemplateColumns: `repeat(${imageGridWidth.value}, 1fr)`,
    gridTemplateRows: `repeat(${imageGridHeight.value}, 1fr)`,
    height: `${imageArtboardHeight.value}px`,
    "--image-grid-height": `${imageGridHeight.value}`,
    "--image-grid-line-opacity": `${imageGridOverlayOpacity.value}`,
    "--image-grid-subdivision-color": getImageGridLineBackground(customImageSubdivisionColor.value),
    "--image-grid-subdivision-thickness": `${imageGridSubdivisionThickness.value}px`,
    "--image-grid-width": `${imageGridWidth.value}`,
    "--image-artboard-height": `${imageArtboardHeight.value}px`,
    "--image-artboard-half-height": `${imageArtboardHeight.value / 2}px`,
    "--image-artboard-half-width": `${imageArtboardWidth.value / 2}px`,
    "--image-artboard-width": `${imageArtboardWidth.value}px`,
    "--image-artboard-center-x": "50%",
    "--image-artboard-center-y": `${imageArtboardCenterYRatio.value * 100}%`,
    "--image-pixel-background": customImageBackground.value,
    width: `${imageArtboardWidth.value}px`,
  };
});
const imageCanvasBitmapStyle = computed(() => ({
  height: `${imageGridOverlayPlan.value.cssHeight}px`,
  width: `${imageGridOverlayPlan.value.cssWidth}px`,
}));
const imageWrapSurfaceStyle = computed(() => ({
  backgroundImage: imageWrapTileDataUrl.value
    ? `url(${JSON.stringify(imageWrapTileDataUrl.value)})`
    : "none",
  backgroundSize: `${imageArtboardWidth.value}px ${imageArtboardHeight.value}px`,
}));
const imagePreviewGridStyle = computed(() => ({
  aspectRatio: `${imageGridWidth.value} / ${imageGridHeight.value}`,
  gridTemplateColumns: `repeat(${imageGridWidth.value}, 1fr)`,
  gridTemplateRows: `repeat(${imageGridHeight.value}, 1fr)`,
  height:
    imageGridWidth.value >= imageGridHeight.value
      ? `${(imageGridHeight.value / imageGridWidth.value) * 100}%`
      : "100%",
  "--image-preview-empty-pixel": customImageBackground.value,
  width:
    imageGridWidth.value >= imageGridHeight.value
      ? "100%"
      : `${(imageGridWidth.value / imageGridHeight.value) * 100}%`,
}));
const imagePreviewViewportStyle = computed(() => ({
  height: `${imagePreviewViewport.value.height}%`,
  left: `${imagePreviewViewport.value.left}%`,
  top: `${imagePreviewViewport.value.top}%`,
  width: `${imagePreviewViewport.value.width}%`,
}));
const imageFloatingPreviewStyle = computed(() => ({
  "--image-preview-size": `${imageFloatingPreview.value.size}px`,
  visibility: imageFloatingPreview.value.visible ? "visible" : "hidden",
}));
const selectedImageHueColor = computed(() =>
  hsvToHexColor(selectedImageHue.value, 1, 1),
);
const imageColorHueHandleStyle = computed(() => {
  const angleDegrees = selectedImageHue.value - 180;
  const angle = (angleDegrees * Math.PI) / 180;
  const radius = IMAGE_COLOR_PICKER_RADIUS - IMAGE_COLOR_PICKER_RING_WIDTH * 0.14;

  return {
    left: `${IMAGE_COLOR_PICKER_CENTER + Math.cos(angle) * radius}px`,
    top: `${IMAGE_COLOR_PICKER_CENTER + Math.sin(angle) * radius}px`,
    transform: `translate(-50%, -50%) rotate(${angleDegrees}deg)`,
  };
});
const imageColorTriangleHandleStyle = computed(() => {
  const hueWeight = selectedImageSaturation.value * selectedImageValue.value;
  const whiteWeight = (1 - selectedImageSaturation.value) * selectedImageValue.value;
  const blackWeight = 1 - selectedImageValue.value;
  const x =
    IMAGE_COLOR_TRIANGLE_TOP.x * blackWeight +
    IMAGE_COLOR_TRIANGLE_LEFT.x * whiteWeight +
    IMAGE_COLOR_TRIANGLE_RIGHT.x * hueWeight;
  const y =
    IMAGE_COLOR_TRIANGLE_TOP.y * blackWeight +
    IMAGE_COLOR_TRIANGLE_LEFT.y * whiteWeight +
    IMAGE_COLOR_TRIANGLE_RIGHT.y * hueWeight;

  return {
    left: `${x - IMAGE_COLOR_TRIANGLE_LEFT.x}px`,
    top: `${y - IMAGE_COLOR_TRIANGLE_TOP.y}px`,
  };
});
const imageColorPickerStyle = computed(() => ({
  "--selected-image-color": selectedImageColor.value,
  "--selected-image-hue-color": selectedImageHueColor.value,
}));

const renderImageCanvas = () => {
  const canvas = imageCanvasRef.value;
  if (!canvas) {
    return;
  }

  const cellSize = imageArtboardMetrics.value.cellSize;
  const width = imageGridWidth.value;
  const height = imageGridHeight.value;
  const renderPlan = createImageCanvasRenderPlan({
    cellSize,
    gridHeight: height,
    gridWidth: width,
  });
  canvas.width = Math.max(1, renderPlan.bitmapWidth);
  canvas.height = Math.max(1, renderPlan.bitmapHeight);
  canvas.style.width = `${renderPlan.cssWidth}px`;
  canvas.style.height = `${renderPlan.cssHeight}px`;

  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, canvas.width, canvas.height);
  const visiblePixels = compositeVisibleLayers(buildImageDocument());

  for (let index = 0; index < visiblePixels.length; index += 1) {
    const column = index % width;
    const row = Math.floor(index / width);
    context.fillStyle = customImageBackground.value;
    context.fillRect(
      column * renderPlan.cellStride,
      row * renderPlan.cellStride,
      renderPlan.cellSize,
      renderPlan.cellSize,
    );
    const color = visiblePixels[index];
    if (color) {
      context.fillStyle = color;
      context.fillRect(
        column * renderPlan.cellStride,
        row * renderPlan.cellStride,
        renderPlan.cellSize,
        renderPlan.cellSize,
      );
    }
  }

  if (imageShapePreviewPoints.value.length > 0) {
    context.save();
    context.globalAlpha = 0.72;
    context.fillStyle = imageInteractionColor || "transparent";
    for (const point of imageShapePreviewPoints.value) {
      context.fillRect(
        point.x * renderPlan.cellStride,
        point.y * renderPlan.cellStride,
        renderPlan.cellSize,
        renderPlan.cellSize,
      );
    }
    context.restore();
  }

  if (isImageWrapAroundEnabled.value) {
    try {
      imageWrapTileDataUrl.value = canvas.toDataURL("image/png");
    } catch {
      imageWrapTileDataUrl.value = "";
    }
  } else if (imageWrapTileDataUrl.value) {
    imageWrapTileDataUrl.value = "";
  }
};

const setSecondaryImageColor = (color: string) => {
  if (!canEditImage.value) return;
  const normalized = normalizeHexColorInput(color);
  if (isCompleteHexColor(normalized)) {
    secondaryImageColor.value = normalized;
  }
};

const swapImageColors = () => {
  if (!canEditImage.value) return;
  const previousPrimary = selectedImageColor.value;
  setSelectedImageColor(secondaryImageColor.value);
  secondaryImageColor.value = previousPrimary;
};

const resetImageColors = () => {
  if (!canEditImage.value) return;
  setSelectedImageColor("#FFFFFF");
  secondaryImageColor.value = "#000000";
};

const renderImagePreviewCanvas = () => {
  const canvas = imagePreviewCanvasRef.value;
  if (!canvas) {
    return;
  }

  const width = imageGridWidth.value;
  const height = imageGridHeight.value;
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);

  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  context.imageSmoothingEnabled = false;
  context.fillStyle = customImageBackground.value;
  context.fillRect(0, 0, width, height);
  const visiblePixels = compositeVisibleLayers(buildImageDocument());

  for (let index = 0; index < visiblePixels.length; index += 1) {
    const color = visiblePixels[index];
    if (!color) {
      continue;
    }

    const column = index % width;
    const row = Math.floor(index / width);
    context.fillStyle = color;
    context.fillRect(column, row, 1, 1);
  }
};

watch(
  imagePreviewCanvasRef,
  (canvas) => {
    if (canvas) {
      renderImagePreviewCanvas();
    }
  },
  { flush: "post" },
);

const getImageColorTriangleWeights = (x: number, y: number) => {
  const denominator =
    (IMAGE_COLOR_TRIANGLE_LEFT.y - IMAGE_COLOR_TRIANGLE_RIGHT.y) *
      (IMAGE_COLOR_TRIANGLE_TOP.x - IMAGE_COLOR_TRIANGLE_RIGHT.x) +
    (IMAGE_COLOR_TRIANGLE_RIGHT.x - IMAGE_COLOR_TRIANGLE_LEFT.x) *
      (IMAGE_COLOR_TRIANGLE_TOP.y - IMAGE_COLOR_TRIANGLE_RIGHT.y);
  const black =
    ((IMAGE_COLOR_TRIANGLE_LEFT.y - IMAGE_COLOR_TRIANGLE_RIGHT.y) *
      (x - IMAGE_COLOR_TRIANGLE_RIGHT.x) +
      (IMAGE_COLOR_TRIANGLE_RIGHT.x - IMAGE_COLOR_TRIANGLE_LEFT.x) *
        (y - IMAGE_COLOR_TRIANGLE_RIGHT.y)) /
    denominator;
  const white =
    ((IMAGE_COLOR_TRIANGLE_RIGHT.y - IMAGE_COLOR_TRIANGLE_TOP.y) *
      (x - IMAGE_COLOR_TRIANGLE_RIGHT.x) +
      (IMAGE_COLOR_TRIANGLE_TOP.x - IMAGE_COLOR_TRIANGLE_RIGHT.x) *
        (y - IMAGE_COLOR_TRIANGLE_RIGHT.y)) /
    denominator;
  const hue = 1 - black - white;

  return { black, hue, white };
};

const renderImageColorTriangleCanvas = () => {
  const canvas = imageColorTriangleCanvasRef.value;
  if (!canvas) {
    return;
  }

  const cssWidth = IMAGE_COLOR_TRIANGLE_RIGHT.x - IMAGE_COLOR_TRIANGLE_LEFT.x;
  const cssHeight = IMAGE_COLOR_TRIANGLE_LEFT.y - IMAGE_COLOR_TRIANGLE_TOP.y;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(cssWidth * pixelRatio);
  const height = Math.round(cssHeight * pixelRatio);
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  const imageData = context.createImageData(width, height);
  const hueRgb = getRgbFromHexColor(selectedImageHueColor.value);

  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const weights = getImageColorTriangleWeights(
        IMAGE_COLOR_TRIANGLE_LEFT.x + (column + 0.5) / pixelRatio,
        IMAGE_COLOR_TRIANGLE_TOP.y + (row + 0.5) / pixelRatio,
      );
      const dataIndex = (row * width + column) * 4;
      const black = Math.max(0, weights.black);
      const white = Math.max(0, weights.white);
      const hue = Math.max(0, weights.hue);
      const total = black + white + hue || 1;
      const normalizedWhite = white / total;
      const normalizedHue = hue / total;

      imageData.data[dataIndex] = Math.round(255 * normalizedWhite + hueRgb.red * normalizedHue);
      imageData.data[dataIndex + 1] = Math.round(255 * normalizedWhite + hueRgb.green * normalizedHue);
      imageData.data[dataIndex + 2] = Math.round(255 * normalizedWhite + hueRgb.blue * normalizedHue);
      imageData.data[dataIndex + 3] = 255;
    }
  }

  context.putImageData(imageData, 0, 0);
};

let imageCanvasRenderFrame: number | null = null;
const scheduleImageCanvasRender = () => {
  if (typeof window === "undefined") {
    return;
  }

  if (imageCanvasRenderFrame !== null) {
    window.cancelAnimationFrame(imageCanvasRenderFrame);
  }

  imageCanvasRenderFrame = window.requestAnimationFrame(() => {
    imageCanvasRenderFrame = null;
    renderImageCanvas();
    renderImagePreviewCanvas();
  });
};

const projectPath = computed(() => `/studio/${encodeURIComponent(props.projectId)}`);
const canonicalResourcePath = computed(
  () =>
    `/studio/${encodeURIComponent(props.projectId)}/${editorMeta.value.routeKind}/${encodeURIComponent(
      props.resourceId,
    )}`,
);

const navigateAfterImageSave = async (path: string) => {
  if (isImageEditor.value && isRenamingResource.value) {
    await commitResourceName();
  }

  if (isImageEditor.value) {
    await imageAutosave.flush();
    await resourceMutationQueue;
    await waitForPersonalImagePaletteMutations();

    const hasUnsavedName =
      isRenamingResource.value &&
      Boolean(resourceNameDraft.value.trim()) &&
      resourceNameDraft.value.trim() !== resource.value?.name;
    if (
      imageAutosave.hasPendingChanges.value ||
      isResourceNameSaving.value ||
      isPersonalImagePaletteSaving.value ||
      hasUnsavedName ||
      imageConflictOperation.value !== null
    ) {
      const shouldLeave = window.confirm(
        "Your latest changes could not be saved. Leave the editor anyway? Unsaved changes may be lost.",
      );
      if (!shouldLeave) {
        showImageNotice(
          imageSaveError.value || "Save your pending changes before leaving the editor.",
          "error",
        );
        return;
      }
    }
  }

  allowImageUnload = true;
  window.location.assign(path);
};

const returnToStudio = () => navigateAfterImageSave("/studio");

const returnToProject = () => navigateAfterImageSave(projectPath.value);

const updateProfile = (user: UserPublic) => {
  profileUsername.value = user.username || "";
  profileUserName.value = user.username || user.email;
  profileAvatarUrl.value = user.avatar_url || "";
  profileEmail.value = user.email;
  profilePixelAvatar.value = user.avatar_pixel_art || null;
  imagePaletteUserId.value = user.id;
  currentPresenceUserId.value = user.id;
  personalImagePalette.value = normalizePinnedPaletteColors(user.pixel_art_palette);
  isProfileDialogOpen.value = false;
  connectResourcePresence();
};

const emptyImagePixels = (width = imageGridWidth.value, height = imageGridHeight.value) =>
  Array<PixelColor>(width * height).fill(null);

const imagePixelsAreEqual = (
  left: ReadonlyArray<PixelColor>,
  right: ReadonlyArray<PixelColor>,
) =>
  left.length === right.length && left.every((pixel, index) => pixel === right[index]);

const normalizeImageDimension = (value: unknown, fallback: number) => {
  const dimension = Number(value);

  if (!Number.isFinite(dimension)) {
    return fallback;
  }

  return Math.min(
    MAX_IMAGE_DIMENSION,
    Math.max(MIN_IMAGE_DIMENSION, Math.round(dimension)),
  );
};

const normalizeImageResizeAnchor = (value: unknown): ImageResizeAnchor =>
  IMAGE_RESIZE_ANCHORS.some((anchor) => anchor.value === value)
    ? (value as ImageResizeAnchor)
    : DEFAULT_IMAGE_RESIZE_ANCHOR;

const readImagePixelsFromData = (data: Record<string, unknown>) => {
  const result = parsePixelArtResourceData(data);
  const legacyPixelArt =
    data.pixel_art && typeof data.pixel_art === "object"
      ? (data.pixel_art as Record<string, unknown>)
      : data;

  return {
    anchor: normalizeImageResizeAnchor(legacyPixelArt.anchor),
    document: result.document,
    migrated: result.migrated,
    warnings: result.warnings,
  };
};

const showImageNotice = (
  message: string,
  tone: "error" | "info" | "success" = "info",
) => {
  imageTransferNotice.value = message;
  imageTransferNoticeTone.value = tone;
};

const enqueueResourceMutation = <T,>(mutation: () => Promise<T>) => {
  const operation = resourceMutationQueue.then(mutation, mutation);
  resourceMutationQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
};

const markImageReadOnly = () => {
  if (project.value) {
    project.value = { ...project.value, access_role: "viewer" };
  }
};

const openImageConflict = (
  operation: ImageConflictOperation,
  remoteRevision: number | null,
) => {
  imageConflictOperation.value = operation;
  imageConflictRemoteRevision.value = remoteRevision;

  const revealConflict = () => {
    isImageConflictOpen.value = true;
  };

  if (isDocumentInfoOpen.value) {
    isDocumentInfoOpen.value = false;
    void nextTick(() => window.requestAnimationFrame(revealConflict));
    return;
  }

  if (activeImageInspectorPanel.value !== null) {
    activeImageInspectorPanel.value = null;
    void nextTick(() => window.requestAnimationFrame(revealConflict));
    return;
  }

  revealConflict();
};

const persistResourceName = async (name: string) => {
  isResourceNameSaving.value = true;
  try {
    await enqueueResourceMutation(async () => {
      const currentResource = resource.value;
      if (!currentResource || !canEditImage.value) {
        throw new Error("You no longer have permission to rename this image.");
      }

      const result = await patchProjectResource(props.projectId, props.resourceId, {
        name,
        base_revision: currentResource.revision,
      });

      if (!result.ok) {
        if (result.conflict) {
          openImageConflict(
            { kind: "rename", name },
            result.conflict.current_revision,
          );
          throw new Error("A newer version exists. Choose which name to keep.");
        }
        if (result.status === 403) {
          markImageReadOnly();
        }
        throw new Error(
          result.status === 403
            ? "You no longer have permission to rename this image."
            : `The image name could not be saved${result.status ? ` (${result.status})` : ""}.`,
        );
      }

      resource.value = {
        ...currentResource,
        ...result.resource,
        data: currentResource.data,
      };
    });
  } finally {
    isResourceNameSaving.value = false;
  }
};

const startRenamingResource = () => {
  if (!canEditImage.value || !resource.value) return;
  resourceNameSaveError.value = "";
  resourceNameDraft.value = resource.value.name;
  isRenamingResource.value = true;
  void nextTick(() => resourceNameInput.value?.focus({ preventScroll: true }));
};

const cancelRenamingResource = () => {
  isRenamingResource.value = false;
  resourceNameSaveError.value = "";
  resourceNameDraft.value = resource.value?.name || "";
};

const performResourceNameCommit = async () => {
  const currentResource = resource.value;
  const name = resourceNameDraft.value.trim();
  if (!currentResource || !canEditImage.value || !name || name === currentResource.name) {
    cancelRenamingResource();
    return;
  }

  await imageAutosave.flush();
  if (imageAutosave.hasPendingChanges.value) {
    resourceNameSaveError.value = imageSaveError.value || "Save the pending image changes before renaming it.";
    showImageNotice(
      resourceNameSaveError.value,
      "error",
    );
    return;
  }

  try {
    await persistResourceName(name);
    resourceNameSaveError.value = "";
    isRenamingResource.value = false;
    showImageNotice("Image name updated.", "success");
  } catch (error) {
    resourceNameSaveError.value =
      error instanceof Error ? error.message : "The image name could not be saved.";
    showImageNotice(resourceNameSaveError.value, "error");
  }
};

const commitResourceName = () => {
  if (resourceNameCommitPromise) {
    return resourceNameCommitPromise;
  }

  const operation = performResourceNameCommit();
  resourceNameCommitPromise = operation;
  void operation.finally(() => {
    if (resourceNameCommitPromise === operation) {
      resourceNameCommitPromise = null;
    }
  });
  return operation;
};

const focusDocumentNameControl = () => {
  void nextTick(() => {
    if (!isDocumentInfoOpen.value) return;
    (isRenamingResource.value ? resourceNameInput.value : resourceRenameButton.value)?.focus({ preventScroll: true });
  });
};

const cancelDocumentInfoName = () => {
  if (isDocumentNameSubmitting.value || isResourceNameSaving.value) return;
  cancelRenamingResource();
  focusDocumentNameControl();
};

const commitDocumentInfoName = async () => {
  if (isDocumentNameSubmitting.value || isResourceNameSaving.value) return;
  isDocumentNameSubmitting.value = true;
  try {
    await commitResourceName();
  } catch (error) {
    resourceNameSaveError.value = error instanceof Error ? error.message : "The image name could not be saved.";
  } finally {
    isDocumentNameSubmitting.value = false;
    focusDocumentNameControl();
  }
};

const documentInfoDetails = computed(() => buildDocumentInfoDetails({
  projectName: projectName.value,
  typeLabel: editorMeta.value.label,
  createdAt: normalizeResourceUpdatedAt(resource.value?.created_at),
  updatedAt: normalizeResourceUpdatedAt(resource.value?.updated_at),
  revision: resource.value?.revision,
  image: isImageEditor.value ? {
    width: imageGridWidth.value,
    height: imageGridHeight.value,
    layerCount: imageLayers.value.length,
  } : null,
}));

const openDocumentInfo = () => {
  if (isLoading.value || errorMessage.value || !resource.value) return;
  clearImageTemporaryKeys();
  isDocumentInfoOpen.value = true;
};

const closeDocumentInfo = () => {
  cancelRenamingResource();
  isDocumentInfoOpen.value = false;
};

const buildImageDocument = (includeRotationPreview = true): PixelArtDocumentV2 => {
  // Pixel buffers are treated as immutable throughout the editor. Reusing them
  // here keeps rendering and history snapshots cheap even at the v1 limits.
  // Saving and broadcasting must exclude an uncommitted rotation preview.
  const layers = imageLayers.value.map((layer) => ({
    ...layer,
    pixels: !includeRotationPreview && imagePixelRotationGesture.value?.layerId === layer.id
      ? [...imagePixelRotationGesture.value.buffer.pixels]
      : layer.pixels,
  }));
  return {
    version: 2,
    width: imageGridWidth.value,
    height: imageGridHeight.value,
    palette: !includeRotationPreview && imagePixelRotationGesture.value
      ? deriveUsedPaletteColors(layers)
      : [...usedImagePaletteColors.value],
    layers,
  };
};

const sendImageCollaborationActivity = (
  kind: ProjectEditorActivity["kind"],
  payload: Record<string, unknown>,
) => {
  if (
    !isImageEditor.value ||
    !canSendCollaborativeActivity(kind, payload, document.visibilityState)
  ) return;
  projectPresenceConnection?.sendEditorActivity(kind, payload);
};

const flushImageCollaborationPixels = () => {
  if (imageCollaborationPixelsTimeout !== null) {
    window.clearTimeout(imageCollaborationPixelsTimeout);
    imageCollaborationPixelsTimeout = null;
  }

  for (const [layerId, pixels] of pendingImageCollaborationPixels) {
    if (pixels.size === 0) continue;
    sendImageCollaborationActivity("pixels", {
      changes: [...pixels.entries()],
      height: imageGridHeight.value,
      layer_id: layerId,
      width: imageGridWidth.value,
    });
  }
  pendingImageCollaborationPixels.clear();
};

const queueImageCollaborationPixels = (
  changes: ReadonlyArray<Readonly<{ index: number; after: PixelColor }>>,
) => {
  const layerId = activeImageLayer.value?.id;
  if (!layerId || changes.length === 0) return;

  const pending = pendingImageCollaborationPixels.get(layerId) || new Map<number, PixelColor>();
  for (const change of changes) pending.set(change.index, change.after);
  pendingImageCollaborationPixels.set(layerId, pending);
  if (imageCollaborationPixelsTimeout !== null) return;
  imageCollaborationPixelsTimeout = window.setTimeout(
    flushImageCollaborationPixels,
    IMAGE_COLLABORATION_PIXEL_INTERVAL_MS,
  );
};

const broadcastImageDocument = (
  persistedRevision?: number,
  targetClientId?: string,
) => {
  flushImageCollaborationPixels();
  sendImageCollaborationActivity("document", {
    document: buildImageDocument(false),
    ...(persistedRevision === undefined ? {} : { persisted_revision: persistedRevision }),
    ...(targetClientId ? { target_client_id: targetClientId } : {}),
  });
};

const flushImageCollaborationCursor = () => {
  if (imageCollaborationCursorTimeout !== null) {
    window.clearTimeout(imageCollaborationCursorTimeout);
    imageCollaborationCursorTimeout = null;
  }
  if (!pendingImageCollaborationCursor) return;
  const payload = pendingImageCollaborationCursor;
  pendingImageCollaborationCursor = null;
  lastImageCollaborationCursorAt = Date.now();
  sendImageCollaborationActivity("cursor", payload);
};

const broadcastImageCursor = (
  position: Readonly<{ x: number; y: number }> | null,
) => {
  lastImageCollaborationCursorPosition = position;
  pendingImageCollaborationCursor = {
    height: imageGridHeight.value,
    tool: activeImageTool.value,
    visible: position !== null,
    width: imageGridWidth.value,
    ...(position === null
      ? {}
      : {
          x: position.x,
          y: position.y,
        }),
  };

  const remaining = Math.max(
    0,
    IMAGE_COLLABORATION_CURSOR_INTERVAL_MS - (Date.now() - lastImageCollaborationCursorAt),
  );
  if (remaining === 0) {
    flushImageCollaborationCursor();
  } else if (imageCollaborationCursorTimeout === null) {
    imageCollaborationCursorTimeout = window.setTimeout(flushImageCollaborationCursor, remaining);
  }
};

const flushImageCollaborationSelection = () => {
  if (imageCollaborationSelectionTimeout !== null) {
    window.clearTimeout(imageCollaborationSelectionTimeout);
    imageCollaborationSelectionTimeout = null;
  }
  if (!pendingImageCollaborationSelection) return;
  const pending = pendingImageCollaborationSelection;
  pendingImageCollaborationSelection = null;
  lastImageCollaborationSelectionAt = Date.now();
  sendImageCollaborationActivity("selection", {
    selection: serializeCollaborativeSelection(
      pending.selection
        ? { ...pending.selection, mode: pending.mode }
        : null,
    ),
  });
};

const broadcastImageSelection = () => {
  pendingImageCollaborationSelection = {
    // Selection objects and their masks are replaced, never mutated. Keeping
    // the latest reference lets the throttle discard intermediate pointer
    // frames without bit-packing a complete 256 x 256 mask for each one.
    mode: imageSelectionMode.value,
    selection: imagePixelRotationGesture.value
      ? imagePixelRotationGesture.value.selection
      : imageSelection.value,
  };
  const remaining = Math.max(
    0,
    IMAGE_COLLABORATION_SELECTION_INTERVAL_MS -
      (Date.now() - lastImageCollaborationSelectionAt),
  );
  if (remaining === 0) {
    flushImageCollaborationSelection();
  } else if (imageCollaborationSelectionTimeout === null) {
    imageCollaborationSelectionTimeout = window.setTimeout(
      flushImageCollaborationSelection,
      remaining,
    );
  }
};

const collaboratorName = (activity: ProjectEditorActivity) =>
  activity.user.username?.trim() || activity.user.email.split("@")[0] || "Collaborator";

const collaboratorPresenceMember = (activity: ProjectEditorActivity) =>
  projectPresenceMembers.value.find((member) => member.client_id === activity.client_id) ||
  projectPresenceMembers.value.find((member) => member.id === activity.user.id);

const remoteImageCollaboratorInitials = (collaborator: RemoteImageCollaborator) => {
  const parts = collaborator.name.split(/[\s._-]+/).filter(Boolean);
  return (parts.length > 1
    ? `${parts[0]?.[0] || ""}${parts[1]?.[0] || ""}`
    : collaborator.name.slice(0, 2)
  ).toUpperCase();
};

const hasRemoteImagePixelAvatar = (collaborator: RemoteImageCollaborator) =>
  Boolean(collaborator.pixelAvatar?.pixels?.length && collaborator.pixelAvatar.size > 0);

const canShowRemoteImageAvatar = (collaborator: RemoteImageCollaborator) =>
  Boolean(
    collaborator.avatarUrl &&
      !failedRemoteImageAvatarClientIds.value.has(collaborator.clientId),
  );

const markRemoteImageAvatarFailed = (collaborator: RemoteImageCollaborator) => {
  failedRemoteImageAvatarClientIds.value = new Set([
    ...failedRemoteImageAvatarClientIds.value,
    collaborator.clientId,
  ]);
};

const updateRemoteImageCollaborator = (
  activity: ProjectEditorActivity,
  update: Partial<RemoteImageCollaborator>,
) => {
  const current = remoteImageCollaborators.value[activity.client_id];
  const presenceMember = collaboratorPresenceMember(activity);
  remoteImageCollaborators.value = {
    ...remoteImageCollaborators.value,
    [activity.client_id]: {
      avatarUrl: "",
      clientId: activity.client_id,
      color: collaboratorColor(activity.user.id || activity.client_id),
      height: imageGridHeight.value,
      lastSeenAt: Date.now(),
      name: collaboratorName(activity),
      pixelAvatar: null,
      selection: null,
      tool: "pencil",
      userId: activity.user.id,
      visible: false,
      width: imageGridWidth.value,
      x: 0,
      y: 0,
      ...current,
      avatarUrl:
        presenceMember?.avatar_url ||
        activity.user.avatar_url ||
        current?.avatarUrl ||
        "",
      pixelAvatar: presenceMember
        ? presenceMember.avatar_pixel_art || null
        : activity.user.avatar_pixel_art || current?.pixelAvatar || null,
      ...update,
    },
  };
};

const handleProjectPresenceSync = (snapshot: ProjectPresenceSnapshot) => {
  projectPresenceMembers.value = snapshot[props.resourceId] || [];
  if (projectPresenceMembers.value.length === 0) return;

  remoteImageCollaborators.value = Object.fromEntries(
    Object.entries(remoteImageCollaborators.value).map(([clientId, collaborator]) => {
      const member =
        projectPresenceMembers.value.find((candidate) => candidate.client_id === clientId) ||
        projectPresenceMembers.value.find((candidate) => candidate.id === collaborator.userId);
      if (!member) return [clientId, collaborator];
      return [
        clientId,
        {
          ...collaborator,
          avatarUrl: member.avatar_url || "",
          pixelAvatar: member.avatar_pixel_art || null,
        },
      ];
    }),
  );
};

const applyRemoteImageDocument = (document: PixelArtDocumentV2) => {
  const currentLayerId = activeImageLayerId.value;
  const didResize =
    document.width !== imageGridWidth.value || document.height !== imageGridHeight.value;
  imageGridWidth.value = document.width;
  imageGridHeight.value = document.height;
  imageLayers.value = document.layers.map((layer) => ({ ...layer, pixels: [...layer.pixels] }));
  activeImageLayerId.value =
    document.layers.some((layer) => layer.id === currentLayerId)
      ? currentLayerId
      : document.layers[document.layers.length - 1]?.id || "";
  if (didResize) {
    imageSelection.value = null;
    broadcastImageSelection();
  }
  syncImageDimensionDrafts();
  resetImageHistory();
  scheduleImageCanvasRender();
  void nextTick(scheduleImagePreviewViewportUpdate);
};

const handleProjectEditorActivity = (activity: ProjectEditorActivity) => {
  if (activity.resource_id !== props.resourceId) return;
  if (!resource.value || !isImageEditor.value) {
    pendingProjectEditorActivities.push(activity);
    if (pendingProjectEditorActivities.length > 100) pendingProjectEditorActivities.shift();
    return;
  }
  const previousSequence = lastImageCollaborationSequence.get(activity.client_id) || 0;
  if (activity.sequence <= previousSequence) return;
  lastImageCollaborationSequence.set(activity.client_id, activity.sequence);

  if (activity.kind === "sync-request") {
    updateRemoteImageCollaborator(activity, {});
    if (canEditImage.value) {
      broadcastImageDocument(resource.value.revision, activity.client_id);
    }
    broadcastImageCursor(lastImageCollaborationCursorPosition);
    broadcastImageSelection();
    return;
  }

  const cursor = readCollaborativeCursor(activity);
  if (cursor) {
    updateRemoteImageCollaborator(activity, {
      height: cursor.height,
      tool: cursor.tool,
      visible: cursor.visible,
      width: cursor.width,
      x: cursor.x,
      y: cursor.y,
    });
    return;
  }

  const selection = readCollaborativeSelection(activity);
  if (selection !== undefined) {
    updateRemoteImageCollaborator(activity, { selection });
    return;
  }

  const patch = readCollaborativePixelPatch(activity);
  if (patch) {
    if (imagePixelRotationGesture.value) cancelImageInteraction();
    const nextLayers = applyCollaborativePixelPatch(
      imageLayers.value,
      patch,
      imageGridWidth.value,
      imageGridHeight.value,
    );
    if (nextLayers) {
      imageLayers.value = nextLayers;
      if (imageHistory.value) {
        imageHistory.value = imageHistory.value.mapSnapshots((snapshot) => {
          const rebasedLayers = applyCollaborativePixelPatch(
            snapshot.document.layers,
            patch,
            snapshot.document.width,
            snapshot.document.height,
          );
          return rebasedLayers
            ? {
                ...snapshot,
                document: { ...snapshot.document, layers: rebasedLayers },
              }
            : snapshot;
        });
      }
      lastRemoteImageMutationAt = Date.now();
      scheduleImageCanvasRender();
    }
    updateRemoteImageCollaborator(activity, {});
    return;
  }

  const document = readCollaborativeDocument(activity);
  if (!document) return;
  const targetClientId = activity.payload.target_client_id;
  if (
    typeof targetClientId === "string" &&
    targetClientId !== projectPresenceConnection?.clientId
  ) {
    return;
  }
  lastRemoteImageMutationAt = Date.now();
  if (imagePixelRotationGesture.value) cancelImageInteraction();
  applyRemoteImageDocument(document);
  updateRemoteImageCollaborator(activity, {});

  const persistedRevision = activity.payload.persisted_revision;
  if (
    resource.value &&
    typeof persistedRevision === "number" &&
    Number.isInteger(persistedRevision) &&
    persistedRevision > resource.value.revision
  ) {
    resource.value = {
      ...resource.value,
      data: serializePixelArtResourceData(resource.value.data || {}, document),
      revision: persistedRevision,
    };
  }
};

const createImageSnapshot = (): ImageEditorSnapshot => ({
  document: buildImageDocument(),
  activeLayerId: activeImageLayerId.value,
  selection: cloneImageSelection(imageSelection.value),
});

const imageSnapshotDocumentsAreEqual = (
  leftDocument: PixelArtDocumentV2,
  rightDocument: PixelArtDocumentV2,
) => {
  if (
    leftDocument.width !== rightDocument.width ||
    leftDocument.height !== rightDocument.height ||
    leftDocument.palette.length !== rightDocument.palette.length ||
    leftDocument.layers.length !== rightDocument.layers.length ||
    leftDocument.palette.some((color, index) => color !== rightDocument.palette[index])
  ) {
    return false;
  }
  return leftDocument.layers.every((layer, index) => {
    const other = rightDocument.layers[index];
    return (
      other !== undefined &&
      layer.id === other.id &&
      layer.name === other.name &&
      layer.visible === other.visible &&
      layer.locked === other.locked &&
      layer.opacity === other.opacity &&
      layer.pixels === other.pixels
    );
  });
};

const imageSnapshotsAreEqual = (left: ImageEditorSnapshot, right: ImageEditorSnapshot) =>
  imageSnapshotDocumentsAreEqual(left.document, right.document) &&
  imageSelectionMasksAreEqual(left.selection, right.selection);

const applyImageSnapshot = (snapshot: ImageEditorSnapshot) => {
  const document = snapshot.document;
  const currentActiveLayerId = activeImageLayerId.value;
  imageGridWidth.value = document.width;
  imageGridHeight.value = document.height;
  imageLayers.value = document.layers.map((layer) => ({
    ...layer,
    pixels: layer.pixels,
  }));
  activeImageLayerId.value = resolveImageActiveLayerAfterHistory(
    document.layers,
    currentActiveLayerId,
    snapshot.activeLayerId,
  );
  imageSelection.value = cloneImageSelection(snapshot.selection);
  syncImageDimensionDrafts();
  scheduleImageCanvasRender();
  void nextTick(scheduleImagePreviewViewportUpdate);
};

const resetImageHistory = () => {
  imageHistory.value = createHistory(createImageSnapshot(), {
    equals: imageSnapshotsAreEqual,
    limit: 100,
  });
};

const commitImageHistory = () => {
  if (!imageHistory.value) {
    resetImageHistory();
    broadcastImageDocument();
    broadcastImageSelection();
    return;
  }

  imageHistory.value = imageHistory.value.push(createImageSnapshot());
  broadcastImageDocument();
  broadcastImageSelection();
};

const commitImageSelectionHistory = () => {
  if (!imageHistory.value) {
    resetImageHistory();
  } else {
    imageHistory.value = imageHistory.value.push(createImageSnapshot());
  }
  broadcastImageSelection();
};

const undoImage = () => {
  if (!imageHistory.value?.canUndo || !canEditImage.value) return;
  const previousDocument = imageHistory.value.current.document;
  imageHistory.value = imageHistory.value.undo();
  const documentChanged = !imageSnapshotDocumentsAreEqual(
    previousDocument,
    imageHistory.value.current.document,
  );
  applyImageSnapshot(imageHistory.value.current);
  if (documentChanged) {
    scheduleImageAutosave();
    broadcastImageDocument();
  }
  broadcastImageSelection();
};

const redoImage = () => {
  if (!imageHistory.value?.canRedo || !canEditImage.value) return;
  const previousDocument = imageHistory.value.current.document;
  imageHistory.value = imageHistory.value.redo();
  const documentChanged = !imageSnapshotDocumentsAreEqual(
    previousDocument,
    imageHistory.value.current.document,
  );
  applyImageSnapshot(imageHistory.value.current);
  if (documentChanged) {
    scheduleImageAutosave();
    broadcastImageDocument();
  }
  broadcastImageSelection();
};

const saveImageDocument = async (_sequence: number) => {
  // Capture one immutable view only when the debounced request actually starts;
  // pointermove events merely advance a tiny sequence token.
  let document = buildImageDocument(false);

  await enqueueResourceMutation(async () => {
    const currentResource = resource.value;
    if (!currentResource || !canEditImage.value) {
      throw new Error("You no longer have permission to save this image.");
    }

    let nextData = serializePixelArtResourceData(
      currentResource.data || {},
      document,
    );

    let result = await patchProjectResource(props.projectId, props.resourceId, {
      data: nextData,
      base_revision: currentResource.revision,
    });

    if (
      !result.ok &&
      result.conflict &&
      Date.now() - lastRemoteImageMutationAt < 5000
    ) {
      const latestKnownResource = resource.value || currentResource;
      document = buildImageDocument(false);
      nextData = serializePixelArtResourceData(latestKnownResource.data || {}, document);
      result = await patchProjectResource(props.projectId, props.resourceId, {
        data: nextData,
        base_revision: Math.max(
          latestKnownResource.revision,
          result.conflict.current_revision,
        ),
      });
    }

    if (!result.ok) {
      if (result.conflict) {
        openImageConflict({ kind: "document" }, result.conflict.current_revision);
        throw new Error("A newer version exists. Choose which version to keep.");
      }
      if (result.status === 403) {
        markImageReadOnly();
      }
      throw new Error(
        result.status === 403
          ? "You no longer have permission to save this image."
          : `Save failed${result.status ? ` (${result.status})` : ""}. Your changes are still local.`,
      );
    }

    resource.value = {
      ...(resource.value || currentResource),
      ...result.resource,
      data: nextData,
    };
    broadcastImageDocument(result.resource.revision);
  });
};

const imageAutosave = useImageAutosave<number>(saveImageDocument, {
  debounceMs: IMAGE_AUTOSAVE_MS,
});
const imageSaveStatus = imageAutosave.status;
const imageSaveError = imageAutosave.errorMessage;
const imageLastSavedAt = imageAutosave.lastSavedAt;
const hasPendingImageNameChange = computed(() => {
  const nextName = resourceNameDraft.value.trim();
  return Boolean(
    isRenamingResource.value &&
      nextName &&
      nextName !== resource.value?.name,
  );
});
const displayedImageSaveStatus = computed(() =>
  isResourceNameSaving.value || isDocumentNameSubmitting.value
    ? "saving"
    : resourceNameSaveError.value
      ? "error"
      : hasPendingImageNameChange.value
        ? "dirty"
        : imageSaveStatus.value,
);
const displayedImageSaveError = computed(
  () => resourceNameSaveError.value || imageSaveError.value,
);
const normalizeResourceUpdatedAt = (value: string | null | undefined) => {
  const timestamp = value?.trim();
  if (!timestamp) return null;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp)) return timestamp;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(timestamp)
    ? `${timestamp}Z`
    : timestamp;
};
const effectiveImageLastSavedAt = computed(
  () => imageLastSavedAt.value ?? normalizeResourceUpdatedAt(resource.value?.updated_at),
);
const isImageSaveClean = computed(
  () =>
    displayedImageSaveStatus.value === "saved" &&
    !imageAutosave.hasPendingChanges.value &&
    !hasPendingImageNameChange.value,
);
const retryImageSave = () => {
  if (!canEditImage.value) return;
  if (
    resourceNameSaveError.value &&
    isRenamingResource.value &&
    resourceNameDraft.value.trim()
  ) {
    void commitResourceName();
    return;
  }
  void imageAutosave.retry();
};

const saveImageNow = async () => {
  if (
    !canEditImage.value ||
    displayedImageSaveStatus.value === "saving" ||
    isImageSaveClean.value
  ) return;

  if (isRenamingResource.value) {
    await commitResourceName();
  }

  await imageAutosave.flush();
};

const reloadImageAfterConflict = async () => {
  await waitForPersonalImagePaletteMutations();
  allowImageUnload = true;
  window.location.reload();
};

const fetchLatestImageResource = () =>
  fetchApi<ProjectResourceDetail>(
    `/projects/${encodeURIComponent(props.projectId)}/resources/${encodeURIComponent(
      props.resourceId,
    )}`,
  );

const keepLocalImageAfterConflict = async () => {
  const operation = imageConflictOperation.value;
  if (!operation || isImageConflictResolving.value) return;

  isImageConflictResolving.value = true;
  try {
    const latestResource = await fetchLatestImageResource();
    if (!latestResource) {
      throw new Error("The latest remote version could not be loaded.");
    }

    const latestImageData =
      operation.kind === "rename"
        ? readImagePixelsFromData(latestResource.data || {})
        : null;

    // Keep all remote resource fields, then reapply only the local operation.
    resource.value = latestResource;
    imageConflictRemoteRevision.value = null;
    imageConflictOperation.value = null;
    isImageConflictOpen.value = false;

    if (operation.kind === "rename") {
      const remoteDocument = latestImageData?.document;
      if (!remoteDocument) {
        throw new Error("The latest remote image could not be loaded.");
      }

      const previousActiveLayerId = activeImageLayerId.value;
      imageGridWidth.value = remoteDocument.width;
      imageGridHeight.value = remoteDocument.height;
      imageLayers.value = remoteDocument.layers;
      activeImageLayerId.value = remoteDocument.layers.some(
        (layer) => layer.id === previousActiveLayerId,
      )
        ? previousActiveLayerId
        : remoteDocument.layers[remoteDocument.layers.length - 1]?.id || "";
      imageSelection.value = null;
      syncImageDimensionDrafts();
      resetImageHistory();
      scheduleImageCanvasRender();
      void nextTick(scheduleImagePreviewViewportUpdate);

      await persistResourceName(operation.name);
      resourceNameDraft.value = operation.name;
      resourceNameSaveError.value = "";
      isRenamingResource.value = false;
      showImageNotice("Local image name kept on top of the remote version.", "success");
      return;
    }

    imageAutosave.schedule(++imageAutosaveSequence);
    await imageAutosave.retry();
    if (!imageAutosave.hasPendingChanges.value) {
      showImageNotice("Local image changes kept on top of the remote version.", "success");
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The conflict could not be resolved.";
    if (operation.kind === "rename") {
      resourceNameSaveError.value = message;
    }
    showImageNotice(message, "error");
  } finally {
    isImageConflictResolving.value = false;
  }
};

const scheduleImageAutosave = () => {
  if (!canEditImage.value) {
    return;
  }

  imageAutosave.schedule(++imageAutosaveSequence);
};

const updateImagePixels = (nextPixels: ImagePixelSnapshot) => {
  if (!canMutateActiveImageLayerPixels.value) {
    return false;
  }

  const normalizedPixels = emptyImagePixels().map((_, index) => nextPixels[index] || null);

  if (imagePixelsAreEqual(imagePixels.value, normalizedPixels)) {
    return false;
  }

  imagePixels.value = normalizedPixels;
  scheduleImageCanvasRender();
  scheduleImageAutosave();
  return true;
};

const imagePixelPosition = (index: number) => ({
  column: index % imageGridWidth.value,
  row: Math.floor(index / imageGridWidth.value),
});

const imagePixelIndexFor = (row: number, column: number) => row * imageGridWidth.value + column;

const imageLineBetweenPixels = (fromIndex: number, toIndex: number) => {
  const from = imagePixelPosition(fromIndex);
  const to = imagePixelPosition(toIndex);
  const pixels: number[] = [];

  let column = from.column;
  let row = from.row;
  const columnStep = column < to.column ? 1 : -1;
  const rowStep = row < to.row ? 1 : -1;
  const columnDelta = Math.abs(to.column - column);
  const rowDelta = -Math.abs(to.row - row);
  let error = columnDelta + rowDelta;

  while (true) {
    pixels.push(imagePixelIndexFor(row, column));

    if (column === to.column && row === to.row) {
      break;
    }

    const doubledError = error * 2;

    if (doubledError >= rowDelta) {
      error += rowDelta;
      column += columnStep;
    }

    if (doubledError <= columnDelta) {
      error += columnDelta;
      row += rowStep;
    }
  }

  return pixels;
};

const getImageArtboardClientSpace = () => {
  const artboard = imageArtboardRef.value;
  if (!artboard) return null;

  const rect = artboard.getBoundingClientRect();
  const scale = getImageLiveGestureScale();
  const center = {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
  const width = imageArtboardWidth.value * scale;
  const height = imageArtboardHeight.value * scale;
  const clientWidth = imageGridOverlayPlan.value.cssWidth * scale;
  const clientHeight = imageGridOverlayPlan.value.cssHeight * scale;
  const borderLeft = Math.max(0, (width - clientWidth) / 2);
  const borderTop = Math.max(0, (height - clientHeight) / 2);

  return {
    center,
    clientHeight,
    clientWidth,
    borderLeft,
    borderTop,
    rectLeft: center.x - width / 2,
    rectTop: center.y - height / 2,
    rotationRadians: getImageViewportTransform().rotationRadians,
    scale,
  };
};

const mapImageClientPointToUnrotatedArtboard = (
  point: Readonly<{ x: number; y: number }>,
  clientSpace: NonNullable<ReturnType<typeof getImageArtboardClientSpace>>,
) =>
  rotateImageClientPoint({
    center: clientSpace.center,
    point,
    rotationRadians: -clientSpace.rotationRadians,
  });

const getImageVirtualCanvasPositionFromClientCoordinates = (
  clientX: number,
  clientY: number,
) => {
  const clientSpace = getImageArtboardClientSpace();
  if (!clientSpace) return null;

  const point = mapImageClientPointToUnrotatedArtboard({ x: clientX, y: clientY }, clientSpace);
  const contentLeft = clientSpace.rectLeft + clientSpace.borderLeft;
  const contentTop = clientSpace.rectTop + clientSpace.borderTop;
  const cellSize = imageArtboardMetrics.value.cellSize * clientSpace.scale;
  if (cellSize <= 0) return null;

  return {
    x: (point.x - contentLeft) / cellSize,
    y: (point.y - contentTop) / cellSize,
  };
};

const getImageVirtualPixelPointFromClientCoordinates = (clientX: number, clientY: number) => {
  const position = getImageVirtualCanvasPositionFromClientCoordinates(clientX, clientY);
  if (!position) return null;

  return {
    x: Math.floor(position.x),
    y: Math.floor(position.y),
  };
};

const getImagePixelIndexFromClientCoordinates = (clientX: number, clientY: number) => {
  const clientSpace = getImageArtboardClientSpace();
  if (!clientSpace) return null;

  if (isImageWrapAroundEnabled.value) {
    const virtualPoint = getImageVirtualPixelPointFromClientCoordinates(clientX, clientY);
    if (!virtualPoint) return null;
    const point = wrapCanvasPoint(virtualPoint, imageCanvasBounds.value);
    return imagePixelIndexFor(point.y, point.x);
  }

  const point = mapImageClientPointToUnrotatedArtboard({ x: clientX, y: clientY }, clientSpace);
  return getImagePixelIndexFromClientPoint({
    borderLeft: clientSpace.borderLeft,
    borderTop: clientSpace.borderTop,
    cellSize: imageArtboardMetrics.value.cellSize * clientSpace.scale,
    clientHeight: clientSpace.clientHeight,
    clientWidth: clientSpace.clientWidth,
    clientX: point.x,
    clientY: point.y,
    gridHeight: imageGridHeight.value,
    gridWidth: imageGridWidth.value,
    rectLeft: clientSpace.rectLeft,
    rectTop: clientSpace.rectTop,
  });
};

const getImagePixelIndexFromPointer = (event: PointerEvent) =>
  getImagePixelIndexFromClientCoordinates(event.clientX, event.clientY);

const updateHoveredImagePixelFromPointer = (event: PointerEvent) => {
  const pixelIndex = getImagePixelIndexFromPointer(event);
  const canvasPosition = getImageVirtualCanvasPositionFromClientCoordinates(
    event.clientX,
    event.clientY,
  );
  const virtualPoint =
    pixelIndex !== null
      ? getImageVirtualPixelPointFromClientCoordinates(event.clientX, event.clientY)
      : null;
  if (hoveredImagePixelIndex.value !== pixelIndex) {
    hoveredImagePixelIndex.value = pixelIndex;
  }
  hoveredImageVirtualPoint.value = virtualPoint;
  broadcastImageCursor(canvasPosition);
  return pixelIndex;
};

const focusAndCaptureImagePointer = (event: PointerEvent) => {
  const interactionTarget = event.currentTarget as HTMLElement;
  imageStageRef.value?.focus({ preventScroll: true });
  if (event.type !== "pointerup" && event.type !== "pointercancel") {
    interactionTarget.setPointerCapture?.(event.pointerId);
  }
};

const clampImageZoom = (zoom: number) => Math.min(MAX_IMAGE_ZOOM, Math.max(MIN_IMAGE_ZOOM, zoom));
const clampPercentage = (value: number) => Math.min(100, Math.max(0, value));

const getImageStageCenter = () => {
  const stageRect = imageStageRef.value?.getBoundingClientRect();
  if (!stageRect || stageRect.width <= 0 || stageRect.height <= 0) return null;

  return {
    x: stageRect.left + stageRect.width / 2,
    y: stageRect.top + stageRect.height * imageArtboardCenterYRatio.value,
  };
};

const setImageZoom = (zoom: number, mode: ImageZoomMode = "custom") => {
  const nextZoom = clampImageZoom(zoom);
  imageZoomMode.value = mode;
  if (Math.abs(nextZoom - imageZoom.value) < 0.0001) return;
  imageZoom.value = nextZoom;
  scheduleImageCanvasRender();
  scheduleImagePreviewViewportUpdate();
};

const fitImageToScreen = () => {
  if (imageTouchNavigationActive) return;

  const stage = imageStageRef.value;
  const stageWidth = stage?.clientWidth || imageStageWidth.value || imageViewportWidth.value || 1024;
  const stageHeight = stage?.clientHeight || imageStageHeight.value || imageViewportHeight.value || 768;
  imageStageWidth.value = stageWidth;
  imageStageHeight.value = stageHeight;

  const usableWidth = Math.max(160, stageWidth - 64);
  const usableHeight = Math.max(180, stageHeight - 96);
  const fittedCellSize = Math.min(
    (usableWidth - 2) / Math.max(1, imageGridWidth.value),
    (usableHeight - 2) / Math.max(1, imageGridHeight.value),
  );
  imageGestureView = null;
  imagePanX.value = 0;
  imagePanY.value = 0;
  imageRotationRadians.value = 0;
  void nextTick(writeCommittedImageTransform);
  setImageZoom(fittedCellSize, "fit");
};

const showImageAtActualSize = () => {
  imageGestureView = null;
  imagePanX.value = 0;
  imagePanY.value = 0;
  imageRotationRadians.value = 0;
  void nextTick(writeCommittedImageTransform);
  setImageZoom(1, "actual");
};

const zoomImageIn = () => setImageZoom(imageZoom.value * 1.25, "custom");
const zoomImageOut = () => setImageZoom(imageZoom.value / 1.25, "custom");

const setImageViewRotation = (rotationRadians: number) => {
  if (!Number.isFinite(rotationRadians) || imageTouchNavigationActive) return;

  const nextRotation = normalizeImageRotationRadians(rotationRadians);
  if (Math.abs(nextRotation - imageRotationRadians.value) < 1e-9) return;

  cancelScheduledImageFitToScreen();
  imageZoomMode.value = "custom";
  imageRotationRadians.value = nextRotation;
  writeCommittedImageTransform();
  scheduleImagePreviewViewportUpdate();
};

const rotateImageViewLeft = () =>
  setImageViewRotation(imageRotationRadians.value - IMAGE_ROTATION_STEP_RADIANS);
const rotateImageViewRight = () =>
  setImageViewRotation(imageRotationRadians.value + IMAGE_ROTATION_STEP_RADIANS);
const resetImageViewRotation = () => setImageViewRotation(0);

let imagePreviewViewportFrame: number | null = null;

const updateImagePreviewViewport = () => {
  const stage = imageStageRef.value;
  const artboard = imageArtboardRef.value;

  if (!stage || !artboard || !isImageEditor.value) {
    imagePreviewViewport.value = { ...imagePreviewViewport.value, visible: false };
    imageFloatingPreview.value = { ...imageFloatingPreview.value, visible: false };
    return;
  }

  const stageRect = stage.getBoundingClientRect();
  const artboardRect = artboard.getBoundingClientRect();
  const clientSpace = getImageArtboardClientSpace();
  imageFloatingPreview.value = {
    size: calculateImagePreviewSize({
      documentHeight: imageGridHeight.value,
      documentWidth: imageGridWidth.value,
      stageHeight: stageRect.height,
      stageWidth: stageRect.width,
    }),
    visible: true,
  };
  if (
    !clientSpace ||
    artboardRect.width <= 0 ||
    artboardRect.height <= 0 ||
    Math.min(stageRect.right, artboardRect.right) <= Math.max(stageRect.left, artboardRect.left) ||
    Math.min(stageRect.bottom, artboardRect.bottom) <= Math.max(stageRect.top, artboardRect.top)
  ) {
    imagePreviewViewport.value = { ...imagePreviewViewport.value, visible: false };
    return;
  }

  const stageCorners = [
    { x: stageRect.left, y: stageRect.top },
    { x: stageRect.right, y: stageRect.top },
    { x: stageRect.right, y: stageRect.bottom },
    { x: stageRect.left, y: stageRect.bottom },
  ].map((point) => mapImageClientPointToUnrotatedArtboard(point, clientSpace));
  const contentLeft = clientSpace.rectLeft + clientSpace.borderLeft;
  const contentTop = clientSpace.rectTop + clientSpace.borderTop;
  const contentRight = contentLeft + clientSpace.clientWidth;
  const contentBottom = contentTop + clientSpace.clientHeight;
  const visiblePolygon = clipImagePreviewPolygonToBounds(stageCorners, {
    bottom: contentBottom,
    left: contentLeft,
    right: contentRight,
    top: contentTop,
  });

  if (visiblePolygon.length === 0) {
    imagePreviewViewport.value = { ...imagePreviewViewport.value, visible: false };
    return;
  }

  const visibleLeft = Math.min(...visiblePolygon.map((point) => point.x));
  const visibleTop = Math.min(...visiblePolygon.map((point) => point.y));
  const visibleRight = Math.max(...visiblePolygon.map((point) => point.x));
  const visibleBottom = Math.max(...visiblePolygon.map((point) => point.y));

  if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) {
    imagePreviewViewport.value = { ...imagePreviewViewport.value, visible: false };
    return;
  }

  const left = clampPercentage(
    ((visibleLeft - contentLeft) / clientSpace.clientWidth) * 100,
  );
  const top = clampPercentage(
    ((visibleTop - contentTop) / clientSpace.clientHeight) * 100,
  );
  const width = clampPercentage(
    ((visibleRight - visibleLeft) / clientSpace.clientWidth) * 100,
  );
  const height = clampPercentage(
    ((visibleBottom - visibleTop) / clientSpace.clientHeight) * 100,
  );
  const coversFullImage = left <= 0.2 && top <= 0.2 && width >= 99.6 && height >= 99.6;

  imagePreviewViewport.value = {
    height,
    left,
    top,
    visible: !coversFullImage,
    width,
  };
};

const scheduleImagePreviewViewportUpdate = () => {
  if (imagePreviewViewportFrame !== null) {
    window.cancelAnimationFrame(imagePreviewViewportFrame);
  }

  imagePreviewViewportFrame = window.requestAnimationFrame(() => {
    imagePreviewViewportFrame = null;
    updateImagePreviewViewport();
  });
};

let imageFitFrame: number | null = null;
let imageStageResizeObserver: ResizeObserver | null = null;

const cancelScheduledImageFitToScreen = () => {
  if (imageFitFrame === null || typeof window === "undefined") return;
  window.cancelAnimationFrame(imageFitFrame);
  imageFitFrame = null;
};

const scheduleImageFitToScreen = () => {
  if (typeof window === "undefined") return;
  cancelScheduledImageFitToScreen();
  imageFitFrame = window.requestAnimationFrame(() => {
    imageFitFrame = null;
    if (imageZoomMode.value === "fit" && !imageTouchNavigationActive) fitImageToScreen();
  });
};

const syncImageStageSize = () => {
  const stage = imageStageRef.value;
  const nextWidth = stage?.clientWidth || 0;
  const nextHeight = stage?.clientHeight || 0;
  const didResize = nextWidth !== imageStageWidth.value || nextHeight !== imageStageHeight.value;
  imageStageWidth.value = nextWidth;
  imageStageHeight.value = nextHeight;

  if (didResize && imageZoomMode.value === "fit") {
    scheduleImageFitToScreen();
  }
  if (didResize && imageTransformGesture) {
    updateImageTransformGesture(imageTransformGesture.lastFrame);
  }
  scheduleImagePreviewViewportUpdate();
};

const observeImageStage = () => {
  imageStageResizeObserver?.disconnect();
  imageStageResizeObserver = null;
  bindImageTouchViewportGesture();

  const stage = imageStageRef.value;
  if (!stage) return;

  if (typeof ResizeObserver !== "undefined") {
    imageStageResizeObserver = new ResizeObserver(syncImageStageSize);
    imageStageResizeObserver.observe(stage);
  }
  syncImageStageSize();
};

const updateImageViewportSize = () => {
  if (typeof window === "undefined") {
    return;
  }

  imageViewportWidth.value = window.innerWidth;
  imageViewportHeight.value = window.innerHeight;
  syncImageStageSize();
};

const zoomImageFromWheel = (event: WheelEvent) => {
  if (!isImageEditor.value || imageTouchNavigationActive) {
    return;
  }

  const zoomDelta = -event.deltaY * IMAGE_ZOOM_WHEEL_STEP;
  const nextZoom = clampImageZoom(imageZoom.value * (1 + zoomDelta));
  if (nextZoom === imageZoom.value) {
    return;
  }

  const stageCenter = getImageStageCenter();
  if (stageCenter) {
    const anchor = { x: event.clientX, y: event.clientY };
    const nextView = applyImageTwoFingerTransformDelta({
      currentStageCenter: stageCenter,
      delta: {
        currentCentroid: anchor,
        previousCentroid: anchor,
        rotationRadians: 0,
        zoomFactor: nextZoom / imageZoom.value,
      },
      maximumZoom: MAX_IMAGE_ZOOM,
      minimumZoom: MIN_IMAGE_ZOOM,
      previousStageCenter: stageCenter,
      view: {
        panX: imagePanX.value,
        panY: imagePanY.value,
        rotationRadians: imageRotationRadians.value,
        zoom: imageZoom.value,
      },
    });
    imagePanX.value = nextView.panX;
    imagePanY.value = nextView.panY;
    writeCommittedImageTransform();
  }

  imageZoomMode.value = "custom";
  imageZoom.value = nextZoom;
  scheduleImageCanvasRender();
  scheduleImagePreviewViewportUpdate();
};

const getImagePointerEventIntent = (event: PointerEvent) =>
  getImagePointerIntent({
    button: event.button,
    buttons: event.buttons,
    shiftPressed: event.shiftKey,
    spacePressed: isImageSpacePressed.value,
    startsOnArtboard: event.currentTarget === imageArtboardRef.value,
  });

const isImagePanButton = (event: PointerEvent) => getImagePointerEventIntent(event) === "pan";

const captureImagePointerInteractionIntent = (event: PointerEvent) => {
  imageInteractionTool = activeImageTool.value;
  imagePointerColorChannel =
    getImagePointerColorChannel({ button: event.button, buttons: event.buttons }) || "primary";
  imageInteractionPrimaryColor = selectedImageColor.value;
  imageInteractionSecondaryColor = secondaryImageColor.value;
  imageViewportPaintButtonMask = imagePointerColorChannel === "secondary" ? 2 : 1;
  const colorIntent = getImageToolColorIntent({
    tool: imageInteractionTool,
    channel: imagePointerColorChannel,
    primaryColor: selectedImageColor.value,
    secondaryColor: secondaryImageColor.value,
  });
  if (colorIntent.kind === "checker") {
    imageInteractionPrimaryColor = colorIntent.primaryColor;
    imageInteractionSecondaryColor = colorIntent.secondaryColor;
    imageInteractionGraffitiInverted = colorIntent.inverted;
  } else {
    imageInteractionGraffitiInverted = false;
  }
  imageGraffitiPreviewGesture.value =
    colorIntent.kind === "checker"
      ? {
          inverted: colorIntent.inverted,
          primaryColor: colorIntent.primaryColor,
          secondaryColor: colorIntent.secondaryColor,
        }
      : null;
  imageInteractionColor =
    colorIntent.kind === "paint"
      ? colorIntent.color
      : colorIntent.kind === "checker" && colorIntent.inverted
        ? colorIntent.secondaryColor
        : selectedImageColor.value;
};

const imageRotationPointerAngle = (
  center: Readonly<{ x: number; y: number }>,
  clientX: number,
  clientY: number,
) => Math.atan2(clientY - center.y, clientX - center.x);

const finishRotatingImageFromPointer = (event?: PointerEvent) => {
  const gesture = imageDesktopRotationGesture;
  if (!gesture || (event && event.pointerId !== gesture.pointerId)) return false;

  imageDesktopRotationGesture = null;
  isRotatingImage.value = false;
  if (gesture.captureTarget.hasPointerCapture?.(gesture.pointerId)) {
    gesture.captureTarget.releasePointerCapture?.(gesture.pointerId);
  }
  imageRotationRadians.value = normalizeImageRotationRadians(imageRotationRadians.value);
  writeCommittedImageTransform();
  scheduleImagePreviewViewportUpdate();
  return true;
};

const continueRotatingImageFromPointer = (event: PointerEvent) => {
  const gesture = imageDesktopRotationGesture;
  if (!gesture || event.pointerId !== gesture.pointerId) return false;

  if (
    event.type === "pointermove" &&
    (event.buttons & gesture.buttonMask) !== gesture.buttonMask
  ) {
    finishRotatingImageFromPointer(event);
    return true;
  }

  const distanceFromCenter = Math.hypot(
    event.clientX - gesture.center.x,
    event.clientY - gesture.center.y,
  );
  if (distanceFromCenter < IMAGE_ROTATION_MIN_POINTER_RADIUS) {
    gesture.hasPointerAngle = false;
    return true;
  }

  const pointerAngle = imageRotationPointerAngle(gesture.center, event.clientX, event.clientY);
  if (!gesture.hasPointerAngle) {
    gesture.hasPointerAngle = true;
    gesture.previousPointerAngleRadians = pointerAngle;
    return true;
  }

  const rotationDelta = normalizeImageRotationRadians(
    pointerAngle - gesture.previousPointerAngleRadians,
  );
  gesture.previousPointerAngleRadians = pointerAngle;
  if (Math.abs(rotationDelta) < 1e-9) return true;

  cancelScheduledImageFitToScreen();
  imageZoomMode.value = "custom";
  imageRotationRadians.value = normalizeImageRotationRadians(
    imageRotationRadians.value + rotationDelta,
  );
  writeCommittedImageTransform();
  scheduleImagePreviewViewportUpdate();
  return true;
};

const startRotatingImageFromPointer = (event: PointerEvent) => {
  if (
    imageDesktopRotationGesture ||
    imagePanPointerId !== null ||
    imageViewportPaintPointerId !== null ||
    imageTouchNavigationActive ||
    imageTouchPointers.size > 0
  ) {
    return;
  }

  const center = getImageArtboardClientSpace()?.center ?? getImageStageCenter();
  if (!center) return;

  const distanceFromCenter = Math.hypot(event.clientX - center.x, event.clientY - center.y);
  imageDesktopRotationGesture = {
    buttonMask: event.button === 1 || (event.buttons & 4) !== 0 ? 4 : 1,
    captureTarget: event.currentTarget as HTMLElement,
    center,
    hasPointerAngle: distanceFromCenter >= IMAGE_ROTATION_MIN_POINTER_RADIUS,
    pointerId: event.pointerId,
    previousPointerAngleRadians: imageRotationPointerAngle(
      center,
      event.clientX,
      event.clientY,
    ),
  };
  isRotatingImage.value = true;
  hoveredImagePixelIndex.value = null;
  hoveredImageVirtualPoint.value = null;
  broadcastImageCursor(null);
  focusAndCaptureImagePointer(event);
};

const startPanningImageFromPointer = (event: PointerEvent) => {
  if (
    imageDesktopRotationGesture !== null ||
    imagePanPointerId !== null ||
    imageViewportPaintPointerId !== null
  ) {
    return;
  }

  imagePanPointerId = event.pointerId;
  imagePanPointerClientX = event.clientX;
  imagePanPointerClientY = event.clientY;
  isPanningImage.value = true;
  hoveredImagePixelIndex.value = null;
  hoveredImageVirtualPoint.value = null;
  focusAndCaptureImagePointer(event);
};

const startImageViewportInteractionFromPointer = (
  event: PointerEvent,
  startPoint?: Readonly<{ x: number; y: number }>,
) => {
  const intent = getImagePointerEventIntent(event);
  if (intent === "rotate") {
    startRotatingImageFromPointer(event);
    return;
  }
  if (intent === "pan") {
    startPanningImageFromPointer(event);
    return;
  }

  if (
    intent !== "paint" ||
    imageDesktopRotationGesture !== null ||
    imagePanPointerId !== null ||
    imageViewportPaintPointerId !== null
  ) {
    return;
  }

  if (
    isImagePixelMutationTool(activeImageTool.value) &&
    !canMutateActiveImageLayerPixels.value
  ) {
    return;
  }

  imageViewportPaintPointerId = event.pointerId;
  captureImagePointerInteractionIntent(event);
  const clientX = startPoint?.x ?? event.clientX;
  const clientY = startPoint?.y ?? event.clientY;
  imageViewportPaintClientX = clientX;
  imageViewportPaintClientY = clientY;
  hoveredImagePixelIndex.value = null;
  hoveredImageVirtualPoint.value = null;

  if (imageInteractionTool === "rotate") {
    startImagePixelRotation(event, { x: clientX, y: clientY });
    return;
  }

  if (isImageWrapAroundEnabled.value) {
    const initialPixelIndex = getImagePixelIndexFromClientCoordinates(clientX, clientY);
    const initialVirtualPoint = getImageVirtualPixelPointFromClientCoordinates(clientX, clientY);
    isImageViewportPaintAwaitingArtboard = initialPixelIndex === null;
    if (initialPixelIndex !== null) {
      startPaintingImageFromPointer(event, false, initialPixelIndex, initialVirtualPoint ?? undefined);
      return;
    }
  } else {
    isImageViewportPaintAwaitingArtboard = true;
  }
  focusAndCaptureImagePointer(event);
};

const startImageArtboardInteractionFromPointer = (
  event: PointerEvent,
  startPoint?: Readonly<{ x: number; y: number }>,
) => {
  const intent = getImagePointerEventIntent(event);
  if (intent === "rotate") {
    startRotatingImageFromPointer(event);
    return;
  }
  if (intent === "pan") {
    startPanningImageFromPointer(event);
    return;
  }

  if (
    intent !== "paint" ||
    imageDesktopRotationGesture !== null ||
    imagePanPointerId !== null ||
    imageViewportPaintPointerId !== null
  ) {
    return;
  }

  if (
    isImagePixelMutationTool(activeImageTool.value) &&
    !canMutateActiveImageLayerPixels.value
  ) {
    return;
  }

  imageViewportPaintPointerId = event.pointerId;
  captureImagePointerInteractionIntent(event);
  const clientX = startPoint?.x ?? event.clientX;
  const clientY = startPoint?.y ?? event.clientY;
  imageViewportPaintClientX = clientX;
  imageViewportPaintClientY = clientY;
  if (imageInteractionTool === "rotate") {
    startImagePixelRotation(event, { x: clientX, y: clientY });
    return;
  }
  const initialPixelIndex = getImagePixelIndexFromClientCoordinates(clientX, clientY);
  const initialVirtualPoint = getImageVirtualPixelPointFromClientCoordinates(clientX, clientY);
  isImageViewportPaintAwaitingArtboard = initialPixelIndex === null;
  if (initialPixelIndex === null) {
    hoveredImagePixelIndex.value = null;
    hoveredImageVirtualPoint.value = null;
    focusAndCaptureImagePointer(event);
    return;
  }
  startPaintingImageFromPointer(event, false, initialPixelIndex, initialVirtualPoint ?? undefined);
};

const continuePanningImageFromPointer = (event: PointerEvent) => {
  if (!isPanningImage.value || imagePanPointerId !== event.pointerId) {
    return;
  }

  const deltaX = event.clientX - imagePanPointerClientX;
  const deltaY = event.clientY - imagePanPointerClientY;
  imagePanPointerClientX = event.clientX;
  imagePanPointerClientY = event.clientY;

  if (deltaX === 0 && deltaY === 0) {
    return;
  }

  imageZoomMode.value = "custom";
  imagePanX.value += deltaX;
  imagePanY.value += deltaY;
  writeCommittedImageTransform();
  scheduleImagePreviewViewportUpdate();
};

const processImagePointerSegment = (
  event: PointerEvent,
  to: Readonly<{ x: number; y: number }>,
) => {
  const clientSpace = getImageArtboardClientSpace();
  if (!clientSpace) return;

  const from = { x: imageViewportPaintClientX, y: imageViewportPaintClientY };
  imageViewportPaintClientX = to.x;
  imageViewportPaintClientY = to.y;
  if (imageInteractionKind.value === "rotate") {
    continueImagePixelRotation(event, to);
    return;
  }
  const unrotatedFrom = mapImageClientPointToUnrotatedArtboard(from, clientSpace);
  const unrotatedTo = mapImageClientPointToUnrotatedArtboard(to, clientSpace);

  if (isImageWrapAroundEnabled.value) {
    const virtualFrom = getImageVirtualPixelPointFromClientCoordinates(from.x, from.y);
    const virtualTo = getImageVirtualPixelPointFromClientCoordinates(to.x, to.y);
    if (!virtualFrom || !virtualTo) return;

    const virtualStroke = linePoints(virtualFrom, virtualTo);
    const wrappedStroke = virtualStroke.map((point) => {
      const wrappedPoint = wrapCanvasPoint(point, imageCanvasBounds.value);
      return imagePixelIndexFor(wrappedPoint.y, wrappedPoint.x);
    });
    const firstIndex = wrappedStroke[0];
    const lastIndex = wrappedStroke[wrappedStroke.length - 1];
    if (firstIndex === undefined || lastIndex === undefined) return;

    if (isImageViewportPaintAwaitingArtboard) {
      isImageViewportPaintAwaitingArtboard = false;
      startPaintingImageFromPointer(event, false, firstIndex, virtualStroke[0]);
      if (virtualStroke.length > 1) {
        continuePaintingImageFromPointer(event, lastIndex, wrappedStroke.slice(1), virtualTo);
      }
      return;
    }

    continuePaintingImageFromPointer(event, lastIndex, wrappedStroke, virtualTo);
    return;
  }

  const lassoVirtualTo = getImageVirtualPixelPointFromClientCoordinates(to.x, to.y);
  if (
    imageInteractionKind.value === "select" &&
    imageSelectionGestureKind === "lasso" &&
    !isImageViewportPaintAwaitingArtboard &&
    lassoVirtualTo
  ) {
    const fallbackPoint = clampImageSelectionPoint(lassoVirtualTo);
    continuePaintingImageFromPointer(
      event,
      imagePixelIndexFor(fallbackPoint.y, fallbackPoint.x),
      undefined,
      lassoVirtualTo,
    );
    return;
  }

  const contentLeft = clientSpace.rectLeft + clientSpace.borderLeft;
  const contentTop = clientSpace.rectTop + clientSpace.borderTop;
  const pixelSegment = getImagePixelSegmentFromClientSegment({
    borderLeft: clientSpace.borderLeft,
    borderTop: clientSpace.borderTop,
    bounds: {
      bottom: contentTop + clientSpace.clientHeight,
      left: contentLeft,
      right: contentLeft + clientSpace.clientWidth,
      top: contentTop,
    },
    cellSize: imageArtboardMetrics.value.cellSize * clientSpace.scale,
    clientHeight: clientSpace.clientHeight,
    clientWidth: clientSpace.clientWidth,
    from: unrotatedFrom,
    gridHeight: imageGridHeight.value,
    gridWidth: imageGridWidth.value,
    rectLeft: clientSpace.rectLeft,
    rectTop: clientSpace.rectTop,
    to: unrotatedTo,
  });

  if (!pixelSegment) {
    if (!isImageViewportPaintAwaitingArtboard && imageInteractionKind.value === "paint") {
      lastPaintedImagePixelIndex = null;
    }
    return;
  }

  const { startIndex: segmentStartIndex, endIndex: segmentEndIndex } = pixelSegment;

  if (isImageViewportPaintAwaitingArtboard) {
    isImageViewportPaintAwaitingArtboard = false;
    startPaintingImageFromPointer(event, false, segmentStartIndex);
    if (segmentEndIndex !== segmentStartIndex) {
      continuePaintingImageFromPointer(
        event,
        segmentEndIndex,
        undefined,
        activeImageTool.value === "select" && imageSelectionKind.value === "lasso"
          ? lassoVirtualTo ?? undefined
          : undefined,
      );
    }
    return;
  }

  if (
    imageInteractionKind.value === "paint" &&
    getImagePixelIndexFromClientCoordinates(from.x, from.y) === null
  ) {
    lastPaintedImagePixelIndex = segmentStartIndex;
  }
  continuePaintingImageFromPointer(event, segmentEndIndex);
};

const getImagePointerSamplePoints = (event: PointerEvent) => {
  const coalescedEvents =
    typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
  const points = coalescedEvents.map((sample) => ({ x: sample.clientX, y: sample.clientY }));
  const lastPoint = points[points.length - 1];
  if (!lastPoint || lastPoint.x !== event.clientX || lastPoint.y !== event.clientY) {
    points.push({ x: event.clientX, y: event.clientY });
  }
  return points;
};

const continueImageViewportInteractionFromPointer = (event: PointerEvent) => {
  if (continueRotatingImageFromPointer(event)) {
    return;
  }

  if (isPanningImage.value) {
    continuePanningImageFromPointer(event);
    return;
  }

  if (imageViewportPaintPointerId !== event.pointerId) {
    if (imageViewportPaintPointerId === null) {
      updateHoveredImagePixelFromPointer(event);
    }
    return;
  }

  if (
    event.type === "pointermove" &&
    (event.buttons & imageViewportPaintButtonMask) !== imageViewportPaintButtonMask
  ) {
    stopPaintingImage(event);
    return;
  }

  for (const point of getImagePointerSamplePoints(event)) {
    processImagePointerSegment(event, point);
  }
  updateHoveredImagePixelFromPointer(event);
};

const finishImagePointerInteractionFromPointer = (event: PointerEvent) => {
  if (imageDesktopRotationGesture?.pointerId === event.pointerId) {
    continueRotatingImageFromPointer(event);
    finishRotatingImageFromPointer(event);
    return;
  }

  if (imagePanPointerId === event.pointerId) {
    continuePanningImageFromPointer(event);
    stopPaintingImage(event);
    return;
  }

  if (imageViewportPaintPointerId !== event.pointerId) {
    return;
  }

  for (const point of getImagePointerSamplePoints(event)) {
    processImagePointerSegment(event, point);
  }
  updateHoveredImagePixelFromPointer(event);
  stopPaintingImage(event);
};

const writeImageGestureTransform = (view: ImageViewportTransform) => {
  const artboard = imageArtboardRef.value;
  if (!artboard) return;

  const liveScale = imageZoom.value > 0 ? view.zoom / imageZoom.value : 1;
  artboard.style.setProperty("--image-pan-x", `${view.panX}px`);
  artboard.style.setProperty("--image-pan-y", `${view.panY}px`);
  artboard.style.setProperty("--image-rotation", `${view.rotationRadians}rad`);
  artboard.style.setProperty("--image-live-scale", `${liveScale}`);
  imageViewportTransformRevision.value += 1;
};

const writeCommittedImageTransform = () => {
  const artboard = imageArtboardRef.value;
  if (!artboard) return;

  artboard.style.setProperty("--image-pan-x", `${imagePanX.value}px`);
  artboard.style.setProperty("--image-pan-y", `${imagePanY.value}px`);
  artboard.style.setProperty("--image-rotation", `${imageRotationRadians.value}rad`);
  artboard.style.setProperty("--image-live-scale", "1");
};

const commitImageGestureView = () => {
  const view = imageGestureView;
  if (!view) return;

  imagePanX.value = view.panX;
  imagePanY.value = view.panY;
  imageRotationRadians.value = normalizeImageRotationRadians(view.rotationRadians);
  imageZoom.value = view.zoom;
  imageZoomMode.value = "custom";
  imageGestureView = null;
  void nextTick(writeCommittedImageTransform);
  scheduleImageCanvasRender();
  scheduleImagePreviewViewportUpdate();
};

const resetImageTouchPointers = () => {
  commitImageGestureView();
  imageTouchPointers.clear();
  imagePendingTouchPointerId = null;
  imageTransformGesture = null;
  imageTouchNavigationActive = false;
  imageSingleTouchStartSnapshot = null;
  imageSingleTouchStartHistory = null;
  imageSingleTouchStartTool = null;
  imageSingleTouchStartPrimaryColor = null;
  imageSingleTouchStartSecondaryColor = null;
  isImagePinching.value = false;
};

const rollbackSingleTouchInteractionForTransform = () => {
  const snapshot = imageSingleTouchStartSnapshot;
  const history = imageSingleTouchStartHistory;
  const startTool = imageSingleTouchStartTool;
  const startPrimaryColor = imageSingleTouchStartPrimaryColor;
  const startSecondaryColor = imageSingleTouchStartSecondaryColor;
  const hadInteraction =
    imagePanPointerId !== null ||
    imageViewportPaintPointerId !== null ||
    imageInteractionKind.value !== null;
  const hadDocumentInteraction =
    imageInteractionKind.value !== null ||
    (imageViewportPaintPointerId !== null && imageInteractionTool === "fill");

  if (hadInteraction) cancelImageInteraction(undefined, { commitHistory: false });
  if (snapshot && hadDocumentInteraction) {
    if (history) imageHistory.value = history;
    applyImageSnapshot(snapshot);
    scheduleImageAutosave();
  }
  if (startTool) activeImageTool.value = startTool;
  if (startPrimaryColor) setSelectedImageColor(startPrimaryColor);
  if (startSecondaryColor) secondaryImageColor.value = startSecondaryColor;
  imageSingleTouchStartSnapshot = null;
  imageSingleTouchStartHistory = null;
  imageSingleTouchStartTool = null;
  imageSingleTouchStartPrimaryColor = null;
  imageSingleTouchStartSecondaryColor = null;
};

const finishImageTransformGesture = () => {
  commitImageGestureView();
  imageTransformGesture = null;
  isImagePinching.value = false;
  hoveredImagePixelIndex.value = null;
  hoveredImageVirtualPoint.value = null;
};

const updateImageTransformGesture = (frame: TouchViewportGestureFrame) => {
  if (
    draggingImageMirrorAxis.value !== null ||
    !imageTouchNavigationActive ||
    imageTouchPointers.size < 2
  ) {
    return false;
  }

  const stageCenter = getImageStageCenter();
  if (!stageCenter) return false;

  if (!imageTransformGesture) {
    cancelScheduledImageFitToScreen();
    imageTransformGesture = {
      initialStageCenter: stageCenter,
      initialView: imageGestureView || {
        panX: imagePanX.value,
        panY: imagePanY.value,
        rotationRadians: imageRotationRadians.value,
        zoom: imageZoom.value,
      },
      lastFrame: frame,
    };
  }

  const gesture = imageTransformGesture;
  gesture.lastFrame = frame;
  const nextView = applyImageTwoFingerTransformDelta({
    currentStageCenter: stageCenter,
    delta: {
      currentCentroid: frame.centroid,
      previousCentroid: frame.initialCentroid,
      rotationRadians: frame.rotationRadians,
      zoomFactor: frame.scale,
    },
    maximumZoom: MAX_IMAGE_ZOOM,
    minimumZoom: MIN_IMAGE_ZOOM,
    previousStageCenter: gesture.initialStageCenter,
    view: gesture.initialView,
  });

  imageZoomMode.value = "custom";
  imageGestureView = nextView;
  writeImageGestureTransform(nextView);
  return true;
};

const bindImageTouchViewportGesture = () => {
  imageTouchViewportGesture?.destroy();
  imageTouchViewportGesture = null;

  const stage = imageStageRef.value;
  if (!stage) return;

  imageTouchViewportGesture = createTouchViewportGesture(stage, {
    onChange: updateImageTransformGesture,
    onEnd: finishImageTransformGesture,
    onStart: updateImageTransformGesture,
  });
};

const startImageTouchPointer = (event: PointerEvent, startsOnArtboard: boolean) => {
  if (
    draggingImageMirrorAxis.value !== null ||
    imageDesktopRotationGesture !== null ||
    imageTouchNavigationActive ||
    imageTouchPointers.size >= 2
  ) {
    return;
  }

  const existingTouch = [...imageTouchPointers.values()][0];
  const activePointerId = imagePanPointerId ?? imageViewportPaintPointerId;
  const canPromoteExistingTouch =
    Boolean(existingTouch) && activePointerId === existingTouch?.pointerId;
  if (
    imageTouchPointers.size === 0 &&
    (imagePanPointerId !== null ||
      imageViewportPaintPointerId !== null ||
      imageInteractionKind.value !== null)
  ) {
    return;
  }
  if (
    imageTouchPointers.size === 1 &&
    (imagePanPointerId !== null ||
      imageViewportPaintPointerId !== null ||
      imageInteractionKind.value !== null) &&
    !canPromoteExistingTouch
  ) {
    return;
  }

  focusAndCaptureImagePointer(event);
  imageTouchPointers.set(event.pointerId, {
    pointerId: event.pointerId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startsOnArtboard,
  });

  if (imageTouchPointers.size === 1) {
    imagePendingTouchPointerId = event.pointerId;
    imageSingleTouchStartSnapshot = null;
    imageSingleTouchStartHistory = null;
    imageSingleTouchStartTool = null;
    imageSingleTouchStartPrimaryColor = null;
    imageSingleTouchStartSecondaryColor = null;
    hoveredImagePixelIndex.value = null;
    hoveredImageVirtualPoint.value = null;
    return;
  }

  if (imageTouchPointers.size === 2) {
    imageTouchNavigationActive = true;
    rollbackSingleTouchInteractionForTransform();
    cancelScheduledImageFitToScreen();
    imagePendingTouchPointerId = null;
    isImagePinching.value = true;
    hoveredImagePixelIndex.value = null;
    hoveredImageVirtualPoint.value = null;
  }
};

const continueCommittedImageTouch = (event: PointerEvent) => {
  if (imagePanPointerId === event.pointerId) {
    continuePanningImageFromPointer(event);
    return;
  }
  if (imageViewportPaintPointerId !== event.pointerId) return;

  for (const point of getImagePointerSamplePoints(event)) {
    processImagePointerSegment(event, point);
  }
  updateHoveredImagePixelFromPointer(event);
};

const beginPendingImageTouch = (event: PointerEvent, touch: ImageTouchPointer) => {
  imageSingleTouchStartSnapshot = createImageSnapshot();
  imageSingleTouchStartHistory = imageHistory.value;
  imageSingleTouchStartTool = activeImageTool.value;
  imageSingleTouchStartPrimaryColor = selectedImageColor.value;
  imageSingleTouchStartSecondaryColor = secondaryImageColor.value;
  imagePendingTouchPointerId = null;
  const startPoint = { x: touch.startClientX, y: touch.startClientY };
  if (touch.startsOnArtboard) {
    startImageArtboardInteractionFromPointer(event, startPoint);
  } else {
    startImageViewportInteractionFromPointer(event, startPoint);
  }
  continueCommittedImageTouch(event);
};

const continueImageTouchPointer = (event: PointerEvent) => {
  const touch = imageTouchPointers.get(event.pointerId);
  if (!touch) return;

  // @use-gesture owns every two-touch frame. Pointer Events arrive one finger
  // at a time, so using them here would reintroduce the scale/rotation noise
  // that the TouchEvent recognizer removes.
  if (imageTouchNavigationActive) return;

  if (imagePendingTouchPointerId === event.pointerId) {
    const distanceFromStart = Math.hypot(
      event.clientX - touch.startClientX,
      event.clientY - touch.startClientY,
    );
    if (distanceFromStart < IMAGE_TOUCH_COMMIT_THRESHOLD) return;
    beginPendingImageTouch(event, touch);
    return;
  }

  continueCommittedImageTouch(event);
};

const finishImageTouchPointer = (event: PointerEvent) => {
  const touch = imageTouchPointers.get(event.pointerId);
  if (!touch) return;

  if (imageTouchNavigationActive) {
    imageTouchPointers.delete(event.pointerId);
    finishImageTransformGesture();

    // Once a two-finger gesture has started, the remaining finger stays
    // blocked. A new drawing gesture can only begin after every finger lifts.
    if (imageTouchPointers.size === 0) {
      imageTouchNavigationActive = false;
      imageSingleTouchStartSnapshot = null;
      imageSingleTouchStartHistory = null;
      imageSingleTouchStartTool = null;
      imageSingleTouchStartPrimaryColor = null;
      imageSingleTouchStartSecondaryColor = null;
    }
    return;
  }

  if (imagePendingTouchPointerId === event.pointerId) {
    beginPendingImageTouch(event, touch);
  }
  imageTouchPointers.delete(event.pointerId);

  if (
    imagePanPointerId === event.pointerId ||
    imageViewportPaintPointerId === event.pointerId
  ) {
    finishImagePointerInteractionFromPointer(event);
  }
  imageSingleTouchStartSnapshot = null;
  imageSingleTouchStartHistory = null;
  imageSingleTouchStartTool = null;
  imageSingleTouchStartPrimaryColor = null;
  imageSingleTouchStartSecondaryColor = null;
};

const startImageViewportPointerInteraction = (event: PointerEvent) => {
  if (draggingImageMirrorAxis.value !== null) return;
  if (event.pointerType === "touch") {
    startImageTouchPointer(event, false);
    return;
  }
  startImageViewportInteractionFromPointer(event);
};

const startImageArtboardPointerInteraction = (event: PointerEvent) => {
  if (draggingImageMirrorAxis.value !== null) return;
  if (event.pointerType === "touch") {
    startImageTouchPointer(event, true);
    return;
  }
  startImageArtboardInteractionFromPointer(event);
};

const continueImagePointerInteraction = (event: PointerEvent) => {
  if (event.pointerType === "touch") {
    continueImageTouchPointer(event);
    return;
  }
  continueImageViewportInteractionFromPointer(event);
};

const finishImagePointerInteraction = (event: PointerEvent) => {
  if (event.pointerType === "touch") {
    finishImageTouchPointer(event);
    return;
  }
  finishImagePointerInteractionFromPointer(event);
};

let lastPaintedImagePixelIndex: number | null = null;
const paintImagePixels = (indexes: number[], color: PixelColor) => {
  if (!canMutateActiveImageLayerPixels.value) {
    return;
  }

  const nextColor = color;
  const centers = indexes
    .filter((index) => index >= 0 && index < imagePixelCount.value)
    .map((index) => ({
      x: index % imageGridWidth.value,
      y: Math.floor(index / imageGridWidth.value),
    }));
  const points = centers.flatMap((point) =>
    brushPoints(
      point,
      imageBrushSize.value,
      imageBrushShape.value,
      isImageWrapAroundEnabled.value ? undefined : imageCanvasBounds.value,
    ),
  );
  const mutation = paintPixels(
    {
      width: imageGridWidth.value,
      height: imageGridHeight.value,
      pixels: imagePixels.value,
    },
    filterImagePointsToSelection(prepareImageCanvasStrokePoints(points)),
    nextColor,
  );
  const didChange = mutation.changes.length > 0;

  if (!didChange) return;

  imagePixels.value = [...mutation.buffer.pixels];
  scheduleImageCanvasRender();
  scheduleImageAutosave();
  queueImageCollaborationPixels(mutation.changes);
};

const paintImageGraffitiPixels = (indexes: number[]) => {
  if (!canMutateActiveImageLayerPixels.value) {
    return;
  }

  const centers = indexes
    .filter((index) => index >= 0 && index < imagePixelCount.value)
    .map((index) => imagePointFromPixelIndex(index));
  const brushOptions = {
    bounds: isImageWrapAroundEnabled.value ? undefined : imageCanvasBounds.value,
    brushSize: imageBrushSize.value,
    brushShape: imageBrushShape.value,
    inverted: imageInteractionGraffitiInverted,
    primaryColor: imageInteractionPrimaryColor,
    secondaryColor: imageInteractionSecondaryColor,
  };
  const pixelsByIndex = new Map<number, string>();
  for (const center of centers) {
    for (const pixel of graffitiBrushStamp(center, brushOptions)) {
      const basePoint = isImageWrapAroundEnabled.value
        ? wrapCanvasPoint(pixel, imageCanvasBounds.value)
        : pixel;
      const color = isImageWrapAroundEnabled.value
        ? graffitiCheckerColorAt(basePoint, brushOptions)
        : pixel.color;
      for (const point of expandCanvasMirrorPoints(
        [basePoint],
        imageCanvasBounds.value,
        imageMirrorModes.value,
        { wrapAround: isImageWrapAroundEnabled.value },
      )) {
        pixelsByIndex.set(point.y * imageGridWidth.value + point.x, color);
      }
    }
  }

  if (pixelsByIndex.size === 0) return;

  const nextPixels = [...imagePixels.value];
  let didChange = false;
  const changes: Array<{ index: number; after: PixelColor }> = [];
  for (const [index, color] of pixelsByIndex) {
    if (!isImagePixelIndexWithinSelection(index)) continue;
    if (nextPixels[index] === color) continue;
    nextPixels[index] = color;
    didChange = true;
    changes.push({ index, after: color });
  }

  if (!didChange) return;

  imagePixels.value = nextPixels;
  scheduleImageCanvasRender();
  scheduleImageAutosave();
  queueImageCollaborationPixels(changes);
};

const fillImagePixelsFrom = (startIndex: number, replacementColor: PixelColor) => {
  if (
    !canMutateActiveImageLayerPixels.value ||
    startIndex < 0 ||
    startIndex >= imagePixelCount.value ||
    !isImagePixelIndexWithinSelection(startIndex)
  ) {
    return;
  }

  const targetColor = imagePixels.value[startIndex] || null;
  if (targetColor === replacementColor) return;

  const nextPixels = [...imagePixels.value];
  const pending = [startIndex];
  const visited = new Set<number>();

  while (pending.length > 0) {
    const index = pending.pop();

    if (
      index === undefined ||
      visited.has(index) ||
      !isImagePixelIndexWithinSelection(index) ||
      nextPixels[index] !== targetColor
    ) {
      continue;
    }

    visited.add(index);
    nextPixels[index] = replacementColor;

    const row = Math.floor(index / imageGridWidth.value);
    const column = index % imageGridWidth.value;

    if (row > 0) pending.push(index - imageGridWidth.value);
    if (row < imageGridHeight.value - 1) pending.push(index + imageGridWidth.value);
    if (column > 0) pending.push(index - 1);
    if (column < imageGridWidth.value - 1) pending.push(index + 1);
  }

  updateImagePixels(nextPixels);
};

const pickImageColorFrom = (pixelIndex: number, channel: ImageColorChannel) => {
  const color = compositeVisibleLayers(buildImageDocument())[pixelIndex];

  if (!color) {
    return;
  }

  if (channel === "secondary") {
    setSecondaryImageColor(color);
    return;
  }

  setSelectedImageColor(color);
};

const updateImageHueFromPointer = (event: PointerEvent) => {
  if (!canEditImage.value) return;
  if (event.type === "pointermove" && event.buttons === 0) {
    return;
  }

  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const x = event.clientX - rect.left - rect.width / 2;
  const y = event.clientY - rect.top - rect.height / 2;
  selectedImageHue.value = (Math.atan2(y, x) * 180) / Math.PI + 180;
  selectedImageHue.value = (selectedImageHue.value + 360) % 360;
  applySelectedImageHsv();
};

const getImageTriangleWeightsFromPointer = (event: PointerEvent) => {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const scaleX = rect.width / (IMAGE_COLOR_TRIANGLE_RIGHT.x - IMAGE_COLOR_TRIANGLE_LEFT.x);
  const scaleY = rect.height / (IMAGE_COLOR_TRIANGLE_LEFT.y - IMAGE_COLOR_TRIANGLE_TOP.y);
  const x = IMAGE_COLOR_TRIANGLE_LEFT.x + (event.clientX - rect.left) / scaleX;
  const y = IMAGE_COLOR_TRIANGLE_TOP.y + (event.clientY - rect.top) / scaleY;
  const weights = getImageColorTriangleWeights(x, y);
  const clampedBlack = Math.max(0, weights.black);
  const clampedWhite = Math.max(0, weights.white);
  const clampedHue = Math.max(0, weights.hue);
  const total = clampedBlack + clampedWhite + clampedHue || 1;

  return {
    black: clampedBlack / total,
    hue: clampedHue / total,
    white: clampedWhite / total,
  };
};

const updateImageColorTriangleFromPointer = (event: PointerEvent) => {
  if (!canEditImage.value) return;
  if (event.type === "pointermove" && event.buttons === 0) {
    return;
  }

  const weights = getImageTriangleWeightsFromPointer(event);
  const value = 1 - weights.black;
  selectedImageValue.value = clamp01(value);
  selectedImageSaturation.value = value <= 0 ? 0 : clamp01(weights.hue / value);
  applySelectedImageHsv();
};

const startImageHueSelection = (event: PointerEvent) => {
  if (!canEditImage.value) return;
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  updateImageHueFromPointer(event);
};

const startImageColorTriangleSelection = (event: PointerEvent) => {
  if (!canEditImage.value) return;
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  updateImageColorTriangleFromPointer(event);
};

watch(
  selectedImageHue,
  () => {
    void nextTick(renderImageColorTriangleCanvas);
  },
  { immediate: true },
);

const imagePointFromPixelIndex = (pixelIndex: number): Point => ({
  x: pixelIndex % imageGridWidth.value,
  y: Math.floor(pixelIndex / imageGridWidth.value),
});

const isImageShapeTool = (
  tool: ImageTool,
): tool is "line" | "rectangle" | "ellipse" =>
  tool === "line" || tool === "rectangle" || tool === "ellipse";

const constrainImageShapeEnd = (
  start: Point,
  end: Point,
  event: PointerEvent,
  tool: ImageTool,
) => {
  let constrainedEnd = end;
  if (event.shiftKey) {
    if (tool === "line") {
      constrainedEnd = constrainPointToEightDirections(start, end);
    } else {
      const deltaX = end.x - start.x;
      const deltaY = end.y - start.y;
      const span = Math.max(Math.abs(deltaX), Math.abs(deltaY));
      constrainedEnd = {
        x: start.x + (deltaX < 0 ? -span : span),
        y: start.y + (deltaY < 0 ? -span : span),
      };
    }
  }

  if (!isImageWrapAroundEnabled.value) return constrainedEnd;

  // Spans beyond one complete tile only repeat pixels already represented in
  // the canonical document and can make filled previews needlessly enormous.
  return {
    x:
      start.x +
      Math.max(
        -imageGridWidth.value,
        Math.min(imageGridWidth.value, constrainedEnd.x - start.x),
      ),
    y:
      start.y +
      Math.max(
        -imageGridHeight.value,
        Math.min(imageGridHeight.value, constrainedEnd.y - start.y),
      ),
  };
};

const updateImageShapePreview = (end: Point, event: PointerEvent) => {
  const start = imagePointerStart.value;
  const tool = imageInteractionTool;
  if (!start || !tool || !isImageShapeTool(tool)) return;
  const constrainedEnd = constrainImageShapeEnd(start, end, event, tool);
  imagePointerEnd.value = constrainedEnd;
  const options = {
    bounds: isImageWrapAroundEnabled.value ? undefined : imageCanvasBounds.value,
    brushSize: imageBrushSize.value,
    brushShape: imageBrushShape.value,
    filled: isImageShapeFilled.value,
  };
  const points =
    tool === "line"
      ? strokePoints(
          linePoints(start, constrainedEnd),
          imageBrushSize.value,
          options.bounds,
          imageBrushShape.value,
        )
      : tool === "rectangle"
        ? rectanglePoints(start, constrainedEnd, options)
        : ellipsePoints(start, constrainedEnd, options);
  imageShapePreviewPoints.value = filterImagePointsToSelection(
    prepareImageCanvasStrokePoints(points),
  );
  scheduleImageCanvasRender();
};

const applyImagePoints = (points: Point[], color: PixelColor) => {
  if (!canMutateActiveImageLayerPixels.value) return false;
  const mutation = paintPixels(
    {
      width: imageGridWidth.value,
      height: imageGridHeight.value,
      pixels: imagePixels.value,
    },
    filterImagePointsToSelection(points),
    color,
  );
  if (mutation.changes.length === 0) return false;
  imagePixels.value = [...mutation.buffer.pixels];
  scheduleImageCanvasRender();
  scheduleImageAutosave();
  return true;
};

const startPaintingImageFromPointer = (
  event: PointerEvent,
  allowPan = true,
  initialPixelIndex?: number,
  initialVirtualPoint?: Point,
) => {
  if (allowPan && isImagePanButton(event)) {
    startPanningImageFromPointer(event);
    return;
  }

  const pointerPixelIndex = updateHoveredImagePixelFromPointer(event);
  const pixelIndex = initialPixelIndex ?? pointerPixelIndex;

  if (pixelIndex === null) {
    return;
  }

  const point = imagePointFromPixelIndex(pixelIndex);
  const tool = imageInteractionTool;
  if (!tool) return;

  if (tool === "picker") {
    focusAndCaptureImagePointer(event);
    pickImageColorFrom(pixelIndex, imagePointerColorChannel);
    activeImageTool.value = "pencil";
    return;
  }

  if (tool === "fill") {
    focusAndCaptureImagePointer(event);
    fillImagePixelsFrom(pixelIndex, imageInteractionColor);
    commitImageHistory();
    return;
  }

  if (tool === "select") {
    imageSelectionGestureTileOffset =
      imageSelectionKind.value !== "wand" && initialVirtualPoint
        ? {
            x: initialVirtualPoint.x - point.x,
            y: initialVirtualPoint.y - point.y,
          }
        : null;
    const selectionPoint = point;
    focusAndCaptureImagePointer(event);
    imagePointerStart.value = selectionPoint;
    imagePointerEnd.value = selectionPoint;
    imageSelectionDidDrag = false;
    imageSelectionGestureBase = cloneImageSelection(imageSelection.value);
    imageSelectionGestureKind = imageSelectionKind.value;
    imageSelectionGestureMode = resolveImageSelectionMode(event);
    imageSelectionLassoPoints = [selectionPoint];
    const dimensions = imageCanvasBounds.value;
    const candidate =
      imageSelectionGestureKind === "wand"
        ? createMagicWandSelectionMask(activeImageBuffer(), selectionPoint, {
            contiguous: isImageSelectionContiguous.value,
          })
        : imageSelectionGestureKind === "lasso"
          ? createPointSelectionMask([selectionPoint], dimensions)
          : createRectangleSelectionMask(selectionPoint, selectionPoint, dimensions);
    applyImageSelectionCandidate(
      candidate,
      imageSelectionGestureKind,
      imageSelectionGestureMode,
      imageSelectionGestureBase,
    );
    if (imageSelectionGestureKind === "wand") imageSelectionDidDrag = true;
    broadcastImageSelection();
    imageInteractionKind.value = "select";
    return;
  }

  if (tool === "move") {
    if (!canMutateActiveImageLayerPixels.value) return;
    focusAndCaptureImagePointer(event);
    const movePoint = initialVirtualPoint ?? point;
    imagePointerStart.value = movePoint;
    imagePointerEnd.value = movePoint;
    imageMoveSourceBuffer = {
      width: imageGridWidth.value,
      height: imageGridHeight.value,
      pixels: [...imagePixels.value],
    };
    imageMoveSourceSelection = cloneImageSelection(imageSelection.value);
    imageMoveDidChange = false;
    imageInteractionKind.value = "move";
    isPaintingImage.value = true;
    return;
  }

  if (isImageShapeTool(tool)) {
    if (!canMutateActiveImageLayerPixels.value) return;
    focusAndCaptureImagePointer(event);
    const shapePoint = initialVirtualPoint ?? point;
    imagePointerStart.value = shapePoint;
    imagePointerEnd.value = shapePoint;
    imageInteractionKind.value = "shape";
    isPaintingImage.value = true;
    updateImageShapePreview(shapePoint, event);
    return;
  }

  if (!canMutateActiveImageLayerPixels.value) {
    return;
  }

  isPaintingImage.value = true;
  imageInteractionKind.value = "paint";
  focusAndCaptureImagePointer(event);
  if (tool === "graffiti") {
    paintImageGraffitiPixels([pixelIndex]);
  } else {
    paintImagePixels([pixelIndex], imageInteractionColor);
  }
  lastPaintedImagePixelIndex = pixelIndex;
};

const continuePaintingImageFromPointer = (
  event: PointerEvent,
  forcedPixelIndex?: number,
  forcedStrokePixels?: number[],
  forcedVirtualPoint?: Point,
) => {
  if (isPanningImage.value) {
    continuePanningImageFromPointer(event);
    return;
  }

  const pointerPixelIndex = updateHoveredImagePixelFromPointer(event);
  const pixelIndex = forcedPixelIndex ?? pointerPixelIndex;

  if (
    (imageInteractionKind.value === "paint" ||
      imageInteractionKind.value === "shape" ||
      imageInteractionKind.value === "move") &&
    !canMutateActiveImageLayerPixels.value
  ) {
    cancelImageInteraction(event);
    return;
  }

  if (imageInteractionKind.value === "select" && pixelIndex !== null && imagePointerStart.value) {
    const point =
      imageSelectionGestureKind === "lasso" &&
      forcedVirtualPoint &&
      !isImageWrapAroundEnabled.value
        ? { x: Math.round(forcedVirtualPoint.x), y: Math.round(forcedVirtualPoint.y) }
        : imageSelectionPointWithinGestureTile(
            forcedVirtualPoint,
            imagePointFromPixelIndex(pixelIndex),
          );
    if (imageSelectionGestureKind === "wand") return;
    if (!isSinglePixelSelectionGesture(imagePointerStart.value, point)) {
      imageSelectionDidDrag = true;
    }
    imagePointerEnd.value = point;
    let candidate: PixelSelectionMask;
    if (imageSelectionGestureKind === "lasso") {
      const previousPoint = imageSelectionLassoPoints.at(-1) || imagePointerStart.value;
      if (previousPoint.x === point.x && previousPoint.y === point.y) return;
      // The rasterizer joins sampled points itself. Keeping only pointer samples
      // avoids an ever-growing list of intermediate Bresenham points.
      imageSelectionLassoPoints.push(point);
      candidate = createLassoSelectionMask(
        imageSelectionLassoPoints,
        imageCanvasBounds.value,
      );
    } else {
      candidate = createRectangleSelectionMask(
        imagePointerStart.value,
        point,
        imageCanvasBounds.value,
      );
    }
    applyImageSelectionCandidate(
      candidate,
      imageSelectionGestureKind,
      imageSelectionGestureMode,
      imageSelectionGestureBase,
    );
    broadcastImageSelection();
    return;
  }

  if (imageInteractionKind.value === "shape" && pixelIndex !== null) {
    updateImageShapePreview(
      forcedVirtualPoint ?? imagePointFromPixelIndex(pixelIndex),
      event,
    );
    return;
  }

  if (
    imageInteractionKind.value === "move" &&
    pixelIndex !== null &&
    imagePointerStart.value &&
    imageMoveSourceBuffer
  ) {
    if (!canMutateActiveImageLayerPixels.value) {
      cancelImageInteraction(event);
      return;
    }
    const point = forcedVirtualPoint ?? imagePointFromPixelIndex(pixelIndex);
    const delta = {
      x: point.x - imagePointerStart.value.x,
      y: point.y - imagePointerStart.value.y,
    };
    const result = imageMoveSourceSelection
      ? moveImageSelectedPixels(imageMoveSourceBuffer, imageMoveSourceSelection, delta)
      : {
          pixels: [...moveLayer(imageMoveSourceBuffer, delta).buffer.pixels],
          selection: null,
        };
    const previousPixels = imagePixels.value;
    const nextPixels = [...result.pixels];
    imagePixels.value = nextPixels;
    imageSelection.value = result.selection;
    imagePointerEnd.value = point;
    imageMoveDidChange =
      !imagePixelsAreEqual(imageMoveSourceBuffer.pixels, imagePixels.value) ||
      !imageSelectionMasksAreEqual(imageMoveSourceSelection, result.selection);
    const collaborationChanges: Array<{ index: number; after: PixelColor }> = [];
    for (const [index, after] of nextPixels.entries()) {
      if (previousPixels[index] !== after) collaborationChanges.push({ index, after });
    }
    queueImageCollaborationPixels(collaborationChanges);
    broadcastImageSelection();
    scheduleImageCanvasRender();
    return;
  }

  if (!isPaintingImage.value || imageInteractionKind.value !== "paint") {
    return;
  }

  if (pixelIndex === null) {
    lastPaintedImagePixelIndex = null;
    return;
  }

  const strokePixels =
    forcedStrokePixels ??
    imageLineBetweenPixels(lastPaintedImagePixelIndex ?? pixelIndex, pixelIndex);
  if (imageInteractionTool === "graffiti") {
    paintImageGraffitiPixels(strokePixels);
  } else {
    paintImagePixels(strokePixels, imageInteractionColor);
  }
  lastPaintedImagePixelIndex = pixelIndex;
};

const stopPaintingImage = (event?: PointerEvent) => {
  const activePointerId = imagePanPointerId ?? imageViewportPaintPointerId;
  if (
    event &&
    activePointerId !== null &&
    event.pointerId !== activePointerId
  ) {
    return;
  }

  const interactionKind = imageInteractionKind.value;
  const shouldCommitHistory =
    interactionKind === "paint" ||
    interactionKind === "shape" ||
    (interactionKind === "move" && imageMoveDidChange) ||
    (interactionKind === "rotate" && imagePixelRotationGesture.value?.didChange === true);
  if (interactionKind === "shape" && imageShapePreviewPoints.value.length > 0) {
    applyImagePoints(imageShapePreviewPoints.value, imageInteractionColor);
  }
  if (interactionKind === "select" && !imageSelectionDidDrag) {
    imageSelection.value =
      imageSelectionGestureMode === "replace"
        ? null
        : cloneImageSelection(imageSelectionGestureBase);
  }
  if (interactionKind === "select") {
    commitImageSelectionHistory();
    flushImageCollaborationSelection();
  }
  isPaintingImage.value = false;
  isPanningImage.value = false;
  imagePanPointerId = null;
  imageViewportPaintPointerId = null;
  imageViewportPaintButtonMask = 0;
  imagePointerColorChannel = "primary";
  imageInteractionColor = selectedImageColor.value;
  imageInteractionTool = null;
  imageInteractionPrimaryColor = selectedImageColor.value;
  imageInteractionSecondaryColor = secondaryImageColor.value;
  imageInteractionGraffitiInverted = false;
  imageGraffitiPreviewGesture.value = null;
  isImageViewportPaintAwaitingArtboard = false;
  imageViewportPaintClientX = 0;
  imageViewportPaintClientY = 0;
  imageInteractionKind.value = null;
  imagePointerStart.value = null;
  imagePointerEnd.value = null;
  imageShapePreviewPoints.value = [];
  imageMoveSourceBuffer = null;
  imageMoveSourceSelection = null;
  imageMoveDidChange = false;
  imagePixelRotationGesture.value = null;
  if (interactionKind === "rotate") imagePixelRotationDegrees.value = 0;
  imageSelectionDidDrag = false;
  imageSelectionGestureBase = null;
  imageSelectionGestureKind = imageSelectionKind.value;
  imageSelectionGestureMode = imageSelectionMode.value;
  imageSelectionLassoPoints = [];
  imageSelectionGestureTileOffset = null;
  lastPaintedImagePixelIndex = null;
  scheduleImageCanvasRender();
  if (shouldCommitHistory) {
    if (interactionKind === "move" || interactionKind === "rotate") scheduleImageAutosave();
    commitImageHistory();
  }
};

const leaveImageCanvas = () => {
  hoveredImagePixelIndex.value = null;
  hoveredImageVirtualPoint.value = null;
};

const leaveImageViewport = () => {
  leaveImageCanvas();
  broadcastImageCursor(null);
};

const cancelImageInteraction = (
  event?: PointerEvent,
  { commitHistory = true }: Readonly<{ commitHistory?: boolean }> = {},
) => {
  const activePointerId =
    imageDesktopRotationGesture?.pointerId ?? imagePanPointerId ?? imageViewportPaintPointerId;
  if (
    event &&
    activePointerId !== null &&
    event.pointerId !== activePointerId
  ) {
    return;
  }

  finishRotatingImageFromPointer(event);
  const interactionKind = imageInteractionKind.value;
  const wasMoving = interactionKind === "move";
  const wasSelecting = interactionKind === "select";
  hoveredImagePixelIndex.value = null;
  hoveredImageVirtualPoint.value = null;
  isPaintingImage.value = false;
  isPanningImage.value = false;
  imagePanPointerId = null;
  imageViewportPaintPointerId = null;
  imageViewportPaintButtonMask = 0;
  imagePointerColorChannel = "primary";
  imageInteractionColor = selectedImageColor.value;
  imageInteractionTool = null;
  imageInteractionPrimaryColor = selectedImageColor.value;
  imageInteractionSecondaryColor = secondaryImageColor.value;
  imageInteractionGraffitiInverted = false;
  imageGraffitiPreviewGesture.value = null;
  isImageViewportPaintAwaitingArtboard = false;
  imageViewportPaintClientX = 0;
  imageViewportPaintClientY = 0;
  imageInteractionKind.value = null;
  imagePointerStart.value = null;
  imagePointerEnd.value = null;
  imageShapePreviewPoints.value = [];
  if (wasMoving && imageMoveSourceBuffer) {
    imagePixels.value = [...imageMoveSourceBuffer.pixels];
    imageSelection.value = cloneImageSelection(imageMoveSourceSelection);
  }
  if (wasSelecting) {
    imageSelection.value = cloneImageSelection(imageSelectionGestureBase);
  }
  if (interactionKind === "rotate" && imagePixelRotationGesture.value) {
    const gesture = imagePixelRotationGesture.value;
    imageLayers.value = imageLayers.value.map((layer) =>
      layer.id === gesture.layerId ? { ...layer, pixels: [...gesture.buffer.pixels] } : layer,
    );
    imageSelection.value = cloneImageSelection(gesture.selection);
  }
  imagePixelRotationGesture.value = null;
  if (interactionKind === "rotate") imagePixelRotationDegrees.value = 0;
  imageMoveSourceBuffer = null;
  imageMoveSourceSelection = null;
  imageMoveDidChange = false;
  imageSelectionDidDrag = false;
  imageSelectionGestureBase = null;
  imageSelectionGestureKind = imageSelectionKind.value;
  imageSelectionGestureMode = imageSelectionMode.value;
  imageSelectionLassoPoints = [];
  imageSelectionGestureTileOffset = null;
  lastPaintedImagePixelIndex = null;
  scheduleImageCanvasRender();
  if (wasMoving) broadcastImageDocument();
  if (wasMoving || wasSelecting) broadcastImageSelection();
  if (interactionKind === "paint" && commitHistory) {
    commitImageHistory();
  }
};

const cancelImagePointerInteraction = (event: PointerEvent) => {
  if (event.pointerType !== "touch") {
    cancelImageInteraction(event);
    return;
  }

  const hadTrackedTouch = imageTouchPointers.has(event.pointerId);
  const hadActiveInteraction =
    imagePanPointerId === event.pointerId || imageViewportPaintPointerId === event.pointerId;
  if (!hadTrackedTouch && !hadActiveInteraction) return;

  resetImageTouchPointers();
  if (hadActiveInteraction) {
    cancelImageInteraction(event);
  }
};

const imageResizeAnchorOptionByValue = (anchorValue: ImageResizeAnchor) =>
  IMAGE_RESIZE_ANCHORS.find((anchor) => anchor.value === anchorValue) ||
  IMAGE_RESIZE_ANCHORS.find((anchor) => anchor.value === DEFAULT_IMAGE_RESIZE_ANCHOR)!;

const activeImageResizeAnchorOption = computed(
  () => imageResizeAnchorOptionByValue(imageResizeAnchor.value),
);

const imageAnchorExpansionDirection = (anchorValue: ImageResizeAnchor) => {
  const activeAnchor = activeImageResizeAnchorOption.value;
  const targetAnchor = imageResizeAnchorOptionByValue(anchorValue);

  if (activeAnchor.value === targetAnchor.value) {
    return null;
  }

  for (const direction of activeAnchor.arrows) {
    const rowDelta = direction === "up" ? -1 : direction === "down" ? 1 : 0;
    const columnDelta = direction === "left" ? -1 : direction === "right" ? 1 : 0;

    if (
      activeAnchor.row + rowDelta === targetAnchor.row &&
      activeAnchor.column + columnDelta === targetAnchor.column
    ) {
      return direction;
    }
  }

  return null;
};

const resizeImageWorkspace = (nextWidth: number, nextHeight: number) => {
  if (!canEditImage.value) {
    return;
  }

  const width = normalizeImageDimension(nextWidth, imageGridWidth.value);
  const height = normalizeImageDimension(nextHeight, imageGridHeight.value);

  if (width === imageGridWidth.value && height === imageGridHeight.value) {
    return;
  }

  if (imagePixelRotationGesture.value) cancelImageInteractionBeforeLayerChange();

  const resizedDocument = resizePixelArtDocument(
    buildImageDocument(),
    width,
    height,
    imageResizeAnchor.value,
  );
  imageGridWidth.value = resizedDocument.width;
  imageGridHeight.value = resizedDocument.height;
  imageLayers.value = resizedDocument.layers;
  imageSelection.value = null;
  scheduleImageCanvasRender();
  imageGridWidthDraft.value = String(width);
  imageGridHeightDraft.value = String(height);
  hoveredImagePixelIndex.value = null;
  hoveredImageVirtualPoint.value = null;
  stopPaintingImage();
  scheduleImageAutosave();
  commitImageHistory();
  void nextTick(scheduleImagePreviewViewportUpdate);
};

const syncImageDimensionDrafts = () => {
  imageGridWidthDraft.value = String(imageGridWidth.value);
  imageGridHeightDraft.value = String(imageGridHeight.value);
};

const updateImageWidthDraft = (event: Event) => {
  const value = (event.currentTarget as HTMLInputElement).value;
  imageGridWidthDraft.value = value;

  if (areImageDimensionsLinked.value) {
    const width = Number(value);
    if (Number.isFinite(width) && width > 0) {
      imageGridHeightDraft.value = String(
        normalizeImageDimension(
          (width * imageGridHeight.value) / imageGridWidth.value,
          imageGridHeight.value,
        ),
      );
    }
  }
};

const updateImageHeightDraft = (event: Event) => {
  const value = (event.currentTarget as HTMLInputElement).value;
  imageGridHeightDraft.value = value;

  if (areImageDimensionsLinked.value) {
    const height = Number(value);
    if (Number.isFinite(height) && height > 0) {
      imageGridWidthDraft.value = String(
        normalizeImageDimension(
          (height * imageGridWidth.value) / imageGridHeight.value,
          imageGridWidth.value,
        ),
      );
    }
  }
};

const applyImageWidthDraft = () => {
  if (!imageGridWidthDraft.value.trim()) {
    syncImageDimensionDrafts();
    return;
  }

  const nextWidth = normalizeImageDimension(Number(imageGridWidthDraft.value), imageGridWidth.value);

  if (areImageDimensionsLinked.value) {
    const nextHeight = normalizeImageDimension(
      Number(imageGridHeightDraft.value),
      imageGridHeight.value,
    );
    resizeImageWorkspace(nextWidth, nextHeight);
  } else {
    resizeImageWorkspace(nextWidth, imageGridHeight.value);
  }

  syncImageDimensionDrafts();
};

const applyImageHeightDraft = () => {
  if (!imageGridHeightDraft.value.trim()) {
    syncImageDimensionDrafts();
    return;
  }

  const nextHeight = normalizeImageDimension(Number(imageGridHeightDraft.value), imageGridHeight.value);

  if (areImageDimensionsLinked.value) {
    const nextWidth = normalizeImageDimension(
      Number(imageGridWidthDraft.value),
      imageGridWidth.value,
    );
    resizeImageWorkspace(nextWidth, nextHeight);
  } else {
    resizeImageWorkspace(imageGridWidth.value, nextHeight);
  }

  syncImageDimensionDrafts();
};

const selectImageResizeAnchor = (anchor: ImageResizeAnchor) => {
  if (imageResizeAnchor.value === anchor) {
    return;
  }

  imageResizeAnchor.value = anchor;
};

const finishImageLayerMutation = () => {
  triggerRef(imageLayers);
  scheduleImageCanvasRender();
  scheduleImageAutosave();
  commitImageHistory();
};

const cancelImageInteractionBeforeLayerChange = () => {
  if (
    imageInteractionKind.value !== null ||
    imageDesktopRotationGesture !== null ||
    imagePanPointerId !== null ||
    imageViewportPaintPointerId !== null ||
    imageTouchPointers.size > 0 ||
    imageTransformGesture !== null
  ) {
    resetImageTouchPointers();
    cancelImageInteraction();
  }
};

const selectImageLayer = (layerId: string) => {
  if (
    layerId !== activeImageLayerId.value &&
    imageLayers.value.some((layer) => layer.id === layerId)
  ) {
    cancelImageInteractionBeforeLayerChange();
    activeImageLayerId.value = layerId;
  }
};

const addImageLayer = () => {
  if (!canEditImage.value) return;
  cancelImageInteractionBeforeLayerChange();
  const layer = createPixelLayer(imageGridWidth.value, imageGridHeight.value, {
    name: `Layer ${imageLayers.value.length + 1}`,
  });
  imageLayers.value = [...imageLayers.value, layer];
  activeImageLayerId.value = layer.id;
  finishImageLayerMutation();
};

const duplicateImageLayer = (layerId: string) => {
  if (!canEditImage.value) return;
  const index = imageLayers.value.findIndex((layer) => layer.id === layerId);
  if (index < 0) return;
  cancelImageInteractionBeforeLayerChange();
  const source = imageLayers.value[index]!;
  const duplicate = createPixelLayer(imageGridWidth.value, imageGridHeight.value, {
    ...source,
    id: undefined,
    name: `${source.name} copy`,
    pixels: source.pixels,
  });
  const layers = [...imageLayers.value];
  layers.splice(index + 1, 0, duplicate);
  imageLayers.value = layers;
  activeImageLayerId.value = duplicate.id;
  finishImageLayerMutation();
};

const removeImageLayer = (layerId: string) => {
  if (!canEditImage.value || imageLayers.value.length <= 1) return;
  const index = imageLayers.value.findIndex((layer) => layer.id === layerId);
  if (index < 0) return;
  if (activeImageLayerId.value === layerId) {
    cancelImageInteractionBeforeLayerChange();
  }
  const layers = imageLayers.value.filter((layer) => layer.id !== layerId);
  imageLayers.value = layers;
  if (activeImageLayerId.value === layerId) {
    activeImageLayerId.value = layers[Math.min(index, layers.length - 1)]?.id || "";
  }
  finishImageLayerMutation();
};

const renameImageLayer = ({ id, name }: { id: string; name: string }) => {
  if (!canEditImage.value) return;
  const normalizedName = name.trim();
  if (!normalizedName) return;
  const previousLayers = imageLayers.value;
  imageLayers.value = previousLayers.map((layer) =>
    layer.id === id ? { ...layer, name: normalizedName } : layer,
  );
  if (imageLayers.value.every((layer, index) => layer === previousLayers[index])) return;
  finishImageLayerMutation();
};

const toggleImageLayerVisibility = (layerId: string) => {
  if (!canEditImage.value) return;
  const layer = imageLayers.value.find((candidate) => candidate.id === layerId);
  if (layerId === activeImageLayerId.value && layer?.visible) {
    cancelImageInteractionBeforeLayerChange();
  }
  imageLayers.value = imageLayers.value.map((layer) =>
    layer.id === layerId ? { ...layer, visible: !layer.visible } : layer,
  );
  finishImageLayerMutation();
};

const toggleImageLayerLock = (layerId: string) => {
  if (!canEditImage.value) return;
  const layer = imageLayers.value.find((candidate) => candidate.id === layerId);
  if (layerId === activeImageLayerId.value && layer && !layer.locked) {
    cancelImageInteractionBeforeLayerChange();
  }
  imageLayers.value = imageLayers.value.map((layer) =>
    layer.id === layerId ? { ...layer, locked: !layer.locked } : layer,
  );
  finishImageLayerMutation();
};

const setImageLayerOpacity = ({ id, opacity }: { id: string; opacity: number }) => {
  if (!canEditImage.value) return;
  const normalizedOpacity = Math.min(1, Math.max(0, opacity));
  imageLayers.value = imageLayers.value.map((layer) =>
    layer.id === id ? { ...layer, opacity: normalizedOpacity } : layer,
  );
  finishImageLayerMutation();
};

const previewImageLayerOpacity = ({ id, opacity }: { id: string; opacity: number }) => {
  if (!canEditImage.value) return;
  const normalizedOpacity = Math.min(1, Math.max(0, opacity));
  imageLayers.value = imageLayers.value.map((layer) =>
    layer.id === id ? { ...layer, opacity: normalizedOpacity } : layer,
  );
  scheduleImageCanvasRender();
};

const moveImageLayer = ({
  id,
  direction,
}: {
  id: string;
  direction: "up" | "down";
}) => {
  if (!canEditImage.value) return;
  const index = imageLayers.value.findIndex((layer) => layer.id === id);
  const targetIndex = direction === "up" ? index + 1 : index - 1;
  if (index < 0 || targetIndex < 0 || targetIndex >= imageLayers.value.length) return;
  const layers = [...imageLayers.value];
  [layers[index], layers[targetIndex]] = [layers[targetIndex]!, layers[index]!];
  imageLayers.value = layers;
  finishImageLayerMutation();
};

const reorderImageLayer = ({
  id,
  targetId,
  position,
}: {
  id: string;
  targetId: string;
  position: ImageLayerDropPosition;
}) => {
  if (!canEditImage.value) return;
  const reorderedLayers = reorderImageLayersByDisplayDrop(
    imageLayers.value,
    id,
    targetId,
    position,
  );
  if (reorderedLayers === imageLayers.value) return;
  imageLayers.value = reorderedLayers;
  finishImageLayerMutation();
};

const activeImageBuffer = () => ({
  width: imageGridWidth.value,
  height: imageGridHeight.value,
  pixels: imagePixels.value,
});

const imagePixelRotationPivotStyle = computed(() => {
  const pivot = imagePixelRotationGesture.value?.pivot ??
    getPixelRotationPivot(imageCanvasBounds.value, imageSelection.value);
  return {
    left: `${pivot.x / imageGridWidth.value * 100}%`,
    top: `${pivot.y / imageGridHeight.value * 100}%`,
  };
});

const pixelRotationPointerAngle = (point: Point, pivot: Point) =>
  Math.hypot(point.x - pivot.x, point.y - pivot.y) < 0.05
    ? null
    : Math.atan2(point.y - pivot.y, point.x - pivot.x) * 180 / Math.PI;

const startImagePixelRotation = (event: PointerEvent, clientPoint: Point) => {
  const point = getImageVirtualCanvasPositionFromClientCoordinates(clientPoint.x, clientPoint.y);
  if (!point || !canMutateActiveImageLayerPixels.value) {
    cancelImageInteraction();
    return;
  }
  const buffer = { ...activeImageBuffer(), pixels: [...imagePixels.value] };
  const selection = cloneImageSelection(imageSelection.value);
  const pivot = getPixelRotationPivot(buffer, selection);
  imagePixelRotationGesture.value = {
    buffer, selection, pivot,
    layerId: activeImageLayerId.value,
    lastAngle: pixelRotationPointerAngle(point, pivot),
    rawDegrees: 0,
    didChange: false,
  };
  imagePixelRotationDegrees.value = 0;
  imageInteractionKind.value = "rotate";
  isPaintingImage.value = true;
  isImageViewportPaintAwaitingArtboard = false;
  focusAndCaptureImagePointer(event);
};

const continueImagePixelRotation = (event: PointerEvent, clientPoint: Point) => {
  const gesture = imagePixelRotationGesture.value;
  if (!gesture) return;
  if (!canMutateActiveImageLayerPixels.value || gesture.layerId !== activeImageLayerId.value) {
    cancelImageInteraction(event);
    return;
  }
  const point = getImageVirtualCanvasPositionFromClientCoordinates(clientPoint.x, clientPoint.y);
  if (!point) return;
  const angle = pixelRotationPointerAngle(point, gesture.pivot);
  if (angle === null) return;
  if (gesture.lastAngle !== null) gesture.rawDegrees += getPixelRotationDelta(gesture.lastAngle, angle);
  gesture.lastAngle = angle;
  const degrees = snapPixelRotationDegrees(gesture.rawDegrees, event.shiftKey);
  imagePixelRotationDegrees.value = Math.round(degrees * 100) / 100;
  const result = rotateImagePixelSelection(gesture.buffer, gesture.selection, degrees);
  imagePixels.value = result.pixels;
  imageSelection.value = result.selection;
  gesture.didChange = !imagePixelsAreEqual(gesture.buffer.pixels, result.pixels) ||
    !imageSelectionMasksAreEqual(gesture.selection, result.selection);
  scheduleImageCanvasRender();
};

const applyImagePixelRotation = () => {
  const degrees = imagePixelRotationDegrees.value;
  if (!canMutateActiveImageLayerPixels.value || imageInteractionKind.value !== null ||
      !Number.isFinite(degrees) || degrees % 360 === 0) return;
  const previousSelection = imageSelection.value;
  const result = rotateImagePixelSelection(activeImageBuffer(), previousSelection, degrees);
  imageSelection.value = result.selection;
  const didChange = updateImagePixels(result.pixels);
  const selectionChanged = !imageSelectionMasksAreEqual(previousSelection, result.selection);
  if (didChange || selectionChanged) commitImageHistory();
  if (selectionChanged) scheduleImageCanvasRender();
  imagePixelRotationDegrees.value = 0;
};

const createImageSelectionClipboard = (
  buffer: PixelBuffer,
  selection: ImageSelection,
): ImageSelectionClipboard | null => {
  const mask = imageSelectionToPixelMask(selection, buffer);
  const bounds = mask?.bounds;
  if (!mask || !bounds) return null;

  const pixels: PixelColor[] = [];
  const relativeMask = new Uint8Array(bounds.width * bounds.height);
  for (let y = 0; y < bounds.height; y += 1) {
    for (let x = 0; x < bounds.width; x += 1) {
      const relativeIndex = y * bounds.width + x;
      const sourceX = bounds.x + x;
      const sourceY = bounds.y + y;
      const sourceIndex = sourceY * buffer.width + sourceX;
      const selected = mask.data[sourceIndex] === 1;
      relativeMask[relativeIndex] = selected ? 1 : 0;
      pixels.push(selected ? (buffer.pixels[sourceIndex] ?? null) : null);
    }
  }

  return {
    block: { width: bounds.width, height: bounds.height, pixels },
    kind: selection.kind ?? "rectangle",
    mask: createPixelSelectionMask(
      { width: bounds.width, height: bounds.height },
      relativeMask,
    ),
  };
};

const clearImageSelectionPixels = (
  buffer: PixelBuffer,
  mask: PixelSelectionMask,
) => {
  const pixels = [...buffer.pixels];
  for (let index = 0; index < mask.data.length; index += 1) {
    if (mask.data[index] === 1) pixels[index] = null;
  }
  return pixels;
};

const placeImageSelectionClipboard = (
  pixels: ReadonlyArray<PixelColor>,
  dimensions: Readonly<{ width: number; height: number }>,
  clipboard: ImageSelectionClipboard,
  origin: Point,
  transparent: "ignore" | "replace" = "ignore",
) => {
  const nextPixels = [...pixels];
  for (let y = 0; y < clipboard.block.height; y += 1) {
    for (let x = 0; x < clipboard.block.width; x += 1) {
      const sourceIndex = y * clipboard.block.width + x;
      if (clipboard.mask.data[sourceIndex] !== 1) continue;
      const destinationX = origin.x + x;
      const destinationY = origin.y + y;
      if (
        destinationX < 0 ||
        destinationX >= dimensions.width ||
        destinationY < 0 ||
        destinationY >= dimensions.height
      ) {
        continue;
      }
      const color = clipboard.block.pixels[sourceIndex] ?? null;
      if (color === null && transparent === "ignore") continue;
      nextPixels[destinationY * dimensions.width + destinationX] = color;
    }
  }
  return nextPixels;
};

const positionImageClipboardMask = (
  mask: PixelSelectionMask,
  origin: Point,
  dimensions = imageCanvasBounds.value,
) => {
  const points: Point[] = [];
  for (let index = 0; index < mask.data.length; index += 1) {
    if (mask.data[index] !== 1) continue;
    points.push({
      x: origin.x + (index % mask.width),
      y: origin.y + Math.floor(index / mask.width),
    });
  }
  return createPointSelectionMask(points, dimensions);
};

const moveImageSelectedPixels = (
  buffer: PixelBuffer,
  selection: ImageSelection,
  delta: Point,
) => {
  const mask = imageSelectionToPixelMask(selection, buffer);
  const clipboard = createImageSelectionClipboard(buffer, selection);
  if (!mask || !clipboard || !mask.bounds) {
    return { pixels: [...buffer.pixels], selection: null as ImageSelection | null };
  }
  const origin = {
    x: mask.bounds.x + Math.round(delta.x),
    y: mask.bounds.y + Math.round(delta.y),
  };
  const cleared = clearImageSelectionPixels(buffer, mask);
  const pixels = placeImageSelectionClipboard(cleared, buffer, clipboard, origin);
  const positionedMask = positionImageClipboardMask(clipboard.mask, origin, buffer);
  return {
    pixels,
    selection: imageSelectionFromPixelMask(
      positionedMask,
      selection.kind ?? "rectangle",
    ),
  };
};

const selectAllImagePixels = () => {
  imageSelectionKind.value = "rectangle";
  imageSelection.value = imageSelectionFromPixelMask(
    createRectangleSelectionMask(
      { x: 0, y: 0 },
      { x: imageGridWidth.value - 1, y: imageGridHeight.value - 1 },
      imageCanvasBounds.value,
    ),
    "rectangle",
  );
  activeImageTool.value = "select";
  commitImageSelectionHistory();
};

const deselectImagePixels = () => {
  imageSelection.value = null;
  commitImageSelectionHistory();
};

const applyImageMutationPixels = (
  pixels: ReadonlyArray<PixelColor>,
  options: { commitHistory?: boolean } = {},
) => {
  const didChange = updateImagePixels([...pixels]);
  if (didChange && options.commitHistory !== false) commitImageHistory();
  return didChange;
};

const deleteImageSelection = () => {
  if (!imageSelection.value || !canMutateActiveImageLayerPixels.value) return;
  const mask = activeImageSelectionMask.value;
  if (!mask) return;
  applyImageMutationPixels(clearImageSelectionPixels(activeImageBuffer(), mask));
};

const copyImageSelection = () => {
  if (!imageSelection.value) return;
  imageClipboard.value = createImageSelectionClipboard(
    activeImageBuffer(),
    imageSelection.value,
  );
};

const cutImageSelection = () => {
  if (!canMutateActiveImageLayerPixels.value) return;
  copyImageSelection();
  deleteImageSelection();
};

const pasteImageSelection = () => {
  const clipboard = imageClipboard.value;
  if (!clipboard || !canMutateActiveImageLayerPixels.value) return;
  const origin = imageSelection.value
    ? { x: imageSelection.value.x, y: imageSelection.value.y }
    : {
        x: Math.floor((imageGridWidth.value - clipboard.block.width) / 2),
        y: Math.floor((imageGridHeight.value - clipboard.block.height) / 2),
      };
  const pixels = placeImageSelectionClipboard(
    imagePixels.value,
    imageCanvasBounds.value,
    clipboard,
    origin,
  );
  const nextSelection = imageSelectionFromPixelMask(
    positionImageClipboardMask(clipboard.mask, origin),
    clipboard.kind,
  );
  const didChangePixels = applyImageMutationPixels(pixels, { commitHistory: false });
  const didChangeSelection = !imageSelectionMasksAreEqual(
    imageSelection.value,
    nextSelection,
  );
  imageSelection.value = nextSelection;
  if (didChangePixels || didChangeSelection) {
    commitImageHistory();
  }
};

const nudgeImageSelection = ({ x, y }: { x: number; y: number }) => {
  if (!canMutateActiveImageLayerPixels.value) return;
  if (imageSelection.value) {
    const previousSelection = imageSelection.value;
    const result = moveImageSelectedPixels(activeImageBuffer(), previousSelection, { x, y });
    const didChangePixels = applyImageMutationPixels(result.pixels, {
      commitHistory: false,
    });
    imageSelection.value = result.selection;
    if (didChangePixels || !imageSelectionMasksAreEqual(previousSelection, result.selection)) {
      commitImageHistory();
    }
    return;
  }

  const mutation = moveLayer(activeImageBuffer(), { x, y });
  applyImageMutationPixels(mutation.buffer.pixels);
};

const transformImagePixels = (
  transform: (block: PixelBlock) => PixelBlock,
) => {
  if (!canMutateActiveImageLayerPixels.value) return;
  if (imageSelection.value) {
    const previousSelection = imageSelection.value;
    const sourceMask = activeImageSelectionMask.value;
    const clipboard = createImageSelectionClipboard(
      activeImageBuffer(),
      previousSelection,
    );
    if (!sourceMask || !sourceMask.bounds || !clipboard) return;

    const block = transform(clipboard.block);
    const transformedMaskBlock = transform({
      width: clipboard.mask.width,
      height: clipboard.mask.height,
      pixels: Array.from(clipboard.mask.data, (selected) =>
        selected === 1 ? "#ffffff" : null,
      ),
    });
    const transformedMask = createPixelSelectionMask(
      { width: transformedMaskBlock.width, height: transformedMaskBlock.height },
      transformedMaskBlock.pixels.map((pixel) => (pixel === null ? 0 : 1)),
    );
    const transformedClipboard: ImageSelectionClipboard = {
      block,
      kind: clipboard.kind,
      mask: transformedMask,
    };
    const origin = { x: sourceMask.bounds.x, y: sourceMask.bounds.y };
    const cleared = clearImageSelectionPixels(activeImageBuffer(), sourceMask);
    const pixels = placeImageSelectionClipboard(
      cleared,
      imageCanvasBounds.value,
      transformedClipboard,
      origin,
      "replace",
    );
    const nextSelection = imageSelectionFromPixelMask(
      positionImageClipboardMask(transformedMask, origin),
      clipboard.kind,
    );
    const didChangePixels = applyImageMutationPixels(pixels, { commitHistory: false });
    const didChangeSelection = !imageSelectionMasksAreEqual(
      previousSelection,
      nextSelection,
    );
    imageSelection.value = nextSelection;
    if (didChangePixels || didChangeSelection) commitImageHistory();
    return;
  }

  const sourceRect = imageSelection.value || {
    x: 0,
    y: 0,
    width: imageGridWidth.value,
    height: imageGridHeight.value,
  };
  const sourceBuffer = activeImageBuffer();
  const block = transform(extractBlock(sourceBuffer, sourceRect));
  const cleared = clearRect(sourceBuffer, sourceRect);
  const origin = {
    x: Math.floor((imageGridWidth.value - block.width) / 2),
    y: Math.floor((imageGridHeight.value - block.height) / 2),
  };
  const placed = placeBlock(cleared.buffer, block, origin, { transparent: "replace" });
  if (applyImageMutationPixels(placed.buffer.pixels, { commitHistory: false })) {
    commitImageHistory();
  }
};

const flipImageHorizontally = () =>
  transformImagePixels((block) => flipBlock(block, "horizontal"));
const flipImageVertically = () =>
  transformImagePixels((block) => flipBlock(block, "vertical"));
const rotateImageClockwise = () =>
  transformImagePixels((block) => rotateBlock90(block, "clockwise"));
const rotateImageCounterclockwise = () =>
  transformImagePixels((block) => rotateBlock90(block, "counterclockwise"));

const downloadImageFile = (blob: Blob, extension: "json" | "png") => {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = `${sanitizeImageFileName(resourceName.value)}.${extension}`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
};

const applyImportedImageDocument = (document: PixelArtDocumentV2) => {
  const importedDocument = clonePixelArtDocument(document);
  imageGridWidth.value = importedDocument.width;
  imageGridHeight.value = importedDocument.height;
  imageLayers.value = importedDocument.layers;
  activeImageLayerId.value = importedDocument.layers[importedDocument.layers.length - 1]?.id || "";
  imageSelection.value = null;
  syncImageDimensionDrafts();
  scheduleImageCanvasRender();
  scheduleImageAutosave();
  commitImageHistory();
  void nextTick(scheduleImagePreviewViewportUpdate);
};

const importImageFile = async (file: File) => {
  if (!canEditImage.value || isImageTransferBusy.value) return;

  isImageTransferBusy.value = true;
  imageTransferNotice.value = "";
  try {
    const isJson = file.type === "application/json" || file.type === "text/json" || /\.json$/i.test(file.name);
    let importedDocument: PixelArtDocumentV2;
    if (isJson) {
      importedDocument = await importPixelArtJson(file);
    } else {
      const rasterOptions = { layerName: file.name.replace(/\.[^.]+$/, "") || "Layer 1" };
      try {
        importedDocument = await importRasterImage(file, rasterOptions);
      } catch (error) {
        if (!(error instanceof RasterImageTooLargeError)) throw error;
        const shouldReduce = window.confirm(
          `${error.width} × ${error.height} exceeds the 256 × 256 limit. Reduce it proportionally with pixel-perfect nearest-neighbor scaling?`,
        );
        if (!shouldReduce) return;
        importedDocument = await importRasterImageReduced(file, rasterOptions);
      }
    }

    if (!window.confirm("Importing this file will replace the current image. Continue?")) {
      return;
    }

    applyImportedImageDocument(importedDocument);
    showImageNotice(
      `Imported ${file.name} (${importedDocument.width} × ${importedDocument.height}).`,
      "success",
    );
  } catch (error) {
    showImageNotice(
      error instanceof Error ? error.message : "The selected file could not be imported.",
      "error",
    );
  } finally {
    isImageTransferBusy.value = false;
  }
};

const exportImagePng = async ({
  scale,
  backgroundColor,
}: {
  scale: PngExportScale;
  backgroundColor: string | null;
}) => {
  if (isImageTransferBusy.value) return;
  isImageTransferBusy.value = true;
  imageTransferNotice.value = "";
  try {
    const blob = await exportPixelArtPng(buildImageDocument(), { scale, backgroundColor });
    downloadImageFile(blob, "png");
    showImageNotice(`PNG exported at ${scale}×.`, "success");
  } catch (error) {
    showImageNotice(error instanceof Error ? error.message : "PNG export failed.", "error");
  } finally {
    isImageTransferBusy.value = false;
  }
};

const exportImageJson = () => {
  try {
    downloadImageFile(exportPixelArtJsonBlob(buildImageDocument()), "json");
    showImageNotice("Sefkira JSON exported.", "success");
  } catch (error) {
    showImageNotice(error instanceof Error ? error.message : "JSON export failed.", "error");
  }
};

const openGifAnimationCreation = (file: File) => {
  const suggestedName = file.name.replace(/\.gif$/i, "").trim() || "Untitled animation";
  showImageNotice("GIF files continue in the animation creation flow.", "info");
  return navigateAfterImageSave(
    `${projectPath.value}?create=pixel_animation&name=${encodeURIComponent(suggestedName)}`,
  );
};

const toggleImageInspectorPanel = (panel: ImageInspectorPanel) => {
  closeImageMobileColorControls(false);
  closeImageLayersDialog(false);
  if (activeImageInspectorPanel.value === panel) {
    activeImageInspectorPanel.value = null;
    return;
  }

  lastImageInspectorPanel.value = panel;
  activeImageInspectorPanel.value = panel;
};

const selectImageInspectorPanel = (panel: ImageInspectorPanel) => {
  lastImageInspectorPanel.value = panel;
  activeImageInspectorPanel.value = panel;
};

const openImageOptionsDialog = () => {
  closeImageMobileColorControls(false);
  closeImageLayersDialog(false);
  activeImageInspectorPanel.value = lastImageInspectorPanel.value;
};

const closeImageInspectorPanel = () => {
  activeImageInspectorPanel.value = null;
};

const setImageMirrorAxis = (axis: ImageMirrorAxis, value: number) => {
  if (axis === "horizontal") {
    imageHorizontalMirrorAxisY.value = clampCanvasMirrorAxis(value, imageGridHeight.value);
    return;
  }

  imageVerticalMirrorAxisX.value = clampCanvasMirrorAxis(value, imageGridWidth.value);
};

const resetImageMirrorAxisToCenter = (axis: ImageMirrorAxis) => {
  setImageMirrorAxis(
    axis,
    axis === "horizontal" ? imageGridHeight.value / 2 : imageGridWidth.value / 2,
  );
};

const isImageMirrorAxisLocked = (axis: ImageMirrorAxis) =>
  axis === "horizontal"
    ? isImageHorizontalMirrorLineLocked.value
    : isImageVerticalMirrorLineLocked.value;

const resetImageMirrorAxisFromHandle = (axis: ImageMirrorAxis) => {
  if (isImageMirrorAxisLocked(axis)) return;
  resetImageMirrorAxisToCenter(axis);
};

const updateImageMirrorAxisFromPointer = (event: PointerEvent, axis: ImageMirrorAxis) => {
  const position = getImageVirtualCanvasPositionFromClientCoordinates(
    event.clientX,
    event.clientY,
  );
  if (!position) return;

  setImageMirrorAxis(axis, axis === "horizontal" ? position.y : position.x);
};

const clearImageMirrorAxisDrag = (restoreStart = false) => {
  const axis = draggingImageMirrorAxis.value;
  const pointerId = imageMirrorAxisPointerId;
  const captureTarget = imageMirrorAxisCaptureTarget;
  const startValue = imageMirrorAxisDragStartValue;
  imageMirrorAxisPointerId = null;
  imageMirrorAxisCaptureTarget = null;
  imageMirrorAxisDragStartValue = null;
  draggingImageMirrorAxis.value = null;

  if (restoreStart && axis && startValue !== null) {
    setImageMirrorAxis(axis, startValue);
  }
  if (pointerId !== null && captureTarget?.hasPointerCapture?.(pointerId)) {
    captureTarget.releasePointerCapture(pointerId);
  }
};

const startImageMirrorAxisDrag = (event: PointerEvent, axis: ImageMirrorAxis) => {
  if (
    isImageMirrorAxisLocked(axis) ||
    imageMirrorAxisPointerId !== null ||
    !event.isPrimary ||
    (event.pointerType === "mouse" && event.button !== 0)
  ) {
    return;
  }

  finishImageInteractionBeforeCanvasModeChange();
  const target = event.currentTarget as HTMLElement;
  imageMirrorAxisPointerId = event.pointerId;
  imageMirrorAxisCaptureTarget = target;
  imageMirrorAxisDragStartValue =
    axis === "horizontal"
      ? imageHorizontalMirrorAxisY.value
      : imageVerticalMirrorAxisX.value;
  draggingImageMirrorAxis.value = axis;
  target.focus({ preventScroll: true });
  target.setPointerCapture?.(event.pointerId);
  updateImageMirrorAxisFromPointer(event, axis);
};

const continueImageMirrorAxisDrag = (event: PointerEvent, axis: ImageMirrorAxis) => {
  if (
    imageMirrorAxisPointerId !== event.pointerId ||
    draggingImageMirrorAxis.value !== axis
  ) {
    return;
  }

  updateImageMirrorAxisFromPointer(event, axis);
};

const finishImageMirrorAxisDrag = (event: PointerEvent, axis: ImageMirrorAxis) => {
  if (
    imageMirrorAxisPointerId !== event.pointerId ||
    draggingImageMirrorAxis.value !== axis
  ) {
    return;
  }

  updateImageMirrorAxisFromPointer(event, axis);
  clearImageMirrorAxisDrag();
};

const cancelImageMirrorAxisDrag = (event: PointerEvent) => {
  if (imageMirrorAxisPointerId !== event.pointerId) return;
  clearImageMirrorAxisDrag(true);
};

const handleImageMirrorAxisKeydown = (event: KeyboardEvent, axis: ImageMirrorAxis) => {
  if (event.key === "Escape" && draggingImageMirrorAxis.value === axis) {
    event.preventDefault();
    event.stopPropagation();
    clearImageMirrorAxisDrag(true);
    return;
  }

  if (isImageMirrorAxisLocked(axis)) return;

  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    event.stopPropagation();
    resetImageMirrorAxisToCenter(axis);
    return;
  }

  const dimension = axis === "horizontal" ? imageGridHeight.value : imageGridWidth.value;
  const current =
    axis === "horizontal"
      ? imageHorizontalMirrorAxisY.value
      : imageVerticalMirrorAxisX.value;
  const step = event.shiftKey ? 1 : 0.5;
  let next: number | null = null;

  if (event.key === "Home") next = 0;
  if (event.key === "End") next = dimension;
  if (event.key === "PageUp") next = current - Math.max(1, dimension / 10);
  if (event.key === "PageDown") next = current + Math.max(1, dimension / 10);
  if (axis === "horizontal" && event.key === "ArrowUp") next = current - step;
  if (axis === "horizontal" && event.key === "ArrowDown") next = current + step;
  if (axis === "vertical" && event.key === "ArrowLeft") next = current - step;
  if (axis === "vertical" && event.key === "ArrowRight") next = current + step;
  if (next === null) return;

  event.preventDefault();
  event.stopPropagation();
  setImageMirrorAxis(axis, next);
};

const finishImageInteractionBeforeCanvasModeChange = () => {
  clearImageMirrorAxisDrag(true);
  if (
    imageInteractionKind.value !== null ||
    imageDesktopRotationGesture !== null ||
    imagePanPointerId !== null ||
    imageViewportPaintPointerId !== null ||
    imageTouchPointers.size > 0
  ) {
    resetImageTouchPointers();
    cancelImageInteraction();
  }
  hoveredImagePixelIndex.value = null;
  hoveredImageVirtualPoint.value = null;
};

const toggleImageHorizontalMirror = () => {
  finishImageInteractionBeforeCanvasModeChange();
  isImageHorizontalMirrorEnabled.value = !isImageHorizontalMirrorEnabled.value;
  scheduleImageCanvasRender();
};

const toggleImageVerticalMirror = () => {
  finishImageInteractionBeforeCanvasModeChange();
  isImageVerticalMirrorEnabled.value = !isImageVerticalMirrorEnabled.value;
  scheduleImageCanvasRender();
};

const toggleImageMirrorLineVisibility = (axis: ImageMirrorAxis) => {
  clearImageMirrorAxisDrag(true);
  if (axis === "horizontal") {
    isImageHorizontalMirrorLineVisible.value = !isImageHorizontalMirrorLineVisible.value;
    return;
  }

  isImageVerticalMirrorLineVisible.value = !isImageVerticalMirrorLineVisible.value;
};

const toggleImageMirrorLineLock = (axis: ImageMirrorAxis) => {
  clearImageMirrorAxisDrag(true);
  if (axis === "horizontal") {
    isImageHorizontalMirrorLineLocked.value = !isImageHorizontalMirrorLineLocked.value;
    return;
  }

  isImageVerticalMirrorLineLocked.value = !isImageVerticalMirrorLineLocked.value;
};

const toggleImageWrapAround = () => {
  finishImageInteractionBeforeCanvasModeChange();
  isImageWrapAroundEnabled.value = !isImageWrapAroundEnabled.value;
  scheduleImageCanvasRender();
  void nextTick(scheduleImagePreviewViewportUpdate);
};

const openImageLayersDialog = () => {
  closeImageMobileColorControls(false);
  closeImageInspectorPanel();
  isImageLayersDialogOpen.value = true;
  void nextTick(() => imageLayersCloseRef.value?.focus({ preventScroll: true }));
};

const closeImageLayersDialog = (restoreFocus = true) => {
  isImageLayersDialogOpen.value = false;
  if (restoreFocus) {
    void nextTick(() => imageLayersTriggerRef.value?.focus({ preventScroll: true }));
  }
};

function openImageMobileColorControls() {
  closeImageInspectorPanel();
  closeImageLayersDialog(false);
  isImageMobileColorControlsOpen.value = true;
  void nextTick(() => imageMobileColorCloseRef.value?.focus({ preventScroll: true }));
}

function closeImageMobileColorControls(restoreFocus = true) {
  isImageMobileColorControlsOpen.value = false;
  if (restoreFocus) {
    void nextTick(() => imageMobileColorTriggerRef.value?.focus({ preventScroll: true }));
  }
}

const selectCustomImageBackground = (event: Event) => {
  const input = event.currentTarget as HTMLInputElement;
  customImageBackground.value = input.value;
  scheduleImageCanvasRender();
};

const selectCustomImageGridColor = (event: Event) => {
  const input = event.currentTarget as HTMLInputElement;
  customImageGridColor.value = input.value;
};

const selectCustomImageSubdivisionColor = (event: Event) => {
  const input = event.currentTarget as HTMLInputElement;
  customImageSubdivisionColor.value = input.value;
};

const selectImageGridLineStyle = (style: ImageGridLineStyle) => {
  imageGridLineStyle.value = style;
  scheduleImageCanvasRender();
};

const selectImageGridSubdivisionThickness = (thickness: ImageGridSubdivisionThickness) => {
  imageGridSubdivisionThickness.value = thickness;
};

const commitImageGridSubdivision = () => {
  const value = Number(imageGridSubdivisionDraft.value);
  const normalized = Math.min(
    MAX_IMAGE_GRID_SUBDIVISION,
    Math.max(MIN_IMAGE_GRID_SUBDIVISION, Number.isFinite(value) ? Math.round(value) : 1),
  );

  imageGridSubdivision.value = normalized;
  imageGridSubdivisionDraft.value = String(normalized);
};

const updateImageGridSubdivisionDraft = (event: Event) => {
  const input = event.currentTarget as HTMLInputElement;
  imageGridSubdivisionDraft.value = input.value;

  if (input.value === "") {
    return;
  }

  commitImageGridSubdivision();
};

const selectImageGridGap = (gap: ImageGridGap) => {
  imageGridGap.value = gap;
  scheduleImageCanvasRender();
};

const updateImageGridLineOpacity = (event: Event) => {
  const input = event.currentTarget as HTMLInputElement;
  const value = Number(input.value);
  imageGridLineOpacity.value = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0.18));
  imageGridLineOpacityDraft.value = imageGridLineOpacity.value.toFixed(2);
};

const commitImageGridLineOpacityDraft = () => {
  const value = Number(imageGridLineOpacityDraft.value);
  const normalized = Math.min(1, Math.max(0, Number.isFinite(value) ? value : imageGridLineOpacity.value));
  imageGridLineOpacity.value = normalized;
  imageGridLineOpacityDraft.value = normalized.toFixed(2);
};

const updateImageGridLineOpacityDraft = (event: Event) => {
  const input = event.currentTarget as HTMLInputElement;
  imageGridLineOpacityDraft.value = input.value;

  if (input.value === "") {
    return;
  }

  const value = Number(input.value);
  if (Number.isFinite(value)) {
    imageGridLineOpacity.value = Math.min(1, Math.max(0, value));
  }
};

const toggleImageDimensionLink = () => {
  areImageDimensionsLinked.value = !areImageDimensionsLinked.value;
};

const currentImagePreferences = (): ImagePreferences =>
  normalizeImagePreferences({
    background: customImageBackground.value,
    gridVisible: isImageGridVisible.value,
    gridColor: customImageGridColor.value,
    gridLineStyle: imageGridLineStyle.value,
    gridOpacity: imageGridLineOpacity.value,
    gridGap: imageGridGap.value,
    subdivision: imageGridSubdivision.value,
    subdivisionColor: customImageSubdivisionColor.value,
    subdivisionThickness: imageGridSubdivisionThickness.value,
    resizeAnchor: imageResizeAnchor.value,
    zoom: imageZoom.value,
  });

const applyImagePreferences = (preferences: ImagePreferences) => {
  isApplyingImagePreferences = true;
  customImageBackground.value = preferences.background;
  isImageGridVisible.value = preferences.gridVisible;
  customImageGridColor.value = preferences.gridColor;
  imageGridLineStyle.value = preferences.gridLineStyle;
  imageGridLineOpacity.value = preferences.gridOpacity;
  imageGridLineOpacityDraft.value = preferences.gridOpacity.toFixed(2);
  imageGridGap.value = preferences.gridGap;
  imageGridSubdivision.value = preferences.subdivision;
  imageGridSubdivisionDraft.value = String(preferences.subdivision);
  customImageSubdivisionColor.value = preferences.subdivisionColor;
  imageGridSubdivisionThickness.value = preferences.subdivisionThickness;
  imageResizeAnchor.value = preferences.resizeAnchor;
  if (preferences.zoom !== undefined) {
    imageZoom.value = preferences.zoom;
    imageZoomMode.value = "custom";
  } else {
    imageZoomMode.value = "fit";
  }
  isApplyingImagePreferences = false;
};

const loadStoredImagePreferences = (userId: string) => {
  imagePreferencesController = useImagePreferences({
    userId,
    resourceId: props.resourceId,
    defaults: { resizeAnchor: imageResizeAnchor.value },
  });
  applyImagePreferences(imagePreferencesController.preferences);
};

const saveStoredImagePreferences = () => {
  if (!imagePreferencesController || isApplyingImagePreferences || isLoading.value) return;
  imagePreferencesController.save({
    ...currentImagePreferences(),
  });
};

const currentImageEditorSession = (): ImageEditorSession => ({
  activeLayerId: activeImageLayerId.value || null,
  primaryColor: selectedImageColor.value,
  secondaryColor: secondaryImageColor.value,
  activeTool: activeImageTool.value,
  brushSize: imageBrushSize.value,
  brushShape: imageBrushShape.value,
  shapeFilled: isImageShapeFilled.value,
  selectionOptions: {
    kind: imageSelectionKind.value,
    mode: imageSelectionMode.value,
    contiguous: isImageSelectionContiguous.value,
  },
  lastInspectorPanel: lastImageInspectorPanel.value,
  preferences: currentImagePreferences(),
  viewport: {
    mode: imageZoomMode.value,
    panX: imagePanX.value,
    panY: imagePanY.value,
    rotationRadians: imageRotationRadians.value,
  },
  canvasModes: {
    horizontalMirror: isImageHorizontalMirrorEnabled.value,
    verticalMirror: isImageVerticalMirrorEnabled.value,
    wrapAround: isImageWrapAroundEnabled.value,
    horizontalAxisY: imageHorizontalMirrorAxisY.value,
    verticalAxisX: imageVerticalMirrorAxisX.value,
    horizontalLineVisible: isImageHorizontalMirrorLineVisible.value,
    verticalLineVisible: isImageVerticalMirrorLineVisible.value,
    horizontalLineLocked: isImageHorizontalMirrorLineLocked.value,
    verticalLineLocked: isImageVerticalMirrorLineLocked.value,
  },
});

const applyImageEditorSession = (value: unknown) => {
  const session = normalizeImageEditorSession(value, currentImageEditorSession());
  if (
    session.activeLayerId &&
    imageLayers.value.some((layer) => layer.id === session.activeLayerId)
  ) {
    activeImageLayerId.value = session.activeLayerId;
  }
  setSelectedImageColor(session.primaryColor);
  secondaryImageColor.value = session.secondaryColor;
  activeImageTool.value = session.activeTool;
  imageBrushSize.value = session.brushSize;
  imageBrushShape.value = session.brushShape;
  isImageShapeFilled.value = session.shapeFilled;
  imageSelectionKind.value = session.selectionOptions.kind;
  imageSelectionMode.value =
    !imageSelection.value &&
    (session.selectionOptions.mode === "subtract" ||
      session.selectionOptions.mode === "intersect")
      ? "replace"
      : session.selectionOptions.mode;
  isImageSelectionContiguous.value = session.selectionOptions.contiguous;
  lastImageInspectorPanel.value = session.lastInspectorPanel;
  applyImagePreferences(session.preferences);
  imageZoomMode.value = session.viewport.mode;
  imagePanX.value = session.viewport.panX;
  imagePanY.value = session.viewport.panY;
  imageRotationRadians.value = session.viewport.rotationRadians;
  isImageHorizontalMirrorEnabled.value = session.canvasModes.horizontalMirror;
  isImageVerticalMirrorEnabled.value = session.canvasModes.verticalMirror;
  isImageWrapAroundEnabled.value = session.canvasModes.wrapAround;
  imageHorizontalMirrorAxisY.value = clampCanvasMirrorAxis(
    session.canvasModes.horizontalAxisY,
    imageGridHeight.value,
  );
  imageVerticalMirrorAxisX.value = clampCanvasMirrorAxis(
    session.canvasModes.verticalAxisX,
    imageGridWidth.value,
  );
  isImageHorizontalMirrorLineVisible.value = session.canvasModes.horizontalLineVisible;
  isImageVerticalMirrorLineVisible.value = session.canvasModes.verticalLineVisible;
  isImageHorizontalMirrorLineLocked.value = session.canvasModes.horizontalLineLocked;
  isImageVerticalMirrorLineLocked.value = session.canvasModes.verticalLineLocked;
  return session;
};

const persistImageEditorSession = (keepalive = false) => {
  if (!isImageEditorSessionReady || !isImageEditor.value || !resource.value) {
    return Promise.resolve();
  }
  if (imageEditorSessionSaveInFlight) {
    imageEditorSessionSaveQueued = true;
    return imageEditorSessionSaveInFlight;
  }

  const state = currentImageEditorSession();
  const serialized = JSON.stringify(state);
  if (serialized === lastSavedImageEditorSession) {
    return Promise.resolve();
  }

  imageEditorSessionSaveQueued = false;
  imageEditorSessionSaveInFlight = putResourceEditorState(
    props.projectId,
    props.resourceId,
    { version: IMAGE_EDITOR_SESSION_VERSION, state },
    { keepalive },
  )
    .then((savedState) => {
      if (savedState) lastSavedImageEditorSession = serialized;
    })
    .catch(() => undefined)
    .finally(() => {
      imageEditorSessionSaveInFlight = null;
      if (imageEditorSessionSaveQueued) scheduleImageEditorSessionSave();
    });
  return imageEditorSessionSaveInFlight;
};

function scheduleImageEditorSessionSave() {
  if (!isImageEditorSessionReady || !isImageEditor.value) return;
  if (imageEditorSessionSaveTimeout !== null) {
    window.clearTimeout(imageEditorSessionSaveTimeout);
  }
  imageEditorSessionSaveTimeout = window.setTimeout(() => {
    imageEditorSessionSaveTimeout = null;
    void persistImageEditorSession();
  }, 700);
}

watch(
  [
    customImageBackground,
    isImageGridVisible,
    customImageGridColor,
    imageGridLineStyle,
    imageGridLineOpacity,
    imageGridGap,
    imageGridSubdivision,
    customImageSubdivisionColor,
    imageGridSubdivisionThickness,
    imageResizeAnchor,
    imageZoom,
  ],
  saveStoredImagePreferences,
);

watch(
  () => (isImageEditor.value ? currentImageEditorSession() : null),
  scheduleImageEditorSessionSave,
  { deep: true },
);

watch(imageSelection, (selection) => {
  if (
    !selection &&
    (imageSelectionMode.value === "subtract" || imageSelectionMode.value === "intersect")
  ) {
    imageSelectionMode.value = "replace";
  }
});

watch([isImageGridVisible, imageGridLineStyle, imageGridGap], () => {
  scheduleImageCanvasRender();
  void nextTick(scheduleImagePreviewViewportUpdate);
});

watch([imageGridWidth, imageGridHeight], ([nextWidth, nextHeight], [previousWidth, previousHeight]) => {
  const horizontalWasCentered =
    Math.abs(imageHorizontalMirrorAxisY.value - previousHeight / 2) < 0.001;
  const verticalWasCentered =
    Math.abs(imageVerticalMirrorAxisX.value - previousWidth / 2) < 0.001;
  imageHorizontalMirrorAxisY.value = horizontalWasCentered
    ? nextHeight / 2
    : clampCanvasMirrorAxis(imageHorizontalMirrorAxisY.value, nextHeight);
  imageVerticalMirrorAxisX.value = verticalWasCentered
    ? nextWidth / 2
    : clampCanvasMirrorAxis(imageVerticalMirrorAxisX.value, nextWidth);

  if (imageZoomMode.value === "fit") {
    void nextTick(scheduleImageFitToScreen);
  }
  void nextTick(scheduleImagePreviewViewportUpdate);
});

const runImageKeyboardAction = (action: ImageKeyboardAction) => {
  switch (action.type) {
    case "select-tool":
      if (canEditImage.value) activeImageTool.value = action.tool;
      break;
    case "undo":
      undoImage();
      break;
    case "redo":
      redoImage();
      break;
    case "select-all":
      selectAllImagePixels();
      break;
    case "copy":
      copyImageSelection();
      break;
    case "cut":
      cutImageSelection();
      break;
    case "paste":
      pasteImageSelection();
      break;
    case "duplicate-layer":
      duplicateImageLayer(activeImageLayerId.value);
      break;
    case "delete-selection":
      deleteImageSelection();
      break;
    case "nudge-selection":
      nudgeImageSelection({ x: action.deltaX, y: action.deltaY });
      break;
    case "escape":
      if (isImageLayersDialogOpen.value) closeImageLayersDialog();
      else if (isImageMobileColorControlsOpen.value) {
        closeImageMobileColorControls();
      } else if (imageSelection.value) deselectImagePixels();
      else closeImageInspectorPanel();
      break;
  }
};

const isImageControlKeyboardTarget = (target: EventTarget | null) => {
  const element = target instanceof Element ? target : null;
  return Boolean(
    element?.closest(
      'button, a[href], summary, [role="button"], [role="slider"], [role="menuitem"], [data-image-shortcuts="off"]',
    ),
  );
};

const handleResourceEditorKeydown = (event: KeyboardEvent) => {
  if (isImageEditor.value && event.key === "Shift") {
    isImageShiftPressed.value = true;
  }

  if (
    isImageEditor.value &&
    event.key === "Escape" &&
    (imageDesktopRotationGesture !== null ||
      imagePanPointerId !== null ||
      imageViewportPaintPointerId !== null ||
      imageTouchPointers.size > 0 ||
      imageTransformGesture !== null)
  ) {
    event.preventDefault();
    resetImageTouchPointers();
    cancelImageInteraction();
    return;
  }

  if (
    !isImageEditor.value ||
    event.defaultPrevented ||
    event.isComposing ||
    activeImageInspectorPanel.value !== null ||
    isImageConflictOpen.value ||
    isDocumentInfoOpen.value ||
    isProfileDialogOpen.value ||
    isEditableKeyboardTarget(event.target) ||
    isImageControlKeyboardTarget(event.target)
  ) {
    return;
  }

  if (imageInteractionKind.value === "rotate") {
    event.preventDefault();
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void saveImageNow();
    return;
  }

  if (
    event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    event.key.toLowerCase() === "w"
  ) {
    event.preventDefault();
    toggleImageWrapAround();
    return;
  }

  if (event.code === "Space") {
    isImageSpacePressed.value = true;
    event.preventDefault();
    return;
  }

  if (!event.ctrlKey && !event.metaKey && !event.altKey) {
    if (event.key === "[") {
      imageBrushSize.value = Math.max(1, imageBrushSize.value - 1);
      event.preventDefault();
      return;
    }
    if (event.key === "]") {
      imageBrushSize.value = Math.min(8, imageBrushSize.value + 1);
      event.preventDefault();
      return;
    }
    if (event.key === "1") {
      fitImageToScreen();
      event.preventDefault();
      return;
    }
    if (event.key === "2") {
      showImageAtActualSize();
      event.preventDefault();
      return;
    }
    if (event.key.toLowerCase() === "x") {
      swapImageColors();
      event.preventDefault();
      return;
    }
  }

  const action = getImageKeyboardAction(event);
  if (!action) return;
  event.preventDefault();
  runImageKeyboardAction(action);
};

const handleResourceEditorKeyup = (event: KeyboardEvent) => {
  if (event.code === "Space") isImageSpacePressed.value = false;
  if (event.key === "Shift") isImageShiftPressed.value = false;
};

const clearImageTemporaryKeys = () => {
  isImageSpacePressed.value = false;
  isImageShiftPressed.value = false;
  clearImageMirrorAxisDrag(true);
  if (
    imageDesktopRotationGesture !== null ||
    imagePanPointerId !== null ||
    imageViewportPaintPointerId !== null ||
    imageTouchPointers.size > 0 ||
    imageTransformGesture !== null
  ) {
    resetImageTouchPointers();
    cancelImageInteraction();
  }
};

const hasImageUnloadRisk = () => {
  const hasUnsavedName =
    isRenamingResource.value &&
    Boolean(resourceNameDraft.value.trim()) &&
    resourceNameDraft.value.trim() !== resource.value?.name;
  return (
    isImageEditor.value &&
    (imageAutosave.hasPendingChanges.value ||
      isResourceNameSaving.value ||
      isPersonalImagePaletteSaving.value ||
      hasUnsavedName ||
      imageConflictOperation.value !== null)
  );
};

const warnBeforeImageUnload = (event: BeforeUnloadEvent) => {
  if (allowImageUnload || !hasImageUnloadRisk()) return;
  event.preventDefault();
  event.returnValue = "";
};

const flushImageBeforePageHide = () => {
  finishRotatingImageFromPointer();
  resetImageTouchPointers();
  isImageSpacePressed.value = false;
  isImageShiftPressed.value = false;
  if (imageAutosave.hasPendingChanges.value) {
    void imageAutosave.flush();
  }
  if (isPersonalImagePaletteSaving.value) {
    void waitForPersonalImagePaletteMutations();
  }
  if (imageEditorSessionSaveTimeout !== null) {
    window.clearTimeout(imageEditorSessionSaveTimeout);
    imageEditorSessionSaveTimeout = null;
  }
  void persistImageEditorSession(true);
};

const handleResourceVisibilityChange = () => {
  if (document.visibilityState !== "visible") {
    broadcastImageCursor(null);
    flushImageCollaborationCursor();
    flushImageCollaborationPixels();
    flushImageCollaborationSelection();
  }
  // Presence belongs to the open document, not the focused browser tab. Keep
  // receiving updates and answering sync requests while it is in the background.
};

const connectResourcePresence = () => {
  projectPresenceConnection?.close();
  projectPresenceConnection = connectProjectPresence(
    props.projectId,
    handleProjectPresenceSync,
    props.resourceId,
    handleProjectEditorActivity,
  );
};

const removeStaleImageCollaborators = () => {
  if (document.visibilityState === "visible" && resource.value) {
    broadcastImageCursor(lastImageCollaborationCursorPosition);
  }
  const cutoff = Date.now() - IMAGE_COLLABORATOR_STALE_MS;
  const entries = Object.entries(remoteImageCollaborators.value).filter(
    ([, collaborator]) => collaborator.lastSeenAt >= cutoff,
  );
  if (entries.length !== Object.keys(remoteImageCollaborators.value).length) {
    remoteImageCollaborators.value = Object.fromEntries(entries);
  }
};

const loadEditor = async () => {
  isLoading.value = true;
  isImageEditorSessionReady = false;
  lastSavedImageEditorSession = "";
  if (imageEditorSessionSaveTimeout !== null) {
    window.clearTimeout(imageEditorSessionSaveTimeout);
    imageEditorSessionSaveTimeout = null;
  }
  errorMessage.value = "";
  let shouldFitImageAfterLoad = true;
  let storedImageEditorState: ResourceEditorStatePublic | null = null;
  let restoredImageEditorSession: ImageEditorSession | null = null;

  try {
    const [workspace, resourceDetail, editorState] = await Promise.all([
      fetchApi<WorkspaceBootstrap>("/workspace/"),
      fetchApi<ProjectResourceDetail>(
        `/projects/${encodeURIComponent(props.projectId)}/resources/${encodeURIComponent(
          props.resourceId,
        )}`,
      ),
      getResourceEditorState(props.projectId, props.resourceId),
    ]);
    storedImageEditorState = editorState;

    if (!resourceDetail) {
      errorMessage.value = "This item is no longer available.";
      return;
    }

    imagePaletteUserId.value = workspace?.user.id || "";
    currentPresenceUserId.value = workspace?.user.id || "";
    personalImagePalette.value = normalizePinnedPaletteColors(
      workspace?.user.pixel_art_palette,
    );

    resource.value = resourceDetail;
    if (editorMetaByType[resourceDetail.type]?.routeKind === "image") {
      let imageData: ReturnType<typeof readImagePixelsFromData>;
      try {
        imageData = readImagePixelsFromData(resourceDetail.data || {});
      } catch (error) {
        errorMessage.value =
          error instanceof PixelArtMigrationError
            ? `${error.message} This resource was left unchanged.`
            : "This image could not be opened safely.";
        return;
      }
      imageGridWidth.value = imageData.document.width;
      imageGridHeight.value = imageData.document.height;
      resetImageMirrorAxisToCenter("horizontal");
      resetImageMirrorAxisToCenter("vertical");
      syncImageDimensionDrafts();
      imageResizeAnchor.value = imageData.anchor;
      imageLayers.value = imageData.document.layers;
      activeImageLayerId.value = imageData.document.layers[imageData.document.layers.length - 1]?.id || "";
      imageSelection.value = null;
      if (imageData.warnings.length > 0) {
        showImageNotice(imageData.warnings.join(" "), "info");
      }
      imageSaveStatus.value = "saved";
      imageSaveError.value = "";
      activeImageTool.value = "pencil";
      setSelectedImageColor(DEFAULT_PENCIL_COLOR);
    }
    project.value =
      workspace?.projects.find((workspaceProject) => workspaceProject.id === props.projectId) || null;
    if (editorMetaByType[resourceDetail.type]?.routeKind === "image") {
      loadStoredImagePreferences(workspace?.user.id || profileEmail.value || "local-user");
      if (storedImageEditorState?.version === IMAGE_EDITOR_SESSION_VERSION) {
        restoredImageEditorSession = applyImageEditorSession(storedImageEditorState.state);
      }
      shouldFitImageAfterLoad = restoredImageEditorSession
        ? restoredImageEditorSession.viewport.mode === "fit"
        : imagePreferencesController?.preferences.zoom === undefined;
      resetImageHistory();
    }

    const routeKind = editorMetaByType[resourceDetail.type]?.routeKind;
    if (routeKind && props.resourceKind !== routeKind) {
      window.history.replaceState(null, "", canonicalResourcePath.value);
    }

  } catch {
    errorMessage.value =
      navigator.onLine === false
        ? "You appear to be offline. Reconnect and try again."
        : "The editor could not be loaded. Check your connection and try again.";
  } finally {
    isLoading.value = false;
  }

  if (
    errorMessage.value ||
    !resource.value ||
    editorMetaByType[resource.value.type]?.routeKind !== "image"
  ) {
    return;
  }

  await nextTick();
  observeImageStage();
  updateImageViewportSize();
  const imageStageBounds = imageStageRef.value?.getBoundingClientRect();
  const loadedArtboardMetrics = imageArtboardMetrics.value;
  const loadedZoomFitsStage = Boolean(
    imageStageBounds &&
    loadedArtboardMetrics.width <= Math.max(1, imageStageBounds.width - 72) &&
    loadedArtboardMetrics.height <= Math.max(1, imageStageBounds.height - 104),
  );
  imageGestureView = null;
  if (restoredImageEditorSession?.viewport.mode === "custom") {
    imagePanX.value = restoredImageEditorSession.viewport.panX;
    imagePanY.value = restoredImageEditorSession.viewport.panY;
    imageRotationRadians.value = restoredImageEditorSession.viewport.rotationRadians;
    imageZoomMode.value = "custom";
    void nextTick(writeCommittedImageTransform);
  } else if (restoredImageEditorSession?.viewport.mode === "actual") {
    showImageAtActualSize();
  } else if (shouldFitImageAfterLoad || !loadedZoomFitsStage) {
    fitImageToScreen();
  } else {
    imagePanX.value = 0;
    imagePanY.value = 0;
    imageRotationRadians.value = 0;
    imageZoomMode.value = "custom";
    void nextTick(writeCommittedImageTransform);
  }
  scheduleImageCanvasRender();
  scheduleImagePreviewViewportUpdate();
  renderImageColorTriangleCanvas();
  for (const activity of pendingProjectEditorActivities.splice(0)) {
    handleProjectEditorActivity(activity);
  }
  sendImageCollaborationActivity("sync-request", {});
  lastSavedImageEditorSession = restoredImageEditorSession
    ? JSON.stringify(restoredImageEditorSession)
    : "";
  isImageEditorSessionReady = true;
  scheduleImageEditorSessionSave();
};

onMounted(() => {
  window.addEventListener("pointerup", finishImagePointerInteraction);
  window.addEventListener("pointercancel", cancelImagePointerInteraction);
  window.addEventListener("keydown", handleResourceEditorKeydown);
  window.addEventListener("keyup", handleResourceEditorKeyup);
  window.addEventListener("blur", clearImageTemporaryKeys);
  window.addEventListener("beforeunload", warnBeforeImageUnload);
  window.addEventListener("pagehide", flushImageBeforePageHide);
  window.addEventListener("resize", updateImageViewportSize);
  document.addEventListener("visibilitychange", handleResourceVisibilityChange);
  imageCollaborationCleanupInterval = window.setInterval(
    removeStaleImageCollaborators,
    4000,
  );
  updateImageViewportSize();
  // The route already identifies the resource, so announce presence while the
  // document, layers, and per-user editor state load in parallel.
  connectResourcePresence();
  void loadEditor().then(() => {
    if (!resource.value) projectPresenceConnection?.setResourceId(null);
  });
});

onUnmounted(() => {
  broadcastImageCursor(null);
  flushImageCollaborationCursor();
  flushImageCollaborationPixels();
  window.removeEventListener("pointerup", finishImagePointerInteraction);
  window.removeEventListener("pointercancel", cancelImagePointerInteraction);
  window.removeEventListener("keydown", handleResourceEditorKeydown);
  window.removeEventListener("keyup", handleResourceEditorKeyup);
  window.removeEventListener("blur", clearImageTemporaryKeys);
  window.removeEventListener("beforeunload", warnBeforeImageUnload);
  window.removeEventListener("pagehide", flushImageBeforePageHide);
  window.removeEventListener("resize", updateImageViewportSize);
  document.removeEventListener("visibilitychange", handleResourceVisibilityChange);
  projectPresenceConnection?.close();
  projectPresenceConnection = null;
  remoteImageCollaborators.value = {};
  if (imageCollaborationCleanupInterval !== null) {
    window.clearInterval(imageCollaborationCleanupInterval);
    imageCollaborationCleanupInterval = null;
  }
  if (imageCollaborationSelectionTimeout !== null) {
    window.clearTimeout(imageCollaborationSelectionTimeout);
    imageCollaborationSelectionTimeout = null;
  }
  imageStageResizeObserver?.disconnect();
  imageStageResizeObserver = null;
  imageTouchViewportGesture?.destroy();
  imageTouchViewportGesture = null;
  clearImageMirrorAxisDrag();
  finishRotatingImageFromPointer();
  resetImageTouchPointers();
  if (imageFitFrame !== null) {
    window.cancelAnimationFrame(imageFitFrame);
    imageFitFrame = null;
  }
  if (imagePreviewViewportFrame !== null) {
    window.cancelAnimationFrame(imagePreviewViewportFrame);
    imagePreviewViewportFrame = null;
  }
  if (imageCanvasRenderFrame !== null) {
    window.cancelAnimationFrame(imageCanvasRenderFrame);
    imageCanvasRenderFrame = null;
  }
  if (imageEditorSessionSaveTimeout !== null) {
    window.clearTimeout(imageEditorSessionSaveTimeout);
    imageEditorSessionSaveTimeout = null;
  }
  void persistImageEditorSession(true);
  void imageAutosave.flush().finally(imageAutosave.dispose);
});
</script>

<template>
  <section class="resource-editor" :style="editorStyle">
    <StudioTopbar
      mode="project"
      center-max-width="min(520px, 38vw)"
      brand-interactive
      brand-aria-label="Back to studio"
      :brand-trail="projectName"
      :brand-trail-pixel-art="projectPixelArt"
      :brand-trail-loading="isLoading"
      brand-trail-interactive
      brand-trail-aria-label="Back to project"
      user-interactive
      :user-name="profileUserName"
      :user-username="profileUsername"
      :user-avatar-url="profileAvatarUrl"
      :user-email="profileEmail"
      :user-pixel-avatar="profilePixelAvatar"
      :user-label="profileEmail || profileUserName"
      @brand-click="returnToStudio"
      @brand-trail-click="returnToProject"
      @user-click="isProfileDialogOpen = true"
    >
      <template #center>
        <button
          type="button"
          class="resource-editor-title"
          :class="{
            'is-loading': isLoading,
          }"
          :disabled="isLoading || Boolean(errorMessage) || !resource"
          :aria-label="`Open information for ${resourceName}`"
          title="Document information"
          aria-haspopup="dialog"
          :aria-expanded="isDocumentInfoOpen"
          aria-controls="resource-document-info-dialog"
          data-image-shortcuts="off"
          @click="openDocumentInfo"
        >
          <span class="resource-editor-title__identity">
            <span class="resource-editor-title__icon" aria-hidden="true">
              <Icon :icon="editorMeta.icon" width="22" height="22" />
            </span>
            <span class="resource-editor-title__name">{{ resourceName }}</span>
            <span class="resource-editor-title__kind">{{ editorMeta.label }}</span>
          </span>
          <span v-if="isImageEditor && !isLoading" class="resource-editor-title__status">
            <ImageSaveStatus
              :status="displayedImageSaveStatus"
              :error="displayedImageSaveError"
              :last-saved-at="effectiveImageLastSavedAt"
              :compact-on-mobile="hasImageDocumentPresence"
              :interactive="false"
              appearance="inline"
            />
            <ImageDocumentPresence
              v-if="!errorMessage"
              :members="projectPresenceMembers"
              :current-user-id="currentPresenceUserId"
              :current-user="currentImagePresenceMember"
            />
          </span>
        </button>
      </template>
    </StudioTopbar>

    <ResourceDocumentInfoDialog
      v-if="!isLoading && !errorMessage && resource"
      :open="isDocumentInfoOpen"
      :close-disabled="isDocumentNameSubmitting || isResourceNameSaving"
      dialog-id="resource-document-info-dialog"
      :type-label="editorMeta.label"
      :details="documentInfoDetails"
      :members="projectPresenceMembers"
      :current-user-id="currentPresenceUserId"
      :current-user="currentImagePresenceMember"
      :show-people="isImageEditor"
      @close="closeDocumentInfo"
    >
      <template #name>
        <form
          v-if="isRenamingResource"
          class="resource-document-info__rename-form"
          @submit.prevent="commitDocumentInfoName"
        >
          <label for="resource-document-name">Document name</label>
          <input
            id="resource-document-name"
            ref="resourceNameInput"
            v-model="resourceNameDraft"
            class="resource-editor-title__name-input"
            type="text"
            maxlength="120"
            required
            autocomplete="off"
            enterkeyhint="done"
            :disabled="isResourceNameSaving || isDocumentNameSubmitting"
            :aria-invalid="Boolean(resourceNameSaveError)"
            :aria-describedby="resourceNameSaveError ? 'resource-document-name-error' : undefined"
          />
          <div class="resource-document-info__rename-actions">
            <button type="button" class="resource-document-info__rename" :disabled="isResourceNameSaving || isDocumentNameSubmitting" @click="cancelDocumentInfoName">Cancel</button>
            <button type="submit" class="resource-document-info__rename resource-document-info__rename--confirm" :disabled="isResourceNameSaving || isDocumentNameSubmitting || !resourceNameDraft.trim()">{{ isResourceNameSaving || isDocumentNameSubmitting ? 'Saving…' : 'Save name' }}</button>
          </div>
        </form>
        <strong v-else class="resource-document-info__name">{{ resourceName }}</strong>
        <button
          v-if="canEditImage && !isRenamingResource"
          ref="resourceRenameButton"
          type="button"
          class="resource-document-info__rename"
          :aria-label="`Rename ${resourceName}`"
          :disabled="isResourceNameSaving || isDocumentNameSubmitting"
          @click="startRenamingResource"
        >Rename</button>
        <p v-if="resourceNameSaveError" id="resource-document-name-error" class="resource-document-info__name-error" role="alert">{{ resourceNameSaveError }}</p>
      </template>
      <template v-if="isImageEditor" #save>
        <ImageSaveStatus
          :status="displayedImageSaveStatus"
          :error="displayedImageSaveError"
          :last-saved-at="effectiveImageLastSavedAt"
          @retry="retryImageSave"
        />
      </template>
    </ResourceDocumentInfoDialog>

    <main class="resource-editor-stage" aria-label="Resource editor">
      <div v-if="isLoading" class="resource-editor-loader" role="status" aria-label="Loading item">
        <span></span>
      </div>

      <div v-else-if="errorMessage" class="resource-editor-error">
        <p>{{ errorMessage }}</p>
        <button type="button" @click="loadEditor">Try again</button>
        <button type="button" @click="returnToProject">Back to project</button>
      </div>

      <div
        v-else
        class="resource-editor-canvas"
        :aria-label="`${editorMeta.label} editor in progress for ${resourceName}`"
      >
        <aside v-if="isImageEditor" class="image-editor-left-dock" aria-label="Drawing tools">
          <ImageToolbar
            class="image-editor-toolbar"
            :active-tool="activeImageTool"
            :can-edit="canEditImage"
            :selection-tool="imageSelectionKind"
            @select-tool="activeImageTool = $event"
          />
        </aside>

        <ImageCanvasModesMenu
          v-if="isImageEditor"
          class="image-editor-canvas-modes"
          :horizontal-mirror="isImageHorizontalMirrorEnabled"
          :horizontal-mirror-line-locked="isImageHorizontalMirrorLineLocked"
          :horizontal-mirror-line-visible="isImageHorizontalMirrorLineVisible"
          :vertical-mirror="isImageVerticalMirrorEnabled"
          :vertical-mirror-line-locked="isImageVerticalMirrorLineLocked"
          :vertical-mirror-line-visible="isImageVerticalMirrorLineVisible"
          :wrap-around="isImageWrapAroundEnabled"
          @center-horizontal-mirror-line="resetImageMirrorAxisToCenter('horizontal')"
          @center-vertical-mirror-line="resetImageMirrorAxisToCenter('vertical')"
          @toggle-horizontal-mirror="toggleImageHorizontalMirror"
          @toggle-horizontal-mirror-line-lock="toggleImageMirrorLineLock('horizontal')"
          @toggle-horizontal-mirror-line-visibility="toggleImageMirrorLineVisibility('horizontal')"
          @toggle-vertical-mirror="toggleImageVerticalMirror"
          @toggle-vertical-mirror-line-lock="toggleImageMirrorLineLock('vertical')"
          @toggle-vertical-mirror-line-visibility="toggleImageMirrorLineVisibility('vertical')"
          @toggle-wrap-around="toggleImageWrapAround"
        />

        <div
          v-if="isImageEditor"
          id="image-editor-floating-layers"
          class="image-editor-floating-layers"
        >
          <button
            ref="imageLayersTriggerRef"
            type="button"
            class="image-editor-layers-trigger"
            aria-haspopup="dialog"
            :aria-expanded="isImageLayersDialogOpen"
            aria-controls="image-editor-layers-dialog"
            @click="openImageLayersDialog"
          >
            <Layers3 :size="17" :stroke-width="2" aria-hidden="true" />
            <span>Layers</span>
            <small>{{ imageLayers.length }}</small>
          </button>

          <div
            class="image-editor-layers-dialog-layer"
            :class="{ 'is-open': isImageLayersDialogOpen }"
            :aria-hidden="!isImageLayersDialogOpen"
            :inert="!isImageLayersDialogOpen"
            @pointerdown.self="closeImageLayersDialog()"
          >
            <section
              id="image-editor-layers-dialog"
              class="image-editor-layers-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="Layers"
              @keydown.esc.stop.prevent="closeImageLayersDialog()"
            >
              <button
                ref="imageLayersCloseRef"
                type="button"
                class="image-editor-layers-dialog__close"
                aria-label="Close layers"
                @click="closeImageLayersDialog()"
              >
                <X :size="17" :stroke-width="2" aria-hidden="true" />
              </button>
              <div class="image-editor-layers-host">
                <ImageLayersPanel
                  :layers="imageLayers"
                  :active-layer-id="activeImageLayerId"
                  :can-edit="canEditImage"
                  :image-width="imageGridWidth"
                  :image-height="imageGridHeight"
                  @select="selectImageLayer"
                  @add="addImageLayer"
                  @duplicate="duplicateImageLayer"
                  @remove="removeImageLayer"
                  @rename="renameImageLayer"
                  @toggle-visible="toggleImageLayerVisibility"
                  @toggle-lock="toggleImageLayerLock"
                  @preview-opacity="previewImageLayerOpacity"
                  @set-opacity="setImageLayerOpacity"
                  @move="moveImageLayer"
                  @reorder="reorderImageLayer"
                />
              </div>
            </section>
          </div>
        </div>

        <ImageOptionsToolbar
          v-if="isImageEditor"
          id="image-editor-options-rail"
          class="image-editor-options-rail"
          :class="{ 'is-dialog-open': activeImageInspectorPanel !== null }"
          :active-panel="activeImageInspectorPanel"
          @open="selectImageInspectorPanel"
        />

        <ImageOptionsDialog
          v-if="isImageEditor"
          auxiliary-controls-id="image-editor-options-rail"
          content-sized
          dialog-id="image-editor-options-dialog"
          :label="`${activeImageInspectorLabel} options`"
          :open="activeImageInspectorPanel !== null"
          @close="closeImageInspectorPanel"
        >
          <section
            v-if="activeImageInspectorPanel"
            class="image-editor-inspector-panel is-content-sized"
            :aria-label="`${activeImageInspectorLabel} options`"
          >
            <div class="image-editor-inspector-header">
              <div class="image-editor-inspector-title">
                <Ruler
                  v-if="activeImageInspectorPanel === 'resize'"
                  :size="15"
                  :stroke-width="2.2"
                  aria-hidden="true"
                />
                <MousePointer2
                  v-else-if="activeImageInspectorPanel === 'transform'"
                  :size="15"
                  :stroke-width="2.2"
                  aria-hidden="true"
                />
                <Download
                  v-else-if="activeImageInspectorPanel === 'transfer'"
                  :size="15"
                  :stroke-width="2.2"
                  aria-hidden="true"
                />
                <SlidersHorizontal
                  v-else
                  :size="15"
                  :stroke-width="2.2"
                  aria-hidden="true"
                />
                <span>{{ activeImageInspectorLabel }}</span>
              </div>
              <button
                type="button"
                class="image-editor-inspector-close"
                data-image-dialog-initial-focus
                aria-label="Close image options"
                title="Close"
                @click="closeImageInspectorPanel"
              >
                <X :size="14" :stroke-width="2.4" aria-hidden="true" />
              </button>
            </div>

            <ImageOptionsToolbar
              class="image-editor-options-tabs"
              variant="tabs"
              :active-panel="activeImageInspectorPanel"
              @open="selectImageInspectorPanel"
            />

            <div class="image-editor-dialog-notice-host">
              <ImageEditorNotice
                :message="imageTransferNotice"
                :tone="imageTransferNoticeTone"
                @dismiss="imageTransferNotice = ''"
              />
            </div>

            <div
              v-if="activeImageInspectorPanel === 'resize'"
              class="image-editor-settings-page image-editor-resize-settings"
              aria-label="Resize options"
            >
              <div class="image-editor-dimensions">
                <div class="image-editor-control-heading">Size</div>
                <div class="image-editor-size-row">
                  <label class="image-editor-size-field" for="image-editor-width-input">Width:</label>
                  <input
                    id="image-editor-width-input"
                    class="image-editor-size-input"
                    type="number"
                    inputmode="numeric"
                    :min="MIN_IMAGE_DIMENSION"
                    :max="MAX_IMAGE_DIMENSION"
                    step="1"
                    :value="imageGridWidthDraft"
                    aria-label="Workspace width"
                    @input="updateImageWidthDraft"
                    @keydown.enter.prevent="applyImageWidthDraft"
                    @blur="applyImageWidthDraft"
                  />
                </div>
                <div class="image-editor-size-row">
                  <label class="image-editor-size-field" for="image-editor-height-input">Height:</label>
                  <input
                    id="image-editor-height-input"
                    class="image-editor-size-input"
                    type="number"
                    inputmode="numeric"
                    :min="MIN_IMAGE_DIMENSION"
                    :max="MAX_IMAGE_DIMENSION"
                    step="1"
                    :value="imageGridHeightDraft"
                    aria-label="Workspace height"
                    @input="updateImageHeightDraft"
                    @keydown.enter.prevent="applyImageHeightDraft"
                    @blur="applyImageHeightDraft"
                  />
                </div>
                <div class="image-editor-dimension-link-row">
                  <button
                    type="button"
                    class="image-editor-dimension-link"
                    :class="{ 'is-active': areImageDimensionsLinked }"
                    :aria-pressed="areImageDimensionsLinked"
                    :aria-label="areImageDimensionsLinked ? 'Unlink width and height' : 'Link width and height'"
                    :title="areImageDimensionsLinked ? 'Unlink size' : 'Link size'"
                    @click="toggleImageDimensionLink"
                  >
                    <Link2 v-if="areImageDimensionsLinked" :size="13" :stroke-width="2.2" aria-hidden="true" />
                    <Link2Off v-else :size="13" :stroke-width="2.2" aria-hidden="true" />
                  </button>
                  <span class="image-editor-dimension-link-label">
                    {{ areImageDimensionsLinked ? "Linked" : "Unlinked" }}
                  </span>
                </div>
              </div>
              <div class="image-editor-anchor-field" aria-label="Resize anchor">
                <div class="image-editor-control-heading">Anchor</div>
                <div class="image-editor-anchor-grid">
                  <button
                    v-for="anchor in IMAGE_RESIZE_ANCHORS"
                    :key="anchor.value"
                    type="button"
                    :class="{
                      'is-active': imageResizeAnchor === anchor.value,
                      'has-expansion-arrow': imageAnchorExpansionDirection(anchor.value),
                    }"
                    :aria-label="`Anchor ${anchor.label}`"
                    :aria-pressed="imageResizeAnchor === anchor.value"
                    :title="anchor.label"
                    @click="selectImageResizeAnchor(anchor.value)"
                  >
                    <span aria-hidden="true">
                      <i
                        v-if="imageResizeAnchor === anchor.value"
                        class="is-anchor"
                        aria-hidden="true"
                      ></i>
                      <i
                        v-else-if="imageAnchorExpansionDirection(anchor.value)"
                        class="is-arrow"
                        :class="`is-${imageAnchorExpansionDirection(anchor.value)}`"
                        aria-hidden="true"
                      ></i>
                    </span>
                  </button>
                </div>
              </div>
            </div>

            <div
              v-else-if="activeImageInspectorPanel === 'preferences'"
              class="image-editor-settings-page image-editor-preferences"
              aria-label="Preference options"
            >
              <div class="image-editor-preference-group">
                <div class="image-editor-control-heading">View</div>
                <div class="image-editor-preference-row">
                  <span class="image-editor-preference-label">Background</span>
                  <div class="image-editor-grid-color-list" aria-label="Canvas background">
                    <label
                      class="image-editor-background-color-picker"
                      aria-label="Use custom background color"
                      title="Background color"
                      :style="{ '--custom-background-color': customImageBackground }"
                    >
                      <input
                        type="color"
                        :value="customImageBackground"
                        @input="selectCustomImageBackground"
                      />
                    </label>
                  </div>
                </div>
              </div>

              <div class="image-editor-preference-group">
                <div class="image-editor-control-heading">Grid</div>
                <label class="image-editor-toggle-row">
                  <span>Show grid</span>
                  <input v-model="isImageGridVisible" type="checkbox" />
                </label>
                <div class="image-editor-grid-subheading">Main lines</div>
                <div class="image-editor-preference-row">
                  <span class="image-editor-preference-label">Color</span>
                  <div class="image-editor-grid-color-list" aria-label="Grid color">
                    <label
                      class="image-editor-grid-color-picker"
                      aria-label="Choose grid color"
                      title="Grid color"
                      :style="{ '--custom-grid-color': customImageGridColor }"
                    >
                      <input
                        type="color"
                        :value="customImageGridColor"
                        :disabled="!isImageGridVisible"
                        @input="selectCustomImageGridColor"
                      />
                    </label>
                  </div>
                </div>
                <div class="image-editor-preference-row">
                  <span class="image-editor-preference-label">Style</span>
                  <div class="image-editor-segment-list" aria-label="Grid line style">
                    <button
                      v-for="option in IMAGE_GRID_LINE_STYLE_OPTIONS"
                      :key="option.value"
                      type="button"
                      class="image-editor-segment-button"
                      :class="{ 'is-active': imageGridLineStyle === option.value }"
                      :aria-pressed="imageGridLineStyle === option.value"
                      :disabled="!isImageGridVisible"
                      @click="selectImageGridLineStyle(option.value)"
                    >
                      {{ option.label }}
                    </button>
                  </div>
                </div>
                <div class="image-editor-range-row">
                  <label for="image-grid-opacity-input">Opacity</label>
                  <input
                    id="image-grid-opacity-input"
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    :disabled="!isImageGridVisible"
                    :value="imageGridLineOpacity"
                    @input="updateImageGridLineOpacity"
                  />
                  <input
                    class="image-editor-opacity-input"
                    type="number"
                    inputmode="decimal"
                    min="0"
                    max="1"
                    step="0.01"
                    :disabled="!isImageGridVisible"
                    :value="imageGridLineOpacityDraft"
                    aria-label="Grid opacity value"
                    @input="updateImageGridLineOpacityDraft"
                    @blur="commitImageGridLineOpacityDraft"
                  />
                </div>
                <div class="image-editor-preference-row">
                  <span class="image-editor-preference-label">Thickness</span>
                  <div class="image-editor-gap-list" aria-label="Grid line thickness">
                    <button
                      v-for="gap in IMAGE_GRID_GAP_OPTIONS"
                      :key="gap"
                      type="button"
                      class="image-editor-gap-button"
                      :class="{ 'is-active': imageGridGap === gap }"
                      :aria-label="`${gap} pixel grid line thickness`"
                      :aria-pressed="imageGridGap === gap"
                      :disabled="!isImageGridVisible"
                      @click="selectImageGridGap(gap)"
                    >
                      {{ gap }}
                    </button>
                  </div>
                </div>
                <div class="image-editor-grid-subheading">Subdivisions</div>
                <div class="image-editor-preference-row">
                  <span class="image-editor-preference-label">Every</span>
                  <input
                    class="image-editor-preference-number-input"
                    type="number"
                    inputmode="numeric"
                    :min="MIN_IMAGE_GRID_SUBDIVISION"
                    :max="MAX_IMAGE_GRID_SUBDIVISION"
                    step="1"
                    :disabled="!isImageGridVisible"
                    :value="imageGridSubdivisionDraft"
                    aria-label="Subdivision interval"
                    @input="updateImageGridSubdivisionDraft"
                    @blur="commitImageGridSubdivision"
                  />
                </div>
                <div class="image-editor-preference-row">
                  <span class="image-editor-preference-label">Color</span>
                  <div class="image-editor-grid-color-list" aria-label="Subdivision color">
                    <label
                      class="image-editor-subdivision-color-picker"
                      aria-label="Choose subdivision color"
                      title="Subdivision color"
                      :style="{ '--custom-subdivision-color': customImageSubdivisionColor }"
                    >
                      <input
                        type="color"
                        :value="customImageSubdivisionColor"
                        :disabled="!isImageGridVisible || imageGridSubdivision === 1"
                        @input="selectCustomImageSubdivisionColor"
                      />
                    </label>
                  </div>
                </div>
                <div class="image-editor-preference-row">
                  <span class="image-editor-preference-label">Thickness</span>
                  <div class="image-editor-gap-list" aria-label="Subdivision thickness">
                    <button
                      v-for="thickness in IMAGE_GRID_SUBDIVISION_THICKNESS_OPTIONS"
                      :key="thickness"
                      type="button"
                      class="image-editor-gap-button"
                      :class="{ 'is-active': imageGridSubdivisionThickness === thickness }"
                      :aria-label="`${thickness} pixel subdivision thickness`"
                      :aria-pressed="imageGridSubdivisionThickness === thickness"
                      :disabled="!isImageGridVisible || imageGridSubdivision === 1"
                      @click="selectImageGridSubdivisionThickness(thickness)"
                    >
                      {{ thickness }}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <ImageTransformPanel
              v-else-if="activeImageInspectorPanel === 'transform'"
              class="image-editor-transform-host"
              :selection="imageSelection"
              :can-edit="canMutateActiveImageLayerPixels"
              :has-clipboard="Boolean(imageClipboard)"
              @select-all="selectAllImagePixels"
              @deselect="deselectImagePixels"
              @delete="deleteImageSelection"
              @copy="copyImageSelection"
              @cut="cutImageSelection"
              @paste="pasteImageSelection"
              @flip-horizontal="flipImageHorizontally"
              @flip-vertical="flipImageVertically"
              @rotate-clockwise="rotateImageClockwise"
              @rotate-counterclockwise="rotateImageCounterclockwise"
              @nudge="nudgeImageSelection"
            />

            <ImageImportExportPanel
              v-else
              class="image-editor-transfer-host"
              :can-edit="canEditImage"
              :default-background-color="customImageBackground"
              :is-busy="isImageTransferBusy"
              @import-file="importImageFile"
              @create-animation="openGifAnimationCreation"
              @export-png="exportImagePng"
              @export-json="exportImageJson"
            />
          </section>
        </ImageOptionsDialog>

        <div v-if="isImageEditor" class="image-editor-context-host">
          <ImageToolOptions
            :active-tool="activeImageTool"
            :brush-size="imageBrushSize"
            :brush-shape="imageBrushShape"
            :shape-filled="isImageShapeFilled"
            :selection-tool="imageSelectionKind"
            :selection-mode="imageSelectionMode"
            :selection-contiguous="isImageSelectionContiguous"
            :has-selection="imageSelection !== null"
            :rotation-degrees="imagePixelRotationDegrees"
            :rotation-busy="imageInteractionKind === 'rotate'"
            :can-rotate="canMutateActiveImageLayerPixels"
            :can-undo="canUndoImage"
            :can-redo="canRedoImage"
            :can-edit="canEditImage"
            @update:brush-size="imageBrushSize = $event"
            @update:brush-shape="imageBrushShape = $event"
            @update:shape-filled="isImageShapeFilled = $event"
            @update:selection-tool="imageSelectionKind = $event"
            @update:selection-mode="imageSelectionMode = $event"
            @update:selection-contiguous="isImageSelectionContiguous = $event"
            @update:rotation-degrees="imagePixelRotationDegrees = $event"
            @apply-rotation="applyImagePixelRotation"
            @undo="undoImage"
            @redo="redoImage"
          />
          <button
            type="button"
            class="image-editor-mobile-options-trigger"
            aria-haspopup="dialog"
            aria-controls="image-editor-options-dialog"
            :aria-expanded="activeImageInspectorPanel !== null"
            aria-label="Open image options"
            title="Image options"
            @click="openImageOptionsDialog"
          >
            <SlidersHorizontal :size="18" :stroke-width="2" aria-hidden="true" />
          </button>
        </div>

        <section
          v-if="isImageEditor"
          ref="imageStageRef"
          class="image-editor-viewport"
          :class="{
            'is-pan-ready':
              isImageSpacePressed &&
              !isImageShiftPressed &&
              !isPaintingImage &&
              !isImagePinching &&
              imageInteractionKind === null &&
              imageViewportPaintPointerId === null,
            'is-rotate-ready':
              isImageSpacePressed &&
              isImageShiftPressed &&
              !isPaintingImage &&
              !isImagePinching &&
              imageInteractionKind === null &&
              imageViewportPaintPointerId === null,
            'is-panning': isPanningImage,
            'is-rotating': isRotatingImage,
            'is-pinching': isImagePinching,
            'is-pixel-mutation-blocked': isImagePixelMutationBlocked,
          }"
          :aria-label="imageViewportAriaLabel"
          tabindex="-1"
          @pointerdown.self.prevent="startImageViewportPointerInteraction"
          @pointermove.self.prevent="continueImagePointerInteraction"
          @pointerup.self="finishImagePointerInteraction"
          @pointercancel.self="cancelImagePointerInteraction"
          @lostpointercapture.self="cancelImagePointerInteraction"
          @pointerleave="leaveImageViewport"
          @wheel.stop.prevent="zoomImageFromWheel"
          @auxclick.self.prevent
          @contextmenu.self.prevent
        >
          <div
            class="image-editor-mobile-color-layer"
            :class="{ 'is-mobile-open': isImageMobileColorControlsOpen }"
            :aria-hidden="isImageMobileViewport && !isImageMobileColorControlsOpen"
            :inert="isImageMobileViewport && !isImageMobileColorControlsOpen"
          >
            <button
              type="button"
              class="image-editor-mobile-color-backdrop"
              aria-label="Close colors and palette"
              @click="closeImageMobileColorControls()"
            ></button>
            <section
              id="image-editor-mobile-colors"
              class="image-editor-mobile-color-sheet"
              :role="isImageMobileViewport ? 'dialog' : undefined"
              :aria-modal="isImageMobileViewport ? 'true' : undefined"
              aria-labelledby="image-editor-mobile-color-title"
              @keydown.esc.stop.prevent="closeImageMobileColorControls()"
            >
              <header class="image-editor-mobile-color-header">
                <strong id="image-editor-mobile-color-title">Colors &amp; palette</strong>
                <button
                  ref="imageMobileColorCloseRef"
                  type="button"
                  aria-label="Close colors and palette"
                  @click="closeImageMobileColorControls()"
                >
                  <X :size="20" :stroke-width="2" aria-hidden="true" />
                </button>
              </header>

              <div class="image-editor-mobile-color-content">
                <div
                  ref="imageColorPickerRef"
                  class="image-editor-floating-color-picker"
                  :style="imageColorPickerStyle"
                  role="group"
                  aria-label="Color picker"
                >
                  <div class="image-editor-color-picker-stage">
                    <div
                      class="image-editor-color-wheel"
                      aria-label="Hue"
                      @pointerdown.prevent="startImageHueSelection"
                      @pointermove.prevent="updateImageHueFromPointer"
                    >
                      <span
                        class="image-editor-color-hue-handle"
                        :style="imageColorHueHandleStyle"
                        aria-hidden="true"
                      ></span>
                    </div>
                    <div
                      class="image-editor-color-triangle"
                      aria-label="Saturation and brightness"
                      @pointerdown.prevent="startImageColorTriangleSelection"
                      @pointermove.prevent="updateImageColorTriangleFromPointer"
                    >
                      <canvas ref="imageColorTriangleCanvasRef" aria-hidden="true"></canvas>
                      <svg viewBox="0 0 196 184" aria-hidden="true" focusable="false">
                        <polygon points="98 0 0 184 196 184" fill="transparent" />
                      </svg>
                      <span
                        class="image-editor-color-triangle-handle"
                        :style="imageColorTriangleHandleStyle"
                        aria-hidden="true"
                      ></span>
                    </div>
                  </div>
                </div>

                <section
                  class="image-editor-mobile-color-panel"
                  :style="imageColorPickerStyle"
                  aria-label="Drawing colors"
                >
                  <div class="image-editor-color-value" aria-label="Selected color">
                    <span aria-hidden="true"></span>
                    <input
                      :value="selectedImageColorDraft"
                      aria-label="Selected color hex value"
                      inputmode="text"
                      maxlength="9"
                      spellcheck="false"
                      :disabled="!canEditImage"
                      @blur="commitSelectedImageColorInput"
                      @input="updateSelectedImageColorFromInput"
                    />
                    <button
                      type="button"
                      class="image-editor-color-add"
                      aria-label="Add selected color to palette"
                      title="Pin color to your personal palette"
                      :disabled="!canManagePersonalImagePalette"
                      @click="pinImagePaletteColor()"
                    >
                      <Plus :size="15" :stroke-width="2.2" aria-hidden="true" />
                    </button>
                  </div>

                  <ImageColorSwatches
                    class="image-editor-color-swatches-host"
                    :primary-color="selectedImageColor"
                    :secondary-color="secondaryImageColor"
                    :can-edit="canEditImage"
                    @swap="swapImageColors"
                    @reset="resetImageColors"
                    @update:primary-color="setSelectedImageColor"
                    @update:secondary-color="setSecondaryImageColor"
                  />
                </section>

                <div class="image-editor-floating-palette">
                  <ImagePalettePanel
                    :swatches="usedImagePaletteColors"
                    :pinned-colors="personalImagePalette"
                    :primary-color="selectedImageColor"
                    :secondary-color="secondaryImageColor"
                    :can-select="canEditImage"
                    :can-manage="canManagePersonalImagePalette"
                    @select-primary="selectImagePaletteColor"
                    @select-secondary="selectSecondaryImagePaletteColor"
                    @pin="pinImagePaletteColor"
                    @edit="editImagePaletteColor"
                    @remove="unpinImagePaletteColor"
                  />
                </div>
              </div>
            </section>
          </div>
          <div
            class="image-editor-preview"
            :style="imageFloatingPreviewStyle"
            aria-hidden="true"
          >
            <div
              class="image-editor-preview__grid"
              :style="imagePreviewGridStyle"
              aria-hidden="true"
            >
              <canvas ref="imagePreviewCanvasRef"></canvas>
              <span
                v-if="imagePreviewViewport.visible && !isImageWrapAroundEnabled"
                class="image-editor-preview__viewport"
                :style="imagePreviewViewportStyle"
              ></span>
            </div>
          </div>
          <ImageEditorNotice
            v-if="activeImageInspectorPanel === null"
            class="image-editor-notice-host"
            :message="imageTransferNotice"
            :tone="imageTransferNoticeTone"
            @dismiss="imageTransferNotice = ''"
          />
          <div
            ref="imageArtboardRef"
            class="image-editor-artboard"
            :class="{
              'is-panning': isPanningImage,
              'is-rotating': isRotatingImage,
              'is-pinching': isImagePinching,
              'is-pixel-mutation-blocked': isImagePixelMutationBlocked,
              'is-wrap-around': isImageWrapAroundEnabled,
              'has-mirror-guides':
                (isImageHorizontalMirrorEnabled && isImageHorizontalMirrorLineVisible) ||
                (isImageVerticalMirrorEnabled && isImageVerticalMirrorLineVisible),
            }"
            :style="imageCanvasGridStyle"
            :aria-label="imageArtboardAriaLabel"
            tabindex="0"
            @pointerdown.prevent="startImageArtboardPointerInteraction"
            @pointermove.prevent="continueImagePointerInteraction"
            @pointerup="finishImagePointerInteraction"
            @pointercancel="cancelImagePointerInteraction"
            @lostpointercapture="cancelImagePointerInteraction"
            @pointerleave="leaveImageCanvas"
            @auxclick.prevent
            @contextmenu.prevent
          >
            <div
              v-if="isImageWrapAroundEnabled && imageWrapTileDataUrl"
              class="image-editor-wrap-surface"
              :style="imageWrapSurfaceStyle"
              aria-hidden="true"
            ></div>
            <canvas
              ref="imageCanvasRef"
              class="image-editor-canvas-bitmap"
              :style="imageCanvasBitmapStyle"
            >
              Pixel art preview. Use the editor tools and keyboard shortcuts to modify the image.
            </canvas>
            <span
              v-if="activeImageTool === 'rotate'"
              class="image-editor-pixel-rotation-pivot"
              :style="imagePixelRotationPivotStyle"
              aria-hidden="true"
            ></span>
            <svg
              v-if="imageGridOverlayOpacity > 0"
              class="image-editor-grid-overlay"
              :width="imageGridOverlayPlan.cssWidth"
              :height="imageGridOverlayPlan.cssHeight"
              :viewBox="`0 0 ${imageGridOverlayPlan.cssWidth} ${imageGridOverlayPlan.cssHeight}`"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <template v-if="imageGridLineStyle !== 'dots'">
                <path
                  v-if="imageGridOverlayPath"
                  :d="imageGridOverlayPath"
                  :stroke="customImageGridColor"
                  :stroke-width="imageGridStrokeWidth"
                  :stroke-opacity="imageGridOverlayOpacity"
                  :stroke-dasharray="imageGridLineStyle === 'dashed' ? imageGridDashArray : undefined"
                  fill="none"
                  shape-rendering="crispEdges"
                  stroke-linecap="butt"
                  vector-effect="non-scaling-stroke"
                />
              </template>
              <template v-else-if="hasImageGridDotIntersections">
                <defs>
                  <pattern
                    :id="imageGridDotPatternId"
                    :x="-imageGridOverlayPlan.step / 2"
                    :y="-imageGridOverlayPlan.step / 2"
                    :width="imageGridOverlayPlan.step"
                    :height="imageGridOverlayPlan.step"
                    patternUnits="userSpaceOnUse"
                    patternContentUnits="userSpaceOnUse"
                  >
                    <circle
                      :cx="imageGridOverlayPlan.step / 2"
                      :cy="imageGridOverlayPlan.step / 2"
                      :r="imageGridDotRadius"
                      :fill="customImageGridColor"
                      :fill-opacity="imageGridOverlayOpacity"
                    />
                  </pattern>
                </defs>
                <rect
                  :x="imageGridDotClipRect.x"
                  :y="imageGridDotClipRect.y"
                  :width="imageGridDotClipRect.width"
                  :height="imageGridDotClipRect.height"
                  :fill="`url(#${imageGridDotPatternId})`"
                />
              </template>
            </svg>
            <span
              v-for="line in imageSubdivisionVerticalLines"
              :key="`image-subdivision-column-${line.index}`"
              class="image-editor-subdivision-line is-vertical"
              :style="line.style"
              aria-hidden="true"
            ></span>
            <span
              v-for="line in imageSubdivisionHorizontalLines"
              :key="`image-subdivision-row-${line.index}`"
              class="image-editor-subdivision-line is-horizontal"
              :style="line.style"
              aria-hidden="true"
            ></span>
            <template
              v-if="
                hoveredImagePixelIndex !== null &&
                !isImageBrushHoverPreview &&
                !isImageGraffitiHoverPreview &&
                (!isActiveImagePixelMutationTool || canMutateActiveImageLayerPixels)
              "
            >
              <span
                v-for="cell in imageSingleHoverCells"
                :key="`image-single-hover-${cell.key}`"
                class="image-editor-hover-cell"
                :style="cell.style"
                aria-hidden="true"
              ></span>
            </template>
            <span
              v-for="cell in imageBrushHoverCells"
              :key="`image-brush-hover-${cell.key}`"
              class="image-editor-hover-cell is-brush"
              :style="cell.style"
              aria-hidden="true"
            ></span>
            <span
              v-for="cell in imageGraffitiHoverCells"
              :key="`image-graffiti-hover-${cell.key}`"
              class="image-editor-hover-cell is-graffiti"
              :style="cell.style"
              aria-hidden="true"
            ></span>
            <svg
              v-if="imageSelectionOutlinePath"
              class="image-editor-selection"
              :viewBox="`0 0 ${imageGridWidth} ${imageGridHeight}`"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <path
                class="image-editor-selection__base"
                :d="imageSelectionOutlinePath"
                vector-effect="non-scaling-stroke"
              />
              <path
                class="image-editor-selection__ants"
                :d="imageSelectionOutlinePath"
                vector-effect="non-scaling-stroke"
              />
            </svg>
            <template
              v-for="collaborator in remoteImageCollaboratorList"
              :key="`remote-collaborator-${collaborator.clientId}`"
            >
              <svg
                v-if="remoteImageSelectionOutlinePath(collaborator)"
                class="image-editor-remote-selection"
                :style="{ '--image-collaborator-color': collaborator.color }"
                :viewBox="`0 0 ${imageGridWidth} ${imageGridHeight}`"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <path
                  :d="remoteImageSelectionOutlinePath(collaborator)"
                  vector-effect="non-scaling-stroke"
                />
              </svg>
            </template>
            <div
              v-if="isImageHorizontalMirrorEnabled && isImageHorizontalMirrorLineVisible"
              class="image-editor-mirror-axis is-horizontal"
              :style="imageHorizontalMirrorAxisStyle"
            >
              <span class="image-editor-mirror-axis__line" aria-hidden="true"></span>
              <span
                class="image-editor-mirror-axis__handle"
                :class="{
                  'is-dragging': draggingImageMirrorAxis === 'horizontal',
                  'is-locked': isImageHorizontalMirrorLineLocked,
                }"
                role="slider"
                tabindex="0"
                aria-label="Horizontal mirror axis"
                :aria-disabled="isImageHorizontalMirrorLineLocked"
                aria-orientation="vertical"
                aria-valuemin="0"
                :aria-valuemax="imageGridHeight"
                :aria-valuenow="imageHorizontalMirrorAxisY"
                :aria-valuetext="imageHorizontalMirrorAxisValueText"
                :title="
                  isImageHorizontalMirrorLineLocked
                    ? 'Horizontal mirror axis is locked.'
                    : 'Drag to move the horizontal mirror axis. Double-click or press Enter to center.'
                "
                @dblclick.stop.prevent="resetImageMirrorAxisFromHandle('horizontal')"
                @keydown="handleImageMirrorAxisKeydown($event, 'horizontal')"
                @pointerdown.stop.prevent="startImageMirrorAxisDrag($event, 'horizontal')"
                @pointermove.stop.prevent="continueImageMirrorAxisDrag($event, 'horizontal')"
                @pointerup.stop.prevent="finishImageMirrorAxisDrag($event, 'horizontal')"
                @pointercancel.stop.prevent="cancelImageMirrorAxisDrag"
                @lostpointercapture.stop="cancelImageMirrorAxisDrag"
                @touchstart.stop
                @touchmove.stop.prevent
                @touchend.stop
                @touchcancel.stop
              >
                <LockKeyhole
                  v-if="isImageHorizontalMirrorLineLocked"
                  :size="14"
                  :stroke-width="2.4"
                  aria-hidden="true"
                />
                <ChevronsUpDown v-else :size="17" :stroke-width="2.4" aria-hidden="true" />
              </span>
            </div>
            <div
              v-if="isImageVerticalMirrorEnabled && isImageVerticalMirrorLineVisible"
              class="image-editor-mirror-axis is-vertical"
              :style="imageVerticalMirrorAxisStyle"
            >
              <span class="image-editor-mirror-axis__line" aria-hidden="true"></span>
              <span
                class="image-editor-mirror-axis__handle"
                :class="{
                  'is-dragging': draggingImageMirrorAxis === 'vertical',
                  'is-locked': isImageVerticalMirrorLineLocked,
                }"
                role="slider"
                tabindex="0"
                aria-label="Vertical mirror axis"
                :aria-disabled="isImageVerticalMirrorLineLocked"
                aria-orientation="horizontal"
                aria-valuemin="0"
                :aria-valuemax="imageGridWidth"
                :aria-valuenow="imageVerticalMirrorAxisX"
                :aria-valuetext="imageVerticalMirrorAxisValueText"
                :title="
                  isImageVerticalMirrorLineLocked
                    ? 'Vertical mirror axis is locked.'
                    : 'Drag to move the vertical mirror axis. Double-click or press Enter to center.'
                "
                @dblclick.stop.prevent="resetImageMirrorAxisFromHandle('vertical')"
                @keydown="handleImageMirrorAxisKeydown($event, 'vertical')"
                @pointerdown.stop.prevent="startImageMirrorAxisDrag($event, 'vertical')"
                @pointermove.stop.prevent="continueImageMirrorAxisDrag($event, 'vertical')"
                @pointerup.stop.prevent="finishImageMirrorAxisDrag($event, 'vertical')"
                @pointercancel.stop.prevent="cancelImageMirrorAxisDrag"
                @lostpointercapture.stop="cancelImageMirrorAxisDrag"
                @touchstart.stop
                @touchmove.stop.prevent
                @touchend.stop
                @touchcancel.stop
              >
                <LockKeyhole
                  v-if="isImageVerticalMirrorLineLocked"
                  :size="14"
                  :stroke-width="2.4"
                  aria-hidden="true"
                />
                <ChevronsLeftRight v-else :size="17" :stroke-width="2.4" aria-hidden="true" />
              </span>
            </div>
          </div>
          <template
            v-for="collaborator in remoteImageCollaboratorList"
            :key="`remote-cursor-${collaborator.clientId}`"
          >
            <span
              v-if="collaborator.visible"
              class="image-editor-remote-cursor"
              :style="remoteImageCursorStyle(collaborator)"
              :title="collaborator.name"
              aria-hidden="true"
            >
              <MousePointer2
                class="image-editor-remote-cursor__icon"
                :size="20"
                :stroke-width="2.4"
                aria-hidden="true"
              />
              <span class="image-editor-remote-cursor__avatar">
                <svg
                  v-if="hasRemoteImagePixelAvatar(collaborator)"
                  class="image-editor-remote-cursor__pixel-avatar"
                  :viewBox="`0 0 ${collaborator.pixelAvatar?.size || 16} ${collaborator.pixelAvatar?.size || 16}`"
                  shape-rendering="crispEdges"
                  aria-hidden="true"
                >
                  <rect
                    v-for="(pixel, pixelIndex) in collaborator.pixelAvatar?.pixels || []"
                    v-show="pixel"
                    :key="pixelIndex"
                    :x="pixelIndex % (collaborator.pixelAvatar?.size || 16)"
                    :y="Math.floor(pixelIndex / (collaborator.pixelAvatar?.size || 16))"
                    width="1"
                    height="1"
                    :fill="pixel || 'transparent'"
                  />
                </svg>
                <img
                  v-else-if="canShowRemoteImageAvatar(collaborator)"
                  :src="collaborator.avatarUrl"
                  alt=""
                  draggable="false"
                  referrerpolicy="no-referrer"
                  @error="markRemoteImageAvatarFailed(collaborator)"
                />
                <span v-else aria-hidden="true">
                  {{ remoteImageCollaboratorInitials(collaborator) }}
                </span>
              </span>
            </span>
          </template>
        </section>

        <footer v-if="isImageEditor" class="image-editor-statusbar" aria-label="Canvas status">
          <span class="image-editor-statusbar__document">
            {{ imageGridWidth }} × {{ imageGridHeight }} px
          </span>
          <button
            ref="imageMobileColorTriggerRef"
            type="button"
            class="image-editor-mobile-color-trigger"
            aria-controls="image-editor-mobile-colors"
            :aria-expanded="isImageMobileColorControlsOpen"
            aria-label="Open colors and palette"
            title="Colors and palette"
            @click="openImageMobileColorControls"
          >
            <span class="image-editor-mobile-color-trigger__swatch" aria-hidden="true"></span>
          </button>
          <ImageZoomControls
            class="image-editor-zoom-host"
            :class="{
              'is-fit': imageZoomMode === 'fit',
              'is-actual': imageZoomMode === 'actual',
            }"
            :zoom="imageZoom"
            :min="MIN_IMAGE_ZOOM"
            :max="MAX_IMAGE_ZOOM"
            :rotation-radians="imageRotationRadians"
            @zoom-in="zoomImageIn"
            @zoom-out="zoomImageOut"
            @fit="fitImageToScreen"
            @actual-size="showImageAtActualSize"
            @rotate-left="rotateImageViewLeft"
            @rotate-right="rotateImageViewRight"
            @reset-rotation="resetImageViewRotation"
          />
        </footer>
      </div>
    </main>

    <UserProfileDialog
      :open="isProfileDialogOpen"
      :user-name="profileUserName"
      :user-username="profileUsername"
      :user-avatar-url="profileAvatarUrl"
      :user-email="profileEmail"
      :user-pixel-avatar="profilePixelAvatar"
      @close="isProfileDialogOpen = false"
      @saved="updateProfile"
    />
    <ImageConflictNotice
      :open="isImageConflictOpen"
      :local-revision="resource?.revision ?? null"
      :remote-revision="imageConflictRemoteRevision"
      :operation="imageConflictOperation?.kind || 'document'"
      :busy="isImageConflictResolving"
      @reload="reloadImageAfterConflict"
      @keep-local="keepLocalImageAfterConflict"
      @close="isImageConflictOpen = false"
    />
  </section>
</template>

<style scoped>
  .resource-editor {
    --editor-bg: #080808;
    --editor-panel: #111111;
    --editor-surface: #1c1c1c;
    --editor-hover: #242424;
    --editor-selected: #f2f2f2;
    --editor-selected-ink: #0a0a0a;
    --editor-border: #2b2b2b;
    --editor-border-strong: #666666;
    --editor-text: #f2f2f2;
    --editor-muted: #b8b8b8;
    --editor-quiet: #8a8a8a;
    --editor-focus: #ffffff;
    --editor-radius-xs: 4px;
    --editor-radius-sm: 6px;
    --editor-radius-md: 8px;
    --editor-radius-pill: 999px;
    --surface: var(--editor-panel);
    --surface-soft: var(--editor-surface);
    --line: var(--editor-border);
    --line-strong: var(--editor-border-strong);
    --text: var(--editor-text);
    --muted: var(--editor-muted);
    --quiet: var(--editor-quiet);
    position: relative;
    z-index: 5;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    color: var(--text);
  }

  button {
    font: inherit;
    color: inherit;
  }

  /* Pixel editor workbench --------------------------------------------------
     Static chrome is flat and neutral. Color is reserved for document content,
     the user-selected file icon, and genuine semantic states. */
  .resource-editor-title {
    display: inline-flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    box-sizing: border-box;
    min-width: 0;
    max-width: 100%;
    height: 40px;
    padding: 0 12px;
    color: var(--editor-text);
    background: var(--editor-panel);
    border: 1px solid var(--editor-border);
    border-radius: var(--editor-radius-md);
    box-shadow: none;
    text-align: left;
    cursor: pointer;
    touch-action: manipulation;
  }

  .resource-editor-title:hover:not(:disabled),
  .resource-editor-title[aria-expanded="true"] {
    background: var(--editor-surface);
    border-color: var(--editor-border-strong);
  }

  .resource-editor-title:focus-visible {
    outline: 2px solid var(--editor-focus);
    outline-offset: 2px;
  }

  .resource-editor-title:disabled { cursor: default; }

  .resource-editor-title.is-loading {
    opacity: 0.66;
  }

  .resource-editor-title__identity {
    display: inline-flex;
    flex: 1 1 auto;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .resource-editor-title__icon {
    display: grid;
    flex: 0 0 auto;
    place-items: center;
    width: 22px;
    height: 22px;
    color: var(--resource-editor-color);
  }

  .resource-editor-title__icon svg {
    display: block;
    color: inherit;
  }

  .resource-editor-title__name {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    color: var(--editor-text);
    font-size: 14px;
    font-weight: 650;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .resource-editor-title__name-input {
    width: 100%;
    height: 44px;
    padding: 0 10px;
    box-sizing: border-box;
    color: #ffffff;
    font: inherit;
    font-size: 18px;
    font-weight: 650;
    background: #191a19;
    border: 1px solid #454645;
    border-radius: 6px;
    outline: none;
  }

  .resource-editor-title__name-input:focus-visible {
    outline: 2px solid #ffffff;
    outline-offset: 2px;
  }

  .resource-document-info__rename-form {
    display: grid;
    flex: 1 0 100%;
    min-width: 0;
    gap: 12px;
  }

  .resource-document-info__rename-form label { color: #b5b7b5; font-size: 13px; }

  .resource-document-info__rename-actions { display: flex; justify-content: flex-end; gap: 8px; }

  .resource-editor-title__kind {
    flex: 0 0 auto;
    color: var(--editor-quiet);
    font-size: 11px;
    font-weight: 500;
  }

  .resource-document-info__name {
    flex: 1 1 auto;
    min-width: 0;
    overflow-wrap: anywhere;
    font-size: clamp(22px, 3vw, 26px);
    font-weight: 700;
    line-height: 1.35;
  }

  .resource-document-info__rename {
    flex: 0 0 auto;
    min-height: 44px;
    padding: 0 14px;
    color: #eeeeee;
    background: #242424;
    border: 1px solid #454545;
    border-radius: 6px;
    font: inherit;
    font-size: 14px;
    cursor: pointer;
  }

  .resource-document-info__rename:focus-visible {
    outline: 2px solid #ffffff;
    outline-offset: 2px;
  }

  .resource-document-info__rename:hover:not(:disabled) { background: #303130; }

  .resource-document-info__rename--confirm { color: #111212; background: #eeeeee; border-color: #eeeeee; }
  .resource-document-info__rename--confirm:hover:not(:disabled) { background: #ffffff; }
  .resource-document-info__rename:disabled { cursor: default; opacity: 0.5; }

  .resource-document-info__name-error {
    flex: 1 0 100%;
    margin: 0;
    color: #ffabab;
    font-size: 13px;
    font-weight: 500;
    line-height: 1.5;
  }

  .resource-editor-title__status {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 12px;
    min-height: 24px;
    padding-left: 12px;
    border-left: 1px solid var(--editor-border);
  }

  .resource-editor :deep(.studio-topbar) {
    min-height: 56px;
    padding: 6px 16px;
    background: #0b0b0b;
    border-bottom-color: var(--editor-border);
    backdrop-filter: none;
  }

  .resource-editor :deep(.studio-topbar__logo) {
    width: 26px;
    height: 26px;
    filter: none;
  }

  .resource-editor :deep(.studio-topbar__project-logo),
  .resource-editor :deep(.studio-topbar__project-logo-loader) {
    width: 34px;
    height: 34px;
    border-color: var(--editor-border-strong);
    border-radius: var(--editor-radius-md);
  }

  .resource-editor :deep(.studio-topbar__brand-trail.has-logo) {
    width: 36px;
    height: 36px;
  }

  .resource-editor :deep(.studio-topbar__avatar) {
    width: 34px;
    height: 34px;
    border-color: var(--editor-border-strong);
  }

  .resource-editor :deep(.studio-topbar__user-label) {
    color: var(--editor-muted);
    font-size: 12px;
    font-weight: 550;
  }

  .resource-editor-stage {
    position: relative;
    flex: 1;
    min-height: 0;
    background: var(--editor-bg);
  }

  .resource-editor-canvas {
    --editor-left-dock: 48px;
    position: absolute;
    inset: 0;
    display: grid;
    grid-template-columns: var(--editor-left-dock) minmax(0, 1fr);
    grid-template-rows: 40px minmax(0, 1fr) 30px;
    place-items: stretch;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    isolation: isolate;
    background: var(--editor-bg);
  }

  .resource-editor-canvas::after {
    display: none;
    content: none;
  }

  .image-editor-left-dock {
    position: relative;
    z-index: 4;
    grid-column: 1;
    grid-row: 1 / 3;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    min-width: 0;
    min-height: 0;
    padding: 6px 5px;
    overflow-x: hidden;
    overflow-y: auto;
    box-sizing: border-box;
    background: var(--editor-panel);
    border-right: 1px solid var(--editor-border);
    box-shadow: none;
    scrollbar-color: var(--editor-border-strong) transparent;
    scrollbar-width: thin;
  }

  .image-editor-canvas-modes {
    z-index: 8;
    grid-column: 1;
    grid-row: 3;
    min-width: 0;
    min-height: 0;
  }

  .image-editor-left-dock::before,
  .image-editor-left-dock::after {
    display: none;
    content: none;
  }

  .image-editor-floating-layers {
    position: relative;
    z-index: 6;
    grid-column: 2;
    grid-row: 2;
    min-width: 0;
    min-height: 0;
    pointer-events: none;
  }

  .image-editor-layers-trigger {
    position: absolute;
    right: 12px;
    bottom: 12px;
    z-index: 7;
    display: inline-flex;
    gap: 7px;
    align-items: center;
    min-height: 38px;
    padding: 0 12px;
    color: var(--editor-text);
    font: inherit;
    font-size: 12px;
    font-weight: 680;
    cursor: pointer;
    background: var(--editor-panel);
    border: 1px solid var(--editor-border-strong);
    border-radius: var(--editor-radius-md);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.34);
    pointer-events: auto;
  }

  .image-editor-layers-trigger small {
    color: var(--editor-muted);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  .image-editor-layers-trigger:hover,
  .image-editor-layers-trigger:focus-visible,
  .image-editor-layers-trigger[aria-expanded="true"] {
    color: var(--editor-selected-ink);
    background: var(--editor-selected);
    border-color: var(--editor-selected);
    outline: none;
  }

  .image-editor-layers-trigger:hover small,
  .image-editor-layers-trigger:focus-visible small,
  .image-editor-layers-trigger[aria-expanded="true"] small {
    color: currentColor;
    opacity: 0.66;
  }

  .image-editor-options-rail {
    position: absolute;
    top: calc(50% + 5px);
    right: 12px;
    z-index: 7;
    pointer-events: auto;
    transform: translateY(-50%);
  }

  .image-editor-options-rail.is-dialog-open {
    z-index: 22;
  }

  .image-editor-options-tabs,
  .image-editor-mobile-options-trigger {
    display: none;
  }

  .image-editor-layers-dialog-layer {
    position: absolute;
    inset: 0;
    z-index: 18;
    display: grid;
    place-items: center;
    padding: 16px;
    box-sizing: border-box;
    visibility: hidden;
    background: rgba(0, 0, 0, 0.52);
    backdrop-filter: blur(3px);
    opacity: 0;
    pointer-events: none;
    transition:
      opacity 180ms ease-out,
      visibility 0s linear 180ms;
  }

  .image-editor-layers-dialog-layer.is-open {
    visibility: visible;
    opacity: 1;
    pointer-events: auto;
    transition-delay: 0s;
  }

  .image-editor-layers-dialog {
    position: relative;
    width: min(430px, 100%);
    height: min(430px, 100%);
    max-height: 100%;
    overflow: hidden;
    background: #101010;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 12px;
    box-shadow:
      0 28px 72px rgba(0, 0, 0, 0.62),
      0 8px 24px rgba(0, 0, 0, 0.42),
      inset 0 1px 0 rgba(255, 255, 255, 0.06);
    pointer-events: auto;
    opacity: 0;
    transform: translateY(8px) scale(0.985);
    transition:
      opacity 180ms ease,
      transform 240ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  .image-editor-layers-dialog-layer.is-open .image-editor-layers-dialog {
    opacity: 1;
    transform: translateY(0) scale(1);
  }

  .image-editor-layers-dialog__close {
    position: absolute;
    top: 7px;
    right: 10px;
    z-index: 3;
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    padding: 0;
    color: var(--editor-muted);
    cursor: pointer;
    background: rgba(255, 255, 255, 0.045);
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 8px;
  }

  .image-editor-layers-dialog :deep(.image-layers-panel__header) {
    padding-right: 50px;
  }

  .image-editor-layers-dialog__close:hover,
  .image-editor-layers-dialog__close:focus-visible {
    color: #111111;
    background: #f0f0f0;
    border-color: #ffffff;
    outline: 1px solid var(--editor-focus);
    outline-offset: 1px;
  }

  .image-editor-layers-dialog .image-editor-layers-host {
    position: static;
    display: block;
    width: 100%;
    height: 100%;
    max-height: none;
    overflow: hidden;
    border: 0;
    pointer-events: auto;
  }

  .image-editor-floating-layers .image-editor-layers-dialog :deep(.image-layers-panel) {
    height: 100%;
    max-height: 100%;
  }

  .image-editor-floating-layers
    .image-editor-layers-dialog
    :deep(.image-layers-panel__list) {
    max-height: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .image-editor-layers-dialog {
      transition: none;
    }
  }

  @media (max-width: 440px) {
    .resource-editor-canvas .image-editor-floating-layers {
      grid-column: 1 / -1;
    }

    .image-editor-layers-dialog-layer {
      padding: 8px;
    }
  }

  .image-editor-toolbar {
    position: static;
    width: 32px;
    min-width: 32px;
  }

  .image-editor-context-host {
    position: relative;
    z-index: 3;
    grid-column: 2;
    grid-row: 1;
    display: block;
    width: auto;
    min-width: 0;
    overflow: hidden;
    background: var(--editor-panel);
  }

  .image-editor-context-host :deep(.image-tool-options) {
    min-width: 0;
  }

  .image-editor-viewport {
    position: relative;
    z-index: 1;
    grid-column: 2;
    grid-row: 2;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    overscroll-behavior: none;
    cursor: crosshair;
    background: var(--editor-bg);
    outline: none;
    touch-action: none;
    user-select: none;
  }

  .image-editor-viewport.is-pixel-mutation-blocked,
  .image-editor-viewport.is-pixel-mutation-blocked .image-editor-artboard,
  .image-editor-artboard.is-pixel-mutation-blocked {
    cursor: not-allowed;
  }

  .image-editor-viewport.is-pan-ready,
  .image-editor-viewport.is-rotate-ready {
    cursor: grab;
  }

  .image-editor-viewport.is-panning,
  .image-editor-viewport.is-rotating,
  .image-editor-viewport.is-pinching {
    cursor: grabbing;
  }

  .image-editor-viewport.is-pan-ready .image-editor-artboard,
  .image-editor-viewport.is-rotate-ready .image-editor-artboard {
    cursor: grab;
  }

  .image-editor-viewport.is-panning .image-editor-artboard,
  .image-editor-viewport.is-rotating .image-editor-artboard,
  .image-editor-viewport.is-pinching .image-editor-artboard {
    cursor: grabbing;
  }

  .image-editor-viewport::before,
  .image-editor-viewport::after {
    display: none;
    content: none;
  }

  .image-editor-statusbar {
    position: relative;
    z-index: 3;
    grid-column: 2;
    grid-row: 3;
    display: flex;
    gap: 10px;
    align-items: center;
    justify-content: space-between;
    min-width: 0;
    min-height: 30px;
    padding: 0 6px 0 10px;
    box-sizing: border-box;
    color: var(--editor-quiet);
    background: var(--editor-panel);
    border-top: 1px solid var(--editor-border);
  }

  .image-editor-statusbar__document {
    min-width: 0;
    overflow: hidden;
    font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .image-editor-mobile-color-trigger {
    display: none;
  }

  .image-editor-mobile-color-trigger {
    flex: 0 0 auto;
    place-items: center;
    width: 36px;
    min-width: 36px;
    height: 36px;
    min-height: 36px;
    padding: 0;
    cursor: pointer;
    background: transparent;
    border: 0;
    border-radius: var(--editor-radius-sm);
    outline: none;
  }

  .image-editor-mobile-color-trigger__swatch {
    display: block;
    width: 26px;
    height: 26px;
    background:
      radial-gradient(
        circle at center,
        rgba(255, 255, 255, 0.78) 0,
        rgba(255, 255, 255, 0.48) 32%,
        rgba(255, 255, 255, 0.14) 56%,
        rgba(255, 255, 255, 0) 72%
      ),
      conic-gradient(
        from 45deg,
        #ff453a 0deg,
        #ff9f0a 45deg,
        #ffd60a 90deg,
        #32d74b 145deg,
        #64d2ff 200deg,
        #0a84ff 245deg,
        #5e5ce6 285deg,
        #bf5af2 325deg,
        #ff453a 360deg
      );
    border: 1px solid #777777;
    border-radius: 6px;
    box-shadow: 0 0 0 1px #080808;
  }

  .image-editor-mobile-color-trigger:hover,
  .image-editor-mobile-color-trigger:focus-visible,
  .image-editor-mobile-color-trigger[aria-expanded="true"] {
    background: var(--editor-hover);
  }

  .image-editor-mobile-color-trigger:focus-visible {
    outline: 1px solid var(--editor-focus);
    outline-offset: -2px;
  }

  .image-editor-mobile-color-trigger[aria-expanded="true"]
    .image-editor-mobile-color-trigger__swatch {
    border-color: #ffffff;
    box-shadow:
      0 0 0 1px #080808,
      0 0 0 2px #ffffff;
  }

  .image-editor-mobile-color-layer,
  .image-editor-mobile-color-sheet,
  .image-editor-mobile-color-content {
    display: contents;
  }

  .image-editor-mobile-color-backdrop,
  .image-editor-mobile-color-header {
    display: none;
  }

  .image-editor-zoom-host {
    position: static;
    flex: 0 0 auto;
    transform: none;
  }

  .image-editor-notice-host {
    position: absolute;
    top: 10px;
    left: 50%;
    z-index: 7;
    max-width: min(460px, calc(100% - 28px));
    transform: translateX(-50%);
  }

  .image-editor-preview {
    position: absolute;
    top: 12px;
    right: 12px;
    z-index: 6;
    display: grid;
    place-items: start end;
    width: var(--image-preview-size, 176px);
    height: var(--image-preview-size, 176px);
    padding: 0;
    box-sizing: border-box;
    background: transparent;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    pointer-events: none;
  }

  .image-editor-preview__grid {
    position: relative;
    display: block;
    align-self: start;
    justify-self: end;
    max-width: 100%;
    max-height: 100%;
    overflow: hidden;
    image-rendering: pixelated;
    background: var(--image-preview-empty-pixel, #101010);
    border: 0;
    border-radius: var(--editor-radius-sm);
    box-shadow: inset 0 0 0 1px var(--editor-border-strong);
  }

  .image-editor-preview__grid canvas {
    display: block;
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
  }

  .image-editor-preview__viewport {
    position: absolute;
    z-index: 2;
    min-width: 6px;
    min-height: 6px;
    box-sizing: border-box;
    background: rgba(0, 0, 0, 0.14);
    border: 1px solid var(--editor-text);
    border-radius: 2px;
    box-shadow: inset 0 0 0 1px var(--editor-selected-ink);
    pointer-events: none;
  }

  .image-editor-layers-host {
    position: static;
    flex: 0 1 auto;
    width: 100%;
    min-width: 0;
    min-height: 0;
    max-height: min(250px, 28vh);
    overflow: hidden;
    border-bottom: 1px solid var(--editor-border);
  }

  .image-editor-floating-layers :deep(.image-layers-panel) {
    grid-template-rows: auto minmax(0, 1fr) auto;
    width: 100%;
    max-height: 100%;
    overflow: hidden;
    background: var(--editor-panel);
    border: 1px solid var(--editor-border-strong);
    border-radius: var(--editor-radius-md);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.38);
    pointer-events: auto;
  }

  .image-editor-floating-layers :deep(.image-layers-panel__list) {
    min-height: 0;
    max-height: none;
  }

  .image-editor-mobile-color-panel {
    position: absolute;
    bottom: 12px;
    left: 12px;
    z-index: 6;
    display: grid;
    grid-template-areas: "value";
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
    align-items: start;
    width: 196px;
    min-width: 0;
    padding: 0;
    box-sizing: border-box;
    background: transparent;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    pointer-events: auto;
    transform: none;
  }

  .image-editor-color-picker-stage {
    position: relative;
    width: 292px;
    height: 292px;
    transform: scale(var(--image-color-picker-scale, 0.5));
    transform-origin: top left;
  }

  .image-editor-floating-color-picker {
    --image-color-picker-scale: 0.67;
    position: absolute;
    bottom: 56px;
    left: 12px;
    z-index: 6;
    width: 196px;
    height: 196px;
    overflow: hidden;
    pointer-events: auto;
    touch-action: none;
  }

  .image-editor-floating-palette {
    --image-palette-safe-bottom: 264px;
    --image-palette-safe-right: 220px;
    position: absolute;
    top: 12px;
    left: 12px;
    z-index: 6;
    width: calc(100% - var(--image-palette-safe-right));
    height: calc(100% - var(--image-palette-safe-bottom) - 12px);
    min-width: 0;
    overflow-x: auto;
    overflow-y: hidden;
    pointer-events: none;
    scrollbar-color: var(--editor-border-strong) transparent;
    scrollbar-width: thin;
  }

  @media (min-width: 769px) {
    .image-editor-floating-palette :deep(.image-palette-panel) {
      height: 100%;
    }

    .image-editor-floating-palette :deep(.image-palette-panel__swatches) {
      grid-auto-flow: column;
      grid-auto-columns: var(--image-palette-swatch-size, 32px);
      grid-template-rows: repeat(auto-fit, var(--image-palette-swatch-size, 32px));
      grid-template-columns: none;
      width: max-content;
      max-width: none;
      height: 100%;
      max-height: 100%;
      margin-inline: 0;
      pointer-events: auto;
      touch-action: manipulation;
    }
  }

  .image-editor-color-wheel {
    position: absolute;
    inset: 0;
    width: 292px;
    height: 292px;
    cursor: crosshair;
    background: conic-gradient(
      from -90deg,
      #f00,
      #ff0,
      #0f0,
      #0ff,
      #00f,
      #f0f,
      #f00
    );
    border: 1px solid #565656;
    border-radius: 50%;
    box-shadow: none;
  }

  .image-editor-color-wheel::after {
    position: absolute;
    inset: 28px;
    content: "";
    background: #101010;
    border: 1px solid #3a3a3a;
    border-radius: 50%;
    box-shadow: none;
    pointer-events: none;
  }

  .image-editor-color-hue-handle,
  .image-editor-color-triangle-handle {
    position: absolute;
    z-index: 3;
    width: 12px;
    height: 12px;
    box-sizing: border-box;
    background: transparent;
    border: 2px solid #ffffff;
    border-radius: 50%;
    outline: 1px solid #000000;
    pointer-events: none;
    transform: translate(-50%, -50%);
  }

  .image-editor-color-hue-handle {
    width: 28px;
    height: 8px;
    background: #ffffff;
    border: 1px solid #000000;
    border-radius: 4px;
    outline: 1px solid #ffffff;
  }

  .image-editor-color-triangle {
    position: absolute;
    top: 28px;
    left: 48px;
    z-index: 2;
    width: 196px;
    height: 184px;
    overflow: hidden;
    cursor: crosshair;
    filter: none;
    pointer-events: none;
  }

  .image-editor-color-triangle::after {
    display: none;
    content: none;
  }

  .image-editor-color-triangle canvas,
  .image-editor-color-triangle svg {
    position: absolute;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }

  .image-editor-color-triangle svg {
    z-index: 2;
  }

  .image-editor-color-triangle polygon {
    pointer-events: fill;
  }

  .image-editor-color-triangle canvas {
    clip-path: polygon(50% 0, 0 100%, 100% 100%);
    image-rendering: auto;
  }

  .image-editor-color-triangle-handle {
    width: 13px;
    height: 13px;
  }

  .image-editor-color-value {
    display: grid;
    grid-area: value;
    grid-template-columns: 34px minmax(0, 1fr) 34px;
    gap: 6px;
    align-items: center;
    width: 100%;
    min-width: 0;
    margin: 0;
    transform: none;
  }

  .image-editor-color-value > span {
    width: 34px;
    height: 34px;
    box-sizing: border-box;
    background: var(--selected-image-color, #ffffff);
    border: 1px solid var(--editor-border-strong);
    border-radius: var(--editor-radius-sm);
    box-shadow: none;
  }

  .image-editor-color-value input {
    width: 100%;
    min-width: 0;
    height: 34px;
    padding: 0 8px;
    box-sizing: border-box;
    color: var(--editor-muted);
    font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
    font-size: 12px;
    font-weight: 550;
    text-transform: uppercase;
    background: var(--editor-surface);
    border: 1px solid var(--editor-border);
    border-radius: var(--editor-radius-sm);
    outline: none;
  }

  .image-editor-color-value input:hover {
    border-color: var(--editor-border-strong);
  }

  .image-editor-color-value input:focus-visible {
    border-color: var(--editor-focus);
  }

  .image-editor-color-add {
    display: grid;
    place-items: center;
    width: 34px;
    min-width: 34px;
    height: 34px;
    padding: 0;
    color: var(--editor-muted);
    cursor: pointer;
    background: transparent;
    border: 1px solid var(--editor-border);
    border-radius: var(--editor-radius-sm);
    box-shadow: none;
    outline: none;
  }

  .image-editor-color-add:hover:not(:disabled) {
    color: var(--editor-text);
    background: var(--editor-hover);
    border-color: var(--editor-border-strong);
  }

  .image-editor-color-add:focus-visible {
    outline: 1px solid var(--editor-focus);
    outline-offset: -2px;
  }

  .image-editor-color-add:disabled {
    cursor: not-allowed;
    opacity: 0.3;
  }

  .image-editor-color-swatches-host {
    display: none;
    grid-area: swatches;
    width: 100%;
    min-width: 0;
    margin: 0;
    transform: none;
  }

  .image-editor-inspector-panel {
    position: relative;
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr);
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    max-height: none;
    padding: 0;
    overflow: hidden;
    box-sizing: border-box;
    color: var(--editor-text);
    background: transparent;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    pointer-events: auto;
    transform: none;
    scrollbar-color: var(--editor-border-strong) transparent;
    scrollbar-width: thin;
  }

  @media (min-width: 1121px) {
    .image-editor-inspector-panel.is-content-sized {
      grid-template-rows: auto minmax(0, 1fr);
      height: fit-content;
      max-height: min(680px, calc(100dvh - 48px));
    }
  }

  .image-editor-dialog-notice-host {
    position: absolute;
    top: 52px;
    right: 12px;
    left: 12px;
    z-index: 6;
    display: grid;
    justify-items: center;
    pointer-events: none;
  }

  .image-editor-dialog-notice-host :deep(.image-editor-notice) {
    pointer-events: auto;
  }

  .image-editor-inspector-header {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
    min-height: 40px;
    padding: 7px 12px;
    box-sizing: border-box;
    border-bottom: 1px solid var(--editor-border);
  }

  .image-editor-inspector-title {
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr);
    gap: 7px;
    align-items: center;
    min-width: 0;
    color: var(--editor-text);
    font-size: 13px;
    font-weight: 600;
  }

  .image-editor-inspector-title span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .image-editor-inspector-close {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    padding: 0;
    color: var(--editor-quiet);
    cursor: pointer;
    background: transparent;
    border: 0;
    border-radius: var(--editor-radius-sm);
    outline: none;
  }

  .image-editor-inspector-close:hover {
    color: var(--editor-text);
    background: var(--editor-hover);
  }

  .image-editor-inspector-close:focus-visible {
    outline: 1px solid var(--editor-focus);
    outline-offset: -2px;
  }

  .image-editor-settings-page,
  .image-editor-dimensions,
  .image-editor-anchor-field,
  .image-editor-preference-group {
    display: grid;
    min-width: 0;
  }

  .image-editor-settings-page {
    gap: 16px;
    align-content: start;
    min-height: 0;
    padding: 12px;
    overflow-x: hidden;
    overflow-y: auto;
    scrollbar-color: var(--editor-border-strong) transparent;
    scrollbar-width: thin;
  }

  @media (min-width: 769px) {
    .image-editor-resize-settings {
      grid-template-columns: minmax(210px, 1fr) 108px;
      gap: 20px;
      align-items: start;
    }
  }

  .image-editor-dimensions,
  .image-editor-anchor-field {
    gap: 8px;
  }

  .image-editor-preference-group {
    gap: 9px;
  }

  .image-editor-preference-group + .image-editor-preference-group {
    padding-top: 14px;
    border-top: 1px solid var(--editor-border);
  }

  .image-editor-control-heading {
    color: var(--editor-muted);
    font-size: 12px;
    font-weight: 600;
    line-height: 1.2;
    text-transform: none;
  }

  .image-editor-control-heading::after {
    display: none;
    content: none;
  }

  .image-editor-grid-subheading {
    padding-top: 3px;
    color: var(--editor-quiet);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .image-editor-size-row,
  .image-editor-preference-row,
  .image-editor-range-row,
  .image-editor-toggle-row {
    display: grid;
    gap: 8px;
    align-items: center;
    min-width: 0;
    min-height: 34px;
  }

  .image-editor-size-row {
    grid-template-columns: minmax(0, 1fr) 84px;
  }

  .image-editor-preference-row {
    grid-template-columns: 112px minmax(0, 1fr);
  }

  .image-editor-range-row {
    grid-template-columns: 84px minmax(72px, 1fr) 64px;
  }

  .image-editor-toggle-row {
    grid-template-columns: minmax(0, 1fr) 32px;
  }

  .image-editor-size-field,
  .image-editor-preference-label,
  .image-editor-range-row > label,
  .image-editor-toggle-row > span {
    color: var(--editor-muted);
    font-size: 12px;
    font-weight: 500;
  }

  .image-editor-size-input,
  .image-editor-opacity-input,
  .image-editor-preference-number-input {
    width: 100%;
    min-width: 0;
    height: 34px;
    padding: 0 8px;
    box-sizing: border-box;
    color: var(--editor-text);
    font: inherit;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    text-align: right;
    background: var(--editor-surface);
    border: 1px solid var(--editor-border);
    border-radius: 5px;
    outline: none;
  }

  .image-editor-size-input:hover,
  .image-editor-opacity-input:hover,
  .image-editor-preference-number-input:hover {
    border-color: var(--editor-border-strong);
  }

  .image-editor-size-input:focus-visible,
  .image-editor-opacity-input:focus-visible,
  .image-editor-preference-number-input:focus-visible {
    border-color: var(--editor-focus);
  }

  .image-editor-size-input:disabled,
  .image-editor-opacity-input:disabled,
  .image-editor-preference-number-input:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }

  .image-editor-dimension-link-row {
    display: flex;
    gap: 7px;
    align-items: center;
    min-height: 34px;
  }

  .image-editor-dimension-link {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    padding: 0;
    color: var(--editor-quiet);
    cursor: pointer;
    background: transparent;
    border: 1px solid var(--editor-border);
    border-radius: 5px;
    outline: none;
  }

  .image-editor-dimension-link:hover {
    color: var(--editor-text);
    background: var(--editor-hover);
    border-color: var(--editor-border-strong);
  }

  .image-editor-dimension-link:focus-visible {
    outline: 1px solid var(--editor-focus);
    outline-offset: -2px;
  }

  .image-editor-dimension-link.is-active {
    color: var(--editor-selected-ink);
    background: var(--editor-selected);
    border-color: var(--editor-selected);
  }

  .image-editor-dimension-link-label {
    color: var(--editor-quiet);
    font-size: 12px;
  }

  .image-editor-anchor-grid {
    display: grid;
    grid-template-columns: repeat(3, 32px);
    gap: 6px;
  }

  .image-editor-anchor-grid button,
  .image-editor-gap-button,
  .image-editor-segment-button {
    display: grid;
    place-items: center;
    min-width: 32px;
    height: 32px;
    padding: 0 7px;
    color: var(--editor-muted);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    background: transparent;
    border: 1px solid var(--editor-border);
    border-radius: 5px;
    box-shadow: none;
    outline: none;
  }

  .image-editor-anchor-grid button {
    width: 32px;
  }

  .image-editor-anchor-grid button:hover:not(:disabled),
  .image-editor-gap-button:hover:not(:disabled),
  .image-editor-segment-button:hover:not(:disabled) {
    color: var(--editor-text);
    background: var(--editor-hover);
    border-color: var(--editor-border-strong);
  }

  .image-editor-anchor-grid button:focus-visible,
  .image-editor-gap-button:focus-visible,
  .image-editor-segment-button:focus-visible {
    outline: 1px solid var(--editor-focus);
    outline-offset: -2px;
  }

  .image-editor-anchor-grid button.is-active,
  .image-editor-gap-button.is-active,
  .image-editor-segment-button.is-active {
    color: var(--editor-selected-ink);
    background: var(--editor-selected);
    border-color: var(--editor-selected);
  }

  .image-editor-anchor-grid button:disabled,
  .image-editor-gap-button:disabled,
  .image-editor-segment-button:disabled {
    cursor: not-allowed;
    opacity: 0.35;
  }

  .image-editor-anchor-grid button span {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
  }

  .image-editor-anchor-grid button i {
    display: block;
    width: 0;
    height: 0;
    pointer-events: none;
  }

  .image-editor-anchor-grid button i.is-anchor {
    width: 6px;
    height: 6px;
    background: var(--editor-selected-ink);
    border-radius: 50%;
  }

  .image-editor-anchor-grid button i.is-up {
    border-right: 4px solid transparent;
    border-bottom: 6px solid currentColor;
    border-left: 4px solid transparent;
  }

  .image-editor-anchor-grid button i.is-right {
    border-top: 4px solid transparent;
    border-bottom: 4px solid transparent;
    border-left: 6px solid currentColor;
  }

  .image-editor-anchor-grid button i.is-down {
    border-top: 6px solid currentColor;
    border-right: 4px solid transparent;
    border-left: 4px solid transparent;
  }

  .image-editor-anchor-grid button i.is-left {
    border-top: 4px solid transparent;
    border-right: 6px solid currentColor;
    border-bottom: 4px solid transparent;
  }

  .image-editor-gap-list,
  .image-editor-segment-list,
  .image-editor-grid-color-list {
    display: flex;
    gap: 4px;
    align-items: center;
    justify-content: flex-end;
    min-width: 0;
  }

  .image-editor-segment-list {
    flex-wrap: wrap;
  }

  .image-editor-background-color-picker,
  .image-editor-grid-color-picker,
  .image-editor-subdivision-color-picker {
    position: relative;
    display: block;
    width: 32px;
    height: 32px;
    overflow: hidden;
    background: var(--custom-background-color, var(--custom-grid-color, var(--custom-subdivision-color, #ffffff)));
    border: 1px solid var(--editor-border-strong);
    border-radius: 5px;
    cursor: pointer;
    outline: none;
  }

  .image-editor-background-color-picker input,
  .image-editor-grid-color-picker input,
  .image-editor-subdivision-color-picker input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    padding: 0;
    cursor: pointer;
    opacity: 0;
  }

  .image-editor-background-color-picker:focus-within,
  .image-editor-grid-color-picker:focus-within,
  .image-editor-subdivision-color-picker:focus-within {
    outline: 1px solid var(--editor-focus);
    outline-offset: 1px;
  }

  .image-editor-grid-color-picker:has(input:disabled),
  .image-editor-subdivision-color-picker:has(input:disabled) {
    cursor: not-allowed;
    opacity: 0.4;
  }

  .image-editor-toggle-row input {
    justify-self: end;
    width: 18px;
    height: 18px;
    margin: 0;
    accent-color: var(--editor-selected);
  }

  .image-editor-range-row input[type="range"] {
    width: 100%;
    min-width: 0;
    min-height: 32px;
    margin: 0;
    accent-color: var(--editor-selected);
  }

  .image-editor-transform-host,
  .image-editor-transfer-host {
    width: 100%;
    min-height: 0;
    margin-top: 0;
    overflow-x: hidden;
    overflow-y: auto;
    background: transparent;
    border: 0;
    border-radius: 0;
    box-shadow: none;
  }

  .image-editor-artboard {
    position: absolute;
    top: calc(var(--image-artboard-center-y, 50%) - var(--image-artboard-half-height, 0px));
    left: calc(var(--image-artboard-center-x, 50%) - var(--image-artboard-half-width, 0px));
    z-index: 2;
    display: grid;
    overflow: visible;
    box-sizing: border-box;
    cursor: crosshair;
    background-color: var(--image-pixel-background, #101010);
    border: 0;
    border-radius: var(--editor-radius-md);
    box-shadow: 0 0 0 1px var(--editor-border-strong);
    outline: none;
    touch-action: none;
    transform: translate3d(var(--image-pan-x, 0px), var(--image-pan-y, 0px), 0)
      rotate(var(--image-rotation, 0rad)) scale(var(--image-live-scale, 1));
    transform-origin: center;
    user-select: none;
  }

  .image-editor-pixel-rotation-pivot {
    position: absolute;
    z-index: 8;
    width: 16px;
    height: 16px;
    transform: translate(-50%, -50%);
    pointer-events: none;
    filter: drop-shadow(0 0 1px #000000) drop-shadow(0 0 1px #000000);
  }

  .image-editor-pixel-rotation-pivot::before,
  .image-editor-pixel-rotation-pivot::after {
    position: absolute;
    content: "";
    background: #ffffff;
  }

  .image-editor-pixel-rotation-pivot::before {
    top: 7px;
    width: 16px;
    height: 2px;
  }

  .image-editor-pixel-rotation-pivot::after {
    left: 7px;
    width: 2px;
    height: 16px;
  }

  .image-editor-artboard:focus-visible {
    outline: 1px solid var(--editor-focus);
    outline-offset: 1px;
  }

  .image-editor-artboard.is-panning,
  .image-editor-artboard.is-rotating,
  .image-editor-artboard.is-pinching {
    cursor: grabbing;
  }

  .image-editor-artboard.is-rotating,
  .image-editor-artboard.is-pinching {
    will-change: transform;
  }

  .image-editor-artboard.is-wrap-around,
  .image-editor-artboard.has-mirror-guides {
    overflow: visible;
  }

  .image-editor-wrap-surface {
    position: absolute;
    top: 50%;
    left: 50%;
    z-index: 0;
    width: max(400vw, 4096px);
    height: max(400vh, 4096px);
    background-position: center;
    background-repeat: repeat;
    image-rendering: pixelated;
    pointer-events: none;
    transform: translate(-50%, -50%);
  }

  .image-editor-canvas-bitmap {
    position: absolute;
    top: 0;
    left: 0;
    z-index: 1;
    display: block;
    image-rendering: pixelated;
    pointer-events: none;
  }

  .image-editor-grid-overlay {
    position: absolute;
    top: 0;
    left: 0;
    z-index: 2;
    display: block;
    overflow: hidden;
    pointer-events: none;
  }

  .image-editor-subdivision-line {
    position: absolute;
    z-index: 3;
    background: var(--image-grid-subdivision-color, rgba(242, 242, 242, 0.18));
    pointer-events: none;
  }

  .image-editor-subdivision-line.is-vertical {
    top: 0;
    bottom: 0;
  }

  .image-editor-subdivision-line.is-horizontal {
    right: 0;
    left: 0;
  }

  .image-editor-hover-cell {
    position: absolute;
    z-index: 4;
    box-sizing: border-box;
    border: 1px solid #ffffff;
    outline: 1px solid #000000;
    pointer-events: none;
  }

  .image-editor-hover-cell.is-graffiti {
    border-width: 1px;
    outline: 0;
    opacity: 0.72;
  }

  .image-editor-hover-cell.is-brush {
    opacity: 0.82;
  }

  .image-editor-selection {
    position: absolute;
    inset: 0;
    z-index: 5;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
  }

  .image-editor-selection path {
    fill: none;
    stroke-linecap: square;
    stroke-linejoin: miter;
  }

  .image-editor-selection__base {
    stroke: #ffffff;
    stroke-width: 2px;
  }

  .image-editor-selection__ants {
    stroke: #111111;
    stroke-width: 2px;
    stroke-dasharray: 4 4;
    animation: image-selection-march 700ms linear infinite;
  }

  .image-editor-remote-selection {
    position: absolute;
    inset: 0;
    z-index: 5;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
    opacity: 0.9;
  }

  .image-editor-remote-selection path {
    fill: none;
    stroke: var(--image-collaborator-color);
    stroke-linecap: square;
    stroke-linejoin: miter;
    stroke-width: 2px;
  }

  .image-editor-remote-cursor {
    position: absolute;
    z-index: 9;
    display: flex;
    align-items: flex-start;
    color: var(--image-collaborator-color);
    pointer-events: none;
    filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.8));
    transform-origin: 0 0;
  }

  .image-editor-remote-cursor__icon {
    flex: 0 0 auto;
    fill: var(--image-collaborator-color);
    stroke: #0b0b0b;
  }

  .image-editor-remote-cursor__avatar {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    margin: 14px 0 0 -3px;
    overflow: hidden;
    box-sizing: border-box;
    color: #111212;
    font-size: 10px;
    font-weight: 900;
    line-height: 1;
    background: var(--image-collaborator-color);
    border: 2px solid var(--image-collaborator-color);
    border-radius: 50%;
    box-shadow: 0 0 0 1px rgba(5, 6, 5, 0.9);
  }

  .image-editor-remote-cursor__avatar img,
  .image-editor-remote-cursor__pixel-avatar {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: inherit;
  }

  .image-editor-remote-cursor__avatar img {
    object-fit: cover;
  }

  .image-editor-mirror-axis {
    position: absolute;
    z-index: 6;
    pointer-events: none;
    filter: drop-shadow(0 0 1px #000000);
  }

  .image-editor-mirror-axis.is-horizontal {
    right: 0;
    left: 0;
    height: 0;
  }

  .image-editor-mirror-axis.is-vertical {
    top: 0;
    bottom: 0;
    width: 0;
  }

  .image-editor-mirror-axis__line {
    position: absolute;
    display: block;
    pointer-events: none;
  }

  .image-editor-mirror-axis.is-horizontal .image-editor-mirror-axis__line {
    top: -1px;
    right: 0;
    left: 0;
    height: 2px;
    background: repeating-linear-gradient(
      90deg,
      var(--editor-selected) 0 6px,
      transparent 6px 10px
    );
  }

  .image-editor-mirror-axis.is-vertical .image-editor-mirror-axis__line {
    top: 0;
    bottom: 0;
    left: -1px;
    width: 2px;
    background: repeating-linear-gradient(
      180deg,
      var(--editor-selected) 0 6px,
      transparent 6px 10px
    );
  }

  .image-editor-mirror-axis__handle {
    position: absolute;
    z-index: 1;
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    padding: 0;
    box-sizing: border-box;
    color: var(--editor-selected-ink);
    background: var(--editor-selected);
    border: 1px solid var(--editor-bg);
    border-radius: 50%;
    box-shadow:
      0 0 0 1px var(--editor-selected),
      0 4px 12px rgba(0, 0, 0, 0.34);
    pointer-events: auto;
    touch-action: none;
    user-select: none;
  }

  .image-editor-mirror-axis.is-horizontal .image-editor-mirror-axis__handle {
    top: 0;
    left: 0;
    cursor: ns-resize;
    transform: translate(-58%, -50%);
  }

  .image-editor-mirror-axis.is-vertical .image-editor-mirror-axis__handle {
    top: 0;
    left: 0;
    cursor: ew-resize;
    transform: translate(-50%, -58%);
  }

  .image-editor-mirror-axis__handle:hover,
  .image-editor-mirror-axis__handle.is-dragging {
    background: var(--editor-text);
    box-shadow:
      0 0 0 2px var(--editor-focus),
      0 5px 15px rgba(0, 0, 0, 0.42);
  }

  .image-editor-mirror-axis__handle.is-locked,
  .image-editor-mirror-axis__handle.is-locked:hover {
    color: var(--editor-muted);
    cursor: not-allowed;
    background: var(--editor-panel);
    border-color: var(--editor-border-strong);
    box-shadow: 0 0 0 1px var(--editor-border-strong);
  }

  .image-editor-mirror-axis__handle:focus-visible {
    outline: 2px solid var(--editor-focus);
    outline-offset: 3px;
  }

  @keyframes image-selection-march {
    to {
      stroke-dashoffset: -8;
    }
  }

  .resource-editor-loader,
  .resource-editor-error {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
  }

  .resource-editor-loader span {
    width: 26px;
    height: 26px;
    border: 2px solid #3a3a3a;
    border-top-color: var(--editor-text);
    border-radius: 50%;
    animation: resource-editor-loader 820ms linear infinite;
  }

  .resource-editor-error {
    gap: 12px;
    align-content: center;
  }

  .resource-editor-error p {
    margin: 0;
    color: var(--editor-muted);
    font-weight: 600;
  }

  .resource-editor-error button {
    min-height: 32px;
    padding: 0 12px;
    color: var(--editor-selected-ink);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    background: var(--editor-selected);
    border: 1px solid var(--editor-selected);
    border-radius: var(--editor-radius-sm);
  }

  @keyframes resource-editor-loader {
    to {
      transform: rotate(360deg);
    }
  }

  @media (max-width: 820px) {
    .resource-editor-canvas {
      --editor-left-dock: 44px;
    }

    .image-editor-left-dock {
      padding-right: 4px;
      padding-left: 4px;
    }

  }

  @media (max-width: 768px) {
    .image-editor-mirror-axis__handle {
      width: 44px;
      height: 44px;
    }

    .image-editor-mirror-axis.is-horizontal .image-editor-mirror-axis__handle {
      transform: translate(0, -50%);
    }

    .image-editor-mirror-axis.is-vertical .image-editor-mirror-axis__handle {
      transform: translate(-50%, 0);
    }

    .resource-editor {
      width: 100%;
      height: 100dvh;
      min-height: 0;
      max-height: none;
    }

    .resource-editor :deep(.studio-topbar) {
      grid-template-areas: "brand center user";
      grid-template-columns: max-content minmax(0, 1fr) max-content;
      row-gap: 0;
      column-gap: 6px;
      padding-right: 6px;
      padding-left: 6px;
    }

    .resource-editor :deep(.studio-topbar__center) {
      justify-self: stretch;
      width: 100%;
      min-width: 0;
    }

    .resource-editor :deep(.studio-topbar__brand-name),
    .resource-editor :deep(.studio-topbar__brand-separator),
    .resource-editor :deep(.studio-topbar__user-label),
    .resource-editor :deep(.studio-topbar__brand-trail > :not(.studio-topbar__project-logo)) {
      display: none;
    }

    .resource-editor-title__kind {
      display: none;
    }

    .resource-editor-title {
      height: 44px;
      gap: 8px;
      padding: 0 8px;
    }

    .resource-editor-title__identity { gap: 8px; }

    .resource-editor-title__status {
      gap: 8px;
      padding-left: 8px;
    }

    .resource-editor-canvas {
      --editor-left-dock: 48px;
      grid-template-columns: var(--editor-left-dock) minmax(0, 1fr);
      grid-template-rows: 44px minmax(0, 1fr) 44px;
    }

    .image-editor-layers-host {
      flex: 0 0 auto;
      max-height: none;
      overflow: visible;
    }

    .image-editor-layers-host :deep(.image-layers-panel__list) {
      max-height: clamp(96px, 24dvh, 180px);
    }

    .image-editor-mobile-color-layer {
      position: absolute;
      inset: 0;
      z-index: 16;
      display: block;
      visibility: hidden;
      pointer-events: none;
      transition: visibility 0s linear 280ms;
    }

    .image-editor-mobile-color-layer.is-mobile-open {
      visibility: visible;
      pointer-events: auto;
      transition-delay: 0s;
    }

    .image-editor-mobile-color-backdrop {
      position: absolute;
      inset: 0;
      display: block;
      width: 100%;
      height: 100%;
      padding: 0;
      cursor: default;
      background: rgba(0, 0, 0, 0.46);
      border: 0;
      opacity: 0;
      transition: opacity 180ms ease-out;
    }

    .image-editor-mobile-color-layer.is-mobile-open .image-editor-mobile-color-backdrop {
      opacity: 1;
    }

    .image-editor-mobile-color-sheet {
      position: absolute;
      right: 0;
      bottom: 0;
      left: 0;
      display: flex;
      flex-direction: column;
      height: 100%;
      max-height: none;
      overflow: hidden;
      color: var(--editor-text);
      background: var(--editor-panel);
      border-top: 0;
      border-radius: 0;
      box-shadow: 0 -14px 36px rgba(0, 0, 0, 0.34);
      transform: translate3d(0, 100%, 0);
      transition: transform 280ms cubic-bezier(0.22, 1, 0.36, 1);
    }

    .image-editor-mobile-color-layer.is-mobile-open .image-editor-mobile-color-sheet {
      transform: translate3d(0, 0, 0);
    }

    .image-editor-mobile-color-header {
      display: flex;
      flex: 0 0 auto;
      align-items: center;
      justify-content: space-between;
      min-height: 48px;
      padding: 0 8px 0 14px;
      box-sizing: border-box;
      border-bottom: 1px solid var(--editor-border);
    }

    .image-editor-mobile-color-header strong {
      overflow: hidden;
      font-size: 13px;
      font-weight: 680;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .image-editor-mobile-color-header button {
      display: grid;
      flex: 0 0 auto;
      place-items: center;
      width: 40px;
      height: 40px;
      padding: 0;
      color: var(--editor-muted);
      cursor: pointer;
      background: transparent;
      border: 0;
      border-radius: var(--editor-radius-sm);
    }

    .image-editor-mobile-color-header button:hover,
    .image-editor-mobile-color-header button:focus-visible {
      color: var(--editor-text);
      background: var(--editor-hover);
      outline: none;
    }

    .image-editor-mobile-color-content {
      display: grid;
      flex: 1 1 auto;
      grid-template-areas:
        "picker"
        "controls"
        "palette";
      grid-template-columns: minmax(0, 1fr);
      gap: 14px;
      align-content: start;
      min-height: 0;
      padding: 12px 12px max(14px, env(safe-area-inset-bottom, 0px));
      overflow-x: hidden;
      overflow-y: auto;
      box-sizing: border-box;
      overscroll-behavior: contain;
    }

    .image-editor-mobile-color-panel {
      position: static;
      z-index: auto;
      display: grid;
      grid-area: controls;
      gap: 10px;
      align-content: start;
      width: 100%;
      min-width: 0;
      pointer-events: auto;
    }

    .image-editor-mobile-color-panel .image-editor-color-value {
      grid-area: auto;
      grid-template-columns: 34px minmax(0, 1fr) 34px;
    }

    .image-editor-mobile-color-panel .image-editor-color-swatches-host {
      grid-area: auto;
    }

    .image-editor-mobile-color-panel :deep(.image-color-swatches) {
      grid-template-areas:
        "primary primary-value secondary secondary-value"
        "actions actions actions actions";
      grid-template-columns: 34px minmax(0, 1fr) 34px minmax(0, 1fr);
      column-gap: 8px;
    }

    .image-editor-floating-color-picker {
      --image-color-picker-scale: 0.67;
      position: static;
      z-index: auto;
      grid-area: picker;
      justify-self: center;
      width: 196px;
      height: 196px;
      overflow: hidden;
      pointer-events: auto;
      transform: none;
    }

    .image-editor-floating-palette {
      --image-palette-swatch-gap: clamp(5px, 1.5vw, 7px);
      position: static;
      z-index: auto;
      grid-area: palette;
      width: 100%;
      max-width: none;
      height: auto;
      min-width: 0;
      padding-top: 10px;
      overflow: visible;
      border-top: 1px solid var(--editor-border);
      pointer-events: auto;
    }

    .image-editor-floating-palette :deep(.image-palette-panel__swatches) {
      grid-template-columns: repeat(6, minmax(0, 1fr));
      width: 100%;
    }

    .image-editor-floating-palette :deep(.image-palette-panel__swatch) {
      width: 100%;
      height: auto;
      aspect-ratio: 1;
    }

    .image-editor-context-host,
    .image-editor-viewport,
    .image-editor-statusbar {
      grid-column: 2;
    }

    .image-editor-context-host {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 44px;
    }

    .image-editor-options-rail {
      display: none;
    }

    .image-editor-options-tabs {
      display: grid;
      grid-row: 1;
    }

    .image-editor-inspector-panel {
      position: relative;
      grid-template-rows: 52px minmax(0, 1fr);
    }

    .image-editor-inspector-header {
      position: absolute;
      top: 0;
      right: 0;
      z-index: 3;
      display: block;
      width: 48px;
      min-height: 52px;
      padding: 6px 4px;
      border-bottom: 0;
      pointer-events: none;
    }

    .image-editor-inspector-title {
      display: none;
    }

    .image-editor-inspector-close {
      width: 40px;
      height: 40px;
      pointer-events: auto;
    }

    .image-editor-settings-page,
    .image-editor-transform-host,
    .image-editor-transfer-host {
      grid-row: 2;
      padding-bottom: max(12px, env(safe-area-inset-bottom, 0px));
    }

    .image-editor-mobile-options-trigger {
      display: grid;
      place-items: center;
      width: 44px;
      min-width: 44px;
      height: 44px;
      min-height: 44px;
      padding: 0;
      color: var(--editor-muted);
      font: inherit;
      cursor: pointer;
      background: var(--editor-panel);
      border: 0;
      border-bottom: 1px solid var(--editor-border);
      border-left: 1px solid var(--editor-border);
      outline: none;
    }

    .image-editor-mobile-options-trigger:hover,
    .image-editor-mobile-options-trigger:focus-visible,
    .image-editor-mobile-options-trigger[aria-expanded="true"] {
      color: var(--editor-selected-ink);
      background: var(--editor-selected);
    }

    .image-editor-mobile-options-trigger:focus-visible {
      outline: 2px solid var(--editor-focus);
      outline-offset: -3px;
    }

    .image-editor-left-dock {
      padding: 4px;
    }

    .image-editor-toolbar {
      width: 40px;
      min-width: 40px;
    }

    .image-editor-statusbar {
      gap: 4px;
      justify-content: center;
      min-height: 44px;
      padding-right: 4px;
      padding-left: 8px;
    }

    .image-editor-statusbar__document {
      display: none;
    }

    .image-editor-mobile-color-trigger {
      display: inline-grid;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .image-editor-layers-dialog-layer {
      transition: none;
    }

    .image-editor-mobile-color-layer,
    .image-editor-mobile-color-backdrop,
    .image-editor-mobile-color-sheet {
      transition: none;
    }

    .image-editor-selection__ants,
    .resource-editor-loader span {
      animation: none;
    }
  }

  @media (forced-colors: active) {
    .image-editor-artboard,
    .image-editor-preview__grid,
    .image-editor-color-value input,
    .image-editor-color-add,
    .image-editor-inspector-close,
    .image-editor-size-input,
    .image-editor-opacity-input,
    .image-editor-preference-number-input,
    .image-editor-dimension-link,
    .image-editor-anchor-grid button,
    .image-editor-gap-button,
    .image-editor-segment-button {
      border-color: ButtonBorder;
    }

    .image-editor-mirror-axis__handle {
      color: ButtonText;
      background: ButtonFace;
      border-color: ButtonBorder;
    }

    .image-editor-mirror-axis__line {
      background: CanvasText;
    }

    .image-editor-dimension-link.is-active,
    .image-editor-anchor-grid button.is-active,
    .image-editor-gap-button.is-active,
    .image-editor-segment-button.is-active {
      color: HighlightText;
      background: Highlight;
    }
  }
</style>
