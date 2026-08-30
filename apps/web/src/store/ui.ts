import { create } from "zustand";

/** Every theme preference, in the order the interface offers them. */
export const THEME_PREFERENCES = ["system", "light", "dark"] as const;

/** How the interface picks a theme: follow the system, or override it. */
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** The label each preference carries. A new preference fails to typecheck until it has one. */
export const THEME_PREFERENCE_LABELS: Record<ThemePreference, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

const STORAGE_KEY = "tasma.theme";

/** Where a preference survives a restart. */
export type PreferenceStorage = {
  read: () => ThemePreference;
  write: (preference: ThemePreference) => void;
};

function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_PREFERENCES.some((preference) => preference === value);
}

// A desktop shell may load the bundle from a file:// origin, where touching
// localStorage throws rather than returning null.
export const browserPreferenceStorage: PreferenceStorage = {
  read() {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      return isThemePreference(stored) ? stored : "system";
    } catch {
      return "system";
    }
  },
  write(preference) {
    try {
      window.localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      // A preference that cannot be persisted still applies for this session.
    }
  },
};

let storage: PreferenceStorage = browserPreferenceStorage;

/** Replaces the backend every later read and write goes through. */
export function setPreferenceStorage(next: PreferenceStorage): void {
  storage = next;
}

type UiState = {
  themePreference: ThemePreference;
  setThemePreference: (preference: ThemePreference) => void;
};

/**
 * The one piece of state that crosses distant components. Everything narrower
 * belongs in useState, and server data belongs in the query cache.
 *
 * It starts on the default and reads nothing: importing a module must not
 * touch storage, or the starting state cannot be changed by whoever mounts the
 * app. hydrateUiStore loads the persisted value instead.
 */
export const useUiStore = create<UiState>((set) => ({
  themePreference: "system",
  setThemePreference: (preference) => {
    storage.write(preference);
    set({ themePreference: preference });
  },
}));

/**
 * Loads the persisted preference into the store and returns it. The entry
 * calls this before the first render, so nothing paints on the wrong palette.
 */
export function hydrateUiStore(): ThemePreference {
  const themePreference = storage.read();
  useUiStore.setState({ themePreference });
  return themePreference;
}
