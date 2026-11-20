import { useEffect, type ReactNode } from "react";
import { NO_CONTEXT_SELECT_SELECTOR } from "../lib/context-select";

/** A right click, or a Control-click, which macOS treats as one. */
function contextPress({ button, ctrlKey }: MouseEvent): boolean {
  return button === 2 || (button === 0 && ctrlKey);
}

/**
 * Stops the text selection that WebKit makes on a right click on an element
 * marked with `NO_CONTEXT_SELECT_MARK`. WebKit selects between `mousedown` and
 * `contextmenu`, through a cancelable `selectstart`; canceling `contextmenu`
 * does not undo it.
 */
export function ContextSelectGuard(): ReactNode {
  useEffect(() => {
    let pressed = false;

    // Both presses: WebKit sends no `mousedown` when a handler cancels
    // `pointerdown`, and VoiceOver's show-menu action may send `mousedown` alone.
    function onPress(event: MouseEvent): void {
      const { target } = event;
      if (contextPress(event) && target instanceof Element && target.closest(NO_CONTEXT_SELECT_SELECTOR) !== null) {
        pressed = true;
      }
    }

    function onSelectStart(event: Event): void {
      if (pressed) {
        event.preventDefault();
      }
    }

    // A record left set would also stop Select All, which sends `selectstart` too.
    function onEnd(): void {
      pressed = false;
    }

    document.addEventListener("pointerdown", onPress, true);
    document.addEventListener("mousedown", onPress, true);
    document.addEventListener("selectstart", onSelectStart, true);
    document.addEventListener("contextmenu", onEnd, true);
    document.addEventListener("pointerup", onEnd, true);
    document.addEventListener("keydown", onEnd, true);
    return () => {
      document.removeEventListener("pointerdown", onPress, true);
      document.removeEventListener("mousedown", onPress, true);
      document.removeEventListener("selectstart", onSelectStart, true);
      document.removeEventListener("contextmenu", onEnd, true);
      document.removeEventListener("pointerup", onEnd, true);
      document.removeEventListener("keydown", onEnd, true);
    };
  }, []);

  return null;
}
