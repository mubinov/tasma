import { appAvailable } from "./app";
import { APP_PATH_PREFIX, BROWSERS_ROUTE, OPEN_URL_ROUTE } from "./paths";

/** A browser installed on this Mac. `id` is its bundle id. */
export type Browser = { id: string; name: string; default: boolean };

/** Not in the macOS app, no answer, a refusal, or an answer that the app does not send. */
export class BrowserError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "BrowserError";
  }
}

const UNKNOWN_LIST = "The app answered the browser list request with a reply it does not send.";

async function request(route: string, init: RequestInit, purpose: string): Promise<Response> {
  if (!appAvailable()) {
    throw new BrowserError("The browsers are available only in the macOS app.");
  }

  try {
    return await fetch(`${APP_PATH_PREFIX}${route}`, init);
  } catch (error) {
    throw new BrowserError(`The app did not answer the ${purpose}.`, error);
  }
}

function isBrowser(entry: unknown): entry is Browser {
  return typeof entry === "object" && entry !== null
    && "id" in entry && typeof entry.id === "string"
    && "name" in entry && typeof entry.name === "string"
    && "default" in entry && typeof entry.default === "boolean";
}

/** The browsers installed on this Mac, sorted by name, with the macOS default marked. */
export async function listBrowsers(): Promise<Browser[]> {
  const response = await request(BROWSERS_ROUTE, { method: "GET" }, "browser list request");

  if (response.status !== 200) {
    throw new BrowserError(`The app refused the browser list request with status ${response.status}.`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new BrowserError(UNKNOWN_LIST, error);
  }

  if (!Array.isArray(body) || !body.every(isBrowser)) {
    throw new BrowserError(UNKNOWN_LIST);
  }

  return body;
}

/** Opens a web link in the browser with the bundle id `browser`. */
export async function openInBrowser(url: string, browser: string): Promise<void> {
  const response = await request(
    OPEN_URL_ROUTE,
    { method: "POST", body: JSON.stringify({ url, browser }) },
    "request to open a link",
  );

  if (response.status !== 204) {
    throw new BrowserError(`The app refused to open the link with status ${response.status}.`);
  }
}
