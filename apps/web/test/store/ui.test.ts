import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserPreferenceStorage,
  hydrateUiStore,
  setPreferenceStorage,
  THEME_PREFERENCE_LABELS,
  THEME_PREFERENCES,
  useUiStore,
  type ThemePreference,
} from "../../src/store/ui";

const STORAGE_KEY = "tasma.theme";

beforeEach(() => {
  window.localStorage.clear();
  setPreferenceStorage(browserPreferenceStorage);
  useUiStore.setState({ themePreference: "system" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the ui store", () => {
  it("starts on the default without reading storage", () => {
    window.localStorage.setItem(STORAGE_KEY, "light");
    expect(useUiStore.getState().themePreference).toBe("system");
  });

  it("hydrates from a stored preference", () => {
    window.localStorage.setItem(STORAGE_KEY, "light");
    expect(hydrateUiStore()).toBe("light");
    expect(useUiStore.getState().themePreference).toBe("light");
  });

  it("hydrates to the default when nothing is stored", () => {
    expect(hydrateUiStore()).toBe("system");
  });

  it("ignores a stored value that is not a preference", () => {
    window.localStorage.setItem(STORAGE_KEY, "sepia");
    expect(hydrateUiStore()).toBe("system");
  });

  it("hydrates to the default when storage cannot be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage is not available on this origin");
    });
    expect(hydrateUiStore()).toBe("system");
  });

  it("persists a new preference", () => {
    useUiStore.getState().setThemePreference("dark");
    expect(useUiStore.getState().themePreference).toBe("dark");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("dark");
  });

  it("applies a new preference even when storage cannot be written", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage is not available on this origin");
    });
    useUiStore.getState().setThemePreference("dark");
    expect(useUiStore.getState().themePreference).toBe("dark");
  });

  it("goes through an injected storage instead of the browser's", () => {
    const written: ThemePreference[] = [];
    setPreferenceStorage({ read: () => "dark", write: (preference) => void written.push(preference) });

    expect(hydrateUiStore()).toBe("dark");
    useUiStore.getState().setThemePreference("light");

    expect(written).toEqual(["light"]);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe("the preference list", () => {
  it("labels every preference exactly once", () => {
    expect(Object.keys(THEME_PREFERENCE_LABELS).sort()).toEqual([...THEME_PREFERENCES].sort());
  });
});
