import { useEffect, type ReactNode } from "react";
import { useUiStore } from "../store/ui";

/** Notes the first key press of the page in the store, for a screen that mounts after it. */
export function KeyWatch(): ReactNode {
  useEffect(() => {
    function onKeyDown({ metaKey, altKey, ctrlKey }: KeyboardEvent): void {
      // A shortcut, Cmd+Tab for example, moves no focus in the page.
      if (metaKey || altKey || ctrlKey) {
        return;
      }

      useUiStore.getState().noteKeyPress();
      window.removeEventListener("keydown", onKeyDown, true);
    }

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  return null;
}
