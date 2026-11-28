import { useEffect, useEffectEvent, useRef, type FocusEvent, type RefObject } from "react";
import { stepOfElement, triggerIn } from "./setup-step-elements";
import type { StepId } from "./setup-steps";
import { focusDropped } from "./use-focus-lost";

/**
 * The element that held focus, and its step. Focus drops to <body> when the
 * element leaves the page, and by then the element no longer names its step.
 */
type HeldFocus = { element: Element; step: StepId | null };

/**
 * Moves focus to a step trigger in `container`, else to `fallbackRef`, when the focused element of the container
 * leaves the page. WebKit fires no `focusout` for it. Returns the focus handler of the container.
 */
export function useSetupFocusFallback(
  container: HTMLElement | null,
  fallbackRef: RefObject<HTMLElement | null>,
  current: StepId | undefined,
  active: boolean,
): (event: FocusEvent) => void {
  const heldRef = useRef<HeldFocus | null>(null);

  const restoreFocus = useEffectEvent((within: HTMLElement) => {
    const held = heldRef.current;

    if (held === null || held.element.isConnected || !focusDropped() || !active) {
      return;
    }

    (triggerIn(within, held.step) ?? triggerIn(within, current) ?? fallbackRef.current!).focus();
  });

  useEffect(() => {
    if (container === null) {
      return;
    }

    const observer = new MutationObserver(() => {
      restoreFocus(container);
    });

    observer.observe(container, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
    };
  }, [container]);

  return ({ target }) => {
    heldRef.current = { element: target, step: stepOfElement(target) };
  };
}
