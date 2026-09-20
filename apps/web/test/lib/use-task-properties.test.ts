import { QueryClientProvider } from "@tanstack/react-query";
import { createClient, type Config, type Frontmatter, type TaskEntry, type TransportReply } from "@tasma/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createAppQueryClient } from "../../src/api/client";
import { useTaskProperties } from "../../src/lib/use-task-properties";
import { stubTransport, successReply } from "../helpers";

const TAG = "NOTE";

const TASK_PATH = "/projects/NOTE/tasks/NOTE-3";

const CONFIG: Config = {
  statuses: ["Backlog", "In Progress", "Done"],
  default_status: "Backlog",
  final_statuses: ["Done"],
  priorities: ["high", "low"],
  workflows: [],
  instructions: [],
};

function frontmatter(fields: Partial<Frontmatter> = {}): Frontmatter {
  return {
    id: "NOTE-3",
    title: "Build the parser",
    status: "In Progress",
    created: "2026-09-01T10:00:00Z",
    updated: "2026-09-01T10:00:00Z",
    next_comment_id: 1,
    ...fields,
  };
}

function renderProperties(entries: readonly TaskEntry[] = []) {
  const replies: Record<string, TransportReply> = { [`PATCH ${TASK_PATH}`]: successReply({ id: "NOTE-3" }) };
  const { transport, requests } = stubTransport(replies);
  const queryClient = createAppQueryClient();
  const client = createClient(transport);
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const rendered = renderHook(
    () => useTaskProperties({
      queryClient,
      client,
      tag: TAG,
      id: "NOTE-3",
      frontmatter: frontmatter(),
      config: CONFIG,
      entries,
      workflow: null,
    }),
    { wrapper },
  );

  /** Runs a pick and waits until its write is sent or dropped. */
  async function pick(run: () => void): Promise<void> {
    await act(async () => {
      run();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }

  return { ...rendered, pick, writes: () => requests.filter(({ method }) => method === "PATCH").map(({ body }) => body) };
}

afterEach(() => {
  cleanup();
});

describe("the Status row", () => {
  it("sends the status and the order of the top of its new column", async () => {
    const { result, pick, writes } = renderProperties();

    await pick(() => {
      result.current.status.onPick("Done");
    });

    expect(writes()).toEqual([{ status: "Done", order: 0 }]);
  });

  // The task page serves the listing from the cache the board filled, so the
  // listing can hold a status the task read has already moved on from.
  it("sends the write when the listing still holds the status the pick asks for", async () => {
    const stale: TaskEntry = {
      id: "NOTE-3",
      path: TASK_PATH,
      frontmatter: frontmatter({ status: "Done", order: 0 }),
      blocked: false,
    };
    const { result, pick, writes } = renderProperties([stale]);

    await pick(() => {
      result.current.status.onPick("Done");
    });

    expect(writes()).toEqual([{ status: "Done", order: 0 }]);
  });

  // Status is required, so its menu offers no "None" and a null never arrives.
  it("sends nothing for a pick that clears it", async () => {
    const { result, pick, writes } = renderProperties();

    await pick(() => {
      result.current.status.onPick(null);
    });

    expect(writes()).toEqual([]);
  });
});
