import { useEffect, type ReactNode } from "react";

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta"]);

/**
 * Records the last input mode as `data-input` on `<html>`, `keyboard` or
 * `pointer`, for the `keyboard:` variant. A key with a modifier held counts:
 * Option+Down Arrow opens a combobox list.
 */
export function InputModeSync(): ReactNode {
  useEffect(() => {
    const root = document.documentElement;

    function record(mode: "keyboard" | "pointer"): void {
      if (root.dataset.input !== mode) {
        root.dataset.input = mode;
      }
    }

    function onKeyDown({ key }: KeyboardEvent): void {
      if (!MODIFIER_KEYS.has(key)) {
        record("keyboard");
      }
    }

    function onPointerDown(): void {
      record("pointer");
    }

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      delete root.dataset.input;
    };
  }, []);

  return null;
}
