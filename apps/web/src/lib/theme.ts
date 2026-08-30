import { useLayoutEffect, useSyncExternalStore } from "react";
import { useUiStore, type ThemePreference } from "../store/ui";

/** The theme the document actually renders in, once the preference is resolved. */
export type Theme = "light" | "dark";

const DARK_QUERY = "(prefers-color-scheme: dark)";

const THEMES: readonly Theme[] = ["light", "dark"];

function subscribeToSystemTheme(onChange: () => void): () => void {
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** The appearance the operating system is set to right now. */
export function readSystemTheme(): Theme {
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

/**
 * The theme a preference resolves to. The system appearance is a parameter so
 * a caller already subscribed to it passes that value instead of reading a
 * second time, and the rule stays written once.
 */
export function resolveTheme(preference: ThemePreference, systemTheme: Theme = readSystemTheme()): Theme {
  return preference === "system" ? systemTheme : preference;
}

/**
 * Writes the theme as a class on <html>, which is the one element it may sit
 * on; test/base-ui.test.tsx states why and enforces it.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.classList.remove(...THEMES);
  root.classList.add(theme);
}

export type UseTheme = {
  preference: ThemePreference;
  theme: Theme;
  setPreference: (preference: ThemePreference) => void;
};

/**
 * Keeps <html> on the resolved theme for as long as the app runs. The entry
 * writes the first class before rendering, so this only has to follow later
 * changes — from a layout effect, which runs before the browser paints.
 */
export function useTheme(): UseTheme {
  const preference = useUiStore((state) => state.themePreference);
  const setPreference = useUiStore((state) => state.setThemePreference);
  const systemTheme = useSyncExternalStore(subscribeToSystemTheme, readSystemTheme);
  const theme = resolveTheme(preference, systemTheme);

  useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return { preference, theme, setPreference };
}
