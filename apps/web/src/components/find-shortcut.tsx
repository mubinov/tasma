import type { AnyRouter } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { useUiStore } from "../store/ui";

/** The board and the task page. */
const FIND_ROUTES = new Set(["/tasks", "/tasks/$project/$task"]);

/** The dashboard takes the key only while its search field is mounted. */
const DASHBOARD_ROUTE = "/";

const LATIN_LETTER = /^[a-z]$/i;

function isFindKey({ key, code, metaKey, shiftKey, altKey, ctrlKey }: KeyboardEvent): boolean {
  if (!metaKey || shiftKey || altKey || ctrlKey) {
    return false;
  }
  // A layout that types no Latin letter, Cyrillic for example, is read by the place of the key.
  return key.toLowerCase() === "f" || (!LATIN_LETTER.test(key) && code === "KeyF");
}

/**
 * Cmd+F on the board, on the task page and on the dashboard. On any other
 * screen the key stays the browser's. It sits above the router, where no
 * router hook works, so it reads the router it is handed at each press.
 */
export function FindShortcut({ router }: { router: AnyRouter }): ReactNode {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const ui = useUiStore.getState();
      if (!isFindKey(event) || ui.modalDialogs > 0) {
        return;
      }
      const route = router.state.matches.at(-1)?.routeId;
      const findable = route === DASHBOARD_ROUTE ? ui.findTargets > 0 : route !== undefined && FIND_ROUTES.has(route);
      if (!findable) {
        return;
      }

      event.preventDefault();
      useUiStore.getState().requestFind();
    }

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [router]);

  return null;
}
