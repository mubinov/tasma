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
