import { useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useLayoutEffect, useState } from "react";
import { useUiStore, type BoardReturn } from "../store/ui";

const RESTORE_CANCELLERS = ["keydown", "pointerdown", "wheel"] as const;

/**
 * A card the filters now hide, or a task that is gone, leaves the focus where it
 * is. Focus scrolls of its own accord where the restored offset leaves the card
 * out of view or under the sticky column header.
 */
function focusReturnCard(taskId: string): void {
  document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(taskId)}"] [data-task-title]`)?.focus();
}

/**
 * Puts the board back where the reader left it when they opened a card: the
 * scroll position that was recorded, and focus on that card.
 *
 * The router resets the scroll to the top from an `onRendered` subscriber it
 * registered when it was created, so a restore in a layout effect is undone.
 * This one waits for the same event, later in the subscriber list and therefore
 * after the reset, and it runs once: a later visit opens the board at the top.
 *
 * Until the columns use the search result for `q` (`settled`), the restore
 * waits, and the reader's own key, pointer or wheel input cancels it. A
 * `scroll` does not: the router's reset and the restore itself scroll too.
 * A waiting restore acts only while its record is still the pending one: a
 * card opened meanwhile records a restore of its own.
 */
export function useBoardReturn(tag: string, labels: string | undefined, q: string | undefined, settled: boolean): void {
  const router = useRouter();
  const boardReturn = useUiStore((state) => state.boardReturn);
  const pending = useUiStore((state) => state.boardRestorePending);
  const endBoardRestore = useUiStore((state) => state.endBoardRestore);
  const [waitingFor, setWaitingFor] = useState<BoardReturn | null>(null);
  const waiting = waitingFor === boardReturn && pending ? waitingFor : null;
  const isSettled = useEffectEvent(() => settled);
  const endIfWaiting = useEffectEvent(() => {
    // Read from the store: the card that unmounts the board can record its
    // return after the board last rendered.
    const state = useUiStore.getState();
    if (waitingFor !== null && waitingFor === state.boardReturn && state.boardRestorePending) {
      endBoardRestore();
    }
  });

  // A restore that waits for the board's input ends with the board: no later visit takes it.
  useEffect(() => () => {
    endIfWaiting();
  }, []);

  useLayoutEffect(() => {
    if (boardReturn === null || !pending) {
      return;
    }
    if (boardReturn.projects !== tag || boardReturn.labels !== labels || boardReturn.q !== q) {
      endBoardRestore();
      return;
    }

    let frame = 0;
    // Subscribed at once: the event fires once per navigation.
    const stop = router.subscribe("onRendered", () => {
      stop();
      if (!isSettled()) {
        setWaitingFor(boardReturn);
        return;
      }
      window.scrollTo(boardReturn.scrollX, boardReturn.scrollY);
      // A frame after the effect AppShell moves focus to <main> in.
      frame = requestAnimationFrame(() => {
        focusReturnCard(boardReturn.taskId);
        endBoardRestore();
      });
    });

    return () => {
      stop();
      cancelAnimationFrame(frame);
    };
  }, [boardReturn, pending, tag, labels, q, router, endBoardRestore]);

  useEffect(() => {
    if (waiting === null) {
      return;
    }

    function cancel(): void {
      setWaitingFor(null);
      endBoardRestore();
    }

    for (const type of RESTORE_CANCELLERS) {
      window.addEventListener(type, cancel, { capture: true });
    }

    let focusFrame = 0;
    const frame = settled
      ? requestAnimationFrame(() => {
          window.scrollTo(waiting.scrollX, waiting.scrollY);
          // A virtualized column renders the card only on the scroll event, which
          // fires in the next frame, before that frame's callbacks.
          focusFrame = requestAnimationFrame(() => {
            focusReturnCard(waiting.taskId);
            setWaitingFor(null);
            endBoardRestore();
          });
        })
      : 0;

    return () => {
      for (const type of RESTORE_CANCELLERS) {
        window.removeEventListener(type, cancel, { capture: true });
      }
      cancelAnimationFrame(frame);
      cancelAnimationFrame(focusFrame);
    };
  }, [waiting, settled, endBoardRestore]);
}
