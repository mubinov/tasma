import type { ChatListItem, FeedEvent } from "@tasma/protocol";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatPath } from "../chat-daemon";
import {
  chatHeading,
  chatList,
  ITEMS,
  itemLink,
  itemLinks,
  listItem,
  minutesAgo,
  NOW,
  OPEN,
  pageReply,
  renderDashboard,
  stubDashboard,
  stubLayout,
} from "../dashboard-fixtures";
import { heldBack, refusalReply, stubThreadDom, successReply } from "../helpers";
import { stubWindowWidth } from "../setup/match-media";
import { spoken } from "../update-fixtures";

const OPEN_PATH = "/?task=SAGA-3&chat=2";

const LIST_EVENT: FeedEvent = { kind: "chat", tag: "ACME", task: "ACME-7", chat: 1, step: "dev:test", state: "needs-you" };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("TZ", "UTC");
  stubThreadDom();
  stubLayout();
  document.title = "tasma";
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function missing(code: "chat-not-found" | "task-not-found" | "project-not-found") {
  return refusalReply(404, { kind: "store", code, message: "gone" });
}

function itemState(task: string, chat: number): string | null {
  const line = itemLink(task, chat).lastElementChild!;
  return line.children.length > 1 ? line.lastElementChild!.textContent : null;
}

/** The status line of the open chat, under the header. */
function chatStatusLine(): HTMLElement {
  return screen.getByRole("region", { name: /^SAGA-|^ACME-/ }).querySelector<HTMLElement>(':scope > [role="status"]')!;
}

/** Gives the scroll region of the list a scroll offset, which jsdom keeps at 0. */
function scrollableList() {
  const region = chatList().parentElement!;
  let top = 0;
  Object.defineProperty(region, "scrollTop", { configurable: true, get: () => top, set: (value: number) => (top = value) });
  return {
    scrollTo(y: number) {
      act(() => {
        top = y;
        region.dispatchEvent(new Event("scroll"));
      });
    },
  };
}

describe("the screen", () => {
  it("opens with a hidden h1 and names the document Dashboard", async () => {
    await renderDashboard(stubDashboard());

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("Dashboard");
    expect(heading.classList.contains("sr-only")).toBe(true);
    expect(document.title).toBe("Dashboard · tasma");
    expect(screen.getByRole("heading", { level: 2, name: "Chats" }).classList.contains("sr-only")).toBe(true);
  });

  it("shows the route failure when the first page cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stub = stubDashboard({ "/chats": refusalReply(500, { kind: "store", code: "chat-unreadable", message: "broken" }) });
    await renderDashboard(stub);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Chats" })).toBeNull();
  });
});

describe("the items", () => {
  it("lists the chats newest first, with the id, the time, the title, the step, and the state only where there is one", async () => {
    await renderDashboard(stubDashboard());

    expect(itemLinks().map((link) => link.getAttribute("data-chat-key"))).toEqual(["ACME-7/1", "SAGA-3/2", "SAGA-3/1"]);
    const first = itemLinks()[0]!;
    expect(within(first).getByText("ACME-7").className).toContain("font-mono");
    expect(within(first).getByText("ACME-7").className).toContain("wrap-anywhere");
    expect(first.querySelector("time")?.textContent).toBe("2m");
    expect(first.querySelector("time")?.getAttribute("datetime")).toBe(minutesAgo(2));
    expect(within(first).getByText("Ship the release")).toBeTruthy();
    expect(within(first).getByText("dev:test")).toBeTruthy();
    expect(itemState("ACME-7", 1)).toBe("Agent works");
    expect(itemState("SAGA-3", 2)).toBe("Needs you");
    expect(itemLink("SAGA-3", 1).querySelector("time")?.textContent).toBe("1h");
    expect(itemState("SAGA-3", 1)).toBeNull();
  });

  it("names each item by the id, the title, the step, the state when there is one, and the full time", async () => {
    await renderDashboard(stubDashboard());

    expect(itemLink("ACME-7", 1).getAttribute("aria-label")).toBe("ACME-7 Ship the release, dev:test, Agent works, 22 October 2026 11:58");
    expect(itemLink("SAGA-3", 1).getAttribute("aria-label")).toBe("SAGA-3 Build the parser, dev:research, 22 October 2026 10:30");
  });

  it("states the total of all pages as the size of the list", async () => {
    const stub = stubDashboard({ "/chats": pageReply(ITEMS, "c1", 120), "/chats?after=c1": heldBack().reply });
    await renderDashboard(stub);

    expect(within(chatList()).getAllByRole("listitem")[0]?.getAttribute("aria-setsize")).toBe("120");
  });

  it("marks the item of the open chat as the current page, and no other item", async () => {
    await renderDashboard(stubDashboard(), OPEN_PATH);

    expect(itemLink("SAGA-3", 2).getAttribute("aria-current")).toBe("page");
    expect(itemLinks().filter((link) => link.hasAttribute("aria-current"))).toHaveLength(1);
    expect(itemLink("SAGA-3", 2).className).toContain("before:bg-text");
  });

  it("makes the item of the open chat the tab stop of the list, and the first item with no open chat", async () => {
    await renderDashboard(stubDashboard(), OPEN_PATH);
    expect(itemLinks().map((link) => link.tabIndex)).toEqual([-1, 0, -1]);
    cleanup();

    await renderDashboard(stubDashboard());
    expect(itemLinks().map((link) => link.tabIndex)).toEqual([0, -1, -1]);
  });

  it("counts the time of the items again each minute", async () => {
    const setInterval = vi.spyOn(globalThis, "setInterval");
    await renderDashboard(stubDashboard());
    const tick = setInterval.mock.calls.find(([, delay]) => delay === 60_000)![0];

    vi.setSystemTime(NOW + 60 * 60_000);
    act(() => {
      tick();
    });

    expect(itemLink("ACME-7", 1).querySelector("time")?.textContent).toBe("1h");
  });
});

describe("the address", () => {
  it("opens a chat on a click, in place of the address entry, and keeps the focus on the item", async () => {
    const user = userEvent.setup();
    const router = await renderDashboard(stubDashboard());
    const entries = router.history.length;

    await user.click(itemLink("SAGA-3", 2));

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ task: "SAGA-3", chat: "2" });
    });
    expect(router.history.length).toBe(entries);
    expect(chatHeading().textContent).toBe("SAGA-3 Build the parser");
    expect(document.activeElement).toBe(itemLink("SAGA-3", 2));
    expect(itemLinks().map((link) => link.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("opens a chat with Enter on the focused item", async () => {
    const user = userEvent.setup();
    const router = await renderDashboard(stubDashboard());
    itemLink("ACME-7", 1).focus();

    await user.keyboard("{ArrowDown}");
    expect(router.state.location.search).toEqual({ task: undefined, chat: undefined });
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ task: "SAGA-3", chat: "2" });
    });
  });

  it("shows the chat of the address when the screen opens", async () => {
    await renderDashboard(stubDashboard(), OPEN_PATH);

    expect(chatHeading().textContent).toBe("SAGA-3 Build the parser");
    expect(screen.queryByText("Select a chat in the list.")).toBeNull();
  });

  it("shows the same chat after Open task and Back", async () => {
    const user = userEvent.setup();
    const router = await renderDashboard(stubDashboard(), OPEN_PATH);

    await user.click(screen.getByRole("link", { name: "Open task" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Build the parser" })).toBeTruthy();
    expect(router.state.location.search).toEqual({ chat: undefined });

    await act(async () => {
      router.history.back();
    });

    await waitFor(() => {
      expect(chatHeading().textContent).toBe("SAGA-3 Build the parser");
    });
    expect(router.state.location.search).toEqual({ task: "SAGA-3", chat: "2" });
  });

  it.each([
    "/?task=SAGA-3",
    "/?chat=2",
    "/?task=saga-3&chat=2",
    "/?task=SAGA-3&chat=0",
    "/?task=SAGA-3&chat=two",
    "/?task=a/b-1&chat=1",
    "/?task=SAGA&chat=1",
  ])("opens no chat for %s", async (path) => {
    const router = await renderDashboard(stubDashboard(), path);

    expect(router.state.location.search).toEqual({ task: undefined, chat: undefined });
    expect(screen.getByText("Select a chat in the list.")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2, name: /^[A-Z0-9]+-\d+/ })).toBeNull();
  });
});

describe("the header", () => {
  it("shows the id and the title, the agent, the step, the number and the state of the item, and Open task", async () => {
    await renderDashboard(stubDashboard(), OPEN_PATH);

    const heading = chatHeading();
    expect(heading.tabIndex).toBe(-1);
    expect(heading.firstElementChild?.textContent).toBe("SAGA-3");
    expect(heading.firstElementChild?.className).toContain("wrap-anywhere");
    const line = heading.nextElementSibling!;
    expect(line.textContent).toBe("Claude · dev:review · Chat 2Needs you");
    expect(screen.getByRole("link", { name: "Open task" }).getAttribute("href")).toBe("/tasks/SAGA/SAGA-3");
    expect(screen.queryByRole("button", { name: "Close the chat" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Chats" })).toBeNull();
  });

  it("shows no state for an item that has none", async () => {
    await renderDashboard(stubDashboard(), "/?task=SAGA-3&chat=1");

    expect(chatHeading().nextElementSibling?.textContent).toBe("Claude · dev:research · Chat 1");
  });

  it("reads the item of an open chat that the loaded pages do not hold, and selects no item", async () => {
    const other = listItem("SAGA-9", 4, 3000, { title: "Plan the cache", step: "dev:plan", status: { state: "failed" } });
    const stub = stubDashboard({ "/chats/SAGA-9/4": successReply(other) });
    await renderDashboard(stub, "/?task=SAGA-9&chat=4");

    await waitFor(() => {
      expect(chatHeading().textContent).toBe("SAGA-9 Plan the cache");
    });
    expect(chatHeading().nextElementSibling?.textContent).toBe("Claude · dev:plan · Chat 4Failed");
    expect(itemLinks().some((link) => link.hasAttribute("aria-current"))).toBe(false);
    expect(stub.paths.filter((path) => path === "/chats/SAGA-9/4")).toHaveLength(1);
  });

  it("shows the id alone while the item is read the first time", async () => {
    const stub = stubDashboard({ "/chats/SAGA-9/4": heldBack().reply });
    await renderDashboard(stub, "/?task=SAGA-9&chat=4");

    expect(chatHeading().textContent).toBe("SAGA-9");
    expect(chatHeading().nextElementSibling).toBeNull();
    expect(screen.queryByRole("link", { name: "Open task" })).toBeNull();
  });

  it.each(["chat-not-found", "task-not-found", "project-not-found"] as const)(
    "shows the id alone and This chat does not exist. after %s",
    async (code) => {
      const stub = stubDashboard({
        "/chats/SAGA-9/4": missing(code),
        "/projects/SAGA/tasks/SAGA-9/chats/4": missing(code),
      });
      await renderDashboard(stub, "/?task=SAGA-9&chat=4");

      await waitFor(() => {
        expect(chatStatusLine().textContent).toBe("This chat does not exist.");
      });
      expect(chatHeading().textContent).toBe("SAGA-9");
      expect(chatHeading().nextElementSibling).toBeNull();
      expect(screen.queryByRole("link", { name: "Open task" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    },
  );

  it("shows the id alone when the item cannot be read, and the transcript of a record that can", async () => {
    const stub = stubDashboard({
      "/chats": pageReply([]),
      "/chats/SAGA-3/2": refusalReply(500, { kind: "store", code: "chat-unreadable", message: "broken" }),
    });
    await renderDashboard(stub, OPEN_PATH);

    await waitFor(() => {
      expect(stub.paths).toContain("/chats/SAGA-3/2");
    });
    expect(chatHeading().textContent).toBe("SAGA-3");
    expect(chatHeading().nextElementSibling).toBeNull();
    await waitFor(() => {
      expect(chatStatusLine().textContent).toBe("");
    });
  });

  it("keeps the status line of the chat in the column of the header", async () => {
    await renderDashboard(stubDashboard(), OPEN_PATH);

    expect(chatStatusLine().className).toContain("max-w-[44rem]");
  });
});

describe("the empty texts", () => {
  it("says that there are no chats, and shows no text on the chat side", async () => {
    await renderDashboard(stubDashboard({ "/chats": pageReply([]) }));

    const empty = screen.getByText("No chats yet. A chat shows here when an agent starts a step of a task.");
    expect(empty.tabIndex).toBe(-1);
    expect(screen.queryByRole("list", { name: "Chats" })).toBeNull();
    expect(screen.queryByText("Select a chat in the list.")).toBeNull();
  });

  it("asks to select a chat while no chat is open", async () => {
    await renderDashboard(stubDashboard());

    expect(screen.getByText("Select a chat in the list.")).toBeTruthy();
  });
});

/** Twenty chats of one project, newest first, so the end of the first page is not in view. */
const LONG: readonly ChatListItem[] = Array.from({ length: 20 }, (_, index) => listItem(`BETA-${String(40 - index)}`, 1, 10 + index));

function olderStatus(): HTMLElement {
  return within(chatList().parentElement!).getAllByRole("status").at(-1)!;
}

describe("older chats", () => {
  it("loads the next page when the end of the list is in view, and says that it loads", async () => {
    const older = heldBack();
    const stub = stubDashboard({ "/chats": pageReply(ITEMS, "c1", 4), "/chats?after=c1": older.reply });
    await renderDashboard(stub);

    await waitFor(() => {
      expect(olderStatus().textContent).toBe("Loading older chats");
    });
    expect(olderStatus().closest("li")).toBeNull();

    older.answer(pageReply([listItem("SAGA-1", 1, 600)], undefined, 4));

    await waitFor(() => {
      expect(itemLinks()).toHaveLength(4);
    });
    expect(olderStatus().textContent).toBe("");
    expect(stub.paths.filter((path) => path.startsWith("/chats?after="))).toEqual(["/chats?after=c1"]);
  });

  it("loads the next page when the list scrolls near its end", async () => {
    const stub = stubDashboard({ "/chats": pageReply(LONG, "c1", 21), "/chats?after=c1": heldBack().reply });
    await renderDashboard(stub);
    const list = scrollableList();
    expect(stub.paths).not.toContain("/chats?after=c1");

    // 20 items of 79px end 1580px down; the part in view is 600px tall.
    list.scrollTo(1580 - 600 - 600);

    await waitFor(() => {
      expect(stub.paths).toContain("/chats?after=c1");
    });
  });

  it("loads the next page on Down on the last item, and keeps the focus on it", async () => {
    const user = userEvent.setup();
    const stub = stubDashboard({ "/chats": pageReply(LONG, "c1", 21), "/chats?after=c1": heldBack().reply });
    await renderDashboard(stub);
    itemLinks()[0]!.focus();

    await user.keyboard("{End}");
    expect(stub.paths).not.toContain("/chats?after=c1");
    await user.keyboard("{ArrowDown}");

    await waitFor(() => {
      expect(stub.paths).toContain("/chats?after=c1");
    });
    expect(document.activeElement).toBe(itemLink("BETA-21", 1));
  });

  it("says that older chats cannot be loaded, loads them again with Try again, and moves the focus to the last item", async () => {
    const user = userEvent.setup();
    const stub = stubDashboard({
      "/chats": pageReply(ITEMS, "c1", 4),
      "/chats?after=c1": refusalReply(500, { kind: "store", code: "chat-unreadable", message: "broken" }),
    });
    await renderDashboard(stub);
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(olderStatus().textContent).toBe("Older chats cannot be loaded.");
    expect(retry.parentElement).toBe(olderStatus().parentElement);
    expect(retry.classList).toContain("shrink-0");
    expect(stub.paths.filter((path) => path === "/chats?after=c1")).toHaveLength(1);

    const older = heldBack();
    stub.replies["/chats?after=c1"] = older.reply;
    await user.click(retry);

    expect(olderStatus().textContent).toBe("Loading older chats");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(document.activeElement).toBe(itemLink("SAGA-3", 1));

    older.answer(pageReply([listItem("SAGA-1", 1, 600)], undefined, 4));
    await waitFor(() => {
      expect(itemLinks()).toHaveLength(4);
    });
  });

  it("loads no older page in place of a live refresh that reads, so the refresh shows", async () => {
    const stub = stubDashboard({
      "/chats": pageReply(ITEMS, "c1", 4),
      "/chats?after=c1": refusalReply(500, { kind: "store", code: "chat-unreadable", message: "broken" }),
    });
    await renderDashboard(stub);
    await screen.findByRole("button", { name: "Try again" });
    const refresh = heldBack();
    stub.replies["/chats"] = refresh.reply;

    await stub.send([LIST_EVENT]);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    });
    expect(stub.paths.filter((path) => path === "/chats?after=c1")).toHaveLength(1);

    const [acme, ...rest] = ITEMS as [ChatListItem, ...ChatListItem[]];
    await act(async () => {
      refresh.answer(pageReply([{ ...acme, status: { state: "failed" } }, ...rest], "c1", 4));
    });

    await waitFor(() => {
      expect(itemState("ACME-7", 1)).toBe("Failed");
    });
  });

  it("asks again for the older page that a live refresh cancels, once the refresh ends with the same pages", async () => {
    const stub = stubDashboard({ "/chats": pageReply(ITEMS, "c1", 4), "/chats?after=c1": heldBack().reply });
    await renderDashboard(stub);
    await waitFor(() => {
      expect(olderStatus().textContent).toBe("Loading older chats");
    });
    const refresh = heldBack();
    const older = heldBack();
    stub.replies["/chats"] = refresh.reply;
    stub.replies["/chats?after=c1"] = older.reply;

    await stub.send([LIST_EVENT]);
    await waitFor(() => {
      expect(olderStatus().textContent).toBe("");
    });
    await act(async () => {
      refresh.answer(pageReply(ITEMS, "c1", 4));
    });

    await waitFor(() => {
      expect(stub.paths.filter((path) => path === "/chats?after=c1")).toHaveLength(2);
    });
    older.answer(pageReply([listItem("SAGA-1", 1, 600)], undefined, 4));
    await waitFor(() => {
      expect(itemLinks()).toHaveLength(4);
    });
  });

  it("moves the focus from Try again to the last item when a live refresh ends the failure", async () => {
    const stub = stubDashboard({
      "/chats": pageReply(ITEMS, "c1", 4),
      "/chats?after=c1": refusalReply(500, { kind: "store", code: "chat-unreadable", message: "broken" }),
    });
    await renderDashboard(stub);
    const retry = await screen.findByRole("button", { name: "Try again" });
    retry.focus();
    stub.replies["/chats"] = pageReply(ITEMS);

    await stub.send([LIST_EVENT]);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    });
    expect(document.activeElement).toBe(itemLink("SAGA-3", 1));
  });
});

describe("live updates", () => {
  it("shows a new chat at the top while the list is at its top", async () => {
    const stub = stubDashboard();
    await renderDashboard(stub);
    const newer = listItem("ACME-8", 1, 0, { title: "Fix the build", status: { state: "working" } });
    stub.replies["/chats"] = pageReply([newer, ...ITEMS]);

    await stub.send([{ kind: "chat", tag: "ACME", task: "ACME-8", chat: 1, step: "build", state: "working" }]);

    await waitFor(() => {
      expect(itemLinks()[0]?.getAttribute("data-chat-key")).toBe("ACME-8/1");
    });
    expect(itemState("ACME-8", 1)).toBe("Agent works");
  });

  it("follows a change of state, of a title and of the status of a task", async () => {
    const stub = stubDashboard();
    await renderDashboard(stub);
    const [acme, open, older] = ITEMS as [ChatListItem, ChatListItem, ChatListItem];
    stub.replies["/chats"] = pageReply([{ ...acme, status: { state: "failed" } }, { ...open, title: "Build the lexer", status: undefined }, older]);

    await stub.send([{ kind: "task", tag: "SAGA", id: "SAGA-3", change: "changed" }]);

    await waitFor(() => {
      expect(itemState("ACME-7", 1)).toBe("Failed");
    });
    expect(itemState("SAGA-3", 2)).toBeNull();
    expect(within(itemLink("SAGA-3", 2)).getByText("Build the lexer")).toBeTruthy();
  });

  it("drops the items of a removed project", async () => {
    const stub = stubDashboard();
    await renderDashboard(stub);
    stub.replies["/chats"] = pageReply(ITEMS.filter((item) => item.tag !== "ACME"));

    await stub.send([{ kind: "project", tag: "ACME", change: "deleted" }]);

    await waitFor(() => {
      expect(itemLinks()).toHaveLength(2);
    });
  });

  it("shows This chat does not exist. and the id alone when the task of the open chat is deleted", async () => {
    const stub = stubDashboard();
    await renderDashboard(stub, OPEN_PATH);
    expect(chatHeading().textContent).toBe("SAGA-3 Build the parser");
    stub.replies["/chats"] = pageReply(ITEMS.filter((item) => item.task !== "SAGA-3"));
    stub.replies["/chats/SAGA-3/2"] = missing("task-not-found");
    stub.replies[chatPath()] = missing("task-not-found");

    await stub.send([{ kind: "task", tag: "SAGA", id: "SAGA-3", change: "deleted" }]);

    await waitFor(() => {
      expect(chatStatusLine().textContent).toBe("This chat does not exist.");
    });
    await waitFor(() => {
      expect(chatHeading().textContent).toBe("SAGA-3");
    });
    expect(screen.queryByRole("link", { name: "Open task" })).toBeNull();
  });

  it("keeps the header of an open chat that new chats push out of the loaded pages, and then reads its item", async () => {
    const stub = stubDashboard();
    await renderDashboard(stub, OPEN_PATH);
    const item = heldBack();
    stub.replies["/chats"] = pageReply([listItem("ACME-9", 1, 0)], "c1", 4);
    stub.replies["/chats?after=c1"] = heldBack().reply;
    stub.replies["/chats/SAGA-3/2"] = item.reply;

    await stub.send([{ kind: "chat", tag: "ACME", task: "ACME-9", chat: 1, step: "build", state: "working" }]);

    await waitFor(() => {
      expect(stub.paths).toContain("/chats/SAGA-3/2");
    });
    expect(chatHeading().textContent).toBe("SAGA-3 Build the parser");
    expect(itemLinks().some((link) => link.hasAttribute("aria-current"))).toBe(false);

    item.answer(successReply({ ...OPEN, title: "Build the lexer" }));
    await waitFor(() => {
      expect(chatHeading().textContent).toBe("SAGA-3 Build the lexer");
    });
  });

  it("announces a chat other than the open one that now needs you or failed, and not the first result", async () => {
    const stub = stubDashboard();
    await renderDashboard(stub, OPEN_PATH);
    expect(spoken()).toEqual([]);
    const [acme, open, older] = ITEMS as [ChatListItem, ChatListItem, ChatListItem];
    stub.replies["/chats"] = pageReply([{ ...acme, status: { state: "needs-you" } }, { ...open, status: { state: "failed" } }, older]);

    await stub.send([LIST_EVENT]);

    await waitFor(() => {
      expect(spoken()).toContain("ACME-7 needs you");
    });
    expect(spoken()).not.toContain("SAGA-3 failed");
  });

  it("announces in the narrow window too, where the list is not shown", async () => {
    stubWindowWidth("narrow");
    const stub = stubDashboard();
    await renderDashboard(stub, OPEN_PATH);
    expect(screen.queryByRole("list", { name: "Chats" })).toBeNull();
    const [acme, ...rest] = ITEMS as [ChatListItem, ...ChatListItem[]];
    stub.replies["/chats"] = pageReply([{ ...acme, status: { state: "failed" } }, ...rest]);

    await stub.send([LIST_EVENT]);

    await waitFor(() => {
      expect(spoken()).toContain("ACME-7 failed");
    });
  });

  it("moves the focus from a removed item to the next item, and from the last item to the empty text", async () => {
    const stub = stubDashboard();
    await renderDashboard(stub);
    itemLink("ACME-7", 1).focus();
    stub.replies["/chats"] = pageReply([OPEN]);

    await stub.send([{ kind: "task", tag: "ACME", id: "ACME-7", change: "deleted" }]);

    await waitFor(() => {
      expect(document.activeElement).toBe(itemLink("SAGA-3", 2));
    });

    stub.replies["/chats"] = pageReply([]);
    await stub.send([{ kind: "task", tag: "SAGA", id: "SAGA-3", change: "deleted" }]);

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByText(/^No chats yet\./));
    });
  });

  it("moves the focus from the empty text to the first item when a chat comes, also while the window is in the background", async () => {
    const stub = stubDashboard();
    await renderDashboard(stub);
    itemLink("ACME-7", 1).focus();
    stub.replies["/chats"] = pageReply([]);
    await stub.send([{ kind: "project", tag: "ACME", change: "deleted" }]);
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByText(/^No chats yet\./));
    });
    fireEvent.blur(screen.getByText(/^No chats yet\./));
    stub.replies["/chats"] = pageReply([OPEN]);

    await stub.send([{ kind: "chat", tag: "SAGA", task: "SAGA-3", chat: 2, step: "dev:review", state: "needs-you" }]);

    await waitFor(() => {
      expect(document.activeElement).toBe(itemLink("SAGA-3", 2));
    });
  });

  it("moves the focus from Open task to the heading when the item of the open chat goes away", async () => {
    const stub = stubDashboard();
    await renderDashboard(stub, OPEN_PATH);
    screen.getByRole("link", { name: "Open task" }).focus();
    stub.replies["/chats"] = pageReply(ITEMS.filter((item) => item.task !== "SAGA-3"));
    stub.replies["/chats/SAGA-3/2"] = missing("task-not-found");

    await stub.send([{ kind: "task", tag: "SAGA", id: "SAGA-3", change: "deleted" }]);

    await waitFor(() => {
      expect(screen.queryByRole("link", { name: "Open task" })).toBeNull();
    });
    expect(document.activeElement).toBe(chatHeading());
  });
});

describe("the narrow window", () => {
  it("shows the list alone with no open chat", async () => {
    stubWindowWidth("narrow");
    await renderDashboard(stubDashboard());

    expect(chatList()).toBeTruthy();
    expect(chatList().closest(".w-full")).not.toBeNull();
    expect(screen.queryByText("Select a chat in the list.")).toBeNull();
  });

  it("shows the chat alone with Chats on a click of an item, and moves the focus to the heading", async () => {
    stubWindowWidth("narrow");
    const user = userEvent.setup();
    await renderDashboard(stubDashboard());

    await user.click(itemLink("SAGA-3", 2));

    await waitFor(() => {
      expect(screen.queryByRole("list", { name: "Chats" })).toBeNull();
    });
    expect(document.activeElement).toBe(chatHeading());
    expect(screen.getByRole("link", { name: "Chats" })).toBeTruthy();
  });

  it("shows the list again from Chats, in place of the address entry, with the focus on the item of the chat", async () => {
    stubWindowWidth("narrow");
    const user = userEvent.setup();
    const router = await renderDashboard(stubDashboard(), OPEN_PATH);
    const entries = router.history.length;

    await user.click(screen.getByRole("link", { name: "Chats" }));

    await waitFor(() => {
      expect(document.activeElement).toBe(itemLink("SAGA-3", 2));
    });
    expect(router.state.location.search).toEqual({ task: undefined, chat: undefined });
    expect(router.history.length).toBe(entries);
  });

  it("moves the focus from Chats to the first item when the list does not hold the chat", async () => {
    stubWindowWidth("narrow");
    const user = userEvent.setup();
    const stub = stubDashboard({ "/chats/SAGA-9/4": successReply(listItem("SAGA-9", 4, 3000)) });
    await renderDashboard(stub, "/?task=SAGA-9&chat=4");

    await user.click(screen.getByRole("link", { name: "Chats" }));

    await waitFor(() => {
      expect(document.activeElement).toBe(itemLink("ACME-7", 1));
    });
  });

  it("moves the focus from Chats to the empty text when the list has no items", async () => {
    stubWindowWidth("narrow");
    const user = userEvent.setup();
    const stub = stubDashboard({ "/chats": pageReply([]), "/chats/SAGA-3/2": successReply(OPEN) });
    await renderDashboard(stub, OPEN_PATH);

    await user.click(screen.getByRole("link", { name: "Chats" }));

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByText(/^No chats yet\./));
    });
  });

  it("takes no focus when chats come to the empty list that Chats focused, and keeps the closed chat as the tab stop", async () => {
    stubWindowWidth("narrow");
    const user = userEvent.setup();
    const stub = stubDashboard({ "/chats": pageReply([]), "/chats/SAGA-3/2": successReply(OPEN) });
    await renderDashboard(stub, OPEN_PATH);
    await user.click(screen.getByRole("link", { name: "Chats" }));
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByText(/^No chats yet\./));
    });
    const elsewhere = screen.getByRole("link", { name: "Dashboard" });
    elsewhere.focus();
    stub.replies["/chats"] = pageReply(ITEMS);

    await stub.send([LIST_EVENT]);

    await waitFor(() => {
      expect(itemLinks()).toHaveLength(3);
    });
    expect(document.activeElement).toBe(elsewhere);
    expect(itemLinks().map((link) => link.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("moves the focus from the empty text that Chats focused to the item of the closed chat when chats come", async () => {
    stubWindowWidth("narrow");
    const user = userEvent.setup();
    const stub = stubDashboard({ "/chats": pageReply([]), "/chats/SAGA-3/2": successReply(OPEN) });
    await renderDashboard(stub, OPEN_PATH);
    await user.click(screen.getByRole("link", { name: "Chats" }));
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByText(/^No chats yet\./));
    });
    stub.replies["/chats"] = pageReply(ITEMS);

    await stub.send([LIST_EVENT]);

    await waitFor(() => {
      expect(document.activeElement).toBe(itemLink("SAGA-3", 2));
    });
  });

  it("takes no focus after a resize when a modified click on Chats closes nothing", async () => {
    const width = stubWindowWidth("narrow");
    const user = userEvent.setup();
    const router = await renderDashboard(stubDashboard(), OPEN_PATH);

    await user.keyboard("{Meta>}");
    await user.click(screen.getByRole("link", { name: "Chats" }));
    await user.keyboard("{/Meta}");
    expect(router.state.location.search).toEqual({ task: "SAGA-3", chat: "2" });
    (document.activeElement as HTMLElement).blur();

    width.set("wide");

    expect(chatList()).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
  });

  it("does not mark Chats as the current page", async () => {
    stubWindowWidth("narrow");
    await renderDashboard(stubDashboard(), OPEN_PATH);

    expect(screen.getByRole("link", { name: "Chats" }).hasAttribute("aria-current")).toBe(false);
  });

  it("takes no focus in a later mount of the list that a resize causes", async () => {
    const width = stubWindowWidth("narrow");
    const user = userEvent.setup();
    await renderDashboard(stubDashboard(), OPEN_PATH);
    await user.click(screen.getByRole("link", { name: "Chats" }));
    await waitFor(() => {
      expect(document.activeElement).toBe(itemLink("SAGA-3", 2));
    });

    await user.click(itemLink("ACME-7", 1));
    await waitFor(() => {
      expect(document.activeElement).toBe(chatHeading());
    });
    (document.activeElement as HTMLElement).blur();
    width.set("wide");

    expect(chatList()).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
  });

  it("moves the focus from Chats to the heading when the window becomes wide", async () => {
    const width = stubWindowWidth("narrow");
    await renderDashboard(stubDashboard(), OPEN_PATH);
    screen.getByRole("link", { name: "Chats" }).focus();

    width.set("wide");

    expect(screen.queryByRole("link", { name: "Chats" })).toBeNull();
    expect(document.activeElement).toBe(chatHeading());
  });

  it("moves the focus from the list to the heading when the window becomes narrow with a chat open", async () => {
    const width = stubWindowWidth("wide");
    await renderDashboard(stubDashboard(), OPEN_PATH);
    itemLink("ACME-7", 1).focus();

    width.set("narrow");

    expect(screen.queryByRole("list", { name: "Chats" })).toBeNull();
    expect(document.activeElement).toBe(chatHeading());
  });

  it("leaves the focus where it is when the window becomes narrow with no chat open", async () => {
    const width = stubWindowWidth("wide");
    await renderDashboard(stubDashboard());
    itemLink("ACME-7", 1).focus();

    width.set("narrow");

    expect(document.activeElement).toBe(itemLink("ACME-7", 1));
  });
});
