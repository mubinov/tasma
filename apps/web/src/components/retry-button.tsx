import { Button } from "@base-ui/react/button";
import { useRef, type ReactNode } from "react";
import { useFocusLost } from "../lib/use-focus-lost";
import { BUTTON_CLASS } from "./control-classes";

type RetryButtonProps = {
  onRetry: () => void;
  /** Called when the button goes away while it has the focus. */
  onFocusLost: () => void;
  label?: ReactNode;
  /** The id of the line that states the failure. */
  describedBy?: string;
};

/** A retry of a failed read, which a later read can remove while it has the focus. */
export function RetryButton({ onRetry, onFocusLost, label = "Try again", describedBy }: RetryButtonProps): ReactNode {
  const ref = useRef<HTMLButtonElement>(null);

  useFocusLost(ref, onFocusLost);

  return (
    <Button ref={ref} type="button" onClick={onRetry} aria-describedby={describedBy} className={`${BUTTON_CLASS} shrink-0`}>
      {label}
    </Button>
  );
}
