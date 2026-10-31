import type { Chat, TransportReply } from "@tasma/protocol";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatStartKey } from "../../src/api/mutations";
import { taskQuery } from "../../src/api/queries";
import { useNoticeStore } from "../../src/store/notices";
import { useUiStore } from "../../src/store/ui";
import { daemon as boardDaemon, entry, listing } from "../board-fixtures";
import { chatRecord } from "../chat-daemon";
import { heldBack, refusalReply, renderWithRouter, stubScrollIntoView, stubThreadDom, successReply } from "../helpers";
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
  await screen.findByRole("button", { name: "Task menu SAGA-3" });
  await daemon.mount(router);
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
    expect(item.nextElementSibling?.hasAttribute("hidden")).toBe(true);
    expect(item.nextElementSibling?.nextElementSibling?.getAttribute("role")).toBe("separator");
    expect(item.nextElementSibling?.nextElementSibling?.nextElementSibling).toBe(openTask(menu));
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

describe("Restart", () => {
  function restartItem(menu: HTMLElement): HTMLElement | null {
    return within(menu).queryByRole("menuitem", { name: "Restart research, SAGA-3" });
  }

  function spoken(): string[] {
    return useNoticeStore.getState().announced.map(({ words }) => words);
  }

  async function chooseRestart(user: User): Promise<HTMLElement> {
    const menu = await openMenu(user);
    await readyItem(menu);
    await user.click(restartItem(menu)!);
    return screen.findByRole("alertdialog");
  }

  it("follows Open, before the separator, in both menus", async () => {
    const user = userEvent.setup();
    await openBoard(stub([chat(2)]));

    const menu = await openMenu(user);
    const item = await readyItem(menu);

    expect(item.nextElementSibling).toBe(restartItem(menu));
    expect(restartItem(menu)!.textContent).toBe("Restart research");
    expect(restartItem(menu)!.nextElementSibling?.getAttribute("role")).toBe("separator");
    await closeMenu(user);

    fireEvent.contextMenu(screen.getByText("Task 3"));
    const contextMenu = await screen.findByRole("menu");
    await readyItem(contextMenu);

    expect(restartItem(contextMenu)).not.toBeNull();
  });

  it("is not there beside Start, nor while the chats are read", async () => {
    const user = userEvent.setup();
    const daemon = stub([]);
    await openBoard(daemon);

    const menu = await openMenu(user);
    await readyItem(menu);

    expect(restartItem(menu)).toBeNull();
    await closeMenu(user);
    daemon.replies[CHATS_PATH] = heldBack().reply;

    const reading = await openMenu(user);

    expect(stepItem(reading).textContent).toBe("Reading the chats");
    expect(restartItem(reading)).toBeNull();
  });

  /** The highlighted item is the focused one, and ArrowUp from Open task reaches Restart. */
  async function expectHighlightOnFocus(user: User, menu: HTMLElement): Promise<void> {
    await readyItem(menu);
    await frame();

    expect(restartItem(menu)).not.toBeNull();
    expect(document.activeElement).toBe(openTask(menu));
    expect(menu.querySelector("[data-highlighted]")).toBe(openTask(menu));

    await user.keyboard("{ArrowUp}");

    expect(document.activeElement).toBe(restartItem(menu));
    expect(highlighted(restartItem(menu)!)).toBe(true);
  }

  it("keeps the highlight on the focused item when it shows after the read of a menu opened by the keyboard", async () => {
    const user = userEvent.setup();
    const daemon = stub([chat(2)]);
    await openBoard(daemon);
    const { reply, answer } = heldBack();
    daemon.replies[CHATS_PATH] = reply;
    const menu = await openMenuByKey(user);
    await waitFor(() => {
      expect(highlighted(openTask(menu))).toBe(true);
    });

    await act(async () => {
      answer(successReply([chat(2)]));
    });

    await expectHighlightOnFocus(user, menu);
  });

  it("keeps the highlight on the focused item when it shows at the end of a restart while the menu is open", async () => {
    const user = userEvent.setup();
    const daemon = stub([chat(2)]);
    const router = await openBoard(daemon);
    const { reply, answer } = heldBack();
    daemon.replies[`POST ${CHATS_PATH}`] = reply;
    const dialog = await chooseRestart(user);
    await user.click(within(dialog).getByRole("button", { name: "Stop and restart" }));
    await waitFor(() => {
      expect(daemon.restarts()).toBe(1);
    });
    await act(async () => {
      router.history.back();
    });
    await screen.findByRole("button", { name: "Task menu SAGA-3" });
    const menu = await openMenuByKey(user);
    await waitFor(() => {
      expect(highlighted(openTask(menu))).toBe(true);
    });
    expect(stepItem(menu).textContent).toBe("Restarting research");

    daemon.records([chat(3)]);
    daemon.replies[CHATS_PATH] = successReply([chat(2), chat(3)]);
    await act(async () => {
      answer(successReply({ chat: chat(3), started: true }));
    });

    await expectHighlightOnFocus(user, menu);
  });

  it("asks on the board before the task is read, and Cancel stays on the board with focus on the menu button", async () => {
    stubScrollIntoView();
    const user = userEvent.setup();
    const daemon = stub([chat(2)]);
    const { reply } = heldBack();
    daemon.replies[TASK_PATH] = reply;
    const router = await openBoard(daemon);

    const dialog = await chooseRestart(user);

    expect(dialog).toBe(screen.getByRole("alertdialog", { name: "Stop the agent in chat 2 of SAGA-3?" }));
    await frame();
    expect(screen.queryByRole("alertdialog")).not.toBeNull();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(document.activeElement).toBe(menuButton());
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(router.state.location.pathname).toBe("/tasks");
    expect(daemon.starts()).toBe(0);
  });

  it("asks on the read of this open, with an older read of the task in the cache", async () => {
    const user = userEvent.setup();
    const daemon = stub([chat(2)]);
    const router = await openBoard(daemon);
    const { client, queryClient } = router.options.context;
    daemon.replies[TASK_PATH] = task({ fields: { workflow: "dev", step: "approve" } });
    await queryClient.query(taskQuery(client, "SAGA", "SAGA-3"));
    daemon.replies[TASK_PATH] = task({ fields: { workflow: "dev", step: "research" } });
    await daemon.send([{ kind: "task", tag: "SAGA", id: "SAGA-3", change: "changed" }]);

    const dialog = await chooseRestart(user);
    await frame();
    await frame();

    expect(screen.queryByRole("alertdialog")).toBe(dialog);
    expect(useNoticeStore.getState().notices).toEqual([]);

    await user.click(within(dialog).getByRole("button", { name: "Stop and restart" }));

    await waitFor(() => {
      expect(daemon.restarts()).toBe(1);
    });
  });

  it("opens the task view with the old chat, then the new chat by a replace, and Back returns to the board", async () => {
    const user = userEvent.setup();
    const daemon = stub([chat(2)]);
    const router = await openBoard(daemon);
    const entries = router.history.length;
    const { reply, answer } = heldBack();
    daemon.replies[`POST ${CHATS_PATH}`] = reply;
    const dialog = await chooseRestart(user);

    await user.click(within(dialog).getByRole("button", { name: "Stop and restart" }));

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ chat: "2" });
    });
    expect(router.state.location.pathname).toBe(TASK_PAGE);
    expect(router.history.length).toBe(entries + 1);
    expect(useUiStore.getState().boardReturn).toEqual(expect.objectContaining({ taskId: "SAGA-3", projects: "SAGA" }));
    await waitFor(() => {
      expect(daemon.restarts()).toBe(1);
    });
    expect(await screen.findByRole("button", { name: "Restarting research" })).toBeTruthy();

    daemon.records([chat(3)]);
    daemon.replies[CHATS_PATH] = successReply([chat(2), chat(3)]);
    await act(async () => {
      answer(successReply({ chat: chat(3), started: true }));
    });

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ chat: "3" });
    });
    expect(router.history.length).toBe(entries + 1);
    await frame();
    expect(spoken()).toContain("The research chat of SAGA-3 restarted.");

    await act(async () => {
      router.history.back();
    });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/tasks");
    });
  });

  it("restarts with no navigation after Back to the board during the wait, and says it", async () => {
    const user = userEvent.setup();
    const daemon = stub([chat(2)]);
    const router = await openBoard(daemon);
    const { reply, answer } = heldBack();
    daemon.replies[`POST ${CHATS_PATH}`] = reply;
    const dialog = await chooseRestart(user);
    await user.click(within(dialog).getByRole("button", { name: "Stop and restart" }));
    await waitFor(() => {
      expect(daemon.restarts()).toBe(1);
    });

    await act(async () => {
      router.history.back();
    });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/tasks");
    });
    const menu = await openMenu(user);
    await frame();

    expect(stepItem(menu).textContent).toBe("Restarting research");
    expect(stepItem(menu).getAttribute("aria-label")).toBe("Restarting research, SAGA-3");
    expect(stepItem(menu).getAttribute("aria-disabled")).toBe("true");
    expect(restartItem(menu)).toBeNull();
    await closeMenu(user);

    daemon.records([chat(3)]);
    daemon.replies[CHATS_PATH] = successReply([chat(2), chat(3)]);
    await act(async () => {
      answer(successReply({ chat: chat(3), started: true }));
    });

    await waitFor(() => {
      expect(spoken()).toContain("The research chat of SAGA-3 restarted.");
    });
    expect(router.state.location.pathname).toBe("/tasks");
    expect(daemon.restarts()).toBe(1);
  });

  it("returns focus to the h1 when the card left the board during the dialog", async () => {
    const user = userEvent.setup();
    const daemon = stub([chat(2)]);
    await openBoard(daemon);
    const dialog = await chooseRestart(user);
    daemon.replies[LISTING_PATH] = listing([]);
    await daemon.send([{ kind: "task", tag: "SAGA", id: "SAGA-3", change: "deleted" }]);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Task menu SAGA-3" })).toBeNull();
    });

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
    });
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
