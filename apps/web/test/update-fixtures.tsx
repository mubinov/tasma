import { act, render } from "@testing-library/react";
import { vi } from "vitest";
import { UPDATE_EVENT } from "../src/api/paths";
import type { Update } from "../src/api/queries";
import { UpdateEvents } from "../src/components/update-events";
import { useNoticeStore } from "../src/store/notices";
import { useUiStore } from "../src/store/ui";
import { renderWithRouter } from "./helpers";

/** An answer of the app as it is sent: `none` names no version. */
export type Answer = Partial<Update> & Pick<Update, "state" | "current">;

export const AVAILABLE: Answer = {
  state: "available",
  current: "0.1.0",
  version: "0.2.0",
  releaseUrl: "https://example.invalid/releases/tag/v0.2.0",
};

/**
 * Stands in for the app's routes. A GET reads the state the test set; a POST
 * answers the status the test set for it, 202 by default.
 */
export function stubApp(initial: Answer | "unreachable" | "page") {
  let answer = initial;
  const requests: string[] = [];
  const statuses: Record<string, number | "unreachable"> = {};

  vi.stubGlobal("fetch", (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push(`${method} ${input}`);

    if (method === "GET") {
      if (answer === "unreachable") {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return Promise.resolve(
        answer === "page"
          ? new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } })
          : new Response(JSON.stringify(answer), { status: 200 }),
      );
    }

    const status = statuses[input] ?? 202;
    return status === "unreachable"
      ? Promise.reject(new TypeError("Failed to fetch"))
      : Promise.resolve(new Response(null, { status }));
  });

  return {
    requests,
    statuses,
    set(next: Answer) {
      answer = next;
    },
    posted: () => requests.filter((request) => request.startsWith("POST ")),
  };
}

export function spoken(): string[] {
  return useNoticeStore.getState().announced.map(({ words }) => words);
}

/** The shell, and the listener main.tsx mounts beside it. */
export async function renderApp() {
  const router = await renderWithRouter();
  render(<UpdateEvents queryClient={router.options.context.queryClient} />);

  return router;
}

export async function dispatch(detail: object) {
  await act(async () => {
    window.dispatchEvent(new CustomEvent(UPDATE_EVENT, { detail }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

export function resetUpdateUi(): void {
  window.localStorage.clear();
  useUiStore.setState({
    sidebarCollapsed: false,
    modalDialogs: 0,
    unsavedPage: false,
    updateDialog: null,
  });
}
