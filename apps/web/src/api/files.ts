import { appAvailable } from "./app";
import { APP_PATH_PREFIX, EDITORS_ROUTE, OPEN_FILE_ROUTE, REVEAL_FILE_ROUTE } from "./paths";

/** A code editor installed on this Mac. `id` is its bundle id. */
export type Editor = { id: string; name: string };

/**
 * Not in the macOS app, no answer, a refusal, or an answer that the app does not send.
 * `status` is the status of a refusal, and null in the other cases.
 */
export class FileActionError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null, cause?: unknown) {
    super(message, { cause });
    this.name = "FileActionError";
    this.status = status;
  }
}

const UNKNOWN_LIST = "The app answered the editor list request with a reply it does not send.";

async function request(route: string, init: RequestInit, purpose: string): Promise<Response> {
  if (!appAvailable()) {
    throw new FileActionError("Files open only in the macOS app.", null);
  }

  try {
    return await fetch(`${APP_PATH_PREFIX}${route}`, init);
  } catch (error) {
    throw new FileActionError(`The app did not answer the ${purpose}.`, null, error);
  }
}

function isEditor(entry: unknown): entry is Editor {
  return typeof entry === "object" && entry !== null
    && "id" in entry && typeof entry.id === "string"
    && "name" in entry && typeof entry.name === "string";
}

/** The code editors of the app's list that are installed on this Mac, sorted by name. */
export async function listEditors(): Promise<Editor[]> {
  const response = await request(EDITORS_ROUTE, { method: "GET" }, "editor list request");

  if (response.status !== 200) {
    throw new FileActionError(`The app refused the editor list request with status ${response.status}.`, response.status);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new FileActionError(UNKNOWN_LIST, null, error);
  }

  if (!Array.isArray(body) || !body.every(isEditor)) {
    throw new FileActionError(UNKNOWN_LIST, null);
  }

  return body;
}

async function send(route: string, body: { path: string; line?: number }, purpose: string): Promise<void> {
  const response = await request(route, { method: "POST", body: JSON.stringify(body) }, purpose);

  if (response.status !== 204) {
    throw new FileActionError(`The app refused the ${purpose} with status ${response.status}.`, response.status);
  }
}

/** Opens the file at the absolute `path` in the app that the link settings choose, at `line` when the app reads one. */
export function openFile(path: string, line?: number): Promise<void> {
  return send(OPEN_FILE_ROUTE, { path, line }, "request to open a file");
}

/** Shows the file at the absolute `path` in Finder. */
export function revealFile(path: string): Promise<void> {
  return send(REVEAL_FILE_ROUTE, { path }, "request to show a file in Finder");
}
