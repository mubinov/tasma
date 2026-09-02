import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserPreferenceStorage,
  hydrateUiStore,
  setPreferenceStorage,
  THEME_PREFERENCE_LABELS,
  THEME_PREFERENCES,
  useUiStore,
} from "../../src/store/ui";

const THEME_KEY = "tasma.theme";
const SIDEBAR_KEY = "tasma.sidebar";

beforeEach(() => {
  window.localStorage.clear();
  setPreferenceStorage(browserPreferenceStorage);
  useUiStore.setState({ themePreference: "system", sidebarCollapsed: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the ui store", () => {
  it("starts on the defaults without reading storage", () => {
    window.localStorage.setItem(THEME_KEY, "light");
    window.localStorage.setItem(SIDEBAR_KEY, "collapsed");

    expect(useUiStore.getState().themePreference).toBe("system");
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
  });

  it("hydrates from a stored preference", () => {
    window.localStorage.setItem(THEME_KEY, "light");
    expect(hydrateUiStore().themePreference).toBe("light");
    expect(useUiStore.getState().themePreference).toBe("light");
  });

  it("hydrates to the default when nothing is stored", () => {
    expect(hydrateUiStore().themePreference).toBe("system");
  });

  it("ignores a stored value that is not a preference", () => {
    window.localStorage.setItem(THEME_KEY, "sepia");
    expect(hydrateUiStore().themePreference).toBe("system");
  });

  it("hydrates to the default when storage cannot be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage is not available on this origin");
    });

    expect(hydrateUiStore()).toEqual({ themePreference: "system", sidebarCollapsed: false });
  });

  it("persists a new preference", () => {
    useUiStore.getState().setThemePreference("dark");
    expect(useUiStore.getState().themePreference).toBe("dark");
    expect(window.localStorage.getItem(THEME_KEY)).toBe("dark");
  });

  it("applies a new preference even when storage cannot be written", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage is not available on this origin");
    });

    useUiStore.getState().setThemePreference("dark");
    expect(useUiStore.getState().themePreference).toBe("dark");
  });

  it("goes through an injected storage instead of the browser's", () => {
    const written: [string, string][] = [];
    setPreferenceStorage({
      read: (key) => (key === THEME_KEY ? "dark" : "collapsed"),
      write: (key, value) => void written.push([key, value]),
    });

    expect(hydrateUiStore()).toEqual({ themePreference: "dark", sidebarCollapsed: true });
    useUiStore.getState().setThemePreference("light");
    useUiStore.getState().setSidebarCollapsed(false);

    expect(written).toEqual([[THEME_KEY, "light"], [SIDEBAR_KEY, "expanded"]]);
    expect(window.localStorage.getItem(THEME_KEY)).toBeNull();
  });
});

/*
 * The collapse state has no <html> artifact the way the theme does, so the
 * no-flash guarantee cannot be asserted from a rendered tree: by the time a
 * mount settles, a store hydrated before render and one hydrated from an effect
 * produce the same DOM. It is proved here instead — hydrateUiStore returns the
 * persisted value with no render involved.
 */
describe("the sidebar collapse state", () => {
  it("hydrates a stored collapsed state synchronously", () => {
    window.localStorage.setItem(SIDEBAR_KEY, "collapsed");

    expect(hydrateUiStore().sidebarCollapsed).toBe(true);
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
  });

  it("hydrates to expanded when nothing is stored", () => {
    expect(hydrateUiStore().sidebarCollapsed).toBe(false);
  });

  it("hydrates a stored expanded state", () => {
    window.localStorage.setItem(SIDEBAR_KEY, "expanded");

    useUiStore.setState({ sidebarCollapsed: true });
    expect(hydrateUiStore().sidebarCollapsed).toBe(false);
  });

  // The value is self-describing rather than a serialised boolean, so an
  // unrecognised one is told apart from "expanded" and falls back to it.
  it("ignores a stored value that names no state", () => {
    window.localStorage.setItem(SIDEBAR_KEY, "true");
    expect(hydrateUiStore().sidebarCollapsed).toBe(false);
  });

  it("persists both states under their own key", () => {
    useUiStore.getState().setSidebarCollapsed(true);
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe("collapsed");

    useUiStore.getState().setSidebarCollapsed(false);
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe("expanded");
    expect(window.localStorage.getItem(THEME_KEY)).toBeNull();
  });

  it("applies a new state even when storage cannot be written", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage is not available on this origin");
    });

    useUiStore.getState().setSidebarCollapsed(true);
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
  });
});

describe("the preference list", () => {
  it("labels every preference exactly once", () => {
    expect(Object.keys(THEME_PREFERENCE_LABELS).sort()).toEqual([...THEME_PREFERENCES].sort());
  });
});
