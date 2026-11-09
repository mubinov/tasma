import type { AnyChatListItem, TransportReply } from "@tasma/protocol";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatRecord, eventsPath, projectChatPath, projectChatRecord, projectEventsPath } from "../chat-daemon";
import {
  chatHeading,
  itemLink,
  itemLinks,
  listItem,
  minutesAgo,
  NOW,
  OPEN,
  pageReply,
  projectItem,
  renderDashboard,
  stubDashboard,
  stubLayout,
} from "../dashboard-fixtures";
import { heldBack, pathsBeforeFeed, refusalReply, stubThreadDom, successReply } from "../helpers";
import { stubWindowWidth } from "../setup/match-media";
import { CHATS_PATH } from "../task-chats-daemon";
import { TASK_PATH, task } from "../task-screen-fixtures";

type Replies = Record<string, TransportReply | Promise<TransportReply>>;

const PROJECT_OPEN = projectItem("SAGA", 2, 3, { title: "Remove all drafts", status: { state: "needs-you" } });

const NO_MARK = projectItem("ACME", 4, 400, { title: "Plan the release" });

const ROWS: readonly AnyChatListItem[] = [PROJECT_OPEN, OPEN, NO_MARK];

const PROJECT_OPEN_PATH = "/?tag=SAGA&chat=2";

const TASK_OPEN_PATH = "/?task=SAGA-3&chat=2";

/** The daemon of a list of both kinds, which holds the logs of chat 2 of SAGA and of chat 2 of SAGA-3. */
function projectDaemon(replies: Replies = {}) {
  return stubDashboard({
    "/chats": pageReply(ROWS),
    [projectChatPath()]: successReply(projectChatRecord({ title: "Remove all drafts" })),
    [eventsPath(0)]: heldBack().reply,
    ...replies,
  }, projectEventsPath);
}

function projectHeading(name: RegExp | string = /^SAGA/): HTMLElement {
  return screen.getByRole("heading", { level: 2, name });
}

function missing(code: "chat-not-found" | "project-not-found") {
  return refusalReply(404, { kind: "store", code, message: "gone" });
}

function expectNoTaskControls(): void {
  expect(screen.queryByRole("link", { name: "Open task" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Chat menu/ })).toBeNull();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("TZ", "UTC");
  stubThreadDom();
  stubLayout();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the row of a chat of a project", () => {
  it("shows in the order of the page, with the tag, the time, the title and the state, and no step", async () => {
    await renderDashboard(projectDaemon());

    expect(itemLinks().map((link) => link.getAttribute("data-chat-key"))).toEqual(["SAGA/2", "SAGA-3/2", "ACME/4"]);
    const row = itemLink("SAGA", 2);
    const tag = within(row).getByText("SAGA");
    expect(tag.className).toContain("font-mono");
    expect(tag.className).toContain("wrap-anywhere");
    expect(row.querySelector("time")?.textContent).toBe("3m");
    expect(row.querySelector("time")?.getAttribute("datetime")).toBe(minutesAgo(3));
    expect(within(row).getByText("Remove all drafts")).toBeTruthy();
    expect(row.lastElementChild!.textContent).toBe("Needs you");
    expect(row.lastElementChild!.children).toHaveLength(1);
  });

  it("names the row by the tag, the title, the number, the state when there is one, and the full time", async () => {
    await renderDashboard(projectDaemon());

    expect(itemLink("SAGA", 2).getAttribute("aria-label")).toBe("SAGA Remove all drafts, Chat 2, Needs you, 22 October 2026 11:57");
    expect(itemLink("ACME", 4).getAttribute("aria-label")).toBe("ACME Plan the release, Chat 4, 22 October 2026 05:20");
  });

  it("keeps the third line empty, at the height of one line, for a row with no mark", async () => {
    await renderDashboard(projectDaemon());

    const row = itemLink("ACME", 4);
    expect(row.children).toHaveLength(3);
    expect(row.lastElementChild!.textContent).toBe("");
    expect(row.lastElementChild!.className).toContain("min-h-(--text-xs--line-height)");
  });

  it("marks the words of the search in the tag and in the title", async () => {
    const stub = projectDaemon({
      "/chats?q=saga%20drafts": pageReply([PROJECT_OPEN]),
    });
    await renderDashboard(stub, "/?q=saga%20drafts");

    await waitFor(() => {
      expect(itemLinks()).toHaveLength(1);
    });
    const marks = [...itemLink("SAGA", 2).querySelectorAll("mark")].map((mark) => mark.textContent);
    expect(marks).toEqual(["SAGA", "drafts"]);
  });

  it("selects only the row that a click opens, of two chats with the same number", async () => {
    const user = userEvent.setup();
    await renderDashboard(projectDaemon());

    await user.click(itemLink("SAGA", 2));

    await waitFor(() => {
      expect(itemLink("SAGA", 2).getAttribute("aria-current")).toBe("page");
    });
    expect(itemLink("SAGA-3", 2).hasAttribute("aria-current")).toBe(false);
  });
});

describe("the open chat of a project", () => {
  it("opens beside the list on a click, with the tag in the address and no controls of a task", async () => {
    const user = userEvent.setup();
    const stub = projectDaemon();
    const router = await renderDashboard(stub);

    await user.click(itemLink("SAGA", 2));

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ tag: "SAGA", chat: "2" });
    });
    expect(projectHeading().textContent).toBe("SAGA Remove all drafts");
    expect(projectHeading().firstElementChild?.className).toContain("wrap-anywhere");
    expect(projectHeading().nextElementSibling?.textContent).toBe("Claude · Chat 2Needs you");
    expectNoTaskControls();
    await waitFor(() => {
      expect(stub.paths).toContain(projectChatPath());
    });
    expect(stub.paths).toContain(projectEventsPath(0));
    expect(stub.paths.some((path) => path.startsWith("/projects/SAGA/tasks"))).toBe(false);
  });

  it("shows the chat of the address when the screen opens, and selects its row", async () => {
    await renderDashboard(projectDaemon(), PROJECT_OPEN_PATH);

    expect(projectHeading().textContent).toBe("SAGA Remove all drafts");
    expect(itemLink("SAGA", 2).getAttribute("aria-current")).toBe("page");
    expect(itemLinks().filter((link) => link.hasAttribute("aria-current"))).toHaveLength(1);
  });

  it("removes the tag from the address after a click on a chat of a task", async () => {
    const user = userEvent.setup();
    const router = await renderDashboard(projectDaemon(), PROJECT_OPEN_PATH);

    await user.click(itemLink("SAGA-3", 2));

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ task: "SAGA-3", chat: "2" });
    });
    expect(chatHeading().textContent).toBe("SAGA-3 Build the parser");
  });

  it("removes the task from the address after a click on a chat of a project", async () => {
    const user = userEvent.setup();
    const router = await renderDashboard(projectDaemon(), TASK_OPEN_PATH);

    await user.click(itemLink("SAGA", 2));

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ tag: "SAGA", chat: "2" });
    });
  });

  it("reads a chat that the loaded pages do not hold from its item, and shows its title", async () => {
    const stub = projectDaemon({
      "/projects/SAGA/chats/9/item": successReply(projectItem("SAGA", 9, 3000, { title: "Plan the cache", status: { state: "failed" } })),
      [projectChatPath(9)]: successReply(projectChatRecord({ chat: 9 })),
      [projectEventsPath(0, 9)]: heldBack().reply,
    });
    await renderDashboard(stub, "/?tag=SAGA&chat=9");

    await waitFor(() => {
      expect(projectHeading().textContent).toBe("SAGA Plan the cache");
    });
    expect(projectHeading().nextElementSibling?.textContent).toBe("Claude · Chat 9Failed");
    expect(itemLinks().some((link) => link.hasAttribute("aria-current"))).toBe(false);
    expect(pathsBeforeFeed(stub.paths).filter((path) => path === "/projects/SAGA/chats/9/item")).toHaveLength(1);
  });

  it("shows the tag alone while the item is read", async () => {
    const stub = projectDaemon({
      "/projects/SAGA/chats/9/item": heldBack().reply,
      [projectChatPath(9)]: heldBack().reply,
    });
    await renderDashboard(stub, "/?tag=SAGA&chat=9");

    expect(projectHeading("SAGA").textContent).toBe("SAGA");
    expect(projectHeading("SAGA").nextElementSibling).toBeNull();
  });

  it.each(["chat-not-found", "project-not-found"] as const)(
    "shows the tag alone and This chat does not exist. after %s",
    async (code) => {
      const stub = projectDaemon({
        "/projects/SAGA/chats/9/item": missing(code),
        [projectChatPath(9)]: missing(code),
      });
      await renderDashboard(stub, "/?tag=SAGA&chat=9");

      await waitFor(() => {
        expect(within(screen.getByRole("region", { name: "SAGA" })).getByRole("status").textContent).toBe("This chat does not exist.");
      });
      expect(projectHeading("SAGA").textContent).toBe("SAGA");
      expect(projectHeading("SAGA").nextElementSibling).toBeNull();
      expectNoTaskControls();
    },
  );

  it.each([
    "/?tag=saga&chat=2",
    "/?tag=SAGA",
    "/?tag=SAGA-3&chat=2",
    "/?tag=SAGA&task=SAGA-3&chat=2",
    "/?tag=saga&task=SAGA-3&chat=2",
    "/?tag=SAGA&chat=0",
  ])("opens no chat for %s", async (path) => {
    const router = await renderDashboard(projectDaemon(), path);

    expect(router.state.location.search).toEqual({ task: undefined, tag: undefined, chat: undefined });
    expect(screen.getByText("Select a chat in the list.")).toBeTruthy();
  });
});

describe("the focus", () => {
  it("moves to the heading on a click on a row in a narrow window, and Chats closes the chat and returns to the row", async () => {
    stubWindowWidth("narrow");
    const user = userEvent.setup();
    const router = await renderDashboard(projectDaemon());

    await user.click(itemLink("SAGA", 2));

    await waitFor(() => {
      expect(screen.queryByRole("list", { name: "Chats" })).toBeNull();
    });
    expect(document.activeElement).toBe(projectHeading());

    await user.click(within(screen.getByRole("main")).getByRole("link", { name: "Chats" }));

    await waitFor(() => {
      expect(document.activeElement).toBe(itemLink("SAGA", 2));
    });
    expect(router.state.location.search).toEqual({ task: undefined, tag: undefined, chat: undefined });
  });

  async function moveToProjectChat(router: Awaited<ReturnType<typeof renderDashboard>>): Promise<void> {
    await act(async () => {
      await router.navigate({ to: "/", search: (previous) => ({ ...previous, task: undefined, tag: "SAGA", chat: "2" }), replace: true });
    });
  }

  it("moves to the heading when the address changes to a chat of a project while Open task holds it", async () => {
    const router = await renderDashboard(projectDaemon(), TASK_OPEN_PATH);
    screen.getByRole("link", { name: "Open task" }).focus();

    await moveToProjectChat(router);

    await waitFor(() => {
      expect(document.activeElement).toBe(projectHeading());
    });
  });

  it("moves to the heading when the address changes to a chat of a project while the Chat menu holds it", async () => {
    const onResearch = listItem("SAGA-3", 2, 5, { title: "Build the parser", step: "research", status: { state: "needs-you" } });
    const router = await renderDashboard(projectDaemon({
      "/chats": pageReply([PROJECT_OPEN, onResearch]),
      [TASK_PATH]: task({ fields: { workflow: "dev", step: "research" } }),
      [CHATS_PATH]: successReply([chatRecord({ step: "research", created: minutesAgo(5), seq: 3 })]),
    }), TASK_OPEN_PATH);
    (await screen.findByRole("button", { name: /^Chat menu/ })).focus();

    await moveToProjectChat(router);

    await waitFor(() => {
      expect(document.activeElement).toBe(projectHeading());
    });
  });
});
