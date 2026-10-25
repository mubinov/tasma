import type { Chat, ChatState, Frontmatter, TransportReply } from "@tasma/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_CLIENT } from "../../src/api/mutations";
import { BUTTON_FILLED_CLASS } from "../../src/components/control-classes";
import { FindShortcut } from "../../src/components/find-shortcut";
import { STEP_ACTION_SELECTOR } from "../../src/lib/step-action";
import { useNoticeStore } from "../../src/store/notices";
import { useUiStore } from "../../src/store/ui";
import { chatRecord } from "../chat-daemon";
import { countReads, heldBack, refusalReply, renderWithRouter, stubThreadDom, successReply } from "../helpers";
import { CHATS_PATH, stubTaskChats, type TaskChatsStub } from "../task-chats-daemon";
import { backLink, field, TASK_PATH, task } from "../task-screen-fixtures";
import { frame } from "../setup/notice-store";

const PAGE = "/tasks/SAGA/SAGA-3";

const START = `POST ${CHATS_PATH}`;

type Router = Awaited<ReturnType<typeof renderWithRouter>>;

type User = ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({ boardReturn: null, boardRestorePending: false });
  useNoticeStore.setState({ notices: [], dismissed: new Map() });
  stubThreadDom();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A chat of SAGA-3 that holds its first message. */
function chat(number: number, state: ChatState = "working", step = "research"): Chat {
  const status = state === "continued-outside" ? { state, where: "vscode" } : { state };
  return chatRecord({ chat: number, step, seq: 3, ...status } as Partial<Chat>);
}

function onStep(fields: Partial<Frontmatter> = {}): TransportReply {
  return task({ fields: { workflow: "dev", step: "research", ...fields } });
}

/** The daemon of SAGA-3 on the step `research`, with these chats. */
function stub(chats: Chat[], replies: Record<string, TransportReply | Promise<TransportReply>> = {}): TaskChatsStub {
  return stubTaskChats(chats, { [TASK_PATH]: onStep(), ...replies });
}

/** The task page at `path`, with the feed subscriber that main.tsx mounts beside it. */
async function openPage(daemon: TaskChatsStub, path = PAGE): Promise<Router> {
  const router = await renderWithRouter(path, daemon.transport);
  await screen.findByRole("heading", { level: 1 });
  await daemon.mount(router);
  return router;
}

function action(): HTMLElement | null {
  return document.querySelector<HTMLElement>(STEP_ACTION_SELECTOR);
}

function shownAction(): HTMLElement {
  const button = action();
  expect(button).not.toBeNull();
  return button!;
}

function spoken(): string[] {
  return useNoticeStore.getState().announced.map(({ words }) => words);
}

function spinning(button: HTMLElement): boolean {
  return button.querySelector("svg")!.getAttribute("class")?.includes("animate-spin") === true;
}

/** The daemon answers a start with this chat, and lists it from then on. */
function answerWith(daemon: TaskChatsStub, answered: Chat, started = true, listed = [answered]): TransportReply {
  daemon.records(listed);
  daemon.replies[CHATS_PATH] = successReply(listed);
  return successReply({ chat: answered, started });
}

/** A start whose answer the test sends. */
function holdStart(daemon: TaskChatsStub): (reply: TransportReply) => void {
  const { reply, answer } = heldBack();
  daemon.replies[START] = reply;
  return answer;
}

async function answer(send: (reply: TransportReply) => void, reply: TransportReply): Promise<void> {
  await act(async () => {
    send(reply);
  });
  await frame();
}

async function pressHeld(user: User, daemon: TaskChatsStub): Promise<(reply: TransportReply) => void> {
  const send = holdStart(daemon);
  await user.click(shownAction());
  await waitFor(() => {
    expect(shownAction().getAttribute("aria-label")).toBe("Start research, starting");
  });
  return send;
}

async function openEditor(user: User): Promise<void> {
  await user.click(within(screen.getByRole("main")).getByRole("button", { name: "Edit" }));
  await screen.findByRole("textbox", { name: "Title" });
}

function headingFocusWatch(): () => void {
  const listener = vi.fn();
  screen.getByRole("heading", { level: 1 }).addEventListener("focus", listener);
  return listener;
}

async function taskChanged(daemon: TaskChatsStub, reply: TransportReply): Promise<void> {
  daemon.replies[TASK_PATH] = reply;
  await daemon.send([{ kind: "task", tag: "SAGA", id: "SAGA-3", change: "changed" }]);
}

describe("the button", () => {
  it("starts the chat of a task with none, opens it in the panel by a push, and hides", async () => {
    const user = userEvent.setup();
    const daemon = stub([]);
    const router = await openPage(daemon);
    const entries = router.history.length;
    const button = shownAction();
    daemon.replies[START] = answerWith(daemon, chat(1));

    expect(button).toBe(screen.getByRole("button", { name: "Start research" }));
    expect(button.className).toContain(BUTTON_FILLED_CLASS);
    expect(button.textContent).toBe("Startresearch");
    expect(button.nextElementSibling).toBe(screen.getByRole("button", { name: "Find in task" }));

    await user.click(button);

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ chat: "1" });
    });
    expect(router.history.length).toBe(entries + 1);
    const heading = await screen.findByRole("heading", { level: 2, name: "Claude · research" });
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
    expect(action()).toBeNull();
    expect(daemon.requests.find(({ method }) => method === "POST")).toEqual(
      expect.objectContaining({ path: CHATS_PATH, body: { client: CHAT_CLIENT } }),
    );
    await frame();
    expect(spoken()).toEqual(["Starting the research chat of SAGA-3"]);
  });

  it.each([
    ["after the answer", false],
    ["before the answer", true],
  ])("never moves focus to the h1 and never says Open when the event of the new chat comes %s", async (_when, early) => {
    const user = userEvent.setup();
    const daemon = stub([]);
    const router = await openPage(daemon);
    const h1Focused = headingFocusWatch();
    const send = await pressHeld(user, daemon);

    if (early) {
      await daemon.change([chat(1)]);
    }
    await answer(send, answerWith(daemon, chat(1)));
    if (!early) {
      await daemon.change([chat(1)]);
    }

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ chat: "1" });
    });
    await frame();
    expect(h1Focused).not.toHaveBeenCalled();
    expect(spoken()).not.toContain("Open research");
    expect(action()).toBeNull();
  });

  it("opens the chat of the step by a push and sends no start", async () => {
    const user = userEvent.setup();
    const daemon = stub([chat(1, "failed"), chat(2)]);
    const router = await openPage(daemon);
    const entries = router.history.length;
    const h1Focused = headingFocusWatch();

    await user.click(screen.getByRole("button", { name: "Open research" }));

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ chat: "2" });
    });
    expect(router.history.length).toBe(entries + 1);
    const heading = await screen.findByRole("heading", { level: 2, name: "Claude · research" });
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
    expect(action()).toBeNull();
    expect(daemon.starts()).toBe(0);
    expect(h1Focused).not.toHaveBeenCalled();
  });

  it("starts when the latest chat of the step failed", async () => {
    await openPage(stub([chat(1, "failed")]));

    expect(shownAction()).toBe(screen.getByRole("button", { name: "Start research" }));
  });

  it("waits with a spinner, keeps focus and the text of the press, and sends one start", async () => {
    const user = userEvent.setup();
    const daemon = stub([]);
    await openPage(daemon);
    const button = shownAction();

    await pressHeld(user, daemon);
    await user.click(button);
    await daemon.change([chat(1)]);
    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 2, name: "Chats 1" })).toBeTruthy();
    });

    expect(shownAction()).toBe(button);
    expect(button.getAttribute("aria-label")).toBe("Start research, starting");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.textContent).toBe("Startresearch");
    expect(spinning(button)).toBe(true);
    expect(document.activeElement).toBe(button);
    expect(daemon.starts()).toBe(1);
  });

  it("says the start and opens no panel when the editor took focus during the wait", async () => {
    const user = userEvent.setup();
    const daemon = stub([]);
    const router = await openPage(daemon);
    const send = await pressHeld(user, daemon);
    await openEditor(user);

    await answer(send, answerWith(daemon, chat(1)));

    await waitFor(() => {
      expect(spoken()).toContain("The research chat of SAGA-3 started.");
    });
    expect(router.state.location.search).toEqual({});
  });

  it("says that the chat is in its chats when the start answers a chat that exists and the editor took focus", async () => {
    const user = userEvent.setup();
    const daemon = stub([]);
    const router = await openPage(daemon);
    const send = await pressHeld(user, daemon);
    await openEditor(user);

    await answer(send, answerWith(daemon, chat(1), false));

    await waitFor(() => {
      expect(spoken()).toContain("The research chat of SAGA-3 is in its chats.");
    });
    expect(router.state.location.search).toEqual({});
  });

  it("says that a chat failed after a move to the board during the wait", async () => {
    const user = userEvent.setup();
    const daemon = stub([]);
    const router = await openPage(daemon);
    const send = await pressHeld(user, daemon);
    await act(async () => {
      await router.navigate({ to: "/tasks", search: { projects: "SAGA" } });
    });

    await answer(send, answerWith(daemon, chat(1, "failed")));

    await waitFor(() => {
      expect(spoken()).toContain("The research chat of SAGA-3 failed.");
    });
    expect(router.state.location.pathname).toBe("/tasks");
    expect(router.state.location.search).toEqual({ projects: "SAGA" });
  });

  it("says that a chat failed after a move to the dashboard during the wait", async () => {
    const user = userEvent.setup();
    const daemon = stub([]);
    const router = await openPage(daemon);
    const send = await pressHeld(user, daemon);
    await act(async () => {
      await router.navigate({ to: "/" });
    });

    await answer(send, answerWith(daemon, chat(1, "failed")));

    await waitFor(() => {
      expect(spoken()).toContain("The research chat of SAGA-3 failed.");
    });
    expect(router.state.location.pathname).toBe("/");
  });

  it("leaves a navigation that still loads when the answer comes, and says the start", async () => {
    const user = userEvent.setup();
    const otherTask = "/projects/SAGA/tasks/SAGA-4";
    const { reply, answer: sendOther } = heldBack();
    const daemon = stub([], { [otherTask]: reply, [`${otherTask}/chats`]: successReply([]) });
    const router = await openPage(daemon);
    const send = await pressHeld(user, daemon);
    // Focus stays on the button, as after a click on a link in WebKit.
    let leaving: Promise<void> = Promise.resolve();
    act(() => {
      leaving = router.navigate({ to: "/tasks/$project/$task", params: { project: "SAGA", task: "SAGA-4" } });
    });
    await waitFor(() => {
      expect(daemon.paths).toContain(otherTask);
    });

    await answer(send, answerWith(daemon, chat(1)));
    await waitFor(() => {
      expect(spoken()).toContain("The research chat of SAGA-3 started.");
    });
    await act(async () => {
      sendOther(task({ fields: { id: "SAGA-4" } }));
      await leaving;
    });

    expect(router.state.location.pathname).toBe("/tasks/SAGA/SAGA-4");
    expect(router.state.location.search).toEqual({});
  });

  it("opens the start that comes back with the chat working while the refetch has it failed, and shows Start beside the panel", async () => {
    const user = userEvent.setup();
    const daemon = stub([]);
    const router = await openPage(daemon);
    const send = await pressHeld(user, daemon);

    await answer(send, answerWith(daemon, chat(1), true, [chat(1, "failed")]));

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ chat: "1" });
    });
    await waitFor(() => {
      expect(shownAction().getAttribute("aria-label")).toBe("Start research");
    });
    expect(spinning(shownAction())).toBe(false);
    expect(screen.getByRole("heading", { level: 2, name: "Claude · research" })).toBeTruthy();
  });

  it("shows a failure notice with the words of the daemon for a refused start, and Start again", async () => {
    const user = userEvent.setup();
    const daemon = stub([]);
    daemon.replies[START] = refusalReply(409, { kind: "daemon", code: "step-stale", message: "research is not a step of dev" });
    await openPage(daemon);

    await user.click(shownAction());

    await waitFor(() => {
      expect(useNoticeStore.getState().notices).toEqual([
        expect.objectContaining({
          key: "chat-start-failure:SAGA-3",
          form: "failure",
          title: "The research chat of SAGA-3 did not start",
          line: "The daemon refused to start the chat. Its own words are below.",
          words: ["daemon/step-stale · research is not a step of dev"],
        }),
      ]);
    });
    await waitFor(() => {
      expect(shownAction().getAttribute("aria-label")).toBe("Start research");
    });
    expect(spinning(shownAction())).toBe(false);
  });

  it("closes the failure notice of the task when a later start succeeds", async () => {
    const user = userEvent.setup();
    const daemon = stub([]);
    daemon.replies[START] = refusalReply(409, { kind: "daemon", code: "step-stale", message: "research is not a step of dev" });
    const router = await openPage(daemon);
    await user.click(shownAction());
    await waitFor(() => {
      expect(useNoticeStore.getState().notices).toHaveLength(1);
    });
    daemon.replies[START] = answerWith(daemon, chat(1));

    await user.click(shownAction());

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ chat: "1" });
    });
    expect(useNoticeStore.getState().notices).toEqual([]);
  });

  it.each([
    ["approve", "Start approve"],
    [undefined, "Start research"],
  ])("runs the step %s of the task, or the first step for none", async (step, name) => {
    await openPage(stub([], { [TASK_PATH]: onStep({ step }) }));

    expect(shownAction()).toBe(screen.getByRole("button", { name }));
  });

  it("shows Open beside the panel of an older chat, and nothing beside the panel of its own chat", async () => {
    await openPage(stub([chat(1), chat(2)]), `${PAGE}?chat=1`);

    expect(shownAction()).toBe(screen.getByRole("button", { name: "Open research" }));

    cleanup();
    await openPage(stub([chat(1), chat(2)]), `${PAGE}?chat=2`);

    expect(screen.getByRole("heading", { level: 2, name: "Claude · research" })).toBeTruthy();
    expect(action()).toBeNull();
  });
});

describe("the line of the top bar", () => {
  function line(): HTMLElement {
    return backLink().parentElement!;
  }

  it("is marked while the button shows, so a narrow bar gives the button its floor", async () => {
    const user = userEvent.setup();
    await openPage(stub([]));

    expect(line().hasAttribute("data-step-action-shown")).toBe(true);

    await user.click(screen.getByRole("button", { name: "Find in task" }));

    expect(line().hasAttribute("data-step-action-shown")).toBe(false);
  });
});

describe("no button", () => {
  it.each([
    ["no workflow", task({ fields: { step: "research" } })],
    ["a stale step", onStep({ step: "deploy" })],
  ])("for a task with %s", async (_case, reply) => {
    await openPage(stub([], { [TASK_PATH]: reply }));

    expect(action()).toBeNull();
  });

  it("while find is open", async () => {
    const user = userEvent.setup();
    await openPage(stub([]));

    await user.click(screen.getByRole("button", { name: "Find in task" }));

    expect(action()).toBeNull();
  });

  it("in edit mode", async () => {
    const user = userEvent.setup();
    await openPage(stub([]));

    await openEditor(user);

    expect(action()).toBeNull();
  });
});

describe("a change while the button holds focus", () => {
  it("says the new text when a step edit outside the app changes the step", async () => {
    const daemon = stub([]);
    await openPage(daemon);
    shownAction().focus();

    await taskChanged(daemon, onStep({ step: "approve" }));

    await waitFor(() => {
      expect(shownAction().getAttribute("aria-label")).toBe("Start approve");
    });
    await frame();
    expect(spoken()).toEqual(["Start approve"]);
  });

  it("changes Open to Start with no reload when the chat fails, keeps focus, and says Start", async () => {
    const daemon = stub([chat(1)]);
    await openPage(daemon);
    const taskReads = countReads(daemon, TASK_PATH);
    const button = shownAction();
    button.focus();

    await daemon.change([chat(1, "failed")]);

    await waitFor(() => {
      expect(button.getAttribute("aria-label")).toBe("Start research");
    });
    expect(document.activeElement).toBe(button);
    await frame();
    // The list and the button speak in one frame, in no fixed order.
    expect(spoken().toSorted()).toEqual(["Start research", "The research chat failed."]);
    expect(taskReads()).toBe(0);
  });

  it("moves focus to the h1 when the task loses its workflow", async () => {
    const daemon = stub([]);
    await openPage(daemon);
    shownAction().focus();

    await taskChanged(daemon, task());

    await waitFor(() => {
      expect(action()).toBeNull();
    });
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
  });

  it("keeps focus in the find field when Cmd+F hides the button and the task then loses its workflow", async () => {
    const user = userEvent.setup();
    const daemon = stub([]);
    const router = await openPage(daemon);
    render(<FindShortcut router={router} />);
    shownAction().focus();

    await user.keyboard("{Meta>}f{/Meta}");

    const findField = within(screen.getByRole("search", { name: "Find" })).getByRole("searchbox");
    expect(document.activeElement).toBe(findField);
    const h1Focused = headingFocusWatch();

    await taskChanged(daemon, task());

    await waitFor(() => {
      expect(field("Workflow").textContent).not.toBe("dev");
    });
    expect(document.activeElement).toBe(findField);
    expect(h1Focused).not.toHaveBeenCalled();
  });

  it("leaves focus where it is when Edit hides the button, the editor closes, and the task then loses its workflow", async () => {
    const user = userEvent.setup();
    const daemon = stub([]);
    await openPage(daemon);
    const button = shownAction();
    button.focus();

    // WebKit does not focus a clicked button, so focus stays on the step action.
    fireEvent.click(within(screen.getByRole("main")).getByRole("button", { name: "Edit" }));

    expect(await screen.findByRole("textbox", { name: "Title" })).toBe(document.activeElement);
    expect(button.isConnected).toBe(false);

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    shownAction();
    const focused = document.activeElement;
    const h1Focused = headingFocusWatch();

    await taskChanged(daemon, task());

    await waitFor(() => {
      expect(action()).toBeNull();
    });
    expect(document.activeElement).toBe(focused);
    expect(h1Focused).not.toHaveBeenCalled();
  });

  it("moves focus to the panel heading when the open chat becomes the chat of the action", async () => {
    const daemon = stub([chat(1), chat(2, "failed")]);
    await openPage(daemon, `${PAGE}?chat=2`);
    shownAction().focus();
    const h1Focused = headingFocusWatch();

    await daemon.change([chat(1), chat(2)]);

    await waitFor(() => {
      expect(action()).toBeNull();
    });
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "Claude · research" }));
    expect(h1Focused).not.toHaveBeenCalled();
  });

  it("moves focus to the panel heading and says the chat is in its chats when the start answers the open chat", async () => {
    const user = userEvent.setup();
    const daemon = stub([chat(1), chat(2, "failed")]);
    const router = await openPage(daemon, `${PAGE}?chat=2`);
    const entries = router.history.length;
    shownAction().focus();
    const send = await pressHeld(user, daemon);

    expect(shownAction().getAttribute("aria-label")).toBe("Start research, starting");

    await answer(send, answerWith(daemon, chat(2), false, [chat(1), chat(2)]));

    await waitFor(() => {
      expect(action()).toBeNull();
    });
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "Claude · research" }));
    expect(router.state.location.search).toEqual({ chat: "2" });
    expect(router.history.length).toBe(entries);
    expect(spoken().filter((words) => words === "The research chat of SAGA-3 is in its chats.")).toHaveLength(1);
  });
});

describe("a chat that fails at once", () => {
  function failedSpoken(): number {
    return spoken().filter((words) => words.includes("failed")).length;
  }

  it.each([
    ["after the answer", false],
    ["before the answer", true],
  ])("is said one time, by the start, when its event comes %s", async (_when, early) => {
    const user = userEvent.setup();
    const daemon = stub([]);
    const router = await openPage(daemon);
    const send = await pressHeld(user, daemon);

    if (early) {
      await daemon.change([chat(1, "failed")]);
    }
    await answer(send, answerWith(daemon, chat(1, "failed")));
    if (!early) {
      await daemon.change([chat(1, "failed")]);
    }

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ chat: "1" });
    });
    await frame();
    expect(spoken()).toContain("The research chat of SAGA-3 failed.");
    expect(failedSpoken()).toBe(1);
  });

  it("is said one time while the editor is open, and not again when it closes", async () => {
    const user = userEvent.setup();
    const daemon = stub([]);
    const router = await openPage(daemon);
    const send = await pressHeld(user, daemon);
    await openEditor(user);

    await answer(send, answerWith(daemon, chat(1, "failed")));
    await daemon.change([chat(1, "failed")]);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByRole("heading", { level: 1 });
    await frame();

    expect(router.state.location.search).toEqual({});
    expect(spoken()).toContain("The research chat of SAGA-3 failed.");
    expect(failedSpoken()).toBe(1);
  });

  it("is said one time for a task in a final status", async () => {
    const user = userEvent.setup();
    const daemon = stub([], { [TASK_PATH]: onStep({ status: "Done" }) });
    await openPage(daemon);
    const send = await pressHeld(user, daemon);
    await openEditor(user);

    await answer(send, answerWith(daemon, chat(1, "failed")));
    await daemon.change([chat(1, "failed")]);
    await frame();

    expect(spoken()).toContain("The research chat of SAGA-3 failed.");
    expect(failedSpoken()).toBe(1);
  });

  it("is not said by the list when the list reads it after the start ended, and a later change is", async () => {
    const user = userEvent.setup();
    const daemon = stub([]);
    await openPage(daemon);
    const send = await pressHeld(user, daemon);
    await openEditor(user);

    // The refetch of the start still lists no chat.
    await answer(send, answerWith(daemon, chat(1, "failed"), true, []));
    await waitFor(() => {
      expect(spoken()).toContain("The research chat of SAGA-3 failed.");
    });
    await daemon.change([chat(1, "failed")]);
    await frame();

    expect(failedSpoken()).toBe(1);

    await daemon.change([chat(1, "needs-you")]);
    await frame();

    expect(spoken()).toContain("The research chat needs you.");
  });
});

describe("a pending write of the task", () => {
  it("follows a step change in the sidebar at once, and waits for its write before a start", async () => {
    const user = userEvent.setup();
    const daemon = stub([]);
    const { reply, answer: sendPatch } = heldBack();
    daemon.replies[`PATCH ${TASK_PATH}`] = reply;
    await openPage(daemon);

    await user.click(within(field("Step")).getByRole("button"));
    const menu = await screen.findByRole("menu", { name: "Step" });
    await user.click(within(menu).getByRole("menuitemradio", { name: "approve" }));

    const button = shownAction();
    await waitFor(() => {
      expect(button.getAttribute("aria-label")).toBe("Start approve");
    });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(spinning(button)).toBe(true);
    await user.click(button);
    expect(daemon.starts()).toBe(0);

    daemon.replies[TASK_PATH] = onStep({ step: "approve" });
    await act(async () => {
      sendPatch(successReply({ id: "SAGA-3" }));
    });

    await waitFor(() => {
      expect(button.getAttribute("aria-disabled")).not.toBe("true");
    });
    expect(spinning(button)).toBe(false);
  });
});

describe("the tooltip", () => {
  const PAST_FOCUS = 200;

  function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, PAST_FOCUS));
  }

  function stepText(): HTMLElement {
    return shownAction().lastElementChild as HTMLElement;
  }

  async function tabToAction(user: User): Promise<void> {
    while (document.activeElement !== shownAction()) {
      await user.tab();
    }
  }

  it("does not open while the whole text shows", async () => {
    const user = userEvent.setup();
    await openPage(stub([]));

    await tabToAction(user);
    await settle();

    expect(screen.queryByText("Start research", { selector: "[data-side], [data-side] *" })).toBeNull();
  });

  it.each([
    ["hidden", (element: HTMLElement) => {
      Object.defineProperty(element, "checkVisibility", { configurable: true, value: () => false });
    }],
    ["cut", (element: HTMLElement) => {
      Object.defineProperty(element, "checkVisibility", { configurable: true, value: () => true });
      Object.defineProperty(element, "scrollWidth", { configurable: true, value: 200 });
      Object.defineProperty(element, "clientWidth", { configurable: true, value: 120 });
    }],
  ])("shows the full text on keyboard focus while the step text is %s", async (_case, shorten) => {
    const user = userEvent.setup();
    await openPage(stub([]));
    shorten(stepText());

    await tabToAction(user);

    expect(await screen.findByText("Start research", { selector: "[data-side], [data-side] *" })).toBeTruthy();
  });
});
