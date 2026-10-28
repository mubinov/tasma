import { useMutation } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { chatSeenOptions } from "../api/mutations";
import type { ChatPlace } from "../api/queries";

const CHECK_MS = 250;

const HOLD_MS = 1_000;

export type SeenWatch = ChatPlace & {
  /** The scroll box of the thread, null before it mounts. */
  viewport: HTMLElement | null;
  /** The `seq` of the last entry that the view shows. */
  seq: number;
  /** The `seen` of the chat record. */
  seen: number | undefined;
  /** From `chatBusy`. */
  busy: boolean;
};

/** The end of the content is at most half a screen below the visible area. */
export function endInView({ scrollHeight, scrollTop, clientHeight }: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">): boolean {
  return scrollHeight - scrollTop - clientHeight <= clientHeight / 2;
}

/** The bottom edge of the box is inside the window: a page can scroll a chat panel out of it. */
function onScreen(viewport: HTMLElement): boolean {
  const { bottom } = viewport.getBoundingClientRect();
  return viewport.clientHeight > 0 && bottom > 0 && bottom <= window.innerHeight + 1;
}

function endSeen(viewport: HTMLElement | null): boolean {
  return document.visibilityState === "visible"
    && document.hasFocus()
    && viewport !== null
    && onScreen(viewport)
    && endInView(viewport);
}

/**
 * Moves `seen` of the chat to `seq` when the end of the chat stays in view of
 * a focused window for 1 second while the chat is not busy. Each `seq` is
 * written one time, also when the write fails.
 */
export function useChatSeen({ tag, task, chat, viewport, seq, seen, busy }: SeenWatch): void {
  const { client, queryClient } = useRouter().options.context;
  const { mutate } = useMutation(chatSeenOptions(client, { tag, task, chat }), queryClient);
  const sentRef = useRef(0);

  useEffect(() => {
    if (busy || seq <= Math.max(seen ?? 0, sentRef.current)) {
      return undefined;
    }
    let held = -1;
    const check = (): void => {
      held = endSeen(viewport) ? held + 1 : -1;
      if (held * CHECK_MS >= HOLD_MS) {
        clearInterval(timer);
        sentRef.current = seq;
        mutate(seq);
      }
    };
    const timer = setInterval(check, CHECK_MS);
    check();
    return () => {
      clearInterval(timer);
    };
  }, [viewport, seq, seen, busy, mutate]);
}
