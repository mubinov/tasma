import { Button } from "@base-ui/react/button";
import { useRef, type ReactNode } from "react";
import { useFocusLost } from "../lib/use-focus-lost";
import { BUTTON_CLASS } from "./control-classes";

type RetryButtonProps = {
  onRetry: () => void;
  /** Called when the button goes away while it has the focus. */
  onFocusLost: () => void;
};

/** "Try again" for a failed read, which a later read can remove while it has the focus. */
export function RetryButton({ onRetry, onFocusLost }: RetryButtonProps): ReactNode {
  const ref = useRef<HTMLButtonElement>(null);

  useFocusLost(ref, onFocusLost);

  return (
    <Button ref={ref} type="button" onClick={onRetry} className={`${BUTTON_CLASS} shrink-0`}>
      Try again
    </Button>
  );
}
