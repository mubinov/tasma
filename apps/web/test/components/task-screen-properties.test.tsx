import type { Frontmatter, TaskEntry } from "@tasma/protocol";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNoticeStore } from "../../src/store/notices";
import { useUiStore } from "../../src/store/ui";
import { heldBack, refusalReply, renderWithRouter, successReply } from "../helpers";
import {
  LISTING_PATH,
  TASK_PATH,
  daemon,
  entry,
  field,
  frontmatter,
  listing,
  metaLine,
  task,
  topBar,
} from "../task-screen-fixtures";

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({
    lastTasksProject: null,
    boardReturn: null,
    boardRestorePending: false,
    revealedColumns: new Set(),
  });
  useNoticeStore.setState({ notices: [], dismissed: new Map() });
  document.title = "tasma";
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("editing a property in the sidebar", () => {
  function ordered(id: string, status: string, order: number): TaskEntry {
    return { id, path: `/repos/saga/tasks/${id}.md`, blocked: false, frontmatter: frontmatter({ id, status, order }) };
  }

  function control(label: string): HTMLElement {
    return within(field(label)).getByRole("button");
  }

  function patches(requests: readonly { method: string; path: string; body?: unknown }[]) {
    return requests.filter(({ method }) => method === "PATCH").map(({ path, body }) => ({ path, body }));
  }

  async function pick(user: ReturnType<typeof userEvent.setup>, label: string, item: string) {
    await user.click(control(label));
    const menu = await screen.findByRole("menu", { name: label });
    await user.click(within(menu).getByRole("menuitemradio", { name: item }));
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
  }

  it("sends one write carrying status and order, so the task lands at the top of its new column", async () => {
    const user = userEvent.setup();
    const { transport, requests, replies } = daemon({
      [LISTING_PATH]: listing([entry("SAGA-3", "In Progress", "Build the parser"), ordered("SAGA-1", "Backlog", 500)]),
    });
    replies[`PATCH ${TASK_PATH}`] = successReply({ id: "SAGA-3" });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    await pick(user, "Status", "Backlog");

    expect(patches(requests)).toEqual([{ path: TASK_PATH, body: { status: "Backlog", order: -500 } }]);
  });

  it("writes the priority a pick names and removes the key None clears", async () => {
    const user = userEvent.setup();
    const { transport, requests, replies } = daemon({ [TASK_PATH]: task({ fields: { priority: "low" } }) });
    replies[`PATCH ${TASK_PATH}`] = successReply({ id: "SAGA-3" });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    await pick(user, "Priority", "high");
    await pick(user, "Priority", "None");

    expect(patches(requests)).toEqual([
      { path: TASK_PATH, body: { priority: "high" } },
      { path: TASK_PATH, body: { priority: null } },
    ]);
  });

  it("writes the step a pick names, and null for None", async () => {
    const user = userEvent.setup();
    const { transport, requests, replies } = daemon({
      [TASK_PATH]: task({ fields: { workflow: "dev", step: "research" } }),
    });
    replies[`PATCH ${TASK_PATH}`] = successReply({ id: "SAGA-3" });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    await pick(user, "Step", "approve");
    await pick(user, "Step", "None");

    expect(patches(requests)).toEqual([
      { path: TASK_PATH, body: { step: "approve" } },
      { path: TASK_PATH, body: { step: null } },
    ]);
  });

  // The daemon declares a step by its exact name, so the menu checks none of them
  // and the pick that puts the declared spelling on the task goes through.
  it("repairs a stored step that differs from a declared one in case alone", async () => {
    const user = userEvent.setup();
    const { transport, requests, replies } = daemon({
      [TASK_PATH]: task({ fields: { workflow: "dev", step: "Research" } }),
    });
    replies[`PATCH ${TASK_PATH}`] = successReply({ id: "SAGA-3" });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    await user.click(control("Step"));
    const menu = await screen.findByRole("menu", { name: "Step" });
    expect(within(menu).getAllByRole("menuitemradio").map((item) => item.getAttribute("aria-checked")))
      .toEqual(["false", "false", "false"]);
    await user.click(within(menu).getByRole("menuitemradio", { name: "research" }));

    await waitFor(() => {
      expect(patches(requests)).toEqual([{ path: TASK_PATH, body: { step: "research" } }]);
    });
  });

  it("shows the value being written with an ellipsis, in the sidebar and in the meta line alike", async () => {
    const user = userEvent.setup();
    const write = heldBack();
    const { transport, replies } = daemon();
    replies[`PATCH ${TASK_PATH}`] = write.reply;
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    await pick(user, "Status", "Done");

    expect(control("Status").textContent).toBe("Done…");
    expect(metaLine().firstElementChild?.textContent).toBe("Done");
  });

  // The menu hands focus back to the trigger, so the name it now carries is what
  // tells a reader the write is running.
  it("leaves focus on a trigger that names the value it sends", async () => {
    const user = userEvent.setup();
    const write = heldBack();
    const { transport, replies } = daemon();
    replies[`PATCH ${TASK_PATH}`] = write.reply;
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    await pick(user, "Status", "Done");

    await waitFor(() => {
      expect(document.activeElement).toBe(control("Status"));
    });
    expect(screen.getByRole("button", { name: "Status Done…" })).toBe(control("Status"));
  });

  // The pending write is laid over the frontmatter the menu reads its check from.
  it("sends nothing for the value a pending write is already sending", async () => {
    const user = userEvent.setup();
    const write = heldBack();
    const { transport, requests, replies } = daemon();
    replies[`PATCH ${TASK_PATH}`] = write.reply;
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    await pick(user, "Status", "Done");
    await pick(user, "Status", "Done");

    expect(patches(requests)).toHaveLength(1);
  });

  it("names the property in the refusal notice and returns the control to the stored value", async () => {
    const user = userEvent.setup();
    const { transport, replies } = daemon();
    replies[`PATCH ${TASK_PATH}`] = refusalReply(422, {
      kind: "store",
      code: "status-unknown",
      message: "status \"Done\" is not configured",
    });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    await pick(user, "Status", "Done");

    await waitFor(() => {
      expect(useNoticeStore.getState().notices).toMatchObject([
        {
          key: "task-write-failure:SAGA-3",
          form: "failure",
          title: "SAGA-3 was not changed",
          line: "Status. The daemon refused the write, so nothing changed on disk. Its own words are below.",
          words: ["store/status-unknown · status \"Done\" is not configured"],
        },
      ]);
    });
    expect(control("Status").textContent).toBe("In Progress");
  });

  const STEP_CASES: { case: string; fields: Partial<Frontmatter>; items: string[] | null }[] = [
    { case: "no workflow and no step", fields: {}, items: null },
    { case: "a workflow that reads", fields: { workflow: "dev", step: "research" }, items: ["research", "approve", "None"] },
    { case: "a workflow it cannot read and a stored step", fields: { workflow: "gone", step: "review" }, items: ["None"] },
    { case: "a workflow it cannot read and no step", fields: { workflow: "gone" }, items: null },
    { case: "a stored step and no workflow", fields: { step: "review" }, items: ["None"] },
  ];

  it.each(STEP_CASES)("offers $case what the page knows", async ({ fields, items }) => {
    const user = userEvent.setup();
    const { transport } = daemon({ [TASK_PATH]: task({ fields }) });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    if (items === null) {
      expect(within(field("Step")).queryByRole("button")).toBeNull();
      return;
    }

    await user.click(control("Step"));
    const menu = await screen.findByRole("menu", { name: "Step" });
    expect(within(menu).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(items);
  });

  it("closes a sidebar menu with Esc and leaves the open text editor alone", async () => {
    const user = userEvent.setup();
    const { transport } = daemon();
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    await user.click(within(topBar()).getByRole("button", { name: "Edit" }));
    const title = screen.getByRole("textbox", { name: "Title" });
    await user.click(control("Status"));
    await screen.findByRole("menu", { name: "Status" });

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    expect(screen.getByRole("textbox", { name: "Title" })).toBe(title);
  });
});
