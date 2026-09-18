import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserPreferenceStorage,
  hydrateUiStore,
  revealedColumnKey,
  setPreferenceStorage,
  THEME_PREFERENCE_LABELS,
  THEME_PREFERENCES,
  useUiStore,
} from "../../src/store/ui";

const THEME_KEY = "tasma.theme";
const SIDEBAR_KEY = "tasma.sidebar";
const TASKS_PROJECT_KEY = "tasma.tasks.project";

beforeEach(() => {
  window.localStorage.clear();
  setPreferenceStorage(browserPreferenceStorage);
  useUiStore.setState({
    themePreference: "system",
    sidebarCollapsed: false,
    lastTasksProject: null,
    boardReturn: null,
    boardRestorePending: false,
    revealedColumns: new Set(),
  });
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

    expect(hydrateUiStore()).toEqual({ themePreference: "system", sidebarCollapsed: false, lastTasksProject: null });
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

    expect(hydrateUiStore()).toEqual({ themePreference: "dark", sidebarCollapsed: true, lastTasksProject: null });
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

describe("the last opened tasks project", () => {
  it("starts on null", () => {
    expect(hydrateUiStore().lastTasksProject).toBeNull();
    expect(useUiStore.getState().lastTasksProject).toBeNull();
  });

  it("persists the tag under its own key and hydrates it back", () => {
    useUiStore.getState().setLastTasksProject("SAGA");
    expect(useUiStore.getState().lastTasksProject).toBe("SAGA");
    expect(window.localStorage.getItem(TASKS_PROJECT_KEY)).toBe("SAGA");

    useUiStore.setState({ lastTasksProject: null });
    expect(hydrateUiStore().lastTasksProject).toBe("SAGA");
    expect(useUiStore.getState().lastTasksProject).toBe("SAGA");
  });

  it.each([{ stored: "saga" }, { stored: "" }, { stored: "SAGA-1" }, { stored: "../SAGA" }])(
    "hydrates the stored value \"$stored\", which is not a tag, as null",
    ({ stored }) => {
      window.localStorage.setItem(TASKS_PROJECT_KEY, stored);

      expect(hydrateUiStore().lastTasksProject).toBeNull();
    },
  );
});

describe("the preference list", () => {
  it("labels every preference exactly once", () => {
    expect(Object.keys(THEME_PREFERENCE_LABELS).sort()).toEqual([...THEME_PREFERENCES].sort());
  });
});

describe("the board a task page returns to", () => {
  const RECORD = { projects: "SAGA", labels: "web,infra", scrollX: 40, scrollY: 1200, taskId: "SAGA-7" };

  it("starts on null, with no restore to make", () => {
    expect(useUiStore.getState().boardReturn).toBeNull();
    expect(useUiStore.getState().boardRestorePending).toBe(false);
  });

  it("keeps the record when the restore it asked for is over", () => {
    useUiStore.getState().setBoardReturn(RECORD);
    expect(useUiStore.getState().boardReturn).toEqual(RECORD);
    expect(useUiStore.getState().boardRestorePending).toBe(true);

    useUiStore.getState().endBoardRestore();
    expect(useUiStore.getState().boardReturn).toEqual(RECORD);
    expect(useUiStore.getState().boardRestorePending).toBe(false);
  });

  it("asks for a restore again when a later open writes a record", () => {
    useUiStore.getState().setBoardReturn(RECORD);
    useUiStore.getState().endBoardRestore();
    useUiStore.getState().setBoardReturn(RECORD);

    expect(useUiStore.getState().boardRestorePending).toBe(true);
  });

  it("replaces the record a later open writes", () => {
    useUiStore.getState().setBoardReturn(RECORD);
    useUiStore.getState().setBoardReturn({ projects: "DELTA", scrollX: 0, scrollY: 0, taskId: "DELTA-1" });

    expect(useUiStore.getState().boardReturn).toEqual({ projects: "DELTA", scrollX: 0, scrollY: 0, taskId: "DELTA-1" });
  });

  it("writes nothing to storage, and is no part of what a reload hydrates", () => {
    const written: [string, string][] = [];
    setPreferenceStorage({ read: () => null, write: (key, value) => void written.push([key, value]) });

    useUiStore.getState().setBoardReturn(RECORD);
    useUiStore.getState().endBoardRestore();

    expect(written).toEqual([]);
    expect(hydrateUiStore()).toEqual({ themePreference: "system", sidebarCollapsed: false, lastTasksProject: null });
  });
});

describe("the final columns Show all has opened", () => {
  it("starts empty", () => {
    expect([...useUiStore.getState().revealedColumns]).toEqual([]);
  });

  it("keys a revealed column by its project and its place", () => {
    useUiStore.getState().revealColumn("SAGA", 3);

    expect(useUiStore.getState().revealedColumns.has(revealedColumnKey("SAGA", 3))).toBe(true);
    expect(useUiStore.getState().revealedColumns.has(revealedColumnKey("SAGA", 4))).toBe(false);
    expect(useUiStore.getState().revealedColumns.has(revealedColumnKey("DELTA", 3))).toBe(false);
  });

  it("keeps the columns revealed before", () => {
    useUiStore.getState().revealColumn("SAGA", 3);
    useUiStore.getState().revealColumn("DELTA", 3);
    useUiStore.getState().revealColumn("SAGA", 3);

    expect([...useUiStore.getState().revealedColumns].sort()).toEqual([
      revealedColumnKey("DELTA", 3),
      revealedColumnKey("SAGA", 3),
    ]);
  });

  it("writes nothing to storage, and hydrates to none", () => {
    const written: [string, string][] = [];
    setPreferenceStorage({ read: () => null, write: (key, value) => void written.push([key, value]) });

    useUiStore.getState().revealColumn("SAGA", 3);

    expect(written).toEqual([]);
    hydrateUiStore();
    expect(useUiStore.getState().revealedColumns.has(revealedColumnKey("SAGA", 3))).toBe(true);
  });
});
