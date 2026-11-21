import { DEFAULT_DAEMON_PORT } from "@tasma/protocol";

export type LinkKind
  = | { kind: "web"; url: string }
    | { kind: "mail"; address: string }
    | { kind: "task"; id: string }
    | { kind: "editor"; url: string }
    | { kind: "file"; path: string; line?: number };

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

/** Invented schemes of the bases that `hasNoScheme` resolves an href against. */
const PROBE_BASE_SCHEMES = ["relative-a:", "relative-b:"];

const LINE_FRAGMENT = /^L(\d+)(?:-L\d+)?$/;

/**
 * The kind of a URL or a path, with its data, or `undefined` for one that is
 * no link.
 */
export function linkKind(href: string): LinkKind | undefined {
  if (hasNoScheme(href)) {
    return fileLink(href);
  }

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

/**
 * Whether the href resolves against each base in the scheme of that base. An
 * href with a scheme keeps its own scheme or does not parse, also one whose host
 * or port does not parse. Two bases, so that an href naming one of these schemes
 * fails the other.
 */
function hasNoScheme(href: string): boolean {
  return PROBE_BASE_SCHEMES.every((scheme) => URL.parse(href, `${scheme}/`)?.protocol === scheme);
}

/**
 * The parser gives the href percent-encoded, so one decode gives the path as
 * written. A `~` path stays no link: the web part does not know the home folder.
 * A path with a bidi control stays no link: the tooltip shows the path, and the
 * control can show it in another order. A path with a control character stays
 * no link: Copy path gives the path as text to paste, and a newline pasted into
 * a terminal runs the rest as a command.
 */
function fileLink(href: string): LinkKind | undefined {
  const hash = href.indexOf("#");
  const part = hash < 0 ? href : href.slice(0, hash);
  if (part === "" || part.includes("?") || part.startsWith("//")) {
    return undefined;
  }
  const path = decoded(part);
  if (path === undefined || path.startsWith("~") || /[\p{Bidi_Control}\p{Cc}]/u.test(path)) {
    return undefined;
  }
  const digits = hash < 0 ? undefined : LINE_FRAGMENT.exec(href.slice(hash + 1))?.[1];
  const line = Number(digits);
  return line >= 1 && Number.isSafeInteger(line) ? { kind: "file", path, line } : { kind: "file", path };
}

/**
 * The absolute path of a file link, from the folder of its text, or `undefined`
 * for a relative path with no folder. A `..` segment stays: only the file system
 * resolves it correctly through a symlink.
 */
export function fileLinkPath(path: string, folder: string | undefined): string | undefined {
  if (path.startsWith("/")) {
    return withoutEmptyOrDotSegments(path);
  }
  return folder === undefined ? undefined : withoutEmptyOrDotSegments(`${folder}/${path}`);
}

function withoutEmptyOrDotSegments(path: string): string {
  return `/${path.split("/").filter((segment) => segment !== "" && segment !== ".").join("/")}`;
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
