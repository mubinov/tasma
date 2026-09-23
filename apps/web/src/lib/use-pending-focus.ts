import { useLayoutEffect, useRef } from "react";
import { useUiStore } from "../store/ui";

type PendingFocus = { move: () => void; afterWrite: boolean };

/**
 * Moves the caret once the render in flight has committed, when the element it
 * goes to is on the page. The last move asked for wins.
 *
 * `afterWrite` marks a move that follows a write rather than the reader's own
 * answer: it is not run while a modal dialog stands open, since the caret would
 * leave that dialog for the page under it. The store keeps it for a dialog that
 * closes with nowhere left to return the caret to.
 */
export function usePendingFocus(): (move: () => void, afterWrite?: boolean) => void {
  const pendingRef = useRef<PendingFocus | null>(null);

  useLayoutEffect(() => {
    const pending = pendingRef.current;
    if (pending === null) {
      return;
    }

    pendingRef.current = null;
    const ui = useUiStore.getState();
    if (pending.afterWrite && ui.modalDialogs > 0) {
      ui.dropFocus(pending.move);
      return;
    }

    pending.move();
  });

  return (move, afterWrite = false) => {
    pendingRef.current = { move, afterWrite };
  };
}
