import { useEffect, useEffectEvent, useLayoutEffect, useState } from "react";
import type { ChatMessage } from "./chat-fold";

export type ChatScrollInput = {
  /** The scroll box of the thread, null before it mounts. */
  viewport: HTMLElement | null;
  /** The message that the chat opens at, undefined for the end. */
  openId: string | undefined;
  /** The last message of the ready view. The open scroll waits for the thread to hold it. */
  lastId: string | undefined;
  /** The messages that the kit thread holds now. */
  messages: readonly { id: string }[];
  scrollToBottom: (config: { behavior: ScrollBehavior }) => void;
  onFollow: (follow: boolean) => void;
};

/** The id of the message that a chat opens at, or undefined for the end. */
export function chatOpenMessageId(
  messages: readonly ChatMessage[],
  seen: number | undefined,
  busy: boolean,
): string | undefined {
  if (busy || seen === undefined) {
    return undefined;
  }
  return messages.find(({ seq }) => seq > seen)?.id;
}

/** `offsetTop` leaves out the transform of the enter animation of a message, which `getBoundingClientRect` holds. */
function topOf(element: HTMLElement, viewport: HTMLElement): number {
  return element.offsetParent === viewport
    ? element.offsetTop
    : element.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop;
}

function scrollToOpenPlace(
  viewport: HTMLElement,
  openId: string | undefined,
  scrollToBottom: ChatScrollInput["scrollToBottom"],
): void {
  if (openId === undefined) {
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "instant" });
    return;
  }
  const element = viewport.querySelector<HTMLElement>(`[data-message-id="${openId}"]`);
  if (element === null) {
    scrollToBottom({ behavior: "instant" });
    return;
  }
  viewport.scrollTo({ top: topOf(element, viewport), behavior: "instant" });
}

function keyboardFocusInMessage(viewport: HTMLElement): boolean {
  const active = document.activeElement;

  return active !== null
    && viewport.contains(active)
    && active.closest("[data-message-id]") !== null
    && active.matches(":focus-visible");
}

/**
 * A window that lost focus keeps `activeElement`, but `:focus-visible` stops
 * matching, so a check without focus keeps the pause as it is.
 */
function checkFocus(viewport: HTMLElement | null, setPaused: (paused: boolean) => void): void {
  if (viewport !== null && document.hasFocus()) {
    setPaused(keyboardFocusInMessage(viewport));
  }
}

/**
 * Puts the thread at its open place one time, and tells the host when the kit
 * may follow new content. A chat that opens at a message may follow after its
 * open scroll, and a chat that opens at its end from the mount. Neither may
 * while keyboard focus is in a message. The kit then follows only from the end.
 */
export function useChatScroll(
  { viewport, openId, lastId, messages, scrollToBottom, onFollow }: ChatScrollInput,
): void {
  const [opened, setOpened] = useState(false);
  const [paused, setPaused] = useState(false);
  const follow = (openId === undefined || opened) && !paused;
  const report = useEffectEvent(onFollow);
  const holdsLast = messages.some(({ id }) => id === lastId);

  useLayoutEffect(() => {
    if (opened || viewport === null || !holdsLast) {
      return;
    }
    scrollToOpenPlace(viewport, openId, scrollToBottom);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the follow starts from the place after this scroll
    setOpened(true);
  }, [opened, viewport, openId, holdsLast, scrollToBottom]);

  // WebKit sends no `focusout` when the focused element leaves the page.
  useLayoutEffect(() => {
    checkFocus(viewport, setPaused);
  }, [viewport, messages]);

  useEffect(() => {
    if (viewport === null) {
      return undefined;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = (): void => {
      checkFocus(viewport, setPaused);
    };
    // `activeElement` holds the new focus only in the next task.
    const onFocusOut = (): void => {
      clearTimeout(timer);
      timer = setTimeout(check, 0);
    };

    viewport.addEventListener("focusin", check);
    viewport.addEventListener("focusout", onFocusOut);
    viewport.addEventListener("scroll", check);
    return () => {
      clearTimeout(timer);
      viewport.removeEventListener("focusin", check);
      viewport.removeEventListener("focusout", onFocusOut);
      viewport.removeEventListener("scroll", check);
    };
  }, [viewport]);

  useEffect(() => {
    report(follow);
  }, [follow]);
}
