/**
 * Where the dev and preview servers mount the proxy, and the base path every
 * request in this app is written against.
 *
 * It stays alone in a module vite.config.ts can import: Vite loads its config
 * before any `define` exists, so a module that reads an injected global at
 * import time throws while the config loads. This one reads nothing and imports
 * nothing.
 */
export const DAEMON_PATH_PREFIX = "/daemon";

/**
 * The base path of the calls the macOS app answers itself, beside the daemon's.
 * No dev server proxies it, so in a browser it reaches no app.
 */
export const APP_PATH_PREFIX = "/app";

/** The scheme of the origin the macOS app serves the board from. */
export const APP_SCHEME = "tasma-app";

/** The folder dialog's route under `APP_PATH_PREFIX`. */
export const FOLDER_ROUTE = "/folder";

/** The Dock icon's route under `APP_PATH_PREFIX`. */
export const DOCK_ROUTE = "/dock";

/** The window appearance's route under `APP_PATH_PREFIX`. */
export const THEME_ROUTE = "/theme";

/** The link settings' route under `APP_PATH_PREFIX`. */
export const LINKS_ROUTE = "/links";

/** The installed browsers' route under `APP_PATH_PREFIX`. */
export const BROWSERS_ROUTE = "/browsers";

/** The route under `APP_PATH_PREFIX` that opens a web link in a named browser. */
export const OPEN_URL_ROUTE = "/open";

/** The installed code editors' route under `APP_PATH_PREFIX`. */
export const EDITORS_ROUTE = "/editors";

/** The route under `APP_PATH_PREFIX` that opens a file in the app the link settings choose. */
export const OPEN_FILE_ROUTE = "/files/open";

/** The route under `APP_PATH_PREFIX` that shows a file in Finder. */
export const REVEAL_FILE_ROUTE = "/files/reveal";

/** The event the macOS app dispatches on the window when the update changes. */
export const UPDATE_EVENT = "tasma:update";
