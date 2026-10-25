import type { Chat, TransportReply } from "@tasma/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatStartKey } from "../../src/api/mutations";
import { FeedSubscriber } from "../../src/components/feed-subscriber";
import { useNoticeStore } from "../../src/store/notices";
import { useUiStore } from "../../src/store/ui";
import { daemon as boardDaemon, entry, listing } from "../board-fixtures";
import { chatRecord } from "../chat-daemon";
import { heldBack, refusalReply, renderWithRouter, stubThreadDom, successReply } from "../helpers";
import { CHATS_PATH, stubTaskChats, type TaskChatsStub } from "../task-chats-daemon";
import { LISTING_PATH, TASK_PATH, task } from "../task-screen-fixtures";
import { frame } from "../setup/notice-store";

const BOARD = "/tasks?projects=SAGA";

const TASK_PAGE = "/tasks/SAGA/SAGA-3";

type Router = Awaited<ReturnType<typeof renderWithRouter>>;

type User = ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({
    lastTasksProject: null,
    boardReturn: null,
    boardRestorePending: false,
    revealedColumns: new Set(),
  });
  useNoticeStore.setState({ notices: [], dismissed: new Map() });
  stubThreadDom();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function chat(number: number): Chat {
  return chatRecord({ chat: number, step: "research", seq: 3, state: "working" });
}

/** The board of SAGA with SAGA-3 on the step `research`, and the task view of SAGA-3, with these chats. */
function stub(chats: Chat[]): TaskChatsStub {
  return stubTaskChats(chats, {
    ...boardDaemon().replies,
    [LISTING_PATH]: listing([entry(3, { status: "In Progress", workflow: "dev", step: "research" })]),
    [TASK_PATH]: task({ fields: { workflow: "dev", step: "research" } }),
  });
}

async function openBoard(daemon: TaskChatsStub): Promise<Router> {
  const router = await renderWithRouter(BOARD, daemon.transport);
  const { queryClient, client } = router.options.context;
  render(<FeedSubscriber queryClient={queryClient} client={client} />);
  await screen.findByRole("button", { name: "Task menu SAGA-3" });
  await waitFor(() => {
    expect(daemon.paths).toContain("/events?after=c0");
  });
  return router;
}

function menuButton(): HTMLElement {
  return screen.getByRole("button", { name: "Task menu SAGA-3" });
}

async function openMenu(user: User): Promise<HTMLElement> {
  await user.click(menuButton());
  return screen.findByRole("menu");
}

/** Opens the menu with Enter on its button, as a keyboard reader does. */
async function openMenuByKey(user: User): Promise<HTMLElement> {
  menuButton().focus();
  await user.keyboard("{Enter}");
  return screen.findByRole("menu");
}

function stepItem(menu: HTMLElement): HTMLElement {
  return menu.firstElementChild as HTMLElement;
}

async function readyItem(menu: HTMLElement): Promise<HTMLElement> {
  await waitFor(() => {
    expect(stepItem(menu).getAttribute("aria-disabled")).not.toBe("true");
  });
  return stepItem(menu);
}

function openTask(menu: HTMLElement): HTMLElement {
  return within(menu).getByRole("menuitem", { name: "Open task" });
}

function highlighted(item: HTMLElement): boolean {
  return item.hasAttribute("data-highlighted");
}

async function closeMenu(user: User): Promise<void> {
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
}

describe("the item", () => {
  it("is the first item, with a separator under it, before Open task, and names the task", async () => {
    const user = userEvent.setup();
    await openBoard(stub([]));

    const menu = await openMenu(user);
    const item = await readyItem(menu);

    expect(item.getAttribute("role")).toBe("menuitem");
    expect(item.textContent).toBe("Start research");
    expect(item.getAttribute("aria-label")).toBe("Start research, SAGA-3");
    expect(item.nextElementSibling?.getAttribute("role")).toBe("separator");
    expect(item.nextElementSibling?.nextElementSibling).toBe(openTask(menu));
  });

  it("is the first item of the right-click menu too", async () => {
    await openBoard(stub([]));

    fireEvent.contextMenu(screen.getByText("Task 3"));
    const menu = await screen.findByRole("menu");

    expect((await readyItem(menu)).getAttribute("aria-label")).toBe("Start research, SAGA-3");
  });

  it.each([
    ["a step that the workflow does not have", { workflow: "dev", step: "deploy" }],
    ["a workflow that the daemon refuses", { workflow: "gone", step: "research" }],
  ])("is not there for a task with %s, nor its separator", async (_case, fields) => {
    const user = userEvent.setup();
    const daemon = stub([]);
    daemon.replies[LISTING_PATH] = listing([entry(3, { status: "In Progress", ...fields })]);
    await openBoard(daemon);

    const menu = await openMenu(user);
    await frame();

    expect(menu.firstElementChild).toBe(openTask(menu));
    expect(within(menu).getAllByRole("separator")).toHaveLength(2);
  });

  it("reads while the read of a new workflow is pending, and leaves with its separator when that workflow has no such step", async () => {
    const user = userEvent.setup();
    const daemon = stub([]);
    await openBoard(daemon);
    const { reply, answer } = heldBack();
    daemon.replies["/workflows/flow"] = reply;
    daemon.replies[LISTING_PATH] = listing([entry(3, { status: "In Progress", workflow: "flow", step: "research" })]);
    await daemon.send([{ kind: "task", tag: "SAGA", id: "SAGA-3", change: "changed" }]);
    await waitFor(() => {
      expect(daemon.paths).toContain("/workflows/flow");
    });

    const menu = await openMenu(user);
    await frame();

    expect(stepItem(menu).textContent).toBe("Reading the chats");

    await act(async () => {
      answer(successReply({ name: "flow", file: "/w/flow/workflow.yml", instructions: [], steps: [] }));
    });

    await waitFor(() => {
      expect(menu.firstElementChild).toBe(openTask(menu));
    });
    expect(within(menu).getAllByRole("separator")).toHaveLength(2);
  });

  it("keeps its text when an event of a chat of the task comes while the menu is open", async () => {
    const user = userEvent.setup();
    const daemon = stub([]);
    await openBoard(daemon);
    const menu = await openMenu(user);
    const item = await readyItem(menu);

    await daemon.change([chat(1)]);
    await frame();

    expect(item.textContent).toBe("Start research");
    expect(item.getAttribute("aria-label")).toBe("Start research, SAGA-3");
  });
});

describe("a press", () => {
  it("starts the chat on the task view and opens it by a replace, so Back returns to the board", async () => {
    const user = userEvent.setup();
    const daemon = stub([]);
    const router = await openBoard(daemon);
    daemon.records([chat(1)]);
    daemon.replies[`POST ${CHATS_PATH}`] = successReply({ chat: chat(1), started: true });
    daemon.replies[CHATS_PATH] = successReply([]);
    const menu = await openMenu(user);
    const item = await readyItem(menu);
    daemon.replies[CHATS_PATH] = successReply([chat(1)]);

    await user.click(item);

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ chat: "1" });
    });
    expect(router.state.location.pathname).toBe(TASK_PAGE);
    expect(daemon.starts()).toBe(1);
    const heading = await screen.findByRole("heading", { level: 2, name: "Claude · research" });
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });

    await act(async () => {
      router.history.back();
    });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/tasks");
    });
  });

  it("leaves the cache after its gcTime, also when the menu unmounted before the start", async () => {
    const user = userEvent.setup();
    const daemon = stub([]);
    const router = await openBoard(daemon);
    const { queryClient } = router.options.context;
    queryClient.setMutationDefaults(chatStartKey(), { gcTime: 0 });
    daemon.records([chat(1)]);
    daemon.replies[`POST ${CHATS_PATH}`] = successReply({ chat: chat(1), started: true });
    const item = await readyItem(await openMenu(user));
    daemon.replies[CHATS_PATH] = successReply([chat(1)]);

    await user.click(item);
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ chat: "1" });
    });

    await waitFor(() => {
      expect(queryClient.getMutationCache().findAll({ mutationKey: chatStartKey() })).toEqual([]);
    });
  });

  it("opens no chat after Back while the task view still loads", async () => {
    const user = userEvent.setup();
    const daemon = stub([chat(2)]);
    const router = await openBoard(daemon);
    const item = await readyItem(await openMenu(user));
    const { reply, answer } = heldBack();
    daemon.replies[TASK_PATH] = reply;

    await user.click(item);
    await waitFor(() => {
      expect(daemon.paths).toContain(TASK_PATH);
    });
    await act(async () => {
      router.history.back();
    });
    await act(async () => {
      answer(task({ fields: { workflow: "dev", step: "research" } }));
    });
    await frame();

    expect(router.state.location.pathname).toBe("/tasks");
    expect(router.state.location.search).toEqual({ projects: "SAGA" });
  });

  it("opens the chat of the step on the task view by a replace, sends no start, and Back returns to the board", async () => {
    const user = userEvent.setup();
    const daemon = stub([chat(2)]);
    const router = await openBoard(daemon);
    const menu = await openMenu(user);
    const item = await readyItem(menu);

    expect(item.textContent).toBe("Open research");

    await user.click(item);

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ chat: "2" });
    });
    expect(router.state.location.pathname).toBe(TASK_PAGE);
    expect(daemon.starts()).toBe(0);
    const heading = await screen.findByRole("heading", { level: 2, name: "Claude · research" });
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });

    await act(async () => {
      router.history.back();
    });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/tasks");
    });
  });

  it("allows no second start after Back to the board during the wait", async () => {
    const user = userEvent.setup();
    const daemon = stub([]);
    const router = await openBoard(daemon);
    const { reply } = heldBack();
    daemon.replies[`POST ${CHATS_PATH}`] = reply;
    await user.click(await readyItem(await openMenu(user)));
    await waitFor(() => {
      expect(daemon.starts()).toBe(1);
    });

    await act(async () => {
      router.history.back();
    });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/tasks");
    });
    const menu = await openMenu(user);
    await frame();

    const item = stepItem(menu);
    expect(item.textContent).toBe("Start research");
    expect(item.getAttribute("aria-label")).toBe("Start research, SAGA-3, starting");
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.querySelector("svg")!.getAttribute("class")).toContain("animate-spin");

    await user.click(item);

    expect(daemon.starts()).toBe(1);
  });
});

describe("the read at each open", () => {
  function holdChats(daemon: TaskChatsStub): (reply: TransportReply) => void {
    const { reply, answer } = heldBack();
    daemon.replies[CHATS_PATH] = reply;
    return answer;
  }

  it("shows a disabled reading item until it lands, and a keyboard open highlights Open task at each open", async () => {
    const user = userEvent.setup();
    const daemon = stub([]);
    await openBoard(daemon);
    const answer = holdChats(daemon);

    const menu = await openMenuByKey(user);

    const item = stepItem(menu);
    expect(item.textContent).toBe("Reading the chats");
    expect(item.getAttribute("aria-label")).toBe("Reading the chats of SAGA-3");
    expect(item.getAttribute("aria-disabled")).toBe("true");
    await waitFor(() => {
      expect(highlighted(openTask(menu))).toBe(true);
    });

    await act(async () => {
      answer(successReply([]));
    });
    await readyItem(menu);
    await closeMenu(user);

    const again = await openMenuByKey(user);

    await waitFor(() => {
      expect(highlighted(openTask(again))).toBe(true);
    });
    expect(daemon.readsOf(CHATS_PATH)).toBe(2);
  });

  it("never shows the kind of an older list in the cache", async () => {
    const user = userEvent.setup();
    const daemon = stub([chat(2)]);
    await openBoard(daemon);
    expect((await readyItem(await openMenu(user))).textContent).toBe("Open research");
    await closeMenu(user);
    const answer = holdChats(daemon);

    const menu = await openMenu(user);

    expect(stepItem(menu).textContent).toBe("Reading the chats");

    await act(async () => {
      answer(successReply([]));
    });

    expect((await readyItem(menu)).textContent).toBe("Start research");
  });

  it("says the name of the highlighted reading item when its read lands", async () => {
    const user = userEvent.setup();
    const daemon = stub([]);
    await openBoard(daemon);
    const answer = holdChats(daemon);
    const menu = await openMenuByKey(user);
    await waitFor(() => {
      expect(highlighted(openTask(menu))).toBe(true);
    });

    await user.keyboard("{ArrowUp}");
    expect(highlighted(stepItem(menu))).toBe(true);
    await act(async () => {
      answer(successReply([]));
    });
    await readyItem(menu);
    await frame();

    expect(useNoticeStore.getState().announced.map(({ words }) => words)).toEqual(["Start research, SAGA-3"]);
  });

  it("gives Start when the read fails", async () => {
    const user = userEvent.setup();
    const daemon = stub([chat(2)]);
    await openBoard(daemon);
    daemon.replies[CHATS_PATH] = refusalReply(409, { kind: "store", code: "project-invalid", message: "The chats folder is a file." });

    const menu = await openMenu(user);

    expect((await readyItem(menu)).textContent).toBe("Start research");
  });
});
