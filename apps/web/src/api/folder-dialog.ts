import { useUiStore } from "../store/ui";
import { APP_PATH_PREFIX, APP_SCHEME, FOLDER_ROUTE } from "./paths";

/** The dialog is not available, the app refused, or the reply is not one the app sends. */
export class FolderDialogError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "FolderDialogError";
  }
}

/** True only when the page runs in the macOS app, on the tasma-app: origin. */
export function folderDialogAvailable(): boolean {
  return location.protocol === `${APP_SCHEME}:`;
}

const UNKNOWN_REPLY = "The app answered the folder request with a reply it does not send.";

function readPath(body: unknown): string | null {
  if (typeof body === "object" && body !== null && "path" in body) {
    const { path } = body;
    if (typeof path === "string" || path === null) {
      return path;
    }
  }

  throw new FolderDialogError(UNKNOWN_REPLY);
}

async function request(): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(`${APP_PATH_PREFIX}${FOLDER_ROUTE}`, { method: "POST" });
  } catch (error) {
    throw new FolderDialogError("The app did not answer the folder request.", error);
  }

  if (response.status !== 200) {
    throw new FolderDialogError(`The app refused the folder request with status ${response.status}.`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new FolderDialogError(UNKNOWN_REPLY, error);
  }

  return readPath(body);
}

let pending: Promise<string | null> | null = null;

/** The sheet blocks the window, so the page counts it as an open modal dialog. */
async function pick(): Promise<string | null> {
  useUiStore.getState().openModalDialog();
  try {
    return await request();
  } finally {
    pending = null;
    useUiStore.getState().closeModalDialog();
  }
}

/** The absolute path of the folder the user picks, or null on Cancel. */
export function pickFolder(): Promise<string | null> {
  if (!folderDialogAvailable()) {
    return Promise.reject(new FolderDialogError("The folder dialog is available only in the macOS app."));
  }

  // A call while a pick is pending gets that pick, so one sheet opens.
  pending ??= pick();
  return pending;
}
