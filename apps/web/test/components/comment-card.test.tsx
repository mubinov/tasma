import type { Comment, Frontmatter, TaskEntry, TransportReply } from "@tasma/protocol";
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

const LISTING_PATH = "/projects/SAGA/tasks";

const PAGE = "/tasks/SAGA/SAGA-3";

function commentPath(commentId: number): string {
  return `${TASK_PATH}/comments/${String(commentId)}`;
}

function frontmatter(fields: Partial<Frontmatter> = {}): Frontmatter {
  return {
    id: "SAGA-3",
    title: "Build the parser",
    status: "In Progress",
    created: "2026-09-01T10:00:00Z",
    updated: "2026-09-01T10:15:00Z",
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

function card(name: string): HTMLElement {
  return screen.getByRole("article", { name });
}

function menu(name: string): HTMLElement {
  return within(card(name)).getByRole("button", { name: /actions$/ });
}

function item(name: string): HTMLElement {
  return screen.getByRole("menuitem", { name });
}

function flag(): HTMLElement {
  return screen.getByRole("menuitemcheckbox", { name: "Collapsed by default" });
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

async function openMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(menu(name));
  await waitFor(() => {
    expect(screen.getByRole("menu")).toBeTruthy();
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
  vi.unstubAllGlobals();
});

describe("the comment menu", () => {
  it("stands beside the caret and names its comment", async () => {
    await renderWithRouter(PAGE, daemon([comment(3)]).transport);

    const controls = within(card("Note 3")).getAllByRole("button");
    expect(controls.map((control) => control.getAttribute("aria-label")))
      .toEqual(["Comment #3 actions", "Comment #3 text"]);
    const title = within(card("Note 3")).getByRole("heading", { level: 3 }).id;
    expect(controls.map((control) => control.getAttribute("aria-describedby"))).toEqual([title, title]);
  });

  it("holds Edit, the flag, a separator and Delete", async () => {
    const user = userEvent.setup();
    await renderWithRouter(PAGE, daemon([comment(3)]).transport);

    await openMenu(user, "Note 3");

    const rows = [...screen.getByRole("menu").querySelectorAll("[role^='menuitem'], [role='separator']")];
    expect(rows.map((row) => (row.getAttribute("role") === "separator" ? "—" : row.textContent)))
      .toEqual(["Edit", "Collapsed by default", "—", "Delete"]);
  });

  it("shows no menu on a card in editing", async () => {
    const user = userEvent.setup();
    await renderWithRouter(PAGE, daemon([comment(3)]).transport);

    await openMenu(user, "Note 3");
    await user.click(item("Edit"));

    expect(within(card("Note 3")).queryByRole("button", { name: /actions$/ })).toBeNull();
  });
});

describe("Collapsed by default", () => {
  it("is checked from the file", async () => {
    const user = userEvent.setup();
    await renderWithRouter(PAGE, daemon([comment(3, { collapsed: true })]).transport);

    await openMenu(user, "Note 3");

    expect(flag().getAttribute("aria-checked")).toBe("true");
  });

  it("keeps the menu open and moves the check from the pending write, before the read lands", async () => {
    const user = userEvent.setup();
    const write = heldBack();
    const { transport } = daemon([comment(3)], { [`PATCH ${commentPath(3)}`]: write.reply });
    await renderWithRouter(PAGE, transport);
    await openMenu(user, "Note 3");

    await user.click(flag());

    expect(screen.getByRole("menu")).toBeTruthy();
    expect(flag().getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      write.answer(successReply({ id: "SAGA-3", commentId: 3 }));
    });
  });

  it("writes null when turned off, and moves the check the other way at once", async () => {
    const user = userEvent.setup();
    const write = heldBack();
    const { transport, requests } = daemon(
      [comment(3, { collapsed: true })],
      { [`PATCH ${commentPath(3)}`]: write.reply },
    );
    await renderWithRouter(PAGE, transport);
    await openMenu(user, "Note 3");

    await user.click(flag());

    expect(flag().getAttribute("aria-checked")).toBe("false");
    expect(writes(requests)).toEqual([{ method: "PATCH", path: commentPath(3), body: { collapsed: null } }]);

    await act(async () => {
      write.answer(successReply({ id: "SAGA-3", commentId: 3 }));
    });
  });

  it("leaves the check on the last of two quick toggles", async () => {
    const user = userEvent.setup();
    const write = heldBack();
    const { transport } = daemon([comment(3)], { [`PATCH ${commentPath(3)}`]: write.reply });
    await renderWithRouter(PAGE, transport);
    await openMenu(user, "Note 3");

    await user.click(flag());
    await user.click(flag());

    expect(flag().getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      write.answer(successReply({ id: "SAGA-3", commentId: 3 }));
    });
  });

  it("reverts to the file value when the write is refused, and opens a notice about the change", async () => {
    const user = userEvent.setup();
    const { transport } = daemon([comment(3)], {
      [`PATCH ${commentPath(3)}`]: refusalReply(422, {
        kind: "store",
        code: "field-not-writable",
        message: "collapsed is not writable here",
      }),
    });
    await renderWithRouter(PAGE, transport);
    await openMenu(user, "Note 3");

    await act(async () => {
      await user.click(flag());
    });

    await waitFor(() => {
      expect(flag().getAttribute("aria-checked")).toBe("false");
    });
    expect(notices().map(({ title }) => title)).toEqual(["Comment #3 of SAGA-3 was not changed"]);
  });

  it("does not fold a card the reader has open", async () => {
    const user = userEvent.setup();
    const write = heldBack();
    const { transport } = daemon([comment(3)], { [`PATCH ${commentPath(3)}`]: write.reply });
    await renderWithRouter(PAGE, transport);
    await openMenu(user, "Note 3");

    await user.click(flag());

    expect(screen.getByText("Body of note 3.")).toBeTruthy();

    await act(async () => {
      write.answer(successReply({ id: "SAGA-3", commentId: 3 }));
    });
  });
});

describe("deleting a comment", () => {
  const REFUSAL = refusalReply(422, {
    kind: "store",
    code: "comment-not-found",
    message: "comment 3 is not in SAGA-3",
  });

  async function askDelete(user: ReturnType<typeof userEvent.setup>, name = "Note 3") {
    await openMenu(user, name);
    await act(async () => {
      await user.click(item("Delete"));
    });
  }

  it("names the comment and quotes its title, with focus on Cancel", async () => {
    const user = userEvent.setup();
    await renderWithRouter(PAGE, daemon([comment(3)]).transport);

    await askDelete(user);

    expect(within(dialog()).getByRole("heading").textContent).toBe("Delete comment #3?");
    expect(within(dialog()).getByText("\"Note 3\" is removed from the task file. There is no undo.")).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement).toBe(within(dialog()).getByRole("button", { name: "Cancel" }));
    });
  });

  it("names a comment with no title by its id, in the card's heading and in the dialog", async () => {
    const user = userEvent.setup();
    await renderWithRouter(PAGE, daemon([comment(3, { title: "" })]).transport);

    expect(within(card("Comment #3")).getByRole("heading", { level: 3 }).textContent).toBe("Comment #3");

    await askDelete(user, "Comment #3");

    expect(within(dialog()).getByText("\"Comment #3\" is removed from the task file. There is no undo."))
      .toBeTruthy();
  });

  it("speaks the wait and shows it in the dialog while the write runs", async () => {
    const user = userEvent.setup();
    const write = heldBack();
    const { transport } = daemon([comment(3)], { [`DELETE ${commentPath(3)}`]: write.reply });
    await renderWithRouter(PAGE, transport);
    await askDelete(user);

    await user.click(within(dialog()).getByRole("button", { name: "Delete" }));
    await frame();

    expect(announced()).toContain("Deleting comment #3…");
    expect(within(dialog()).getByText("Deleting comment #3…")).toBeTruthy();
    expect(within(dialog()).getByRole("button", { name: "Deleting…" })).toBeTruthy();

    await act(async () => {
      write.answer(successReply({ id: "SAGA-3", commentId: 3 }));
    });
  });

  it("removes the comment, closes the dialog and speaks once it has gone", async () => {
    const user = userEvent.setup();
    const { transport, replies, requests } = daemon([comment(3), comment(5)], {
      [`DELETE ${commentPath(3)}`]: successReply({ id: "SAGA-3", commentId: 3 }),
    });
    await renderWithRouter(PAGE, transport);
    await askDelete(user);

    replies[TASK_PATH] = task([comment(5)]);
    await act(async () => {
      await user.click(within(dialog()).getByRole("button", { name: "Delete" }));
    });
    await frame();

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("article", { name: "Note 3" })).toBeNull();
    expect(writes(requests)).toEqual([{ method: "DELETE", path: commentPath(3), body: undefined }]);
    expect(announced()).toContain("Comment #3 deleted.");
  });

  it("lands the caret on the menu button of the card after the one deleted", async () => {
    const user = userEvent.setup();
    const { transport, replies } = daemon([comment(3), comment(5)], {
      [`DELETE ${commentPath(3)}`]: successReply({ id: "SAGA-3", commentId: 3 }),
    });
    await renderWithRouter(PAGE, transport);
    await askDelete(user);

    replies[TASK_PATH] = task([comment(5)]);
    await act(async () => {
      await user.click(within(dialog()).getByRole("button", { name: "Delete" }));
    });

    expect(document.activeElement).toBe(menu("Note 5"));
  });

  it("lands the caret on Add comment where the comment deleted was the last", async () => {
    const user = userEvent.setup();
    const { transport, replies } = daemon([comment(3)], {
      [`DELETE ${commentPath(3)}`]: successReply({ id: "SAGA-3", commentId: 3 }),
    });
    await renderWithRouter(PAGE, transport);
    await askDelete(user);

    replies[TASK_PATH] = task([]);
    await act(async () => {
      await user.click(within(dialog()).getByRole("button", { name: "Delete" }));
    });

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add comment" }));
  });

  it("keeps the dialog open on a refusal, shows the daemon's words and opens its notice", async () => {
    const user = userEvent.setup();
    const { transport } = daemon([comment(3)], { [`DELETE ${commentPath(3)}`]: REFUSAL });
    await renderWithRouter(PAGE, transport);
    await askDelete(user);

    await act(async () => {
      await user.click(within(dialog()).getByRole("button", { name: "Delete" }));
    });
    await frame();

    expect(screen.queryByRole("alertdialog")).not.toBeNull();
    expect(within(dialog()).getByText(/comment 3 is not in SAGA-3/)).toBeTruthy();
    // The page behind a modal dialog carries `aria-hidden`, so the card is read from the DOM.
    expect(document.querySelector("[data-comment-id=\"3\"]")).not.toBeNull();
    expect(notices().map(({ title }) => title)).toEqual(["Comment #3 of SAGA-3 was not deleted"]);
  });

  it("sends one write for a second Delete pressed while the first runs", async () => {
    const user = userEvent.setup();
    const write = heldBack();
    const { transport, requests } = daemon([comment(3)], { [`DELETE ${commentPath(3)}`]: write.reply });
    await renderWithRouter(PAGE, transport);
    await askDelete(user);

    await user.click(within(dialog()).getByRole("button", { name: "Delete" }));
    await user.click(within(dialog()).getByRole("button", { name: "Deleting…" }));

    expect(writes(requests)).toEqual([{ method: "DELETE", path: commentPath(3), body: undefined }]);

    await act(async () => {
      write.answer(successReply({ id: "SAGA-3", commentId: 3 }));
    });
  });

  it("leaves the comment where Cancel answers the dialog", async () => {
    const user = userEvent.setup();
    const { transport, requests } = daemon([comment(3)]);
    await renderWithRouter(PAGE, transport);
    await askDelete(user);

    await act(async () => {
      await user.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    });

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(card("Note 3")).toBeTruthy();
    expect(writes(requests)).toEqual([]);
  });

  it("opens the next dialog without the refusal of a write whose dialog was cancelled", async () => {
    const user = userEvent.setup();
    const write = heldBack();
    const { transport } = daemon([comment(3)], { [`DELETE ${commentPath(3)}`]: write.reply });
    await renderWithRouter(PAGE, transport);
    await askDelete(user);
    await user.click(within(dialog()).getByRole("button", { name: "Delete" }));
    await act(async () => {
      await user.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    });
    await act(async () => {
      write.answer(REFUSAL);
    });

    await askDelete(user);

    expect(within(dialog()).queryByText(/comment 3 is not in SAGA-3/)).toBeNull();
  });

  it("moves the caret to the next card on a delete that follows a cancelled one, the read still holding it", async () => {
    const user = userEvent.setup();
    const { transport } = daemon([comment(3), comment(5)], {
      [`DELETE ${commentPath(3)}`]: successReply({ id: "SAGA-3", commentId: 3 }),
    });
    await renderWithRouter(PAGE, transport);
    await askDelete(user);
    await act(async () => {
      await user.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    });
    await askDelete(user);

    // The read that follows the write can still hold the comment, so the card and its dialog stay.
    await act(async () => {
      await user.click(within(dialog()).getByRole("button", { name: "Delete" }));
    });
    await frame();

    expect(document.activeElement).toBe(menu("Note 5"));
  });
});

describe("Edit on a card the reader cannot unfold", () => {
  it("opens a reachable editor for a comment its file marks collapsed", async () => {
    const user = userEvent.setup();
    await renderWithRouter(PAGE, daemon([comment(3, { collapsed: true })]).transport);

    await openMenu(user, "Note 3");
    await user.click(item("Edit"));

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Comment #3 title" }));
    });
    expect(screen.getByRole("textbox", { name: "Comment #3 body" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save comment #3" })).toBeTruthy();
  });

  it("opens a reachable editor for a comment with no body on disk", async () => {
    const user = userEvent.setup();
    await renderWithRouter(PAGE, daemon([comment(3, { body: " \n" })]).transport);

    await openMenu(user, "Note 3");
    await user.click(item("Edit"));

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Comment #3 title" }));
    });
    expect(screen.getByRole("button", { name: "Cancel editing comment #3" })).toBeTruthy();
  });
});
