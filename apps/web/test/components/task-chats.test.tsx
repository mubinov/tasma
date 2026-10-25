import type { Chat, ChatState } from "@tasma/protocol";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SELECTED_ROW_CLASS } from "../../src/components/control-classes";
import { fullChatTime, shortChatTime } from "../../src/lib/chat-time";
import { useNoticeStore } from "../../src/store/notices";
import { useUiStore } from "../../src/store/ui";
import { chatRecord } from "../chat-daemon";
import { countReads, heldBack, refusalReply, renderWithRouter, stubThreadDom, successReply } from "../helpers";
import { CHATS_PATH, stubTaskChats, type TaskChatsStub } from "../task-chats-daemon";
import { TASK_PATH, metaLine, task } from "../task-screen-fixtures";
import { frame } from "../setup/notice-store";

const PAGE = "/tasks/SAGA/SAGA-3";

type Router = Awaited<ReturnType<typeof renderWithRouter>>;

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({ boardReturn: null, boardRestorePending: false });
  stubThreadDom();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A chat of SAGA-3 that started on the day of its number in September 2026. */
function chat(number: number, state: ChatState = "working", step = "build"): Chat {
  const status = state === "continued-outside" ? { state, where: "vscode" } : { state };
  const created = new Date(Date.UTC(2026, 8, number, 10, 0)).toISOString();
  return chatRecord({ chat: number, step, created, ...status } as Partial<Chat>);
}

/** The task page at `path`, with the feed subscriber that main.tsx mounts beside it. */
async function openPage(stub: TaskChatsStub, path = PAGE): Promise<Router> {
  const router = await renderWithRouter(path, stub.transport);
  await screen.findByRole("heading", { level: 1 });
  await stub.mount(router);
  return router;
}

function chatsSection(): HTMLElement {
  return screen.getByRole("region", { name: /^Chats / });
}

function rows(): HTMLElement[] {
  return within(chatsSection()).getAllByRole("link");
}

function row(step: RegExp | string): HTMLElement {
  return within(chatsSection()).getByRole("link", { name: step });
}

function stateOf(link: HTMLElement): string | null {
  return link.lastElementChild!.childElementCount > 1 ? link.lastElementChild!.firstElementChild!.textContent : null;
}

function spoken(): string[] {
  return useNoticeStore.getState().announced.map(({ words }) => words);
}

/**
 * Opens SAGA-3 with one working chat, goes to SAGA-4, changes the chats of
 * SAGA-3 to `next` there, and goes back to SAGA-3 with the read of its chats
 * held until the test answers it.
 */
async function returnAfterChange(next: Chat[]) {
  const stub = stubTaskChats([chat(1)], {
    "/projects/SAGA/tasks/SAGA-4": task({ fields: { id: "SAGA-4", title: "Write the docs" } }),
    "/projects/SAGA/tasks/SAGA-4/chats": successReply([]),
  });
  const router = await openPage(stub);
  await act(async () => {
    await router.navigate({ to: "/tasks/$project/$task", params: { project: "SAGA", task: "SAGA-4" } });
  });

  await stub.change(next);
  const { reply, answer } = heldBack();
  stub.replies[CHATS_PATH] = reply;
  await act(async () => {
    await router.navigate({ to: "/tasks/$project/$task", params: { project: "SAGA", task: "SAGA-3" } });
  });
  await frame();

  return { ...stub, answer };
}

describe("the list", () => {
  it("shows no section for a task with no chats, and the body follows the status line", async () => {
    await openPage(stubTaskChats([], { [TASK_PATH]: task({ body: "The plan." }) }));

    expect(screen.queryByRole("heading", { name: /^Chats/ })).toBeNull();
    const body = metaLine().nextElementSibling!;
    expect(body.textContent).toBe("The plan.");
    expect(body.className).toContain("mt-8");
  });

  it("shows every chat newest first under the status line, with the state of the newest alone and each start time", async () => {
    const chats = [chat(1, "working", "research"), chat(2, "failed", "plan"), chat(3, "working", "build")];
    await openPage(stubTaskChats(chats, { [TASK_PATH]: task({ body: "The plan." }) }));

    const heading = screen.getByRole("heading", { level: 2, name: "Chats 3" });
    expect(metaLine().nextElementSibling).toBe(chatsSection());
    expect(chatsSection().firstElementChild).toBe(heading);
    expect(within(chatsSection()).getByRole("list").getAttribute("role")).toBe("list");
    expect(rows().map((link) => link.firstElementChild!.textContent)).toEqual(["build", "plan", "research"]);
    expect(rows().map(stateOf)).toEqual(["Agent works", null, null]);
    expect(rows().map((link) => link.querySelector("time")!.textContent)).toEqual(
      [...chats].reverse().map(({ created }) => shortChatTime(created, Date.now())),
    );
    expect(rows()[0]!.getAttribute("aria-label")).toBe(`build, Agent works, ${fullChatTime(chats[2]!.created)}`);
    expect(rows()[1]!.getAttribute("aria-label")).toBe(`plan, ${fullChatTime(chats[1]!.created)}`);
    expect(chatsSection().nextElementSibling!.className).toContain("mt-10");
  });

  it.each([
    ["working", "Agent works"],
    ["needs-you", "Needs you"],
    ["failed", "Failed"],
    ["continued-outside", "Continued in VS Code"],
  ] as const)("shows the state %s on the newest row", async (state, text) => {
    await openPage(stubTaskChats([chat(1), chat(2, state)]));

    expect(rows().map(stateOf)).toEqual([text, null]);
  });

  it("shows no state on any row while the status of the task is final", async () => {
    await openPage(stubTaskChats([chat(1), chat(2, "needs-you")], { [TASK_PATH]: task({ fields: { status: "Done" } }) }));

    expect(rows().map(stateOf)).toEqual([null, null]);
    expect(rows()[0]!.getAttribute("aria-label")).toBe(`build, ${fullChatTime(chat(2).created)}`);
  });

  it("shows no list in edit mode", async () => {
    const user = userEvent.setup();
    await openPage(stubTaskChats([chat(1)]));

    await user.click(within(screen.getByRole("main")).getByRole("button", { name: "Edit" }));

    expect(screen.queryByRole("region", { name: /^Chats / })).toBeNull();
  });
});

describe("a row", () => {
  it("opens its chat in the panel by a push, and marks itself", async () => {
    const user = userEvent.setup();
    const router = await openPage(stubTaskChats([chat(1, "working", "research"), chat(2)]));
    const entries = router.history.length;

    await user.click(row(/^research,/));

    await waitFor(() => {
      expect(router.state.location.search).toEqual({ chat: "1" });
    });
    expect(router.history.length).toBe(entries + 1);
    expect(await screen.findByRole("heading", { level: 2, name: "Claude · research" })).toBeTruthy();
    expect(row(/^research,/).getAttribute("aria-current")).toBe("page");
    expect(row(/^build,/).getAttribute("aria-current")).toBeNull();
  });

  it("marks the chat of the address alone, by its bar", async () => {
    await openPage(stubTaskChats([chat(1), chat(2), chat(3)]), `${PAGE}?chat=2`);

    expect(rows().map((link) => link.getAttribute("aria-current"))).toEqual([null, "page", null]);
    expect(rows()[1]!.className).toContain(SELECTED_ROW_CLASS);
    expect(rows()[0]!.className).not.toContain(SELECTED_ROW_CLASS);
  });

  it("moves focus to the panel heading when it is the open chat, and leaves the address as it is", async () => {
    const user = userEvent.setup();
    const router = await openPage(stubTaskChats([chat(1), chat(2), chat(3)]), `${PAGE}?chat=2`);
    const entries = router.history.length;
    rows()[1]!.focus();

    await user.keyboard("{Enter}");

    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "Claude · build" }));
    expect(router.state.location.search).toEqual({ chat: "2" });
    expect(router.history.length).toBe(entries);
  });
});

describe("live", () => {
  it("shows a new chat as the first row and a change of state on the newest row, with no reload", async () => {
    const stub = stubTaskChats([chat(1, "working", "research")]);
    await openPage(stub);
    const taskReads = countReads(stub, TASK_PATH);

    await stub.change([chat(1, "working", "research"), chat(2, "working", "build")]);

    await waitFor(() => {
      expect(rows().map((link) => link.firstElementChild!.textContent)).toEqual(["build", "research"]);
    });
    expect(screen.getByRole("heading", { level: 2, name: "Chats 2" })).toBeTruthy();
    expect(rows().map(stateOf)).toEqual(["Agent works", null]);

    await stub.change([chat(1, "working", "research"), chat(2, "needs-you", "build")]);

    await waitFor(() => {
      expect(rows().map(stateOf)).toEqual(["Needs you", null]);
    });
    expect(taskReads()).toBe(0);
  });

  it("keeps focus on the same chat when a new chat comes in at the top", async () => {
    const stub = stubTaskChats([chat(1, "working", "research"), chat(2, "working", "plan")]);
    await openPage(stub);
    const focused = rows()[1]!;
    focused.focus();

    await stub.change([chat(1, "working", "research"), chat(2, "working", "plan"), chat(3)]);

    await waitFor(() => {
      expect(rows()).toHaveLength(3);
    });
    expect(rows()[2]).toBe(focused);
    expect(document.activeElement).toBe(focused);
  });
});

describe("announcements", () => {
  it("announces the newest chat that changes to needs you, or to failed, while no chat is open", async () => {
    const stub = stubTaskChats([chat(1)]);
    await openPage(stub);

    await stub.change([chat(1, "needs-you")]);
    await frame();
    expect(spoken()).toEqual(["The build chat needs you."]);

    await stub.change([chat(1, "failed")]);
    await frame();
    expect(spoken()).toEqual(["The build chat needs you.", "The build chat failed."]);
  });

  it("does not announce the change of the chat that the panel shows", async () => {
    const stub = stubTaskChats([chat(1), chat(2)]);
    await openPage(stub, `${PAGE}?chat=2`);

    await stub.change([chat(1), chat(2, "needs-you")]);
    await waitFor(() => {
      expect(stateOf(rows()[0]!)).toBe("Needs you");
    });
    await frame();

    expect(spoken()).not.toContain("The build chat needs you.");
  });

  it("announces nothing for a new working chat, nor for a change to working", async () => {
    const stub = stubTaskChats([chat(1, "needs-you")]);
    await openPage(stub);

    await stub.change([chat(1)]);
    await stub.change([chat(1), chat(2)]);
    await waitFor(() => {
      expect(rows()).toHaveLength(2);
    });
    await frame();

    expect(spoken()).toEqual([]);
  });

  it("announces a new chat that comes in failed one time", async () => {
    const stub = stubTaskChats([chat(1)]);
    await openPage(stub);

    await stub.change([chat(1), chat(2, "failed")]);
    await frame();
    await stub.change([chat(1), chat(2, "failed")]);
    await frame();

    expect(spoken()).toEqual(["The build chat failed."]);
  });

  it("announces the first chat of a task that comes in failed one time", async () => {
    const stub = stubTaskChats([]);
    await openPage(stub);

    await stub.change([chat(1, "failed")]);
    await waitFor(() => {
      expect(rows()).toHaveLength(1);
    });
    await frame();

    expect(spoken()).toEqual(["The build chat failed."]);
  });

  it("announces in edit mode, where the list does not show", async () => {
    const user = userEvent.setup();
    const stub = stubTaskChats([chat(1)]);
    await openPage(stub);
    await user.click(within(screen.getByRole("main")).getByRole("button", { name: "Edit" }));

    await stub.change([chat(1, "needs-you")]);
    await frame();

    expect(spoken()).toEqual(["The build chat needs you."]);
    expect(screen.queryByRole("region", { name: /^Chats / })).toBeNull();
  });

  it("announces nothing when the page opens on a newest chat that needs you", async () => {
    await openPage(stubTaskChats([chat(1), chat(2, "needs-you")]));
    await frame();

    expect(spoken()).toEqual([]);
  });

  it("announces nothing on a return to a task whose chat changed while away, and announces a later change", async () => {
    const stub = await returnAfterChange([chat(1, "needs-you")]);

    expect(rows().map(stateOf)).toEqual(["Agent works"]);

    await act(async () => {
      stub.answer(successReply([chat(1, "needs-you")]));
    });
    await frame();

    expect(rows().map(stateOf)).toEqual(["Needs you"]);
    expect(spoken()).toEqual([]);

    await stub.change([chat(1, "failed")]);
    await frame();

    expect(spoken()).toEqual(["The build chat failed."]);
  });

  it("keeps the task view when the read of the chats fails on a return", async () => {
    const stub = await returnAfterChange([chat(1, "needs-you")]);

    await act(async () => {
      stub.answer(refusalReply(409, { kind: "store", code: "project-invalid", message: "The chats folder is a file." }));
    });
    await frame();

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Build the parser");
    expect(rows().map(stateOf)).toEqual(["Agent works"]);
  });
});
