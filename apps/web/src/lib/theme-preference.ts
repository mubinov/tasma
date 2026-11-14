// Imports nothing and touches no DOM: the repo tests import it under Node.

export const THEME_PREFERENCES = ["system", "light", "dark"] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];
