import { useEffect } from "react";
import { sendWindowTheme } from "../api/window-theme";
import { useUiStore } from "../store/ui";

/**
 * Sends the theme setting, never the resolved theme, to the window of the
 * macOS app. The window's appearance decides what `prefers-color-scheme`
 * reports, so a resolved theme would hold `system` on the theme of that moment.
 */
export function WindowThemeSync(): null {
  const preference = useUiStore((state) => state.themePreference);

  useEffect(() => {
    void sendWindowTheme(preference);
  }, [preference]);

  return null;
}
