import { describe, expect, it } from "vitest";

import {
  DEFAULT_IMAGE_PREFERENCES,
  IMAGE_PREFERENCES_VERSION,
  imagePreferencesStorageKey,
  useImagePreferences,
  type ImagePreferencesStorage,
} from "./useImagePreferences";
import { IMAGE_GRID_LINE_STYLES } from "../lib/gridOverlay";

class MemoryStorage implements ImagePreferencesStorage {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const options = (storage: ImagePreferencesStorage | null) => ({
  resourceId: "resource/1",
  storage,
  userId: "user@example.com",
});

describe("useImagePreferences", () => {
  it("uses normalized defaults and a key scoped by user and resource", () => {
    const storage = new MemoryStorage();
    const state = useImagePreferences(options(storage));

    expect({ ...state.preferences }).toEqual(DEFAULT_IMAGE_PREFERENCES);
    expect(state.key).toBe(
      "sefkira:image-preferences:v1:user%40example.com:resource%2F1",
    );
    expect(state.key).not.toBe(imagePreferencesStorageKey("other-user", "resource/1"));
    expect(state.key).not.toBe(imagePreferencesStorageKey("user@example.com", "other-resource"));
  });

  it("loads and normalizes a versioned stored value", () => {
    const storage = new MemoryStorage();
    const key = imagePreferencesStorageKey("user@example.com", "resource/1");
    storage.setItem(
      key,
      JSON.stringify({
        version: IMAGE_PREFERENCES_VERSION,
        preferences: {
          background: "#abcdef",
          gridVisible: false,
          gridColor: "invalid",
          gridLineStyle: "dashed",
          gridOpacity: 4,
          gridGap: 2.7,
          subdivision: 99,
          subdivisionColor: "#123456",
          subdivisionThickness: -2,
          resizeAnchor: "bottom-right",
          zoom: 100,
        },
      }),
    );

    const { preferences } = useImagePreferences(options(storage));

    expect({ ...preferences }).toEqual({
      background: "#ABCDEF",
      gridVisible: false,
      gridColor: DEFAULT_IMAGE_PREFERENCES.gridColor,
      gridLineStyle: "dashed",
      gridOpacity: 1,
      gridGap: 3,
      subdivision: 64,
      subdivisionColor: "#123456",
      subdivisionThickness: 1,
      resizeAnchor: "bottom-right",
      zoom: 64,
    });
  });

  it("preserves zoom-out for large canvases and clamps below the supported minimum", () => {
    const storage = new MemoryStorage();
    const state = useImagePreferences(options(storage));

    state.save({ zoom: 0.1 });

    expect(state.preferences.zoom).toBe(0.1);
    state.save({ zoom: 0.001 });
    expect(state.preferences.zoom).toBe(1 / 32);
  });

  it.each(IMAGE_GRID_LINE_STYLES)("persists the %s grid treatment exactly", (lineStyle) => {
    const storage = new MemoryStorage();
    const state = useImagePreferences(options(storage));

    state.save({ gridLineStyle: lineStyle });

    expect(state.preferences.gridLineStyle).toBe(lineStyle);
    expect(useImagePreferences(options(storage)).preferences.gridLineStyle).toBe(lineStyle);
  });

  it("falls back safely for corrupt JSON and unsupported versions", () => {
    const corruptStorage = new MemoryStorage();
    const wrongVersionStorage = new MemoryStorage();
    const key = imagePreferencesStorageKey("user@example.com", "resource/1");
    corruptStorage.setItem(key, "{not-json");
    wrongVersionStorage.setItem(
      key,
      JSON.stringify({ version: 999, preferences: { background: "#FFFFFF" } }),
    );

    expect({ ...useImagePreferences(options(corruptStorage)).preferences }).toEqual(
      DEFAULT_IMAGE_PREFERENCES,
    );
    expect({ ...useImagePreferences(options(wrongVersionStorage)).preferences }).toEqual(
      DEFAULT_IMAGE_PREFERENCES,
    );
  });

  it("saves only normalized preference fields", () => {
    const storage = new MemoryStorage();
    const state = useImagePreferences(options(storage));

    const didSave = state.save({
      background: "#00aaee",
      gridOpacity: -1,
      subdivision: 4.6,
      zoom: 2.25,
      activeTool: "erase",
      activeLayerId: "layer-2",
    } as never);
    const stored = JSON.parse(storage.getItem(state.key) || "null") as {
      version: number;
      preferences: Record<string, unknown>;
    };

    expect(didSave).toBe(true);
    expect(stored.version).toBe(IMAGE_PREFERENCES_VERSION);
    expect(stored.preferences.background).toBe("#00AAEE");
    expect(stored.preferences.gridOpacity).toBe(0);
    expect(stored.preferences.subdivision).toBe(5);
    expect(stored.preferences.zoom).toBe(2.25);
    expect(stored.preferences).not.toHaveProperty("activeTool");
    expect(stored.preferences).not.toHaveProperty("activeLayerId");
    expect(state.preferences.background).toBe("#00AAEE");
  });

  it("saves the current reactive preferences when called without updates", () => {
    const storage = new MemoryStorage();
    const state = useImagePreferences(options(storage));
    state.preferences.gridVisible = false;
    state.preferences.gridGap = 3;

    state.save();

    const stored = JSON.parse(storage.getItem(state.key) || "null") as {
      preferences: { gridGap: number; gridVisible: boolean };
    };
    expect(stored.preferences.gridVisible).toBe(false);
    expect(stored.preferences.gridGap).toBe(3);
  });

  it("omits zoom unless it is configured", () => {
    const storage = new MemoryStorage();
    const state = useImagePreferences(options(storage));

    state.save();

    const stored = JSON.parse(storage.getItem(state.key) || "null") as {
      preferences: Record<string, unknown>;
    };
    expect(state.preferences).not.toHaveProperty("zoom");
    expect(stored.preferences).not.toHaveProperty("zoom");
  });

  it("reset restores custom defaults and removes persisted state", () => {
    const storage = new MemoryStorage();
    const state = useImagePreferences({
      ...options(storage),
      defaults: { background: "#222222", gridVisible: false, zoom: 2 },
    });
    state.save({ background: "#FFFFFF", gridVisible: true, zoom: 8 });

    const didReset = state.reset();

    expect(didReset).toBe(true);
    expect(state.preferences.background).toBe("#222222");
    expect(state.preferences.gridVisible).toBe(false);
    expect(state.preferences.zoom).toBe(2);
    expect(storage.getItem(state.key)).toBeNull();
  });

  it("tolerates unavailable and throwing storage", () => {
    const throwingStorage: ImagePreferencesStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const withoutStorage = useImagePreferences(options(null));
    const blockedStorage = useImagePreferences(options(throwingStorage));

    expect(() => withoutStorage.save({ gridVisible: false })).not.toThrow();
    expect(withoutStorage.save()).toBe(false);
    expect(withoutStorage.reset()).toBe(false);
    expect({ ...blockedStorage.preferences }).toEqual(DEFAULT_IMAGE_PREFERENCES);
    expect(blockedStorage.save()).toBe(false);
    expect(blockedStorage.reset()).toBe(false);
  });
});
