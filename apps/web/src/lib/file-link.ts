import { FileActionError, openFile } from "../api/files";
import { useNoticeStore } from "../store/notices";
import { FILE_OPEN_FAILURE_KEY, fileOpenFailure } from "./write-failure";

/** Each segment encoded, so a `#` or a `?` in a file name stays in the path. */
export function fileUrl(path: string): string {
  return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** Opens the file at the absolute `path`, and shows a notice when it does not open. It never rejects. */
export async function openFileLink(path: string, line: number | undefined): Promise<void> {
  try {
    await openFile(path, line);
  } catch (error) {
    const status = error instanceof FileActionError ? error.status : null;
    // Closed first, so a notice the reader dismissed with the same content does not hold this one back.
    useNoticeStore.getState().closeNotice(FILE_OPEN_FAILURE_KEY);
    useNoticeStore.getState().showNotice(fileOpenFailure(path, status));
  }
}
