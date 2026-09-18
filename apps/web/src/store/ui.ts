import { create } from "zustand";

export const THEME_PREFERENCES = ["system", "light", "dark"] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export const THEME_PREFERENCE_LABELS: Record<ThemePreference, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

const THEME_STORAGE_KEY = "tasma.theme";
const SIDEBAR_STORAGE_KEY = "tasma.sidebar";
const TASKS_PROJECT_STORAGE_KEY = "tasma.tasks.project";

const PROJECT_TAG = /^[A-Z0-9]+$/;

const SIDEBAR_COLLAPSED = "collapsed";
const SIDEBAR_EXPANDED = "expanded";

function readSidebarState(stored: string | null): boolean | null {
  if (stored === SIDEBAR_COLLAPSED) {
    return true;
  }
  if (stored === SIDEBAR_EXPANDED) {
    return false;
  }
  return null;
}

export type PreferenceStorage = {
  read: (key: string) => string | null;
  write: (key: string, value: string) => void;
};

function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_PREFERENCES.some((preference) => preference === value);
}

// On a file:// origin, touching localStorage throws rather than returning null.
export const browserPreferenceStorage: PreferenceStorage = {
  read(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  write(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // A preference that cannot be persisted still applies for this session.
    }
  },
};

let storage: PreferenceStorage = browserPreferenceStorage;

export function setPreferenceStorage(next: PreferenceStorage): void {
  storage = next;
}

/** The board a task page returns to: its address, where it was scrolled, and the card that was opened. */
export type BoardReturn = {
  /** The `projects` of the board's address. */
  projects: string;
  /** The `labels` of the board's address, absent while no label is selected. */
  labels?: string;
  scrollX: number;
  scrollY: number;
  taskId: string;
};

/**
 * The name a final column is held under in `revealedColumns`. The column's
 * place names it, not its status: a hand-edited configuration can hold the same
 * status twice, and the board keys the two columns apart the same way.
 */
export function revealedColumnKey(tag: string, place: number): string {
  return `${tag}/${String(place)}`;
}

type UiState = {
  themePreference: ThemePreference;
  setThemePreference: (preference: ThemePreference) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  lastTasksProject: string | null;
  setLastTasksProject: (tag: string) => void;
  /** Where the open task page's back link leads. Never persisted: a reload has no board behind the page. */
  boardReturn: BoardReturn | null;
  /** Whether a board that matches `boardReturn` still has to put itself back. One board visit consumes it. */
  boardRestorePending: boolean;
  setBoardReturn: (record: BoardReturn) => void;
  endBoardRestore: () => void;
  /** The final columns "Show all" has opened, by `revealedColumnKey`. Never persisted: a reload folds them again. */
  revealedColumns: ReadonlySet<string>;
  revealColumn: (tag: string, place: number) => void;
};

// Starts on the defaults and reads nothing: importing a module must not touch
// storage. hydrateUiStore loads the persisted values.
export const useUiStore = create<UiState>((set) => ({
  themePreference: "system",
  setThemePreference: (preference) => {
    storage.write(THEME_STORAGE_KEY, preference);
    set({ themePreference: preference });
  },
  sidebarCollapsed: false,
  setSidebarCollapsed: (collapsed) => {
    storage.write(SIDEBAR_STORAGE_KEY, collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_EXPANDED);
    set({ sidebarCollapsed: collapsed });
  },
  lastTasksProject: null,
  setLastTasksProject: (tag) => {
    storage.write(TASKS_PROJECT_STORAGE_KEY, tag);
    set({ lastTasksProject: tag });
  },
  boardReturn: null,
  boardRestorePending: false,
  setBoardReturn: (record) => {
    set({ boardReturn: record, boardRestorePending: true });
  },
  endBoardRestore: () => {
    set({ boardRestorePending: false });
  },
  revealedColumns: new Set<string>(),
  revealColumn: (tag, place) => {
    set(({ revealedColumns }) => ({
      revealedColumns: new Set(revealedColumns).add(revealedColumnKey(tag, place)),
    }));
  },
}));

export type HydratedUi = {
  themePreference: ThemePreference;
  sidebarCollapsed: boolean;
  lastTasksProject: string | null;
};

export function hydrateUiStore(): HydratedUi {
  const stored = storage.read(THEME_STORAGE_KEY);
  const themePreference = isThemePreference(stored) ? stored : "system";
  const sidebarCollapsed = readSidebarState(storage.read(SIDEBAR_STORAGE_KEY)) ?? false;
  const storedProject = storage.read(TASKS_PROJECT_STORAGE_KEY);
  const lastTasksProject = storedProject !== null && PROJECT_TAG.test(storedProject) ? storedProject : null;

  useUiStore.setState({ themePreference, sidebarCollapsed, lastTasksProject });
  return { themePreference, sidebarCollapsed, lastTasksProject };
}
