import type { Comment, Frontmatter, SerializeErrorCode, TaskEntry, TransportReply } from "@tasma/protocol";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNoticeStore } from "../../src/store/notices";
import { useUiStore } from "../../src/store/ui";
import { heldBack, refusalReply, renderWithRouter, stubTransport, successReply } from "../helpers";
import { frame } from "../setup/notice-store";

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

const COMMENTS_PATH = `${TASK_PATH}/comments`;

const LISTING_PATH = "/projects/SAGA/tasks";

const PAGE = "/tasks/SAGA/SAGA-3";

const UPDATED = "2026-09-01T10:15:00Z";

const STAMP = "2026-09-02T14:22:00Z";

function commentPath(commentId: number): string {
  return `${COMMENTS_PATH}/${String(commentId)}`;
}

function frontmatter(fields: Partial<Frontmatter> = {}): Frontmatter {
  return {
    id: "SAGA-3",
    title: "Build the parser",
    status: "In Progress",
    created: "2026-09-01T10:00:00Z",
    updated: UPDATED,
    next_comment_id: 9,
    ...fields,
  };
}

function comment(id: number, fields: Partial<Comment> = {}): Comment {
  return {
    id,
    title: `Note ${String(id)}`,
    created: "2026-09-02T10:00:00Z",
    body: `Body of note ${String(id)}.`,
    ...fields,
  };
}

function entry(id: string, title: string): TaskEntry {
  return { id, path: `/repos/saga/tasks/${id}.md`, blocked: false, frontmatter: frontmatter({ id, title }) };
}

function task(comments: Comment[]): TransportReply {
  return successReply({ frontmatter: frontmatter(), body: "The plan.\n", comments });
}

function daemon(comments: Comment[], replies: Record<string, TransportReply | Promise<TransportReply>> = {}) {
  return stubTransport({
    "/projects": successReply([{ tag: "SAGA", name: "Saga", path: "/repos/saga" }]),
    "/projects/SAGA": successReply(PROJECT),
    [TASK_PATH]: task(comments),
    [LISTING_PATH]: successReply({ entries: [entry("SAGA-3", "Build the parser")], excluded: [] }),
    ...replies,
  });
}

function serialize(code: SerializeErrorCode, field?: string): TransportReply {
  return refusalReply(422, { kind: "serialize", code, message: `refused: ${code}`, line: 12, field });
}

function titleField(commentId: number): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>("textbox", { name: `Comment #${String(commentId)} title` });
}

function bodyField(commentId: number): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>("textbox", { name: `Comment #${String(commentId)} body` });
}

function newTitle(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>("textbox", { name: "Title of the new comment" });
}

function newBody(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>("textbox", { name: "New comment body" });
}

function control(name: string): HTMLElement {
  return screen.getByRole("button", { name });
}

function dialog(): HTMLElement {
  return screen.getByRole("alertdialog");
}

function announced(): string[] {
  return useNoticeStore.getState().announced.map(({ words }) => words);
}

function notices() {
  return useNoticeStore.getState().notices;
}

function writes(requests: readonly { method: string; path: string; body?: unknown }[]) {
  return requests.filter(({ method }) => method !== "GET").map(({ method, path, body }) => ({ method, path, body }));
}

/** What a screen reader gets from the parts a control's aria-describedby names, in order. */
function description(element: Element): string {
  const ids = element.getAttribute("aria-describedby")?.split(" ") ?? [];

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

async function openEditor(user: ReturnType<typeof userEvent.setup>, commentId: number, name?: string) {
  const card = screen.getByRole("article", { name: name ?? `Note ${String(commentId)}` });
  await user.click(within(card).getByRole("button", { name: `Comment #${String(commentId)} actions` }));
  await waitFor(() => {
    expect(screen.getByRole("menu")).toBeTruthy();
  });
  await user.click(screen.getByRole("menuitem", { name: "Edit" }));
  await waitFor(() => {
    expect(document.activeElement).toBe(titleField(commentId));
  });
}

async function openAddForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(control("Add comment"));
  await waitFor(() => {
    expect(document.activeElement).toBe(newTitle());
  });
}

/** Replaces ResizeObserver with one that reports a target only when a test asks. */
function stubResizeObservers() {
  const callbacks = new Map<Element, () => void>();

  vi.stubGlobal(
    "ResizeObserver",
    class {
      readonly callback: () => void;

      constructor(callback: () => void) {
        this.callback = callback;
      }

      observe(target: Element) {
        callbacks.set(target, this.callback);
      }

      unobserve() {}

      disconnect() {}
    },
  );

  return {
    report(target: Element) {
      act(() => {
        callbacks.get(target)?.();
      });
    },
  };
}

/** A poll of the task read, which the page runs every five seconds. */
async function poll(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
}

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({
    lastTasksProject: null,
    boardReturn: null,
    boardRestorePending: false,
    revealedColumns: new Set(),
    editRequest: null,
    modalDialogs: 0,
  });
  document.title = "tasma";
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the comment editor", () => {
  it("opens with the text on disk, and every control named by its comment", async () => {
    const user = userEvent.setup();
    await renderWithRouter(PAGE, daemon([comment(3)]).transport);

    await openEditor(user, 3);

    expect(titleField(3).value).toBe("Note 3");
    expect(bodyField(3).value).toBe("Body of note 3.");
    expect(control("Cancel editing comment #3")).toBeTruthy();
    expect(control("Save comment #3")).toBeTruthy();
  });

  it("keeps the card's name while its title is an input, and its place in the outline", async () => {
    const user = userEvent.setup();
    await renderWithRouter(PAGE, daemon([comment(3)]).transport);

    await openEditor(user, 3);

    const card = screen.getByRole("article", { name: "Note 3" });
    expect(within(card).getByRole("heading", { level: 3 }).className).toContain("sr-only");
    expect(card.getAttribute("data-comment-id")).toBe("3");
    expect(card.querySelector("[data-outline-sentinel]")).not.toBeNull();
  });

  it("says the title is required and the body is not", async () => {
    const user = userEvent.setup();
    await renderWithRouter(PAGE, daemon([comment(3)]).transport);

    await openEditor(user, 3);

    expect(titleField(3).getAttribute("aria-required")).toBe("true");
    expect(titleField(3).hasAttribute("required")).toBe(false);
    expect(bodyField(3).getAttribute("aria-required")).toBeNull();
  });

  it("describes the title input with the key hint as well as the body", async () => {
    const user = userEvent.setup();
    await renderWithRouter(PAGE, daemon([comment(3)]).transport);

    await openEditor(user, 3);

    expect(description(titleField(3))).toContain("Command Enter save");
    expect(description(bodyField(3))).toContain("Command Enter save");

    await user.clear(titleField(3));
    await act(async () => {
      await user.click(control("Save comment #3"));
    });

    // Base UI unions the caller's id with the field's own message ids.
    expect(description(titleField(3))).toContain("A comment needs a title.");
    expect(description(titleField(3))).toContain("Command Enter save");
  });

  it("sends the title and the body, closes the card and speaks, naming the comment", async () => {
    const user = userEvent.setup();
    const { transport, replies, requests } = daemon([comment(3)], {
      [`PATCH ${commentPath(3)}`]: successReply({ id: "SAGA-3", commentId: 3 }),
    });
    await renderWithRouter(PAGE, transport);
    await openEditor(user, 3);

    await user.clear(titleField(3));
    await user.type(titleField(3), "Reviewed");
    replies[TASK_PATH] = task([comment(3, { title: "Reviewed" })]);
    await act(async () => {
      await user.click(control("Save comment #3"));
    });
    await frame();

    expect(writes(requests)).toEqual([
      { method: "PATCH", path: commentPath(3), body: { title: "Reviewed", body: "Body of note 3." } },
    ]);
    expect(screen.getByRole("article", { name: "Reviewed" })).toBeTruthy();
    expect(announced()).toContain("Saving comment #3…");
    expect(announced()).toContain("Comment #3 saved.");
  });

  it("lands the caret on the card's menu button once the save closes it", async () => {
    const user = userEvent.setup();
    const { transport } = daemon([comment(3)], {
      [`PATCH ${commentPath(3)}`]: successReply({ id: "SAGA-3", commentId: 3 }),
    });
    await renderWithRouter(PAGE, transport);
    await openEditor(user, 3);

    await user.type(titleField(3), "!");
    await act(async () => {
      await user.click(control("Save comment #3"));
    });

    expect(document.activeElement).toBe(control("Comment #3 actions"));
  });

  it("writes nothing for a blank title, names the fix and moves the caret there", async () => {
    const user = userEvent.setup();
    const { transport, requests } = daemon([comment(3)]);
    await renderWithRouter(PAGE, transport);
    await openEditor(user, 3);

    await user.clear(titleField(3));
    await act(async () => {
      await user.click(control("Save comment #3"));
    });

    expect(writes(requests)).toEqual([]);
    expect(screen.getByText("A comment needs a title.")).toBeTruthy();
    expect(document.activeElement).toBe(titleField(3));
    expect(titleField(3).getAttribute("data-invalid")).not.toBeNull();
  });

  it("writes nothing for an unchanged Save, including a body whose last line end the daemon restores", async () => {
    const user = userEvent.setup();
    const { transport, requests } = daemon([comment(3, { body: "Body.\n" }), comment(5)]);
    await renderWithRouter(PAGE, transport);
    await openEditor(user, 3);

    // Another comment follows, so the serializer writes the line end back.
    await user.click(bodyField(3));
    await user.keyboard("{Backspace}");
    await act(async () => {
      await user.click(control("Save comment #3"));
    });

    expect(writes(requests)).toEqual([]);
    expect(screen.queryByRole("textbox", { name: "Comment #3 title" })).toBeNull();
  });

  it("saves from ⌘↩ in either field, and Esc asks about the text it would drop", async () => {
    const user = userEvent.setup();
    const { transport, requests } = daemon([comment(3)], {
      [`PATCH ${commentPath(3)}`]: successReply({ id: "SAGA-3", commentId: 3 }),
    });
    await renderWithRouter(PAGE, transport);
    await openEditor(user, 3);

    await user.type(bodyField(3), "x");
    await act(async () => {
      await user.keyboard("{Escape}");
    });
    expect(within(dialog()).getByText("Comment #3 is not saved. There is no undo.")).toBeTruthy();

    await act(async () => {
      await user.click(within(dialog()).getByRole("button", { name: "Keep editing" }));
    });
    await act(async () => {
      await user.type(titleField(3), "{Meta>}{Enter}{/Meta}");
    });

    expect(writes(requests)).toEqual([
      { method: "PATCH", path: commentPath(3), body: { title: "Note 3", body: "Body of note 3.x" } },
    ]);
  });

  it("answers neither Esc nor a second ⌘↩ while its write runs", async () => {
    const user = userEvent.setup();
    const write = heldBack();
    const { transport, requests } = daemon([comment(3)], { [`PATCH ${commentPath(3)}`]: write.reply });
    await renderWithRouter(PAGE, transport);
    await openEditor(user, 3);

    await user.type(bodyField(3), "x");
    await user.type(bodyField(3), "{Meta>}{Enter}{/Meta}");
    await user.type(bodyField(3), "{Meta>}{Enter}{/Meta}");
    await act(async () => {
      await user.keyboard("{Escape}");
    });

    expect(writes(requests)).toHaveLength(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(titleField(3)).toBeTruthy();

    await act(async () => {
      write.answer(successReply({ id: "SAGA-3", commentId: 3 }));
    });
  });

  it("speaks the blank-title correction where the caret is already in the field", async () => {
    const user = userEvent.setup();
    await renderWithRouter(PAGE, daemon([comment(3)]).transport);
    await openEditor(user, 3);

    await user.clear(titleField(3));
    await act(async () => {
      await user.type(titleField(3), "{Meta>}{Enter}{/Meta}");
    });
    await frame();

    expect(announced()).toContain("A comment needs a title.");
  });

  it("moves a caret on Cancel to Save, which stays while the write runs", async () => {
    const user = userEvent.setup();
    const write = heldBack();
    const { transport } = daemon([comment(3)], { [`PATCH ${commentPath(3)}`]: write.reply });
    await renderWithRouter(PAGE, transport);
    await openEditor(user, 3);

    await user.type(bodyField(3), "x");
    control("Cancel editing comment #3").focus();
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    expect(screen.queryByRole("button", { name: "Cancel editing comment #3" })).toBeNull();
    expect(document.activeElement).toBe(control("Saving comment #3…"));
    expect(control("Saving comment #3…").textContent).toBe("Saving…");

    await act(async () => {
      write.answer(successReply({ id: "SAGA-3", commentId: 3 }));
    });
  });

  it("closes on Esc where the editor holds nothing unsaved", async () => {
    const user = userEvent.setup();
    await renderWithRouter(PAGE, daemon([comment(3)]).transport);
    await openEditor(user, 3);

    await act(async () => {
      await user.keyboard("{Escape}");
    });

    expect(screen.queryByRole("textbox", { name: "Comment #3 title" })).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("writes the header's height on the card, for a comment with no body as well", async () => {
    const user = userEvent.setup();
    const resize = stubResizeObservers();
    await renderWithRouter(PAGE, daemon([comment(3, { body: "" })]).transport);
    await openEditor(user, 3);

    const card = screen.getByRole("article", { name: "Note 3" });
    const header = card.querySelector<HTMLElement>(".sticky")!;
    Object.defineProperty(header, "offsetHeight", { configurable: true, value: 71 });
    resize.report(header);

    expect(card.style.getPropertyValue("--comment-header-height")).toBe("71px");
  });

  it("sends the same body of the last comment, whose line end nothing restores", async () => {
    const user = userEvent.setup();
    const { transport, requests } = daemon([comment(3, { body: "Body." })], {
      [`PATCH ${commentPath(3)}`]: successReply({ id: "SAGA-3", commentId: 3 }),
    });
    await renderWithRouter(PAGE, transport);
    await openEditor(user, 3);

    await user.click(bodyField(3));
    await user.keyboard("{Enter}");
    await act(async () => {
      await user.click(control("Save comment #3"));
    });

    expect(writes(requests)).toEqual([
      { method: "PATCH", path: commentPath(3), body: { title: "Note 3", body: "Body.\n" } },
    ]);
  });
});

describe("a refused comment save", () => {
  it("keeps the text, marks the title and names the fix for an arrow the daemon refused", async () => {
    const user = userEvent.setup();
    const { transport } = daemon([comment(3)], {
      [`PATCH ${commentPath(3)}`]: serialize("value-contains-arrow", "title"),
    });
    await renderWithRouter(PAGE, transport);
    await openEditor(user, 3);

    await user.type(titleField(3), " -->");
    await act(async () => {
      await user.click(control("Save comment #3"));
    });
    await frame();

    expect(titleField(3).value).toBe("Note 3 -->");
    expect(titleField(3).getAttribute("data-invalid")).not.toBeNull();
    expect(screen.getByText("The title contains \"-->\", which closes the comment marker. Remove it."))
      .toBeTruthy();
    expect(notices().map(({ title }) => title)).toEqual(["Comment #3 of SAGA-3 was not saved"]);
    expect(notices()[0]?.line).toBe("The daemon refused the write, so nothing changed on disk. Its own words are below. "
      + "The title contains \"-->\", which closes the comment marker. Remove it.");
  });

  it("marks the body for a refusal about the body", async () => {
    const user = userEvent.setup();
    const { transport } = daemon([comment(3)], {
      [`PATCH ${commentPath(3)}`]: serialize("marker-collision"),
    });
    await renderWithRouter(PAGE, transport);
    await openEditor(user, 3);

    await user.type(bodyField(3), "x");
    await act(async () => {
      await user.click(control("Save comment #3"));
    });

    expect(bodyField(3).getAttribute("data-invalid")).not.toBeNull();
    expect(titleField(3).getAttribute("data-invalid")).toBeNull();
  });

  it("clears the mark at the next change of the field the daemon named", async () => {
    const user = userEvent.setup();
    const { transport } = daemon([comment(3)], {
      [`PATCH ${commentPath(3)}`]: serialize("value-contains-arrow", "title"),
    });
    await renderWithRouter(PAGE, transport);
    await openEditor(user, 3);

    await user.type(titleField(3), " -->");
    await act(async () => {
      await user.click(control("Save comment #3"));
    });
    await user.type(titleField(3), "x");

    expect(titleField(3).getAttribute("data-invalid")).toBeNull();
  });
});

describe("the add form", () => {
  it("opens after the list in place of the button, with its own words", async () => {
    const user = userEvent.setup();
    await renderWithRouter(PAGE, daemon([comment(3)]).transport);

    await openAddForm(user);

    expect(newTitle().getAttribute("placeholder")).toBe("Title");
    expect(newBody().getAttribute("placeholder")).toBe("Write in markdown");
    expect(screen.getByRole("article", { name: "New comment" })).toBeTruthy();
    expect(control("Cancel the new comment")).toBeTruthy();
    expect(description(newTitle())).toContain("Command Enter add");
  });

  it("adds the comment, closes and lands the caret on the new card", async () => {
    const user = userEvent.setup();
    const { transport, replies, requests } = daemon([comment(3)], {
      [`POST ${COMMENTS_PATH}`]: successReply({ id: "SAGA-3", commentId: 9 }),
    });
    await renderWithRouter(PAGE, transport);
    await openAddForm(user);

    await user.type(newTitle(), "Reviewed");
    await user.type(newBody(), "Looks right.");
    replies[TASK_PATH] = task([comment(3), comment(9, { title: "Reviewed", body: "Looks right." })]);
    await act(async () => {
      await user.click(within(screen.getByRole("article", { name: "New comment" }))
        .getByRole("button", { name: "Add comment" }));
    });
    await frame();

    expect(writes(requests)).toEqual([
      { method: "POST", path: COMMENTS_PATH, body: { title: "Reviewed", body: "Looks right." } },
    ]);
    expect(screen.queryByRole("article", { name: "New comment" })).toBeNull();
    expect(document.activeElement).toBe(control("Comment #9 actions"));
    expect(announced()).toContain("Adding the new comment…");
    expect(announced()).toContain("Comment added.");
  });

  it("opens the page's failure notice for a refused add, and keeps the form", async () => {
    const user = userEvent.setup();
    const { transport } = daemon([comment(3)], {
      [`POST ${COMMENTS_PATH}`]: refusalReply(422, { kind: "store", code: "task-not-found", message: "SAGA-3 is gone" }),
    });
    await renderWithRouter(PAGE, transport);
    await openAddForm(user);

    await user.type(newTitle(), "Reviewed");
    await act(async () => {
      await user.click(within(screen.getByRole("article", { name: "New comment" }))
        .getByRole("button", { name: "Add comment" }));
    });
    await frame();

    expect(notices()).toMatchObject([{
      title: "The new comment on SAGA-3 was not added",
      line: "The daemon refused the write, so nothing changed on disk. Its own words are below.",
    }]);
    expect(newTitle().value).toBe("Reviewed");
  });

  it("returns the caret to Add comment when the form is cancelled", async () => {
    const user = userEvent.setup();
    await renderWithRouter(PAGE, daemon([comment(3)]).transport);
    await openAddForm(user);

    await user.click(control("Cancel the new comment"));

    expect(document.activeElement).toBe(control("Add comment"));
  });

  it("is reachable on a task with no comment at all", async () => {
    const user = userEvent.setup();
    await renderWithRouter(PAGE, daemon([]).transport);

    await openAddForm(user);

    expect(newTitle()).toBeTruthy();
  });

  it("is named in the page dialog, and its text is dropped with every other editor's", async () => {
    const user = userEvent.setup();
    const router = await renderWithRouter(PAGE, daemon([comment(3)]).transport);
    await openAddForm(user);
    await user.type(newTitle(), "Reviewed");

    await act(async () => {
      await user.click(within(screen.getByRole("main")).getByRole("link", { name: "Tasks" }));
    });
    expect(within(dialog()).getByText("The new comment is not saved. There is no undo.")).toBeTruthy();

    await act(async () => {
      await user.click(within(dialog()).getByRole("button", { name: "Discard" }));
    });

    expect(router.state.location.pathname).toBe("/tasks");
  });
});

describe("several editors at once", () => {
  it("each saves on its own and each refusal opens its own notice", async () => {
    const user = userEvent.setup();
    const { transport } = daemon([comment(3), comment(5)], {
      [`PATCH ${commentPath(3)}`]: serialize("marker-collision"),
      [`PATCH ${commentPath(5)}`]: serialize("fence-unterminated"),
    });
    await renderWithRouter(PAGE, transport);
    await openEditor(user, 3);
    await openEditor(user, 5);

    await user.type(bodyField(3), "x");
    await act(async () => {
      await user.click(control("Save comment #3"));
    });
    await user.type(bodyField(5), "y");
    await act(async () => {
      await user.click(control("Save comment #5"));
    });

    expect(notices().map(({ key }) => key)).toEqual([
      "comment-write-failure:SAGA-3#3",
      "comment-write-failure:SAGA-3#5",
    ]);
    expect(titleField(3).value).toBe("Note 3");
    expect(titleField(5).value).toBe("Note 5");
  });

  it("names every unsaved editor in the page dialog when the reader leaves", async () => {
    const user = userEvent.setup();
    await renderWithRouter(PAGE, daemon([comment(3), comment(5)]).transport);
    await openEditor(user, 3);
    await openEditor(user, 5);

    await user.type(bodyField(3), "x");
    await user.type(bodyField(5), "y");
    await act(async () => {
      await user.click(within(screen.getByRole("main")).getByRole("link", { name: "Tasks" }));
    });

    expect(within(dialog()).getByText("Comments #3 and #5 are not saved. There is no undo.")).toBeTruthy();
  });

  it("names the task text beside the comments it is unsaved with", async () => {
    const user = userEvent.setup();
    await renderWithRouter(PAGE, daemon([comment(3)]).transport);
    await openEditor(user, 3);
    await user.type(bodyField(3), "x");

    await user.click(within(screen.getByRole("main")).getByRole("button", { name: "Edit" }));
    await user.type(screen.getByRole("textbox", { name: "Title" }), "!");
    await act(async () => {
      await user.click(within(screen.getByRole("main")).getByRole("link", { name: "Tasks" }));
    });

    expect(within(dialog()).getByText("The task text and comment #3 are not saved. There is no undo."))
      .toBeTruthy();
  });

  it("keeps both texts where Keep editing answers the page dialog", async () => {
    const user = userEvent.setup();
    const router = await renderWithRouter(PAGE, daemon([comment(3), comment(5)]).transport);
    await openEditor(user, 3);
    await openEditor(user, 5);
    await user.type(bodyField(3), "x");
    await user.type(bodyField(5), "y");
    await act(async () => {
      await user.click(within(screen.getByRole("main")).getByRole("link", { name: "Tasks" }));
    });

    await act(async () => {
      await user.click(within(dialog()).getByRole("button", { name: "Keep editing" }));
    });

    expect(router.state.location.pathname).toBe(PAGE);
    expect(bodyField(3).value).toBe("Body of note 3.x");
    expect(bodyField(5).value).toBe("Body of note 5.y");
  });

  it("drops every editor's text on Discard and lets the route change run", async () => {
    const user = userEvent.setup();
    const router = await renderWithRouter(PAGE, daemon([comment(3), comment(5)]).transport);
    await openEditor(user, 3);
    await openEditor(user, 5);
    await user.type(bodyField(3), "x");
    await user.type(bodyField(5), "y");
    await act(async () => {
      await user.click(within(screen.getByRole("main")).getByRole("link", { name: "Tasks" }));
    });

    await act(async () => {
      await user.click(within(dialog()).getByRole("button", { name: "Discard" }));
    });

    expect(router.state.location.pathname).toBe("/tasks");
  });

  it("shows the wait in the page dialog, and speaks it on a Discard that must wait", async () => {
    const user = userEvent.setup();
    const write = heldBack();
    const { transport } = daemon([comment(3)], { [`PATCH ${commentPath(3)}`]: write.reply });
    const router = await renderWithRouter(PAGE, transport);
    await openEditor(user, 3);
    await user.type(bodyField(3), "x");
    await user.click(control("Save comment #3"));
    await act(async () => {
      await user.click(within(screen.getByRole("main")).getByRole("link", { name: "Tasks" }));
    });

    expect(description(dialog())).toContain("Saving…");

    await act(async () => {
      await user.click(within(dialog()).getByRole("button", { name: "Discard" }));
    });
    await frame();

    expect(router.state.location.pathname).toBe(PAGE);
    expect(announced()).toContain("Saving…");

    await act(async () => {
      write.answer(successReply({ id: "SAGA-3", commentId: 3 }));
    });
  });

  it("lets the route change run once the save that empties the registry lands", async () => {
    const user = userEvent.setup();
    const write = heldBack();
    const { transport } = daemon([comment(3)], { [`PATCH ${commentPath(3)}`]: write.reply });
    const router = await renderWithRouter(PAGE, transport);
    await openEditor(user, 3);
    await user.type(bodyField(3), "x");
    await user.click(control("Save comment #3"));
    await act(async () => {
      await user.click(within(screen.getByRole("main")).getByRole("link", { name: "Tasks" }));
    });

    await act(async () => {
      write.answer(successReply({ id: "SAGA-3", commentId: 3 }));
    });

    expect(router.state.location.pathname).toBe("/tasks");
  });

  it("carries a save that lands behind the page dialog in the dialog's own status", async () => {
    const user = userEvent.setup();
    const write = heldBack();
    const { transport } = daemon([comment(3), comment(5)], { [`PATCH ${commentPath(3)}`]: write.reply });
    const router = await renderWithRouter(PAGE, transport);
    await openEditor(user, 3);
    await openEditor(user, 5);
    await user.type(bodyField(3), "x");
    await user.type(bodyField(5), "y");
    await user.click(control("Save comment #3"));
    await act(async () => {
      await user.click(within(screen.getByRole("main")).getByRole("link", { name: "Tasks" }));
    });

    await act(async () => {
      write.answer(successReply({ id: "SAGA-3", commentId: 3 }));
    });

    expect(router.state.location.pathname).toBe(PAGE);
    expect(description(dialog())).toContain("Comment #3 saved. Comment #5 is still not saved.");
  });

  it("says nothing of an earlier save when the page dialog opens again", async () => {
    const user = userEvent.setup();
    const write = heldBack();
    const { transport } = daemon([comment(3), comment(5)], { [`PATCH ${commentPath(3)}`]: write.reply });
    await renderWithRouter(PAGE, transport);
    await openEditor(user, 3);
    await openEditor(user, 5);
    await user.type(bodyField(3), "x");
    await user.type(bodyField(5), "y");
    await user.click(control("Save comment #3"));
    const leave = async (): Promise<void> => {
      await act(async () => {
        await user.click(within(screen.getByRole("main")).getByRole("link", { name: "Tasks" }));
      });
    };
    await leave();
    await act(async () => {
      write.answer(successReply({ id: "SAGA-3", commentId: 3 }));
    });
    await act(async () => {
      await user.click(within(dialog()).getByRole("button", { name: "Keep editing" }));
    });

    await user.type(bodyField(5), "z");
    await leave();

    expect(description(dialog())).not.toContain("Comment #3 saved.");
    expect(within(dialog()).getByText("Comment #5 is not saved. There is no undo.")).toBeTruthy();
  });

  it("lands Keep editing on the card whose save closed the editor the caret was in", async () => {
    const user = userEvent.setup();
    const write = heldBack();
    const { transport } = daemon([comment(3), comment(5)], { [`PATCH ${commentPath(3)}`]: write.reply });
    const router = await renderWithRouter(PAGE, transport);
    await openEditor(user, 3);
    await openEditor(user, 5);
    await user.type(bodyField(5), "y");
    await user.type(titleField(3), "!");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(document.activeElement).toBe(titleField(3));
    // A route change that leaves the caret where it is, as a keyboard shortcut does.
    await act(async () => {
      void router.navigate({ to: "/tasks" });
      await Promise.resolve();
    });
    await act(async () => {
      write.answer(successReply({ id: "SAGA-3", commentId: 3 }));
    });

    await act(async () => {
      await user.click(within(dialog()).getByRole("button", { name: "Keep editing" }));
    });

    await waitFor(() => {
      expect(document.activeElement).toBe(control("Comment #3 actions"));
    });
  });

  it("returns Keep editing to the element the page dialog opened from, where it is still there", async () => {
    const user = userEvent.setup();
    const write = heldBack();
    const { transport } = daemon([comment(3), comment(5)], { [`PATCH ${commentPath(3)}`]: write.reply });
    const router = await renderWithRouter(PAGE, transport);
    await openEditor(user, 3);
    await openEditor(user, 5);
    await user.type(titleField(3), "!");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await user.type(bodyField(5), "y");
    await act(async () => {
      void router.navigate({ to: "/tasks" });
      await Promise.resolve();
    });
    await act(async () => {
      write.answer(successReply({ id: "SAGA-3", commentId: 3 }));
    });

    await act(async () => {
      await user.click(within(dialog()).getByRole("button", { name: "Keep editing" }));
    });

    await waitFor(() => {
      expect(document.activeElement).toBe(bodyField(5));
    });
  });

  it("keeps the caret in the field of a refused save after an earlier page dialog whose opener has gone", async () => {
    const user = userEvent.setup();
    const { transport } = daemon([comment(3), comment(5)], {
      [`PATCH ${commentPath(3)}`]: successReply({ id: "SAGA-3", commentId: 3 }),
      [`PATCH ${commentPath(5)}`]: serialize("value-contains-arrow", "title"),
    });
    const router = await renderWithRouter(PAGE, transport);
    await openEditor(user, 3);
    await openEditor(user, 5);
    await user.type(titleField(3), "!");
    await act(async () => {
      void router.navigate({ to: "/tasks" });
      await Promise.resolve();
    });
    await act(async () => {
      await user.click(within(dialog()).getByRole("button", { name: "Keep editing" }));
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(titleField(3));
    });
    await act(async () => {
      await user.keyboard("{Meta>}{Enter}{/Meta}");
    });
    await frame();

    await user.type(titleField(5), " -->");
    await act(async () => {
      await user.keyboard("{Meta>}{Enter}{/Meta}");
    });
    await frame();
    await frame();

    expect(titleField(5).getAttribute("data-invalid")).not.toBeNull();
    expect(document.activeElement).toBe(titleField(5));
  });

  it("moves no focus for a save that lands behind a modal dialog", async () => {
    const user = userEvent.setup();
    const write = heldBack();
    const { transport } = daemon([comment(3), comment(5)], { [`PATCH ${commentPath(3)}`]: write.reply });
    await renderWithRouter(PAGE, transport);
    await openEditor(user, 3);
    await user.type(bodyField(3), "x");
    await user.click(control("Save comment #3"));
    // Another card's delete dialog is live the whole time a save runs.
    await user.click(control("Comment #5 actions"));
    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
    });
    await act(async () => {
      await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    });
    const cancel = within(dialog()).getByRole("button", { name: "Cancel" });
    await waitFor(() => {
      expect(document.activeElement).toBe(cancel);
    });

    await act(async () => {
      write.answer(successReply({ id: "SAGA-3", commentId: 3 }));
    });

    expect(document.activeElement).toBe(cancel);
  });

  it("moves no focus for a task text save that lands behind a comment's dialog", async () => {
    const user = userEvent.setup();
    const write = heldBack();
    const { transport } = daemon([comment(5)], { [`PATCH ${TASK_PATH}`]: write.reply });
    await renderWithRouter(PAGE, transport);
    await user.click(within(screen.getByRole("main")).getByRole("button", { name: "Edit" }));
    await user.type(screen.getByRole("textbox", { name: "Title" }), "!");
    await user.click(within(screen.getByRole("main")).getByRole("button", { name: "Save" }));
    await user.click(control("Comment #5 actions"));
    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
    });
    await act(async () => {
      await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    });
    const cancel = within(dialog()).getByRole("button", { name: "Cancel" });
    await waitFor(() => {
      expect(document.activeElement).toBe(cancel);
    });

    await act(async () => {
      write.answer(successReply({ id: "SAGA-3" }));
    });

    expect(document.activeElement).toBe(cancel);
  });
});

describe("leaving for another task", () => {
  const OTHER_PATH = "/projects/SAGA/tasks/SAGA-4";

  it("drops the editors of the task left behind, so none opens on the next task's card", async () => {
    const user = userEvent.setup();
    const { transport } = daemon([comment(3)], {
      [OTHER_PATH]: successReply({
        frontmatter: frontmatter({ id: "SAGA-4", title: "Write the docs" }),
        body: "Later.\n",
        comments: [comment(3, { title: "Note of the next task" })],
      }),
      [LISTING_PATH]: successReply({
        entries: [entry("SAGA-3", "Build the parser"), entry("SAGA-4", "Write the docs")],
        excluded: [],
      }),
    });
    const router = await renderWithRouter(PAGE, transport);
    await openEditor(user, 3);
    await user.type(bodyField(3), "typed");

    // Not awaited: the navigation settles only once the dialog is answered.
    let arrived: Promise<void> = Promise.resolve();
    await act(async () => {
      arrived = router.navigate({ to: "/tasks/$project/$task", params: { project: "SAGA", task: "SAGA-4" } });
      await Promise.resolve();
    });
    await act(async () => {
      await user.click(within(dialog()).getByRole("button", { name: "Discard" }));
      await arrived;
    });

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Write the docs");
    expect(screen.queryByRole("textbox", { name: "Comment #3 title" })).toBeNull();
    expect(screen.getByRole("article", { name: "Note of the next task" })).toBeTruthy();
  });
});

describe("the disk line of a card", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  it("appears in that card alone, at the comment's own stamp", async () => {
    const user = userEvent.setup();
    const { transport, replies } = daemon([comment(3), comment(5)]);
    await renderWithRouter(PAGE, transport);
    await openEditor(user, 3);
    await openEditor(user, 5);

    replies[TASK_PATH] = task([comment(3, { body: "Rewritten.", updated: STAMP }), comment(5)]);
    await poll();
    await frame();

    const at = new Date(STAMP).toTimeString().slice(0, 5);
    expect(control("Discard and reload comment #3")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Discard and reload comment #5" })).toBeNull();
    expect(announced()).toContain(`Comment #3 changed on disk at ${at}. Saving overwrites that change.`);
  });

  it("speaks a different sentence for each of two cards", async () => {
    const user = userEvent.setup();
    const { transport, replies } = daemon([comment(3), comment(5)]);
    await renderWithRouter(PAGE, transport);
    await openEditor(user, 3);
    await openEditor(user, 5);

    replies[TASK_PATH] = task([
      comment(3, { body: "Rewritten.", updated: STAMP }),
      comment(5, { body: "Also rewritten.", updated: STAMP }),
    ]);
    await poll();
    await frame();

    const at = new Date(STAMP).toTimeString().slice(0, 5);
    expect(announced()).toContain(`Comment #3 changed on disk at ${at}. Saving overwrites that change.`);
    expect(announced()).toContain(`Comment #5 changed on disk at ${at}. Saving overwrites that change.`);
  });

  it("falls back to the task's stamp for a comment that carries none", async () => {
    const user = userEvent.setup();
    const { transport, replies } = daemon([comment(3)]);
    await renderWithRouter(PAGE, transport);
    await openEditor(user, 3);

    replies[TASK_PATH] = task([comment(3, { body: "Rewritten." })]);
    await poll();
    await frame();

    const at = new Date(UPDATED).toTimeString().slice(0, 5);
    expect(announced()).toContain(`Comment #3 changed on disk at ${at}. Saving overwrites that change.`);
  });

  it("follows the line to the title input when a read ends the difference under the caret", async () => {
    const user = userEvent.setup();
    const { transport, replies } = daemon([comment(3)]);
    await renderWithRouter(PAGE, transport);
    await openEditor(user, 3);

    replies[TASK_PATH] = task([comment(3, { body: "Rewritten.", updated: STAMP })]);
    await poll();
    control("Discard and reload comment #3").focus();

    replies[TASK_PATH] = task([comment(3)]);
    await poll();

    expect(screen.queryByRole("button", { name: "Discard and reload comment #3" })).toBeNull();
    expect(document.activeElement).toBe(titleField(3));
  });

  it("replaces that card's text alone when Discard and reload is pressed", async () => {
    const user = userEvent.setup();
    const { transport, replies } = daemon([comment(3), comment(5)]);
    await renderWithRouter(PAGE, transport);
    await openEditor(user, 3);
    await openEditor(user, 5);
    await user.type(bodyField(5), "kept");

    replies[TASK_PATH] = task([comment(3, { body: "Rewritten.", updated: STAMP }), comment(5)]);
    await poll();
    await act(async () => {
      await user.click(control("Discard and reload comment #3"));
    });

    expect(bodyField(3).value).toBe("Rewritten.");
    expect(bodyField(5).value).toBe("Body of note 5.kept");
  });

  it("sends one write for ⌘↩ on the reload control, and asks once for Esc there", async () => {
    const user = userEvent.setup();
    const { transport, replies, requests } = daemon([comment(3)], {
      [`PATCH ${commentPath(3)}`]: successReply({ id: "SAGA-3", commentId: 3 }),
    });
    await renderWithRouter(PAGE, transport);
    await openEditor(user, 3);
    await user.type(bodyField(3), "x");

    replies[TASK_PATH] = task([comment(3, { body: "Rewritten.", updated: STAMP })]);
    await poll();
    control("Discard and reload comment #3").focus();
    await act(async () => {
      await user.keyboard("{Escape}");
    });
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    await act(async () => {
      await user.click(within(dialog()).getByRole("button", { name: "Keep editing" }));
    });

    control("Discard and reload comment #3").focus();
    await act(async () => {
      await user.keyboard("{Meta>}{Enter}{/Meta}");
    });
    await frame();

    expect(writes(requests)).toHaveLength(1);
    expect(announced().filter((words) => words === "Comment #3 saved.")).toHaveLength(1);
  });
});

describe("a comment removed on disk while its editor is open", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  async function removeComment(user: ReturnType<typeof userEvent.setup>) {
    const { transport, replies } = daemon([comment(3), comment(5)]);
    await renderWithRouter(PAGE, transport);
    await openEditor(user, 3);
    await user.type(bodyField(3), "typed");
    replies[TASK_PATH] = task([comment(5)]);

    return { replies };
  }

  it("keeps the card and its text, swaps Save for Discard and speaks the swap", async () => {
    const user = userEvent.setup();
    await removeComment(user);

    await poll();
    await frame();

    expect(bodyField(3).value).toBe("Body of note 3.typed");
    expect(screen.queryByRole("button", { name: "Save comment #3" })).toBeNull();
    expect(control("Discard comment #3")).toBeTruthy();
    expect(screen.getByText("This comment was removed on disk.")).toBeTruthy();
    expect(announced()).toContain("Comment #3 was removed on disk. It can no longer be saved.");
  });

  it("keeps the card's place in the list", async () => {
    const user = userEvent.setup();
    await removeComment(user);

    await poll();

    const cards = screen.getAllByRole("article").map((card) => card.getAttribute("data-comment-id"));
    expect(cards).toEqual(["3", "5"]);
  });

  it("asks before Discard drops the text, and resolves the caret from its last place", async () => {
    const user = userEvent.setup();
    await removeComment(user);
    await poll();

    await act(async () => {
      await user.click(control("Discard comment #3"));
    });
    expect(within(dialog()).getByText("Comment #3 is not saved. There is no undo.")).toBeTruthy();

    await act(async () => {
      await user.click(within(dialog()).getByRole("button", { name: "Discard" }));
    });

    expect(screen.queryByRole("textbox", { name: "Comment #3 title" })).toBeNull();
    expect(document.activeElement).toBe(control("Comment #5 actions"));
  });

  it("moves a caret that was on Save to the line, and says nothing as well", async () => {
    const user = userEvent.setup();
    await removeComment(user);
    control("Save comment #3").focus();

    await poll();
    await frame();

    expect(document.activeElement).toBe(screen.getByText("This comment was removed on disk.").parentElement!.parentElement);
    expect(announced()).not.toContain("Comment #3 was removed on disk. It can no longer be saved.");
  });

  it("lands Keep editing on the main region when the card it opened from was removed on disk", async () => {
    const user = userEvent.setup();
    const { transport, replies } = daemon([comment(3), comment(5)]);
    const router = await renderWithRouter(PAGE, transport);
    await openEditor(user, 5);
    await user.type(bodyField(5), "y");
    control("Comment #3 actions").focus();
    await act(async () => {
      void router.navigate({ to: "/tasks" });
      await Promise.resolve();
    });

    replies[TASK_PATH] = task([comment(5)]);
    await poll();
    await act(async () => {
      await user.click(within(dialog()).getByRole("button", { name: "Keep editing" }));
    });

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("main"));
    });
  });

  it("leaves a caret in the body where it is, and speaks the swap there", async () => {
    const user = userEvent.setup();
    await removeComment(user);
    const body = bodyField(3);

    await poll();
    await frame();

    expect(document.activeElement).toBe(body);
    expect(announced()).toContain("Comment #3 was removed on disk. It can no longer be saved.");
  });
});
