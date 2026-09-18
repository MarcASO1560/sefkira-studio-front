// @ts-expect-error Node's test-only built-in is available without browser typings.
import { readFileSync } from "node:fs";
import { computed, nextTick, ref, type ComputedRef } from "vue";
import { createSourceFile, isIdentifier, isVariableStatement, ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { describe, expect, it, vi } from "vitest";

// Execute the editor's real header and name-save functions without initializing
// the drawing canvas. These paths must work for each resource type.
const source = readFileSync(new URL("./ResourceEditorShell.vue", import.meta.url), "utf8");
const script = source.slice(source.indexOf(">") + 1, source.indexOf("</script>"));
const ast = createSourceFile("ResourceEditorShell.ts", script, ScriptTarget.ES2022, true);
const names = ["canRenameResource", "hasPendingImageNameChange", "displayedImageSaveStatus",
  "displayedImageSaveError", "normalizeResourceUpdatedAt", "effectiveImageLastSavedAt",
  "enqueueResourceMutation", "persistResourceName", "cancelRenamingResource", "performResourceNameCommit",
  "commitResourceName", "startRenamingResource", "openDocumentChat", "navigateAfterImageSave", "hasImageUnloadRisk"];
const declarations = ast.statements.filter(isVariableStatement).flatMap((statement) => [...statement.declarationList.declarations]);
const compiled = transpileModule(names.map((name) => {
  const declaration = declarations.find((item) => isIdentifier(item.name) && item.name.text === name);
  if (!declaration?.initializer) throw new Error(`Missing editor declaration: ${name}`);
  return `const ${name} = ${declaration.initializer.getText(ast)};`;
}).join("\n"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;

const setupHeader = (type: string, role = "editor") => {
  const resource = ref({ id: "document", type, name: "Document", revision: 4,
    updated_at: "2026-09-18T12:00:00Z", data: { original: "content" } });
  const project = ref({ access_role: role });
  const isDocumentChatOpen = ref(false);
  const assign = vi.fn();
  const confirm = vi.fn(() => false);
  const dependencies = {
    computed, nextTick, resource, project, isImageEditor: ref(type === "pixel_art"),
    canEditImage: computed(() => type === "pixel_art" && ["owner", "editor"].includes(project.value.access_role)),
    isLoading: ref(false), isResourceProjectAccessRevoked: ref(false), isDocumentIdle: ref(false),
    resourceNameDraft: ref("Document"), resourceNameSaveError: ref(""),
    isRenamingResource: ref(false), isResourceNameSaving: ref(false), isDocumentNameSubmitting: ref(false),
    resourceNameInput: ref({ focus: vi.fn() }), imageSaveStatus: ref("saved"),
    imageSaveError: ref(""), imageLastSavedAt: ref<string | null>(null),
    imageAutosave: { flush: vi.fn(async () => {}), refresh: vi.fn(async () => {}),
      acceptResource: vi.fn(async () => {}), hasPendingChanges: ref(false) },
    patchProjectResource: vi.fn(async (_project: string, _resource: string, payload: { name: string }) => ({
      ok: true, resource: { ...resource.value, name: payload.name, revision: 5,
        updated_at: "2026-09-18T12:01:00Z" },
    })),
    fetchLatestImageResource: vi.fn(async () => null), showImageNotice: vi.fn(), openImageConflict: vi.fn(),
    markImageReadOnly: vi.fn(() => { project.value.access_role = "viewer"; }),
    props: { projectId: "project", resourceId: "document" },
    resourceMutationQueue: Promise.resolve(), resourceNameCommitPromise: null,
    isDocumentChatOpen, isDocumentChatAccessDenied: ref(false), errorMessage: ref(""), clearImageTemporaryKeys: vi.fn(),
    closeDocumentInfo: vi.fn(), closeImageLayersDialog: vi.fn(), closeImageMobileColorControls: vi.fn(),
    activeImageInspectorPanel: ref(null),
    documentChat: { setOpen: vi.fn((open: boolean) => { isDocumentChatOpen.value = open; }) },
    isPersonalImagePaletteSaving: ref(false), imageConflictOperation: ref(null),
    waitForPersonalImagePaletteMutations: vi.fn(async () => {}), allowImageUnload: false,
    window: { location: { assign }, confirm },
  };
  const methods = new Function(...Object.keys(dependencies), `${compiled}
    return { canRenameResource, displayedImageSaveStatus, displayedImageSaveError,
      effectiveImageLastSavedAt, startRenamingResource, commitResourceName,
      openDocumentChat, navigateAfterImageSave, hasImageUnloadRisk };`)(...Object.values(dependencies)) as {
    canRenameResource: ComputedRef<boolean>;
    displayedImageSaveStatus: ComputedRef<string>;
    displayedImageSaveError: ComputedRef<string>;
    effectiveImageLastSavedAt: ComputedRef<string | null>;
    startRenamingResource: () => void;
    commitResourceName: () => Promise<void>;
    openDocumentChat: () => void;
    navigateAfterImageSave: (path: string, options?: { requireSaved?: boolean }) => Promise<void>;
    hasImageUnloadRisk: () => boolean;
  };
  return { methods, dependencies, assign, confirm };
};

describe.each(["pixel_art", "pixel_animation", "text", "sound_effect"])("common document header for %s", (type) => {
  it("opens the chat and renames only the document while keeping its persisted content", async () => {
    const { methods, dependencies } = setupHeader(type);
    methods.openDocumentChat();
    expect(dependencies.documentChat.setOpen).toHaveBeenCalledWith(true);
    methods.startRenamingResource();
    await nextTick();
    dependencies.resourceNameDraft.value = "New document name";
    expect(methods.displayedImageSaveStatus.value).toBe("dirty");
    expect(methods.hasImageUnloadRisk()).toBe(true);
    const first = methods.commitResourceName();
    const second = methods.commitResourceName();
    await Promise.all([first, second]);
    expect(dependencies.patchProjectResource).toHaveBeenCalledExactlyOnceWith("project", "document", {
      name: "New document name", base_revision: 4,
    });
    expect(dependencies.resource.value.name).toBe("New document name");
    expect(dependencies.resource.value.data).toEqual({ original: "content" });
    expect(methods.displayedImageSaveStatus.value).toBe("saved");
    expect(methods.effectiveImageLastSavedAt.value).toBe("2026-09-18T12:01:00Z");
    expect(dependencies.imageAutosave.flush).toHaveBeenCalledTimes(type === "pixel_art" ? 1 : 0);
    expect(dependencies.imageAutosave.refresh).toHaveBeenCalledTimes(type === "pixel_art" ? 1 : 0);
  });

  it("lets viewers chat while preventing renames, and blocks the chat when document access is revoked", async () => {
    const { methods, dependencies } = setupHeader(type, "viewer");
    methods.openDocumentChat();
    expect(dependencies.isDocumentChatOpen.value).toBe(true);
    methods.startRenamingResource();
    expect(dependencies.isRenamingResource.value).toBe(false);
    dependencies.resourceNameDraft.value = "Forbidden name";
    await methods.commitResourceName();
    expect(dependencies.patchProjectResource).not.toHaveBeenCalled();
    dependencies.isDocumentChatOpen.value = false;
    dependencies.isResourceProjectAccessRevoked.value = true;
    methods.openDocumentChat();
    expect(dependencies.isDocumentChatOpen.value).toBe(false);
  });

  it("preserves a failed name change and refuses an idle exit that requires all changes saved", async () => {
    const { methods, dependencies, assign } = setupHeader(type);
    dependencies.patchProjectResource.mockRejectedValue(new TypeError("Offline"));
    methods.startRenamingResource();
    dependencies.resourceNameDraft.value = "Keep this name";
    await methods.navigateAfterImageSave("/studio/project", { requireSaved: true });
    expect(assign).not.toHaveBeenCalled();
    expect(dependencies.resource.value.name).toBe("Document");
    expect(dependencies.resourceNameDraft.value).toBe("Keep this name");
    expect(methods.displayedImageSaveStatus.value).toBe("error");
    expect(methods.hasImageUnloadRisk()).toBe(true);
    dependencies.isDocumentIdle.value = true;
    expect(methods.canRenameResource.value).toBe(false);
  });
});
