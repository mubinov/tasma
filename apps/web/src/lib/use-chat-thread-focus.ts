import { useAuiState } from "@assistant-ui/react";
import { useEffectEvent, useLayoutEffect, useRef, type DOMAttributes, type RefObject } from "react";
import { focusInView, KIT_INPUT } from "./focus-in-view";
import { focusDropped } from "./use-focus-lost";

const KIT_SEND = '[aria-label="Send message"]';

/**
 * An own turn removes the action bars of the messages with no action of the user.
 * A send puts Stop in the place of Send, or disables Send, so the focus goes to the
 * message input: a second key press must not stop the turn. Text that comes back
 * into the input during a turn puts Send in the place of Stop, so the focus goes to
 * the heading: a key press meant for Stop must not send that text. The heading is
 * the target for every other element that leaves. The move is in a layout effect
 * body, because React gives the focus back to an element that stays in the page at
 * the end of its mutations. The last element with focus comes from React events:
 * they also come from a portal, such as a menu of a message, and React sends none
 * for an element that leaves in its commit.
 */
export function useChatThreadFocus(
  threadRef: RefObject<HTMLElement | null>,
  onFocusLost: () => void,
): Pick<DOMAttributes<HTMLElement>, "onFocusCapture" | "onBlurCapture"> {
  const canCancel = useAuiState((s) => s.composer.canCancel);
  const canSend = useAuiState((s) => s.composer.canSend);
  const lastFocusedRef = useRef<Element | null>(null);
  const settleFocus = useEffectEvent(() => {
    const held = focusDropped() ? lastFocusedRef.current : document.activeElement;
    if (held === null || (held.isConnected && !held.matches(":disabled"))) {
      return;
    }
    lastFocusedRef.current = null;
    if (held.matches(KIT_SEND)) {
      focusInView(threadRef.current!.querySelector<HTMLElement>(KIT_INPUT));
    } else {
      onFocusLost();
    }
  });

  useLayoutEffect(() => {
    settleFocus();
  }, [canCancel, canSend]);

  return {
    onFocusCapture: ({ target }) => {
      lastFocusedRef.current = target;
    },
    onBlurCapture: ({ target }) => {
      // A window that loses focus keeps `activeElement`, and the element can still leave.
      if (document.activeElement !== target) {
        lastFocusedRef.current = null;
      }
    },
  };
}
