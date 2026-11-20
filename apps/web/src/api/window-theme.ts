import type { ThemePreference } from "../lib/theme-preference";
import { appAvailable } from "./app";
import { APP_PATH_PREFIX, THEME_ROUTE } from "./paths";

/** True only when the page runs in the macOS app, on the tasma-app: origin. */
export function windowThemeAvailable(): boolean {
  return appAvailable();
}

let lastSend: Promise<void> = Promise.resolve();

/**
 * Each send starts after the previous one settles: the app applies them in the
 * order they arrive, so the window ends on the last setting. Every failure
 * leaves the window on its last appearance.
 */
export function sendWindowTheme(preference: ThemePreference): Promise<void> {
  lastSend = lastSend.then(() =>
    fetch(`${APP_PATH_PREFIX}${THEME_ROUTE}/${preference}`, { method: "POST" }).then(
      () => undefined,
      () => undefined,
    ),
  );

  return lastSend;
}
