import { DEFAULT_DAEMON_PORT } from "@tasma/protocol";

export type LinkKind
  = | { kind: "web"; url: string }
    | { kind: "mail"; address: string }
    | { kind: "task"; id: string }
    | { kind: "editor"; url: string };

// The macOS part reads both lists at compile time: each stays one `Set` literal on one line.
export const LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);
export const EDITOR_SCHEMES = new Set(["vscode:", "vscode-insiders:", "cursor:", "vscodium:", "zed:"]);

/** The host names the daemon serves (`SERVED_HOSTS`). */
export const DAEMON_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The path of the daemon page, with one trailing `/` that link detectors add. */
const DAEMON_TASK_PATH = /^\/task\/([^/]+)\/?$/;

const TASMA_TASK_PATH = /^\/([^/]+)\/?$/;

/**
 * Checked before the tag is uppercased: `toUpperCase` maps some non-ASCII
 * letters to ASCII ones (`ſ` to `S`).
 */
const ID_CHARACTERS = /^[A-Za-z0-9-]+$/;

/** `TAG_RULE` of the engine. */
const TAG = /^[A-Z][A-Z0-9]{1,7}$/;

const NUMBER = /^[0-9]+$/;

/** One position suffix that every editor reads: `:<line>` or `:<line>:<column>`. */
const POSITION = /:(\d+)(?::(\d+))?$/;

/**
 * The kind of an absolute URL, with its data, or `undefined` for a URL that
 * is no link.
 */
export function linkKind(href: string): LinkKind | undefined {
  const url = URL.parse(href);
  if (url === null) {
    return undefined;
  }

  const id = url.protocol === "tasma:" ? tasmaTaskId(url) : daemonTaskId(url);
  if (id !== undefined) {
    return { kind: "task", id };
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    return { kind: "web", url: href };
  }
  if (url.protocol === "mailto:") {
    return { kind: "mail", address: decoded(url.pathname) ?? url.pathname };
  }
  if (EDITOR_SCHEMES.has(url.protocol) && url.hostname === "file" && isBare(url) && isEditorPath(url.pathname)) {
    return { kind: "editor", url: href };
  }
  return undefined;
}

/** The grammar of `route()` in the macOS part. */
function tasmaTaskId(url: URL): string | undefined {
  const segment = TASMA_TASK_PATH.exec(url.pathname)?.[1];
  if (!/^task$/i.test(url.hostname) || !isBare(url) || segment === undefined) {
    return undefined;
  }
  const id = decoded(segment);
  return id === undefined ? undefined : taskId(id);
}

/** The grammar of the daemon page, which reads the segment undecoded and ignores the query. */
function daemonTaskId(url: URL): string | undefined {
  const segment = DAEMON_TASK_PATH.exec(url.pathname)?.[1];
  const daemon = url.protocol === "http:" && DAEMON_HOSTS.has(url.hostname) && url.port === String(DEFAULT_DAEMON_PORT);
  if (!daemon || url.username !== "" || url.password !== "" || segment === undefined) {
    return undefined;
  }
  return taskId(segment);
}

function taskId(text: string): string | undefined {
  if (!ID_CHARACTERS.test(text)) {
    return undefined;
  }
  const dash = text.indexOf("-");
  if (dash < 0) {
    return undefined;
  }
  const tag = text.slice(0, dash).toUpperCase();
  const number = text.slice(dash + 1);
  return TAG.test(tag) && NUMBER.test(number) ? `${tag}-${number}` : undefined;
}

/**
 * No user, no password, no port, and no `?` or `#`. `search` and `hash` are
 * empty for an empty `?` or `#`, so the check reads `href`.
 */
function isBare(url: URL): boolean {
  return url.username === "" && url.password === "" && url.port === "" && !/[?#]/.test(url.href);
}

/**
 * Whether every editor reads the path of an editor link as the same file. The
 * editors read more position forms than `POSITION`, so the rule refuses each
 * path that one of them can read as another path. The macOS part applies the
 * same rule before it checks the file.
 */
function isEditorPath(path: string): boolean {
  const file = decoded(path)?.replace(POSITION, "");
  return (
    file !== undefined
    && file.startsWith("/")
    && file.slice(1).split("/").every((segment) => !["", ".", ".."].includes(segment))
    && !file.includes(":")
    && !/\p{White_Space}$/u.test(file)
    && !file.endsWith(")")
    && !file.toLowerCase().endsWith(".code-workspace")
  );
}

function decoded(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}
