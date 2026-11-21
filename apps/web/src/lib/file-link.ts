import { FileActionError, openFile, revealFile } from "../api/files";
import type { ShowNotice } from "../store/notices";
import { fileOpenFailure, fileRevealFailure } from "./write-failure";

/** Each segment encoded, so a `#` or a `?` in a file name stays in the path. */
export function fileUrl(path: string): string {
  return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
}

function statusOf(error: unknown): number | null {
  return error instanceof FileActionError ? error.status : null;
}

/** Opens the file at the absolute `path`, and gives the notice of a failure to `fail`. It never rejects. */
export async function openFileLink(path: string, line: number | undefined, fail: ShowNotice): Promise<void> {
  try {
    await openFile(path, line);
  } catch (error) {
    fail(fileOpenFailure(path, statusOf(error)));
  }
}

/** Shows the file at the absolute `path` in Finder, and gives the notice of a failure to `fail`. It never rejects. */
export async function revealFileLink(path: string, fail: ShowNotice): Promise<void> {
  try {
    await revealFile(path);
  } catch (error) {
    fail(fileRevealFailure(path, statusOf(error)));
  }
}
