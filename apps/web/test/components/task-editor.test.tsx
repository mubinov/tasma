import type { Comment, Diagnostic, Frontmatter, SerializeErrorCode, TaskEntry, TransportReply } from "@tasma/protocol";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNoticeStore } from "../../src/store/notices";
import { useUiStore } from "../../src/store/ui";
import { heldBack, refusalReply, renderWithRouter, stubTransport, successReply } from "../helpers";

const CONFIG = {
  statuses: ["Backlog", "In Progress", "Done"],
  default_status: "Backlog",
  final_statuses: ["Done"],
  priorities: ["high", "medium", "low"],
  workflows: [],
  instructions: [],
};

const PROJECT = { tag: "SAGA", name: "Saga", path: "/repos/saga", live: true, config: CONFIG };

const TASK_PATH = "/projects/SAGA/tasks/SAGA-3";

const LISTING_PATH = "/projects/SAGA/tasks";

const PAGE = "/tasks/SAGA/SAGA-3";

const UPDATED = "2026-09-01T10:15:00Z";

const BODY = "## The plan\n\nFirst line.\n";

function frontmatter(fields: Partial<Frontmatter> = {}): Frontmatter {
  return {
    id: "SAGA-3",
    title: "Build the parser",
    status: "In Progress",
    created: "2026-09-01T10:00:00Z",
    updated: UPDATED,
    next_comment_id: 1,
    ...fields,
  };
}

type TaskParts = { fields?: Partial<Frontmatter>; body?: string; comments?: Comment[] };

function task({ fields = {}, body = BODY, comments = [] }: TaskParts = {}): TransportReply {
  return successReply({ frontmatter: frontmatter(fields), body, comments });
}

function entry(id: string, title: string): TaskEntry {
  return { id, path: `/repos/saga/tasks/${id}.md`, blocked: false, frontmatter: frontmatter({ id, title }) };
}

function daemon(replies: Record<string, TransportReply | Promise<TransportReply>> = {}) {
  return stubTransport({
    "/projects": successReply([{ tag: "SAGA", name: "Saga", path: "/repos/saga" }]),
    "/projects/SAGA": successReply(PROJECT),
    [TASK_PATH]: task(),
    [LISTING_PATH]: successReply({ entries: [entry("SAGA-3", "Build the parser")], excluded: [] }),
    ...replies,
  });
}

function bar(): HTMLElement {
  return within(screen.getByRole("main")).getByRole("link", { name: "Tasks" }).parentElement!;
}

function control(name: string): HTMLElement {
  return within(bar()).getByRole("button", { name });
}

function titleInput(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>("textbox", { name: "Title" });
}

function bodyInput(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Body" });
}

/** What a screen reader gets from the parts a control's aria-describedby names, in order. */
function description(control: Element): string {
  const ids = control.getAttribute("aria-describedby")?.split(" ") ?? [];

  return ids
    .map((id) => {
      const part = document.getElementById(id)?.cloneNode(true) as Element | null;
      for (const hidden of part?.querySelectorAll("[aria-hidden]") ?? []) {
        hidden.remove();
      }

      return part?.textContent ?? "";
    })
    .join(" ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function patches(requests: readonly { method: string; path: string; body?: unknown }[]) {
  return requests.filter(({ method }) => method === "PATCH").map(({ path, body }) => ({ path, body }));
}

function spoken(): string[] {
  return useNoticeStore.getState().spoken.map(({ words }) => words);
}

/** Opens the editor from the page's own Edit control. */
async function openEditor(user: ReturnType<typeof userEvent.setup>) {
  await user.click(control("Edit"));
  await waitFor(() => {
    expect(document.activeElement).toBe(titleInput());
  });
}

beforeEach(async () => {
  // The page speaks one frame after a focus move, so a frame the test before
  // left pending would land in this one's spoken region.
  await new Promise((resolve) => {
    requestAnimationFrame(resolve);
  });
  window.localStorage.clear();
  useUiStore.setState({
    lastTasksProject: null,
    boardReturn: null,
    boardRestorePending: false,
    revealedColumns: new Set(),
    editRequest: null,
  });
  useNoticeStore.setState({ notices: [], dismissed: new Map(), spoken: [], held: [], modalDialogs: 0 });
  document.title = "tasma";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the editor of the task page", () => {
  it("opens from Edit with the text on disk, focus on the title input, and Cancel and Save in the bar", async () => {
    const user = userEvent.setup();
    await renderWithRouter(PAGE, daemon().transport);

    await openEditor(user);

    expect(titleInput().value).toBe("Build the parser");
    expect(bodyInput().value).toBe(BODY);
    expect(within(bar()).getAllByRole("button").map(({ textContent }) => textContent)).toEqual(["Cancel", "Save"]);
    expect(within(bar()).queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("keeps the h1 first in the content, clipped, with the id line after it", async () => {
    const user = userEvent.setup();
    await renderWithRouter(PAGE, daemon().transport);

    await openEditor(user);

    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]!.textContent).toBe("Build the parser");
    expect(headings[0]!.className).toContain("sr-only");
    expect(headings[0]!.nextElementSibling?.textContent).toBe("SAGA-3");
  });

  it("says the title is required to a screen reader alone", async () => {
    const user = userEvent.setup();
    await renderWithRouter(PAGE, daemon().transport);

    await openEditor(user);

    expect(titleInput().getAttribute("aria-required")).toBe("true");
    expect(titleInput().required).toBe(false);
  });

  it("names the markdown source and the two keys under the body editor", async () => {
    const user = userEvent.setup();
    await renderWithRouter(PAGE, daemon().transport);

    await openEditor(user);

    expect(description(bodyInput())).toBe("Markdown Command Enter save Escape cancel");
    expect(screen.getByText("Command Enter").className).toContain("sr-only");
    expect(screen.getByText("Escape").className).toContain("sr-only");
  });

  it("returns to reading with focus on Edit when Cancel is pressed with no change", async () => {
    const user = userEvent.setup();
    await renderWithRouter(PAGE, daemon().transport);
    await openEditor(user);

    await user.click(control("Cancel"));

    expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull();
    expect(document.activeElement).toBe(control("Edit"));
  });

  it("drops the body headings from the contents while the editor is open, and keeps the comment lines", async () => {
    const user = userEvent.setup();
    const comments: Comment[] = [{ id: 1, title: "dev:setup", created: "2026-09-02T10:00:00Z", body: "Done." }];
    await renderWithRouter(PAGE, daemon({ [TASK_PATH]: task({ comments }) }).transport);
    const contents = () =>
      within(screen.getByRole("complementary", { name: "Task details" }))
        .getAllByRole("button")
        .map(({ textContent }) => textContent);

    expect(contents()).toContain("The plan");

    await openEditor(user);

    expect(contents()).not.toContain("The plan");
    expect(contents()).toContain("dev:setup");

    await user.click(control("Cancel"));

    expect(contents()).toContain("The plan");
  });
});

describe("Save", () => {
  it("sends the title and the body alone, waits in its label, and closes on the fresh text", async () => {
    const user = userEvent.setup();
    const write = heldBack();
    const read = daemon();
    const { requests } = read;
    read.replies[`PATCH ${TASK_PATH}`] = write.reply;
    await renderWithRouter(PAGE, read.transport);
    await openEditor(user);

    await user.clear(titleInput());
    await user.type(titleInput(), "Build the lexer");
    read.replies[TASK_PATH] = task({ fields: { title: "Build the lexer" } });
    await user.click(control("Save"));

    expect(control("Saving…")).not.toBeNull();
    expect(within(bar()).queryByRole("button", { name: "Cancel" })).toBeNull();

    await act(async () => {
      write.answer(successReply({ id: "SAGA-3" }));
    });
    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull();
    });

    expect(patches(requests)).toEqual([{ path: TASK_PATH, body: { title: "Build the lexer", body: BODY } }]);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Build the lexer");
    expect(document.activeElement).toBe(control("Edit"));
  });

  it("says the wait and then that the task was saved", async () => {
    const user = userEvent.setup();
    await renderWithRouter(PAGE, daemon({ [`PATCH ${TASK_PATH}`]: successReply({ id: "SAGA-3" }) }).transport);
    await openEditor(user);

    await user.type(titleInput(), " II");
    await user.click(control("Save"));

    await waitFor(() => {
      expect(spoken()).toEqual(["Saving…", "Saved."]);
    });
  });

  it("writes nothing and closes the editor when neither field changed", async () => {
    const user = userEvent.setup();
    const { transport, requests } = daemon();
    await renderWithRouter(PAGE, transport);
    await openEditor(user);

    await user.click(control("Save"));

    expect(patches(requests)).toEqual([]);
    expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull();
    expect(document.activeElement).toBe(control("Edit"));
  });

  it("writes nothing for a blank title, and marks the input and names the fix", async () => {
    const user = userEvent.setup();
    const { transport, requests } = daemon();
    await renderWithRouter(PAGE, transport);
    await openEditor(user);

    await user.clear(titleInput());
    await user.click(control("Save"));

    expect(patches(requests)).toEqual([]);
    expect(document.activeElement).toBe(titleInput());
    expect(titleInput().getAttribute("data-invalid")).not.toBeNull();
    expect(description(titleInput())).toBe("A task needs a title.");
    // The caret arrived from the Save control, and the move reads the correction out.
    expect(spoken()).toEqual([]);

    await user.type(titleInput(), "Named again");

    expect(titleInput().getAttribute("data-invalid")).toBeNull();
    expect(description(titleInput())).toBe("");
  });

  it("says the blank-title correction where the caret is in the input already", async () => {
    const user = userEvent.setup();
    const { transport, requests } = daemon();
    await renderWithRouter(PAGE, transport);
    await openEditor(user);

    await user.clear(titleInput());
    await user.keyboard("{Enter}");

    expect(patches(requests)).toEqual([]);
    expect(document.activeElement).toBe(titleInput());
    // A description is not read again for a field that already holds the caret.
    await waitFor(() => {
      expect(spoken()).toContain("A task needs a title.");
    });
  });

  it("saves from Enter in the title input, through the form the Save control belongs to", async () => {
    const user = userEvent.setup();
    const { transport, requests } = daemon({ [`PATCH ${TASK_PATH}`]: successReply({ id: "SAGA-3" }) });
    await renderWithRouter(PAGE, transport);
    await openEditor(user);

    await user.type(titleInput(), " II{Enter}");

    await waitFor(() => {
      expect(patches(requests)).toHaveLength(1);
    });
  });

  it("saves from ⌘↩ in the body editor", async () => {
    const user = userEvent.setup();
    const { transport, requests } = daemon({ [`PATCH ${TASK_PATH}`]: successReply({ id: "SAGA-3" }) });
    await renderWithRouter(PAGE, transport);
    await openEditor(user);

    await user.click(bodyInput());
    await user.keyboard("More.{Meta>}{Enter}{/Meta}");

    await waitFor(() => {
      expect(patches(requests)).toHaveLength(1);
    });
  });
});

describe("a refused Save", () => {
  const REFUSAL = refusalReply(422, {
    kind: "store",
    code: "field-not-writable",
    message: "field \"title\" is not writable",
  });

  it("keeps the text and opens the notice with the daemon's words", async () => {
    const user = userEvent.setup();
    const { transport } = daemon({ [`PATCH ${TASK_PATH}`]: REFUSAL });
    await renderWithRouter(PAGE, transport);
    await openEditor(user);

    await user.type(titleInput(), " II");
    await user.click(control("Save"));

    await waitFor(() => {
      expect(useNoticeStore.getState().notices).toMatchObject([
        {
          key: "task-write-failure:SAGA-3",
          title: "SAGA-3 was not saved",
          line: "The daemon refused the write, so nothing changed on disk. Its own words are below.",
          words: ["store/field-not-writable · field \"title\" is not writable"],
        },
      ]);
    });
    expect(titleInput().value).toBe("Build the parser II");
    expect(control("Save").textContent).toBe("Save");
  });

  const BODY_REFUSALS: { code: SerializeErrorCode; fix: string }[] = [
    {
      code: "marker-collision",
      fix: "The body starts a line with a comment marker. Indent that line, or change its first characters.",
    },
    { code: "fence-unterminated", fix: "The body opens a code fence that never closes. Close the fence." },
  ];

  it.each(BODY_REFUSALS)("marks the body editor and names the fix for $code", async ({ code, fix }) => {
    const user = userEvent.setup();
    const { transport } = daemon({
      [`PATCH ${TASK_PATH}`]: refusalReply(422, {
        kind: "serialize",
        code,
        message: "the body cannot be written",
        line: 4,
      }),
    });
    await renderWithRouter(PAGE, transport);
    await openEditor(user);

    await user.click(bodyInput());
    await user.keyboard("More.");
    await user.click(control("Save"));

    await waitFor(() => {
      expect(bodyInput().getAttribute("data-invalid")).not.toBeNull();
    });
    // The hint stays, and the correction is added to it rather than put in its place.
    expect(description(bodyInput())).toBe(`Markdown Command Enter save Escape cancel ${fix}`);
    expect(titleInput().getAttribute("data-invalid")).toBeNull();
    expect(useNoticeStore.getState().notices[0]?.line).toBe(
      `The daemon refused the write, so nothing changed on disk. Its own words are below. ${fix}`,
    );

    await user.click(bodyInput());
    await user.keyboard("{Backspace}");

    expect(bodyInput().getAttribute("data-invalid")).toBeNull();
  });

  it("marks neither field for a refusal of another code", async () => {
    const user = userEvent.setup();
    const { transport } = daemon({ [`PATCH ${TASK_PATH}`]: REFUSAL });
    await renderWithRouter(PAGE, transport);
    await openEditor(user);

    await user.click(bodyInput());
    await user.keyboard("More.");
    await user.click(control("Save"));

    await waitFor(() => {
      expect(useNoticeStore.getState().notices).toHaveLength(1);
    });
    expect(bodyInput().getAttribute("data-invalid")).toBeNull();
    expect(titleInput().getAttribute("data-invalid")).toBeNull();
  });
});

describe("the warnings of a Save", () => {
  const WARNING: Diagnostic = { code: "unterminated-fence", message: "the fence opened on line 6 is not closed" };

  it("opens no notice for a warning the task read already shows", async () => {
    const user = userEvent.setup();
    const { transport } = daemon({
      [TASK_PATH]: successReply({ frontmatter: frontmatter(), body: BODY, comments: [] }, [WARNING]),
      [`PATCH ${TASK_PATH}`]: successReply({ id: "SAGA-3" }, [WARNING]),
    });
    await renderWithRouter(PAGE, transport);
    await openEditor(user);

    await user.type(titleInput(), " II");
    await user.click(control("Save"));

    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull();
    });
    expect(useNoticeStore.getState().notices.map(({ key }) => key)).toEqual(["task-read:SAGA-3"]);
  });
});

describe("Edit in the card menu", () => {
  const BOARD = "/tasks?projects=SAGA";

  it("opens the task page with the editor open and focus on the title input", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("scrollTo", () => {});
    await renderWithRouter(BOARD, daemon().transport);

    await user.click(screen.getByRole("button", { name: "Task menu" }));
    await act(async () => {
      await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    });

    await waitFor(() => {
      expect(document.activeElement).toBe(titleInput());
    });
  });

  it("opens the editor again on a second Edit, with the task already in the query cache", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("scrollTo", () => {});
    const router = await renderWithRouter(BOARD, daemon().transport);
    const editFromMenu = async () => {
      await user.click(screen.getByRole("button", { name: "Task menu" }));
      await act(async () => {
        await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
      });
      await waitFor(() => {
        expect(document.activeElement).toBe(titleInput());
      });
    };

    await editFromMenu();
    await user.click(control("Cancel"));
    await act(async () => {
      await router.navigate({ to: "/tasks", search: { projects: "SAGA" } });
    });

    await editFromMenu();
  });

  it("is dropped where the page it names never takes it, so that task opens in reading", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("scrollTo", () => {});
    const read = daemon();
    const router = await renderWithRouter(BOARD, read.transport);

    read.replies[TASK_PATH] = refusalReply(404, {
      kind: "store",
      code: "task-not-found",
      message: "SAGA-3 is not a task",
    });
    await user.click(screen.getByRole("button", { name: "Task menu" }));
    await act(async () => {
      await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    });

    // The route read failed, so the page that would take the request never rendered.
    expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull();

    read.replies[TASK_PATH] = task();
    await act(async () => {
      await router.navigate({ to: "/tasks", search: { projects: "SAGA" } });
    });

    expect(useUiStore.getState().editRequest).toBeNull();

    await act(async () => {
      await router.navigate({ to: "/tasks/$project/$task", params: { project: "SAGA", task: "SAGA-3" } });
    });

    expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull();
  });

  it("is read once, so the page opened again stays in reading", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("scrollTo", () => {});
    const { transport } = daemon();
    const router = await renderWithRouter(BOARD, transport);

    await user.click(screen.getByRole("button", { name: "Task menu" }));
    await act(async () => {
      await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(titleInput());
    });
    await user.click(control("Cancel"));
    await act(async () => {
      await router.navigate({ to: "/tasks", search: { projects: "SAGA" } });
    });
    await act(async () => {
      await router.navigate({ to: "/tasks/$project/$task", params: { project: "SAGA", task: "SAGA-3" } });
    });

    expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull();
  });
});

describe("Changed on disk", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** One poll interval, then the zero-delay timer the query cache notifies its observers through. */
  async function poll() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
  }

  function line(): HTMLElement | null {
    return screen.queryByRole("button", { name: /Discard and reload/ })?.parentElement ?? null;
  }

  async function openWithPolling(replies: Record<string, TransportReply | Promise<TransportReply>> = {}) {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    const read = daemon(replies);
    await renderWithRouter(PAGE, read.transport);
    await user.click(control("Edit"));
    await waitFor(() => {
      expect(document.activeElement).toBe(titleInput());
    });

    return { user, read };
  }

  it("shows the line, with the time of the read that first differed, and says so", async () => {
    const { read } = await openWithPolling();

    read.replies[TASK_PATH] = task({ fields: { title: "Renamed", updated: "2026-09-01T11:20:00Z" } });
    await poll();

    const at = new Date("2026-09-01T11:20:00Z").toTimeString().slice(0, 5);
    expect(line()?.textContent).toContain(`Changed on disk at ${at}, since you began.`);
    expect(line()?.textContent).toContain("Saving overwrites that change.");
    await waitFor(() => {
      expect(spoken()).toEqual([`Changed on disk at ${at}. Saving overwrites that change.`]);
    });

    read.replies[TASK_PATH] = task({ fields: { title: "Renamed twice", updated: "2026-09-01T12:30:00Z" } });
    await poll();

    expect(line()?.textContent).toContain(`Changed on disk at ${at}, since you began.`);
  });

  it("shows nothing for a read that moves only the time", async () => {
    const { read } = await openWithPolling();

    read.replies[TASK_PATH] = task({ fields: { updated: "2026-09-01T11:20:00Z" } });
    await poll();

    expect(line()).toBeNull();
    expect(spoken()).toEqual([]);
  });

  it("shows nothing where the disk already holds the text in the editor", async () => {
    const { user, read } = await openWithPolling();

    await user.clear(titleInput());
    await user.type(titleInput(), "Renamed");
    read.replies[TASK_PATH] = task({ fields: { title: "Renamed", updated: "2026-09-01T11:20:00Z" } });
    await poll();

    expect(line()).toBeNull();
  });

  it("saves the text the editor opened with, which the line says the Save overwrites", async () => {
    const { user, read } = await openWithPolling({ [`PATCH ${TASK_PATH}`]: successReply({ id: "SAGA-3" }) });

    read.replies[TASK_PATH] = task({ fields: { title: "Renamed", updated: "2026-09-01T11:20:00Z" } });
    await poll();

    expect(line()).not.toBeNull();

    await user.click(control("Save"));

    await waitFor(() => {
      expect(patches(read.requests)).toEqual([{ path: TASK_PATH, body: { title: "Build the parser", body: BODY } }]);
    });
  });

  it("moves the caret to Save when the line's control started the write", async () => {
    const write = heldBack();
    const { user, read } = await openWithPolling({ [`PATCH ${TASK_PATH}`]: write.reply });

    read.replies[TASK_PATH] = task({ fields: { title: "Renamed", updated: "2026-09-01T11:20:00Z" } });
    await poll();

    screen.getByRole("button", { name: /Discard and reload/ }).focus();
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    expect(line()).toBeNull();
    expect(document.activeElement).toBe(control("Saving…"));

    await act(async () => {
      write.answer(successReply({ id: "SAGA-3" }));
    });
  });

  it("moves the caret to the title input when a read takes the line away under it", async () => {
    const { read } = await openWithPolling();

    read.replies[TASK_PATH] = task({ fields: { title: "Renamed", updated: "2026-09-01T11:20:00Z" } });
    await poll();

    screen.getByRole("button", { name: /Discard and reload/ }).focus();
    read.replies[TASK_PATH] = task();
    await poll();

    expect(line()).toBeNull();
    expect(document.activeElement).toBe(titleInput());
  });

  it("says nothing after Discard for a change the dialog held back", async () => {
    const { user, read } = await openWithPolling();
    await user.type(titleInput(), " II");
    await user.click(control("Cancel"));

    read.replies[TASK_PATH] = task({ fields: { title: "Renamed", updated: "2026-09-01T11:20:00Z" } });
    await poll();

    await waitFor(() => {
      expect(useNoticeStore.getState().held).toHaveLength(1);
    });

    const dialog = screen.getByRole("alertdialog", { name: "Discard your changes?" });
    await user.click(within(dialog).getByRole("button", { name: "Discard" }));

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(line()).toBeNull();
    expect(spoken()).toEqual([]);
  });

  it("replaces the text from Discard and reload, and moves focus to the title input", async () => {
    const { user, read } = await openWithPolling();
    await user.type(titleInput(), " II");
    read.replies[TASK_PATH] = task({ fields: { title: "Renamed", updated: "2026-09-01T11:20:00Z" }, body: "Other.\n" });
    await poll();

    await user.click(screen.getByRole("button", { name: /Discard and reload/ }));

    expect(titleInput().value).toBe("Renamed");
    expect(bodyInput().value).toBe("Other.\n");
    expect(line()).toBeNull();
    expect(document.activeElement).toBe(titleInput());
  });
});

describe("the discard dialog", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function dialog(): HTMLElement {
    return screen.getByRole("alertdialog", { name: "Discard your changes?" });
  }

  async function typeThenCancel(user: ReturnType<typeof userEvent.setup>) {
    await user.click(bodyInput());
    await user.keyboard("More.");
    await user.click(control("Cancel"));
  }

  it("asks before Cancel drops unsaved text, and starts focus on Keep editing", async () => {
    const user = userEvent.setup();
    await renderWithRouter(PAGE, daemon().transport);
    await openEditor(user);

    await typeThenCancel(user);

    expect(within(dialog()).getByText("The title and the body you edited are not saved. There is no undo."))
      .not.toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(within(dialog()).getByRole("button", { name: "Keep editing" }));
    });
  });

  it("leaves the editor open and the caret where it was when Keep editing is pressed", async () => {
    const user = userEvent.setup();
    await renderWithRouter(PAGE, daemon().transport);
    await openEditor(user);
    const cancelControl = control("Cancel");

    await typeThenCancel(user);
    await user.click(within(dialog()).getByRole("button", { name: "Keep editing" }));

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(bodyInput().value).toBe(`${BODY}More.`);
    expect(document.activeElement).toBe(cancelControl);
  });

  it("returns to reading with focus on Edit when Discard is pressed", async () => {
    const user = userEvent.setup();
    await renderWithRouter(PAGE, daemon().transport);
    await openEditor(user);

    await typeThenCancel(user);
    await user.click(within(dialog()).getByRole("button", { name: "Discard" }));

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(screen.queryByRole("textbox", { name: "Body" })).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(control("Edit"));
    });
  });

  it("opens from Esc as it does from Cancel", async () => {
    const user = userEvent.setup();
    await renderWithRouter(PAGE, daemon().transport);
    await openEditor(user);

    await user.click(bodyInput());
    await user.keyboard("More.{Escape}");

    expect(dialog()).not.toBeNull();
  });

  it("stops that Escape above the React root, so the dialog it opens never meets the same keypress", async () => {
    const user = userEvent.setup();
    await renderWithRouter(PAGE, daemon().transport);
    await openEditor(user);
    // Where the dialog's own dismissal listener sits: a keypress that reaches
    // here after the dialog has mounted closes it again.
    const reached: string[] = [];
    const listen = (event: KeyboardEvent) => {
      reached.push(event.key);
    };
    document.addEventListener("keydown", listen);

    try {
      await user.click(bodyInput());
      await user.keyboard("More.{Escape}");
    } finally {
      document.removeEventListener("keydown", listen);
    }

    expect(reached).toContain("o");
    expect(reached).not.toContain("Escape");
    expect(dialog()).not.toBeNull();
  });

  it("holds a route change, and lets it run after Discard, leaving focus on the main region", async () => {
    const user = userEvent.setup();
    const router = await renderWithRouter(PAGE, daemon().transport);
    await openEditor(user);

    await user.click(bodyInput());
    await user.keyboard("More.");
    await act(async () => {
      await user.click(within(screen.getByRole("main")).getByRole("link", { name: "Tasks" }));
    });

    expect(dialog()).not.toBeNull();
    expect(router.state.location.pathname).toBe(PAGE);

    await act(async () => {
      await user.click(within(dialog()).getByRole("button", { name: "Discard" }));
    });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/tasks");
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("main"));
    });
  });

  it("keeps the page when Keep editing answers a route change", async () => {
    const user = userEvent.setup();
    const router = await renderWithRouter(PAGE, daemon().transport);
    await openEditor(user);

    await user.click(bodyInput());
    await user.keyboard("More.");
    await act(async () => {
      await user.click(within(screen.getByRole("main")).getByRole("link", { name: "Tasks" }));
    });
    await user.click(within(dialog()).getByRole("button", { name: "Keep editing" }));

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(router.state.location.pathname).toBe(PAGE);
    expect(bodyInput().value).toBe(`${BODY}More.`);
  });

  it("lets the route change run when the Save it waited for succeeds", async () => {
    const user = userEvent.setup();
    const write = heldBack();
    const read = daemon();
    read.replies[`PATCH ${TASK_PATH}`] = write.reply;
    const router = await renderWithRouter(PAGE, read.transport);
    await openEditor(user);

    await user.click(bodyInput());
    await user.keyboard("More.");
    await user.click(control("Save"));
    await act(async () => {
      await user.click(within(screen.getByRole("main")).getByRole("link", { name: "Tasks" }));
    });

    expect(dialog()).not.toBeNull();

    await act(async () => {
      write.answer(successReply({ id: "SAGA-3" }));
    });

    // Nothing is left to discard, so the question the dialog asks has no answer.
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/tasks");
    });
  });

  it("answers Discard with nothing while a Save runs, and names the wait inside the dialog", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    const write = heldBack();
    const read = daemon();
    read.replies[`PATCH ${TASK_PATH}`] = write.reply;
    const router = await renderWithRouter(PAGE, read.transport);
    await openEditor(user);

    await user.click(bodyInput());
    await user.keyboard("More.");
    await user.click(control("Save"));
    await act(async () => {
      await user.click(within(screen.getByRole("main")).getByRole("link", { name: "Tasks" }));
    });
    // The dialog holds its status region back from its first write.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });

    expect(within(dialog()).getByRole("status").textContent).toBe("Saving…");

    await user.click(within(dialog()).getByRole("button", { name: "Discard" }));

    expect(screen.queryByRole("alertdialog")).not.toBeNull();
    expect(router.state.location.pathname).toBe(PAGE);

    await act(async () => {
      write.answer(successReply({ id: "SAGA-3" }));
    });

    // The text the dialog offered to drop is on disk, so the route change runs.
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/tasks");
    });
  });

  it("closes on a refused Save, drops the route change, and opens the notice after it has gone", async () => {
    const user = userEvent.setup();
    const write = heldBack();
    const read = daemon();
    read.replies[`PATCH ${TASK_PATH}`] = write.reply;
    const router = await renderWithRouter(PAGE, read.transport);
    await openEditor(user);

    await user.click(bodyInput());
    await user.keyboard("More.");
    await user.click(control("Save"));
    await act(async () => {
      await user.click(within(screen.getByRole("main")).getByRole("link", { name: "Tasks" }));
    });

    expect(dialog()).not.toBeNull();
    expect(useNoticeStore.getState().notices).toEqual([]);

    await act(async () => {
      write.answer(refusalReply(422, { kind: "store", code: "task-not-found", message: "SAGA-3 is gone" }));
    });

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(router.state.location.pathname).toBe(PAGE);
    expect(bodyInput().value).toBe(`${BODY}More.`);
    await waitFor(() => {
      expect(useNoticeStore.getState().notices.map(({ title }) => title)).toEqual(["SAGA-3 was not saved"]);
    });
  });
});

describe("while a Save runs", () => {
  async function startHeldSave() {
    const user = userEvent.setup();
    const write = heldBack();
    const read = daemon();
    read.replies[`PATCH ${TASK_PATH}`] = write.reply;
    await renderWithRouter(PAGE, read.transport);
    await openEditor(user);
    await user.click(bodyInput());
    await user.keyboard("More.");
    await user.click(control("Save"));

    return { user, write, requests: read.requests };
  }

  it("answers Esc with nothing, so the text cannot be dropped on its way to disk", async () => {
    const { user, write } = await startHeldSave();

    await user.click(bodyInput());
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(control("Saving…")).not.toBeNull();

    await act(async () => {
      write.answer(successReply({ id: "SAGA-3" }));
    });
  });

  it("does not start a second write", async () => {
    const { user, write, requests } = await startHeldSave();

    await user.click(bodyInput());
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    expect(patches(requests)).toHaveLength(1);

    await act(async () => {
      write.answer(successReply({ id: "SAGA-3" }));
    });
  });
});

describe("a Save started from the Cancel control", () => {
  it("moves the caret to Save, which is the control that stays", async () => {
    const user = userEvent.setup();
    const write = heldBack();
    const read = daemon();
    read.replies[`PATCH ${TASK_PATH}`] = write.reply;
    await renderWithRouter(PAGE, read.transport);
    await openEditor(user);
    await user.click(bodyInput());
    await user.keyboard("More.");

    control("Cancel").focus();
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    expect(document.activeElement).toBe(control("Saving…"));

    await act(async () => {
      write.answer(successReply({ id: "SAGA-3" }));
    });
  });
});
