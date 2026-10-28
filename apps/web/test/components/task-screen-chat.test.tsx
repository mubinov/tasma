import type { TransportReply } from "@tasma/protocol";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { CHAT_CLIENT } from "../../src/api/mutations";
import { useNoticeStore } from "../../src/store/notices";
import { useUiStore } from "../../src/store/ui";
import { chatPath, chatRecord, stubChatLog, type ChatLogStub } from "../chat-daemon";
import { TERMINAL_LOG, TEXT_LOG } from "../chat-fixtures";
import { renderWithRouter, stubIntersectionObserver, stubResizeObservers, stubThreadDom, successReply } from "../helpers";
import { backLink, daemon, sidebar, task, TASK_PATH, topBar, WORKFLOW } from "../task-screen-fixtures";

const PAGE = "/tasks/SAGA/SAGA-3";

const TASK_PARAMS = { project: "SAGA", task: "SAGA-3" };

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
  stubThreadDom();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * The task page's daemon, with chat 2 of the task, whose log is TEXT_LOG, and
 * chat 3, whose log is TERMINAL_LOG. `replies` replaces any of its replies.
 */
function chatDaemon(replies: Record<string, TransportReply> = {}): ChatLogStub {
  const log = stubChatLog({
    ...daemon().replies,
    [chatPath()]: successReply(chatRecord({ seq: TEXT_LOG.length })),
    [chatPath(3)]: successReply(chatRecord({ chat: 3, step: "test", seq: TERMINAL_LOG.length })),
    ...replies,
  });
  log.serve(0, { cursor: TEXT_LOG.length, entries: [...TEXT_LOG] });
  log.serve(0, { cursor: TERMINAL_LOG.length, entries: [...TERMINAL_LOG] }, 3);
  return log;
}

function taskHeading(): HTMLElement {
  return screen.getByRole("heading", { level: 1 });
}

function chatHeading(): HTMLElement {
  return screen.getByRole("heading", { level: 2, name: "Claude · build" });
}

function noSidebar(): boolean {
  return screen.queryByRole("complementary", { name: "Task details" }) === null;
}

function titleInput(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>("textbox", { name: "Title" });
}

async function openEditor(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(within(screen.getByRole("main")).getByRole("button", { name: "Edit" }));
  await waitFor(() => {
    expect(document.activeElement).toBe(titleInput());
  });
}

async function openChat(router: Awaited<ReturnType<typeof renderWithRouter>>, chat: string): Promise<void> {
  await act(async () => {
    await router.navigate({ to: "/tasks/$project/$task", params: TASK_PARAMS, search: { chat } });
  });
}

/** A window offset that `scrollTo` moves, which jsdom does not implement. Returns the `scrollTo` mock. */
function stubWindowScroll(top: number) {
  const scrollTo = vi.fn((to: ScrollToOptions | number, y = 0) => {
    vi.stubGlobal("scrollY", typeof to === "number" ? y : to.top);
  });
  vi.stubGlobal("scrollX", 0);
  vi.stubGlobal("scrollY", top);
  vi.stubGlobal("scrollTo", scrollTo);
  return scrollTo;
}

/** Waits until the router has rendered the address with this search, after which it scrolls no more. */
async function settled(router: Awaited<ReturnType<typeof renderWithRouter>>, search: object): Promise<void> {
  await waitFor(() => {
    expect(router.state.resolvedLocation?.search).toEqual(search);
  });
}

/** Resolves after the router has rendered its next load and made the scroll that follows it. */
function nextRender(router: Awaited<ReturnType<typeof renderWithRouter>>): Promise<void> {
  return new Promise((resolve) => {
    const stop = router.subscribe("onRendered", () => {
      stop();
      resolve();
    });
  });
}

it("shows the chat panel in place of the task sidebar, and keeps the h1 and the document title", async () => {
  await renderWithRouter(`${PAGE}?chat=2`, chatDaemon().transport);

  expect(await screen.findByRole("heading", { level: 2, name: "Claude · build" })).toBeTruthy();
  expect(await screen.findByText("Rename the parser module.")).toBeTruthy();
  expect(noSidebar()).toBe(true);
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  expect(taskHeading().textContent).toBe("Build the parser");
  expect(document.title).toBe("SAGA-3 Build the parser · tasma");
});

const ENDED = chatRecord({ seq: TEXT_LOG.length, stateSeq: TEXT_LOG.length });

it.each<[string, Record<string, TransportReply>, boolean]>([
  ["the state of the newest chat of a task that is not final", { [`${TASK_PATH}/chats`]: successReply([ENDED]) }, true],
  [
    "no state for an older chat",
    { [`${TASK_PATH}/chats`]: successReply([ENDED, chatRecord({ chat: 3, step: "test", seq: TERMINAL_LOG.length })]) },
    false,
  ],
  [
    "no state for the newest chat of a task in a final status",
    { [`${TASK_PATH}/chats`]: successReply([ENDED]), [TASK_PATH]: task({ fields: { status: "Done" } }) },
    false,
  ],
  [
    "no state for the newest chat on a past step that the user saw",
    {
      [`${TASK_PATH}/chats`]: successReply([{ ...ENDED, seen: TEXT_LOG.length }]),
      [TASK_PATH]: task({ fields: { workflow: "dev", step: "approve" } }),
    },
    false,
  ],
  [
    "the state of a seen chat on the first step of the workflow of a task with no step",
    {
      [`${TASK_PATH}/chats`]: successReply([{ ...ENDED, seen: TEXT_LOG.length }]),
      [TASK_PATH]: task({ fields: { workflow: "dev" } }),
      "/workflows/dev": successReply({ ...WORKFLOW, steps: [{ name: "build", file: "/w/dev/build.md", owner: "agent" }] }),
    },
    true,
  ],
])("shows %s in the header of the chat panel", async (_case, replies, marked) => {
  await renderWithRouter(`${PAGE}?chat=2`, chatDaemon(replies).transport);
  const panel = await screen.findByRole("region", { name: "Claude · build" });
  await waitFor(() => {
    expect(panel.querySelector(':scope > [role="status"]')!.textContent).toBe("");
  });

  expect(within(chatHeading().parentElement!).queryByText("Needs you") !== null).toBe(marked);
});

it("closes the chat by replacing the address, shows the sidebar and moves focus to the h1", async () => {
  const user = userEvent.setup();
  const router = await renderWithRouter(PAGE, chatDaemon().transport);
  await screen.findByRole("heading", { level: 1 });
  await openChat(router, "2");
  await screen.findByRole("heading", { level: 2, name: "Claude · build" });
  const entries = router.history.length;

  await user.click(screen.getByRole("button", { name: "Close the chat" }));

  await waitFor(() => {
    expect(sidebar()).toBeTruthy();
  });
  expect(router.state.location.search).toEqual({});
  expect(router.history.length).toBe(entries);
  expect(document.activeElement).toBe(taskHeading());
});

it("moves focus to the panel heading when a chat opens on the task page", async () => {
  const router = await renderWithRouter(PAGE, chatDaemon().transport);
  await screen.findByRole("heading", { level: 1 });

  await openChat(router, "2");

  await waitFor(() => {
    expect(document.activeElement).toBe(chatHeading());
  });
});

it("does not move focus to the panel heading when the page loads with a chat", async () => {
  await renderWithRouter(`${PAGE}?chat=2`, chatDaemon().transport);

  expect(await screen.findByText("Rename the parser module.")).toBeTruthy();
  expect(document.activeElement).not.toBe(chatHeading());
});

it("moves focus to the h1 when Back closes the chat while focus is in the panel", async () => {
  const router = await renderWithRouter(PAGE, chatDaemon().transport);
  await screen.findByRole("heading", { level: 1 });
  await openChat(router, "2");
  await waitFor(() => {
    expect(document.activeElement).toBe(chatHeading());
  });

  act(() => {
    router.history.back();
  });

  await waitFor(() => {
    expect(sidebar()).toBeTruthy();
  });
  expect(document.activeElement).toBe(taskHeading());
});

it("opens and closes a chat over unsaved text with no dialog, keeps the text, and moves focus to the title field", async () => {
  const user = userEvent.setup();
  const router = await renderWithRouter(PAGE, chatDaemon().transport);
  await screen.findByRole("heading", { level: 1 });
  await openEditor(user);
  await user.type(titleInput(), " II");

  await openChat(router, "2");

  expect(await screen.findByRole("heading", { level: 2, name: "Claude · build" })).toBeTruthy();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(titleInput().value).toBe("Build the parser II");

  await user.click(screen.getByRole("button", { name: "Close the chat" }));

  await waitFor(() => {
    expect(sidebar()).toBeTruthy();
  });
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(titleInput().value).toBe("Build the parser II");
  expect(document.activeElement).toBe(titleInput());
});

it("still asks before a navigation to the board drops unsaved text", async () => {
  const user = userEvent.setup();
  await renderWithRouter(PAGE, chatDaemon().transport);
  await screen.findByRole("heading", { level: 1 });
  await openEditor(user);
  await user.type(titleInput(), " II");

  await user.click(backLink());

  expect(await screen.findByRole("alertdialog", { name: "Discard your changes?" })).toBeTruthy();
});

it.each(["abc", "0", "02", "-1"])("shows the sidebar and no panel for chat=%s", async (chat) => {
  const log = chatDaemon();
  await renderWithRouter(`${PAGE}?chat=${chat}`, log.transport);

  expect(await screen.findByRole("heading", { level: 1 })).toBeTruthy();
  expect(sidebar()).toBeTruthy();
  expect(screen.queryByRole("heading", { level: 2, name: /Claude/ })).toBeNull();
  expect(log.readsOf(chatPath())).toBe(0);
});

it("shows chat 3 and none of the messages of chat 2 when the address changes from chat 2 to chat 3", async () => {
  const router = await renderWithRouter(`${PAGE}?chat=2`, chatDaemon().transport);
  expect(await screen.findByText("Rename the parser module.")).toBeTruthy();

  await openChat(router, "3");

  expect(await screen.findByText("Run the tests.")).toBeTruthy();
  expect(screen.getByRole("heading", { level: 2, name: "Claude · test" })).toBeTruthy();
  expect(screen.queryByText("Rename the parser module.")).toBeNull();
  await waitFor(() => {
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "Claude · test" }));
  });
});

it("keeps the window scroll, and makes no scroll, when a chat opens, changes and closes", async () => {
  const user = userEvent.setup();
  const router = await renderWithRouter(PAGE, chatDaemon().transport);
  await screen.findByRole("heading", { level: 1 });
  const scrollTo = stubWindowScroll(600);

  await openChat(router, "2");
  await settled(router, { chat: "2" });
  expect(window.scrollY).toBe(600);

  await openChat(router, "3");
  await settled(router, { chat: "3" });
  expect(window.scrollY).toBe(600);

  await user.click(screen.getByRole("button", { name: "Close the chat" }));
  await settled(router, {});
  expect(window.scrollY).toBe(600);
  expect(scrollTo).not.toHaveBeenCalled();
});

it("keeps the window scroll when Back closes a chat and Forward opens it again", async () => {
  const router = await renderWithRouter(PAGE, chatDaemon().transport);
  await screen.findByRole("heading", { level: 1 });
  await openChat(router, "2");
  await settled(router, { chat: "2" });
  stubWindowScroll(600);

  act(() => {
    router.history.back();
  });
  await settled(router, {});
  expect(window.scrollY).toBe(600);

  act(() => {
    router.history.forward();
  });
  await settled(router, { chat: "2" });
  expect(window.scrollY).toBe(600);
});

it("keeps the window scroll when Back and Forward go between the closed chat and the same address before it", async () => {
  const user = userEvent.setup();
  const router = await renderWithRouter(PAGE, chatDaemon().transport);
  await screen.findByRole("heading", { level: 1 });
  await openChat(router, "2");
  await settled(router, { chat: "2" });
  await user.click(screen.getByRole("button", { name: "Close the chat" }));
  await settled(router, {});
  const scrollTo = stubWindowScroll(600);

  for (const step of [() => router.history.back(), () => router.history.forward()]) {
    const rendered = nextRender(router);
    act(step);
    await act(() => rendered);
    expect(router.state.resolvedLocation?.pathname).toBe(PAGE);
    expect(window.scrollY).toBe(600);
  }
  expect(scrollTo).not.toHaveBeenCalled();
});

it("keeps the scroll that the focus of the panel heading gives when a chat opens", async () => {
  const router = await renderWithRouter(PAGE, chatDaemon().transport);
  await screen.findByRole("heading", { level: 1 });
  stubWindowScroll(600);
  // A browser scrolls a focused element into view.
  const reveal = () => vi.stubGlobal("scrollY", 1294);
  document.addEventListener("focusin", reveal);
  onTestFinished(() => {
    document.removeEventListener("focusin", reveal);
  });

  await openChat(router, "2");
  await settled(router, { chat: "2" });

  expect(document.activeElement).toBe(chatHeading());
  expect(window.scrollY).toBe(1294);
});

it("still scrolls to the top when the reader leaves the task", async () => {
  const user = userEvent.setup();
  const router = await renderWithRouter(`${PAGE}?chat=2`, chatDaemon().transport);
  await screen.findByRole("heading", { level: 2, name: "Claude · build" });
  stubWindowScroll(600);

  await user.click(backLink());

  await waitFor(() => {
    expect(router.state.resolvedLocation?.pathname).toBe("/tasks");
  });
  expect(window.scrollY).toBe(0);
});

it("gives the panel the height of the window under the top bar, and at xl and wider the whole height beside the content", async () => {
  await renderWithRouter(`${PAGE}?chat=2`, chatDaemon().transport);

  const frame = (await screen.findByRole("region", { name: "Claude · build" })).parentElement!;
  for (const name of [
    "h-[calc(100vh-var(--spacing-top-bar))]",
    "xl:h-screen",
    "xl:sticky",
    "xl:top-0",
    "xl:w-chat-panel",
    "border-t",
    "xl:border-t-0",
    "xl:border-l",
  ]) {
    expect(frame.classList.contains(name), name).toBe(true);
  }
  expect(frame.classList.contains("h-screen")).toBe(false);
  expect([...frame.classList].filter((name) => name.startsWith("lg:"))).toEqual([]);
});

it("puts the chat panel beside the content from xl, and the sidebar from lg again after close", async () => {
  const user = userEvent.setup();
  await renderWithRouter(`${PAGE}?chat=2`, chatDaemon().transport);
  const panel = (await screen.findByRole("region", { name: "Claude · build" })).parentElement!;
  const page = panel.parentElement!;
  const contentEnd = () => taskHeading().parentElement!.parentElement!;
  const room = "[calc(--spacing(12)+var(--notice-stack-height,0px))]";

  expect(topBar().parentElement?.className).toBe("contents xl:block xl:min-w-0 xl:flex-1");
  expect(page.classList.contains("xl:flex-row")).toBe(true);
  expect(page.classList.contains("xl:items-start")).toBe(true);
  expect(page.classList.contains("lg:flex-row")).toBe(false);
  expect(contentEnd().classList.contains(`xl:pb-${room}`)).toBe(true);
  expect(contentEnd().classList.contains(`lg:pb-${room}`)).toBe(false);

  await user.click(screen.getByRole("button", { name: "Close the chat" }));

  await waitFor(() => {
    expect(sidebar()).toBeTruthy();
  });
  expect(topBar().parentElement?.className).toBe("contents lg:block lg:min-w-0 lg:flex-1");
  expect(page.classList.contains("lg:flex-row")).toBe(true);
  expect(page.classList.contains("xl:flex-row")).toBe(false);
  expect(contentEnd().classList.contains(`lg:pb-${room}`)).toBe(true);
  expect(contentEnd().classList.contains(`xl:pb-${room}`)).toBe(false);
});

it("keeps Scroll to top to the left of the chat panel while a chat shows, and to the left of the sidebar after close", async () => {
  const user = userEvent.setup();
  const io = stubIntersectionObserver();
  const resize = stubResizeObservers();
  await renderWithRouter(`${PAGE}?chat=2`, chatDaemon().transport);
  await screen.findByRole("heading", { level: 2, name: "Claude · build" });
  resize.report(topBar());
  io.report({ target: taskHeading(), top: -40, bottom: -10 });
  const control = () => screen.getByRole("button", { name: "Scroll to top" });

  expect(control().classList.contains("xl:right-[calc(var(--spacing-chat-panel)+--spacing(6))]")).toBe(true);

  await user.click(screen.getByRole("button", { name: "Close the chat" }));

  await waitFor(() => {
    expect(sidebar()).toBeTruthy();
  });
  expect(control().classList.contains("lg:right-[calc(var(--spacing-task-sidebar)+--spacing(6))]")).toBe(true);
});

it("sends a message from the composer of the chat on the task page", async () => {
  const user = userEvent.setup();
  const log = chatDaemon();
  log.replies[`POST ${chatPath()}/messages`] = successReply(chatRecord({ seq: TEXT_LOG.length }));
  await renderWithRouter(`${PAGE}?chat=2`, log.transport);

  await user.type(await screen.findByRole("textbox", { name: "Message input" }), "Split the lexer.{Enter}");

  await waitFor(() => {
    expect(log.requests.filter(({ method }) => method === "POST")).toEqual([
      { method: "POST", path: `${chatPath()}/messages`, body: { text: "Split the lexer.", client: CHAT_CLIENT } },
    ]);
  });
});
