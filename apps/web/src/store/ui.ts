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

type UiState = {
  themePreference: ThemePreference;
  setThemePreference: (preference: ThemePreference) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
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
}));

export type HydratedUi = {
  themePreference: ThemePreference;
  sidebarCollapsed: boolean;
};

export function hydrateUiStore(): HydratedUi {
  const stored = storage.read(THEME_STORAGE_KEY);
  const themePreference = isThemePreference(stored) ? stored : "system";
  const sidebarCollapsed = readSidebarState(storage.read(SIDEBAR_STORAGE_KEY)) ?? false;

  useUiStore.setState({ themePreference, sidebarCollapsed });
  return { themePreference, sidebarCollapsed };
}
