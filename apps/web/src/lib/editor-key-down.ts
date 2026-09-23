import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";

/** Esc cancels and ⌘↩ submits, from any field or control of an editor. */
export function editorKeyDown(
  event: ReactKeyboardEvent,
  cancel: () => void,
  formRef: RefObject<HTMLFormElement | null>,
): void {
  if (event.key === "Escape") {
    event.preventDefault();
    // React flushes a discrete key synchronously, so the dialog this opens
    // mounts and attaches its dismissal listener above the React root while
    // the same keypress is still propagating there. Left to travel, that
    // keypress closes the dialog it has just opened.
    event.nativeEvent.stopPropagation();
    cancel();
  } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    formRef.current?.requestSubmit();
  }
}
