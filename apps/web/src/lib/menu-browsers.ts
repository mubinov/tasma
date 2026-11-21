import type { Browser } from "../api/browsers";

const KNOWN_BROWSERS = ["com.apple.Safari", "com.google.Chrome", "org.mozilla.firefox"];

/**
 * The browsers of the link menu, each once: the default browser (`browser`, or
 * the macOS default when `browser` is empty or not in the list), the
 * development browser, then Safari, Chrome and Firefox when they are installed.
 */
export function menuBrowsers(list: Browser[], browser: string, devBrowser: string): Browser[] {
  const byId = (id: string) => list.find((entry) => entry.id === id);
  const picks = [
    byId(browser) ?? list.find((entry) => entry.default),
    byId(devBrowser),
    ...KNOWN_BROWSERS.map(byId),
  ];
  return [...new Set(picks.filter((pick) => pick !== undefined))];
}
