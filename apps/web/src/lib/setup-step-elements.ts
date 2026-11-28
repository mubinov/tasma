import type { StepId } from "./setup-steps";

export function stepOfElement(element: Element | null): StepId | null {
  return (element?.closest<HTMLElement>("[data-setup-step]")?.dataset.setupStep ?? null) as StepId | null;
}

/** The focused element inside `container`: the screen and a dialog over it use the same step ids. */
export function focusedIn(container: HTMLElement | null): Element | null {
  const active = document.activeElement;

  return active !== null && container?.contains(active) === true ? active : null;
}

export function triggerIn(container: HTMLElement, step: StepId | null | undefined): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-setup-step="${String(step)}"] [data-setup-trigger]`);
}
