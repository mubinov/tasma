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

describe("editing labels and relations in the sidebar", () => {
  function labeled(id: string, labels: string[]): TaskEntry {
    return { id, path: `/repos/saga/tasks/${id}.md`, blocked: false, frontmatter: frontmatter({ id, labels }) };
  }

  function picker(label: string): HTMLElement {
    return within(field(label)).getByRole("combobox");
  }

  function patches(requests: readonly { method: string; path: string; body?: unknown }[]) {
    return requests.filter(({ method }) => method === "PATCH").map(({ body }) => body);
  }

  async function open(user: ReturnType<typeof userEvent.setup>, label: string): Promise<HTMLElement> {
    await user.click(picker(label));
    return screen.findByRole("listbox", { name: label });
  }

  it("writes each label a check leaves, computed from the writes still in flight, and null for the last", async () => {
    const user = userEvent.setup();
    const write = heldBack();
    const { transport, requests, replies } = daemon({
      [TASK_PATH]: task({ fields: { labels: ["web"] } }),
      [LISTING_PATH]: listing([labeled("SAGA-1", ["web", "infra"])]),
    });
    replies[`PATCH ${TASK_PATH}`] = write.reply;
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const listbox = await open(user, "Labels");
    await user.click(within(listbox).getByRole("option", { name: /infra/ }));
    await user.click(within(listbox).getByRole("option", { name: /web/ }));
    await user.click(within(listbox).getByRole("option", { name: /infra/ }));
    write.answer(successReply({ id: "SAGA-3" }));

    await waitFor(() => {
      expect(patches(requests)).toEqual([{ labels: ["web", "infra"] }, { labels: ["infra"] }, { labels: null }]);
    });
  });

  it("shows the labels being written in the control, with the wait after them", async () => {
    const user = userEvent.setup();
    const write = heldBack();
    const { transport, replies } = daemon({ [LISTING_PATH]: listing([labeled("SAGA-1", ["web"])]) });
    replies[`PATCH ${TASK_PATH}`] = write.reply;
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const listbox = await open(user, "Labels");
    await user.click(within(listbox).getByRole("option", { name: /web/ }));

    expect(picker("Labels").textContent).toBe("web…");
  });

  it("names Labels in the refusal notice and returns the control to the stored labels", async () => {
    const user = userEvent.setup();
    const { transport, replies } = daemon({ [LISTING_PATH]: listing([labeled("SAGA-1", ["web"])]) });
    replies[`PATCH ${TASK_PATH}`] = refusalReply(422, {
      kind: "store",
      code: "label-invalid",
      message: "the label \"web\" is refused",
    });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const listbox = await open(user, "Labels");
    await user.click(within(listbox).getByRole("option", { name: /web/ }));

    await waitFor(() => {
      expect(useNoticeStore.getState().notices).toMatchObject([
        {
          key: "task-write-failure:SAGA-3",
          form: "failure",
          title: "SAGA-3 was not changed",
          line: "Labels. The daemon refused the write, so nothing changed on disk. Its own words are below.",
        },
      ]);
    });
    await waitFor(() => {
      expect(picker("Labels").textContent).toBe("None");
    });
  });

  it("warns that an upper-case label was stored lower-cased", async () => {
    const user = userEvent.setup();
    const { transport, requests, replies } = daemon();
    const converted = {
      code: "label-case-converted" as const,
      message: "the label \"Backend\" was stored as \"backend\"",
      path: "/repos/saga/tasks/SAGA-3.md",
    };
    replies[`PATCH ${TASK_PATH}`] = successReply({ id: "SAGA-3", labels: ["backend"] }, [converted]);
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    await open(user, "Labels");
    await user.type(screen.getByPlaceholderText("Filter or add a label"), "Backend");
    await user.click(screen.getByRole("option", { name: 'Add "Backend"' }));

    expect(patches(requests)).toEqual([{ labels: ["Backend"] }]);
    await waitFor(() => {
      expect(useNoticeStore.getState().notices).toMatchObject([
        {
          key: "task-write-warnings:SAGA-3",
          form: "warning",
          title: "1 warning about SAGA-3",
          words: [`label-case-converted · ${converted.message}`],
        },
      ]);
    });
  });

  it("writes the blockers a pick leaves and shows them in the row before the daemon answers", async () => {
    const user = userEvent.setup();
    const write = heldBack();
    const { transport, requests, replies } = daemon({
      [TASK_PATH]: task({ fields: { blocked_by: ["SAGA-1"] } }),
      [LISTING_PATH]: listing([entry("SAGA-1", "Backlog", "Draft"), entry("SAGA-2", "Backlog", "Plan")]),
    });
    replies[`PATCH ${TASK_PATH}`] = write.reply;
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const listbox = await open(user, "Blocked by");
    await user.click(within(listbox).getByRole("option", { name: /SAGA-2/ }));

    expect(within(field("Blocked by")).getAllByRole("link").map((link) => link.textContent))
      .toEqual(["[Backlog] SAGA-1 Draft", "[Backlog] SAGA-2 Plan"]);
    expect(patches(requests)).toEqual([{ blocked_by: ["SAGA-1", "SAGA-2"] }]);
  });

  it("drops a blocker that names no task from the list it writes", async () => {
    const user = userEvent.setup();
    const { transport, requests, replies } = daemon({
      [TASK_PATH]: task({ fields: { blocked_by: ["SAGA-9", "SAGA-1"] } }),
      [LISTING_PATH]: listing([entry("SAGA-1", "Backlog", "Draft"), entry("SAGA-2", "Backlog", "Plan")]),
    });
    replies[`PATCH ${TASK_PATH}`] = successReply({ id: "SAGA-3" });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const listbox = await open(user, "Blocked by");
    await user.click(within(listbox).getByRole("option", { name: /SAGA-1/ }));

    await waitFor(() => {
      expect(patches(requests)).toEqual([{ blocked_by: null }]);
    });
  });

  it("writes the parent a pick names and null for None, and shows it in the row before the daemon answers", async () => {
    const user = userEvent.setup();
    const write = heldBack();
    const { transport, requests, replies } = daemon({
      [LISTING_PATH]: listing([entry("SAGA-1", "Backlog", "Draft")]),
    });
    replies[`PATCH ${TASK_PATH}`] = write.reply;
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    await user.click(within(await open(user, "Parent")).getByRole("option", { name: /SAGA-1/ }));
    await waitFor(() => {
      expect(screen.queryByRole("listbox")).toBeNull();
    });
    expect(within(field("Parent")).getByRole("link").textContent).toBe("[Backlog] SAGA-1 Draft");
    await user.click(within(await open(user, "Parent")).getByRole("option", { name: "None" }));
    write.answer(successReply({ id: "SAGA-3" }));

    await waitFor(() => {
      expect(patches(requests)).toEqual([{ parent: "SAGA-1" }, { parent: null }]);
    });
  });

  it("names Parent in the refusal notice", async () => {
    const user = userEvent.setup();
    const { transport, replies } = daemon({ [LISTING_PATH]: listing([entry("SAGA-1", "Backlog", "Draft")]) });
    replies[`PATCH ${TASK_PATH}`] = refusalReply(422, { kind: "store", code: "field-not-writable", message: "refused" });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    await user.click(within(await open(user, "Parent")).getByRole("option", { name: /SAGA-1/ }));

    await waitFor(() => {
      expect(useNoticeStore.getState().notices).toMatchObject([
        { title: "SAGA-3 was not changed", line: expect.stringMatching(/^Parent\. /) as unknown },
      ]);
    });
  });

  it("reaches the pencil before the links of the list it edits", async () => {
    const user = userEvent.setup();
    const { transport } = daemon({
      [TASK_PATH]: task({ fields: { blocked_by: ["SAGA-1", "SAGA-2"] } }),
      [LISTING_PATH]: listing([entry("SAGA-1", "Backlog", "Draft"), entry("SAGA-2", "Backlog", "Plan")]),
    });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    picker("Blocked by").focus();
    await user.tab();

    expect(document.activeElement).toBe(within(field("Blocked by")).getAllByRole("link")[0]);
  });

  it("closes a picker with Esc and leaves the open text editor alone", async () => {
    const user = userEvent.setup();
    const { transport } = daemon();
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    await user.click(within(topBar()).getByRole("button", { name: "Edit" }));
    const title = screen.getByRole("textbox", { name: "Title" });
    await open(user, "Labels");

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("listbox")).toBeNull();
    });
    expect(screen.getByRole("textbox", { name: "Title" })).toBe(title);
  });
});
