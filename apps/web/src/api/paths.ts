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

/** The event the macOS app dispatches on the window when the update changes. */
export const UPDATE_EVENT = "tasma:update";
