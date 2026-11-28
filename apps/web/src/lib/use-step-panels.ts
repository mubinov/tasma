import { useRef, useState } from "react";
import { focusedIn, stepOfElement } from "./setup-step-elements";
import type { SetupStep, StepId } from "./setup-steps";

export type StepPanels = {
  open: StepId | null;
  changeOpen: (value: StepId[]) => void;
  /** The user pressed a control inside a panel. */
  pressInside: () => void;
  /**
   * Opens the current step after a change of the steps, unless the open panel is kept. With `act` false it only
   * notes the current step, for the next change.
   */
  follow: (act: boolean) => void;
  /** The open panel, also when an effect of the same commit opened it. */
  openNow: () => StepId | null;
  kept: (step: StepId | null) => boolean;
  /** Opens a step as the user would. */
  showByHand: (step: StepId) => void;
};

/** Which panel of the steps in `container` is open: one at a time, the current step unless the user chose another. */
export function useStepPanels(
  container: HTMLElement | null,
  steps: readonly SetupStep[],
  current: SetupStep | undefined,
  fullAnswered: boolean,
): StepPanels {
  const [open, setOpen] = useState<StepId | null>(null);
  // Two effects of one commit can each open a panel, and the second needs what the first chose.
  const openNowRef = useRef<StepId | null>(null);
  // The panel that is open is one the user opened or pressed a control in, or one opened to show a failure.
  const byHandRef = useRef(false);
  const openerRef = useRef<StepId | null>(null);

  function show(step: StepId | null): void {
    openNowRef.current = step;
    setOpen(step);
  }

  /**
   * A panel that the user opened, or that holds focus, stays open. WebKit does not focus a button on a
   * pointer press, so focus alone does not protect a panel that a mouse user opened.
   */
  function kept(step: StepId | null): boolean {
    return step !== null && (byHandRef.current || stepOfElement(focusedIn(container)) === step);
  }

  return {
    open,
    changeOpen: (value) => {
      const next = value[0] ?? null;

      if (next !== null) {
        byHandRef.current = true;
        show(next);
        return;
      }

      // The current step stays closed when it is the panel the user closed.
      const reopens = byHandRef.current && fullAnswered && current !== undefined && current.id !== open;

      byHandRef.current = false;
      show(reopens ? current.id : null);
    },
    pressInside: () => {
      byHandRef.current = true;
    },
    follow: (act) => {
      const opener = fullAnswered ? current?.id ?? null : null;
      const lastOpener = openerRef.current;

      openerRef.current = opener;
      if (!act) {
        return;
      }

      const openStep = steps.find(({ id }) => id === open);
      const openLeft = openStep !== undefined && !openStep.canOpen;

      if (openLeft) {
        byHandRef.current = false;
      }
      if (opener === lastOpener && !openLeft) {
        return;
      }
      if (!openLeft && kept(open)) {
        return;
      }

      show(opener);
    },
    openNow: () => openNowRef.current,
    kept,
    showByHand: (step) => {
      byHandRef.current = true;
      show(step);
    },
  };
}
