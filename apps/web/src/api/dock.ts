import type { AgentState } from "@tasma/protocol";
import { APP_PATH_PREFIX, APP_SCHEME, DOCK_ROUTE } from "./paths";

/** True only when the page runs in the macOS app, on the tasma-app: origin. */
export function dockAvailable(): boolean {
  return location.protocol === `${APP_SCHEME}:`;
}

const DOCK_STATES: Record<AgentState, true> = { "off": true, "running": true, "needs-you": true };

/**
 * A daemon answer does not hold its type at run time. The result is a segment
 * of a path under `/app`, and no error boundary stands above the caller.
 */
export function dockState(answer: unknown): AgentState | undefined {
  if (typeof answer !== "object" || answer === null) return undefined;
  const { state } = answer as { state?: unknown };
  return typeof state === "string" && Object.hasOwn(DOCK_STATES, state) ? (state as AgentState) : undefined;
}

/** Every failure leaves the Dock on its last image. */
export function sendDockState(state: AgentState): Promise<void> {
  return fetch(`${APP_PATH_PREFIX}${DOCK_ROUTE}/${state}`, { method: "POST" }).then(
    () => undefined,
    () => undefined,
  );
}
