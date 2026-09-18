// @ts-expect-error Node's test-only built-in is available without browser typings.
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computed, effectScope, markRaw, ref } from "vue";
import { createSourceFile, isArrowFunction, isIdentifier, isVariableStatement, ModuleKind, ScriptTarget, transpileModule } from "typescript";

import { DOCUMENT_INACTIVITY_TIMEOUT_MS, useDocumentInactivity } from "./useDocumentInactivity";

class FakeNode {
  constructor(readonly parent: FakeNode | null = null) {}
  contains(target: FakeNode | null): boolean {
    return target === this || Boolean(target?.parent && this.contains(target.parent));
  }
}
const timeout = DOCUMENT_INACTIVITY_TIMEOUT_MS;
const epoch = new Date("2026-09-19T10:00:00Z").getTime();
const minutes = (value: number) => value * 60 * 1000;
let fakeDocument: EventTarget;
let fakeWindow: EventTarget;
const cleanups: Array<() => void> = [];
const activity = (type: string, target: FakeNode) => {
  const event = new Event(type);
  Object.defineProperty(event, "target", { value: target });
  fakeDocument.dispatchEvent(event);
};
const makeGuard = (additionalActivity?: (event: Event) => boolean) => {
  const editor = markRaw(new FakeNode());
  const canvas = markRaw(new FakeNode(editor));
  const element = ref(editor as unknown as HTMLElement | null);
  const onIdle = vi.fn();
  const scope = effectScope();
  const guard = scope.run(() => useDocumentInactivity({
    element, onIdle, isActivityWithinDocument: additionalActivity,
  }))!;
  cleanups.push(() => scope.stop());
  return { guard, onIdle, editor, canvas, element, scope };
};

// Exercise the real exit/save functions without booting the entire canvas editor.
const shellSource = readFileSync(new URL("../components/ResourceEditorShell.vue", import.meta.url), "utf8");
const shellScript = shellSource.slice(shellSource.indexOf(">") + 1, shellSource.indexOf("</script>"));
const shellAst = createSourceFile("ResourceEditorShell.ts", shellScript, ScriptTarget.ES2022, true);
const readShellFunction = (name: string) => {
  const declaration = shellAst.statements.filter(isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((item) => isIdentifier(item.name) && item.name.text === name);
  if (!declaration?.initializer || !isArrowFunction(declaration.initializer)) {
    throw new Error(`Could not locate the editor function ${name}`);
  }
  return `const ${name} = ${declaration.initializer.getText(shellAst)};`;
};
const exitScript = transpileModule([
  readShellFunction("navigateAfterImageSave"), readShellFunction("leaveInactiveDocument"),
].join("\n"), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
const makeEditorExit = () => {
  const closePresence = vi.fn();
  const closeRealtime = vi.fn();
  const assign = vi.fn();
  const confirm = vi.fn();
  const isDocumentIdle = ref(false);
  const localDocument = { id: "document", name: "Pixel character", data: { pixels: ["#FFCA79"] } };
  const dependencies = {
    resourceEditorDisposed: false,
    isDocumentIdle,
    canEditImage: computed(() => !isDocumentIdle.value),
    canRenameResource: computed(() => !isDocumentIdle.value),
    isIdleExitSaving: ref(false),
    isDocumentInfoOpen: ref(true),
    clearImageTemporaryKeys: vi.fn(),
    documentChat: { setOpen: vi.fn() },
    broadcastImageCursor: vi.fn(),
    flushImageCollaborationCursor: vi.fn(),
    projectPresenceConnection: { close: closePresence },
    resourceAccessConnection: { close: closeRealtime },
    projectPresenceMembers: ref([{ id: "collaborator" }]),
    remoteImageCollaborators: ref({ collaborator: { x: 5, y: 10 } }),
    pendingProjectEditorActivities: [{ kind: "cursor" }],
    pendingImageCollaborationCursor: { x: 5 },
    pendingImageCollaborationSelection: { x: 5 },
    imageLivePreviews: { clear: vi.fn() },
    imageLivePreviewSender: { clear: vi.fn() },
    imageCanonicalRefreshTimeout: setTimeout(vi.fn(), timeout),
    imageCanonicalRefreshRequiresFresh: true,
    imageCollaborationCleanupInterval: setInterval(vi.fn(), 4000),
    persistImageEditorSession: vi.fn(async () => {}),
    projectPath: ref("/studio/project-one"),
    isImageEditor: ref(true),
    isRenamingResource: ref(false),
    commitResourceName: vi.fn(async () => {}),
    imageAutosave: { flush: vi.fn(async () => {}), hasPendingChanges: ref(false) },
    resourceMutationQueue: Promise.resolve(),
    waitForPersonalImagePaletteMutations: vi.fn(async () => {}),
    resourceNameDraft: ref("Pixel character"),
    hasPendingImageNameChange: ref(false),
    resource: ref(localDocument),
    isResourceNameSaving: ref(false),
    isPersonalImagePaletteSaving: ref(false),
    imageConflictOperation: ref(null),
    showImageNotice: vi.fn(),
    imageSaveError: ref(""),
    allowImageUnload: false,
    window: {
      clearTimeout: globalThis.clearTimeout, clearInterval: globalThis.clearInterval,
      location: { assign }, confirm,
    },
  };
  const methods = new Function(...Object.keys(dependencies), `${exitScript}
    return { leaveInactiveDocument, readState: () => ({
      projectPresenceConnection, resourceAccessConnection, allowImageUnload,
      imageCanonicalRefreshTimeout, imageCollaborationCleanupInterval
    }) };`)(...Object.values(dependencies)) as {
      leaveInactiveDocument: () => Promise<void>;
      readState: () => {
        projectPresenceConnection: unknown;
        resourceAccessConnection: unknown;
        allowImageUnload: boolean;
        imageCanonicalRefreshTimeout: unknown;
        imageCollaborationCleanupInterval: unknown;
      };
    };
  return { ...methods, dependencies, closePresence, closeRealtime, assign, confirm, localDocument };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(epoch);
  fakeDocument = new EventTarget();
  fakeWindow = Object.assign(new EventTarget(), {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  });
  vi.stubGlobal("window", fakeWindow);
  vi.stubGlobal("document", fakeDocument);
  vi.stubGlobal("Node", FakeNode);
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("document inactivity", () => {
  it("does nothing until started and expires once at exactly thirty minutes", () => {
    const { guard, onIdle, canvas } = makeGuard();
    vi.advanceTimersByTime(timeout);
    expect(onIdle).not.toHaveBeenCalled();
    guard.start();
    vi.advanceTimersByTime(timeout - 1);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledOnce();
    fakeWindow.dispatchEvent(new Event("focus"));
    activity("pointerdown", canvas);
    vi.advanceTimersByTime(timeout);
    expect(onIdle).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "keydown", "input", "pointerdown", "pointermove", "pointerup", "wheel",
    "touchstart", "touchmove", "touchend",
  ])("extends the deadline for this person's %s inside the editor", (type) => {
    const { guard, onIdle, canvas } = makeGuard();
    guard.start();
    vi.advanceTimersByTime(minutes(29));
    activity(type, canvas);
    vi.advanceTimersByTime(timeout - 1);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it("ignores activity outside the editor and incoming conversation or presence events", () => {
    const { guard, onIdle, canvas } = makeGuard();
    guard.start();
    vi.advanceTimersByTime(minutes(29));
    activity("input", new FakeNode());
    activity("pointermove", new FakeNode());
    activity("document.chat.created", canvas);
    activity("project.presence.updated", canvas);
    vi.advanceTimersByTime(minutes(1));
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it("checks wake events without treating focus or visibility as interaction", () => {
    const { guard, onIdle } = makeGuard();
    guard.start();
    vi.advanceTimersByTime(minutes(29));
    fakeWindow.dispatchEvent(new Event("focus"));
    fakeDocument.dispatchEvent(new Event("visibilitychange"));
    fakeWindow.dispatchEvent(new Event("pageshow"));
    vi.advanceTimersByTime(minutes(1));
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it.each(["focus", "pageshow", "visibilitychange"])("detects an overdue suspended-tab deadline immediately on %s", (type) => {
    const { guard, onIdle, canvas } = makeGuard();
    guard.start();
    // Move the wall clock without executing the suspended tab's scheduled timer.
    vi.setSystemTime(epoch + timeout + 1);
    expect(onIdle).not.toHaveBeenCalled();
    const target = type === "visibilitychange" ? fakeDocument : fakeWindow;
    target.dispatchEvent(new Event(type));
    expect(onIdle).toHaveBeenCalledOnce();
    activity("input", canvas);
    vi.advanceTimersByTime(timeout);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it("expires before resetting when user input arrives ahead of the overdue timer or focus event", () => {
    const { guard, onIdle, canvas } = makeGuard();
    guard.start();
    vi.setSystemTime(epoch + timeout);
    activity("pointerdown", canvas);
    expect(onIdle).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("can include teleported document controls without counting unrelated page controls", () => {
    const chatDialog = new FakeNode();
    const textarea = new FakeNode(chatDialog);
    const { guard, onIdle } = makeGuard((event) => chatDialog.contains(event.target as unknown as FakeNode));
    guard.start();
    vi.advanceTimersByTime(minutes(29));
    activity("input", textarea);
    vi.advanceTimersByTime(minutes(29));
    activity("input", new FakeNode());
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(minutes(1));
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it("reads the current editor ref when it becomes available after start", () => {
    const { guard, onIdle, element, canvas } = makeGuard();
    element.value = null;
    guard.start();
    vi.advanceTimersByTime(minutes(29));
    element.value = canvas.parent as unknown as HTMLElement;
    activity("keydown", canvas);
    vi.advanceTimersByTime(timeout - 1);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it.each(["stop", "scope disposal"])("removes listeners and cancels the timer on %s", (cleanup) => {
    const removeDocument = vi.spyOn(fakeDocument, "removeEventListener");
    const removeWindow = vi.spyOn(fakeWindow, "removeEventListener");
    const { guard, onIdle, canvas, scope } = makeGuard();
    guard.start();
    vi.advanceTimersByTime(minutes(29));
    if (cleanup === "stop") guard.stop();
    else scope.stop();
    guard.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(removeDocument.mock.calls.map((call) => call[0])).toEqual([
      "keydown", "input", "pointerdown", "pointermove", "pointerup", "wheel",
      "touchstart", "touchmove", "touchend", "visibilitychange",
    ]);
    expect(removeWindow.mock.calls.map((call) => call[0])).toEqual(["focus", "pageshow"]);
    activity("keydown", canvas);
    fakeWindow.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(timeout);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("keeps duplicate starts idempotent and permits another activation after stopping or expiring", () => {
    const { guard, onIdle } = makeGuard();
    guard.start();
    vi.advanceTimersByTime(minutes(20));
    guard.start();
    vi.advanceTimersByTime(minutes(10));
    expect(onIdle).toHaveBeenCalledOnce();
    guard.start();
    vi.advanceTimersByTime(minutes(20));
    guard.stop();
    vi.advanceTimersByTime(minutes(20));
    expect(onIdle).toHaveBeenCalledOnce();
    guard.start();
    vi.advanceTimersByTime(timeout - 1);
    expect(onIdle).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(2);
  });

  it("allows server rendering without browser globals or scheduling timers", () => {
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("Node", undefined);
    const { guard, onIdle } = makeGuard();
    expect(() => { guard.start(); guard.stop(); }).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
    expect(onIdle).not.toHaveBeenCalled();
  });
});

describe("inactive document exit", () => {
  it("disconnects before awaiting local persistence and saved navigation", async () => {
    const editor = makeEditorExit();
    let finishPersistence!: () => void;
    editor.dependencies.persistImageEditorSession.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishPersistence = resolve;
    }));
    const exiting = editor.leaveInactiveDocument();
    expect(editor.dependencies.isDocumentIdle.value).toBe(true);
    expect(editor.dependencies.isIdleExitSaving.value).toBe(true);
    expect(editor.closePresence).toHaveBeenCalledOnce();
    expect(editor.closeRealtime).toHaveBeenCalledOnce();
    expect(editor.readState()).toMatchObject({
      projectPresenceConnection: null, resourceAccessConnection: null,
      imageCanonicalRefreshTimeout: null, imageCollaborationCleanupInterval: null,
    });
    expect(editor.dependencies.projectPresenceMembers.value).toEqual([]);
    expect(editor.dependencies.remoteImageCollaborators.value).toEqual({});
    expect(editor.dependencies.documentChat.setOpen).toHaveBeenCalledExactlyOnceWith(false);
    expect(editor.dependencies.imageAutosave.flush).not.toHaveBeenCalled();
    expect(editor.assign).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    finishPersistence();
    await exiting;
    expect(editor.dependencies.imageAutosave.flush).toHaveBeenCalledOnce();
    expect(editor.assign).toHaveBeenCalledExactlyOnceWith("/studio/project-one");
    expect(editor.confirm).not.toHaveBeenCalled();
    expect(editor.readState().allowImageUnload).toBe(true);
    expect(editor.dependencies.isIdleExitSaving.value).toBe(false);
  });

  it("preserves an unsaved name instead of invoking a read-only rename that would discard its draft", async () => {
    const editor = makeEditorExit();
    editor.dependencies.isRenamingResource.value = true;
    editor.dependencies.resourceNameDraft.value = "My unsaved document name";
    editor.dependencies.commitResourceName.mockImplementationOnce(async () => {
      editor.dependencies.isRenamingResource.value = false;
      editor.dependencies.resourceNameDraft.value = "";
    });
    await editor.leaveInactiveDocument();
    expect(editor.dependencies.canEditImage.value).toBe(false);
    expect(editor.dependencies.commitResourceName).not.toHaveBeenCalled();
    expect(editor.dependencies.resourceNameDraft.value).toBe("My unsaved document name");
    expect(editor.dependencies.isRenamingResource.value).toBe(true);
    expect(editor.dependencies.resource.value).toEqual(editor.localDocument);
    expect(editor.assign).not.toHaveBeenCalled();
    expect(editor.confirm).not.toHaveBeenCalled();
    expect(editor.readState().allowImageUnload).toBe(false);
    expect(editor.dependencies.isDocumentIdle.value).toBe(true);
    expect(editor.dependencies.isIdleExitSaving.value).toBe(false);
  });

  it.each(["pending changes", "save error"])("keeps the disconnected local document when there are %s", async (failure) => {
    const editor = makeEditorExit();
    if (failure === "pending changes") editor.dependencies.imageAutosave.hasPendingChanges.value = true;
    else editor.dependencies.imageAutosave.flush.mockRejectedValueOnce(new TypeError("Connection unavailable"));
    await editor.leaveInactiveDocument();
    expect(editor.closePresence).toHaveBeenCalledOnce();
    expect(editor.closeRealtime).toHaveBeenCalledOnce();
    expect(editor.dependencies.isDocumentIdle.value).toBe(true);
    expect(editor.dependencies.isIdleExitSaving.value).toBe(false);
    expect(editor.dependencies.resource.value).toEqual(editor.localDocument);
    expect(editor.assign).not.toHaveBeenCalled();
    expect(editor.confirm).not.toHaveBeenCalled();
    expect(editor.readState().allowImageUnload).toBe(false);
    await editor.leaveInactiveDocument();
    expect(editor.closePresence).toHaveBeenCalledOnce();
    expect(editor.closeRealtime).toHaveBeenCalledOnce();
    expect(editor.dependencies.imageAutosave.flush).toHaveBeenCalledOnce();
  });
});
