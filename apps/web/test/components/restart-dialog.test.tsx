import { createMemoryHistory, createRootRouteWithContext, createRouter, RouterProvider } from "@tanstack/react-router";
import type { Chat, ChatState, TransportReply, TransportRequest } from "@tasma/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daemonKeys, taskChatsQuery, taskQuery } from "../../src/api/queries";
import { RestartDialog } from "../../src/components/restart-dialog";
import type { FinalFocus } from "../../src/lib/final-focus";
import type { RouterContext } from "../../src/routes";
import { useNoticeStore } from "../../src/store/notices";
import { chatRecord } from "../chat-daemon";
import { countReads, heldBack, refusalReply, successReply, testContext } from "../helpers";
import { frame } from "../setup/notice-store";
import { CHATS_PATH } from "../task-chats-daemon";
import { daemon as taskDaemon, TASK_PATH, task } from "../task-screen-fixtures";

type User = ReturnType<typeof userEvent.setup>;

function chat(number: number, state: ChatState = "working"): Chat {
  return chatRecord({ chat: number, step: "research", seq: 3, state });
}

const ON_STEP = task({ fields: { workflow: "dev", step: "research" } });

type HarnessProps = {
  onConfirm: () => void;
  /** The confirm closes the dialog, as each caller does. */
  closes: boolean;
  /** Called in each commit that shows a notice, with whether the dialog shows open in it. */
  onNoticeShown?: (dialogOpen: boolean) => void;
};

function NoticeProbe({ onShown }: { onShown: (dialogOpen: boolean) => void }): ReactNode {
  const shown = useNoticeStore((state) => state.notices.length > 0);

  useLayoutEffect(() => {
    if (shown) {
      onShown(document.querySelector("[role=alertdialog][data-open]") !== null);
    }
  });

  return null;
}

/** The dialog for chat 2 of SAGA-3, opened by a button that takes focus back. */
function Harness({ onConfirm, closes, onNoticeShown }: HarnessProps): ReactNode {
  const [open, setOpen] = useState(true);
  const focusRef = useRef<FinalFocus>(null);

  return (
    <>
      {onNoticeShown !== undefined && <NoticeProbe onShown={onNoticeShown} />}
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Opener
      </button>
      <RestartDialog
        open={open}
        tag="SAGA"
        id="SAGA-3"
        step="research"
        chat={2}
        onCancel={() => {
          setOpen(false);
        }}
        onConfirm={() => {
          if (closes) {
            setOpen(false);
          }
          onConfirm();
        }}
        finalFocus={focusRef}
      />
    </>
  );
}

type Rendered = {
  context: RouterContext;
  replies: Record<string, TransportReply | Promise<TransportReply>>;
  requests: TransportRequest[];
  /** Counts the reads of the task from the render on. */
  taskReads: () => number;
};

async function renderDialog(
  chats: Chat[],
  replies: Record<string, TransportReply | Promise<TransportReply>> = {},
  props: Partial<HarnessProps> = {},
  /** The read of the task that the cache holds before the dialog opens. */
  cachedTask?: TransportReply,
): Promise<Rendered> {
  const stub = taskDaemon({ [TASK_PATH]: ON_STEP, [CHATS_PATH]: successReply(chats) });
  Object.assign(stub.replies, replies);
  const context = testContext(stub.transport);
  // Each opener has read the chats.
  await context.queryClient.query(taskChatsQuery(context.client, "SAGA", "SAGA-3"));
  if (cachedTask !== undefined) {
    const current = stub.replies[TASK_PATH]!;
    stub.replies[TASK_PATH] = cachedTask;
    await context.queryClient.query(taskQuery(context.client, "SAGA", "SAGA-3"));
    stub.replies[TASK_PATH] = current;
  }
  const rootRoute = createRootRouteWithContext<RouterContext>()({
    component: () => (
      <Harness
        onConfirm={props.onConfirm ?? (() => {})}
        closes={props.closes ?? true}
        onNoticeShown={props.onNoticeShown}
      />
    ),
  });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ["/"] }), context });
  await router.load();
  const taskReads = countReads(stub, TASK_PATH);
  render(<RouterProvider router={router} />);
  await screen.findByRole("alertdialog");

  return { context, replies: stub.replies, requests: stub.requests, taskReads };
}

function dialog(): HTMLElement {
  return screen.getByRole("alertdialog");
}

function button(name: string): HTMLElement {
  return within(dialog()).getByRole("button", { name });
}

function spoken(): string[] {
  return useNoticeStore.getState().announced.map(({ words }) => words);
}

/** The daemon now lists these chats, and the dialog reads them again. */
async function chatsChange({ context, replies }: Rendered, chats: Chat[]): Promise<void> {
  replies[CHATS_PATH] = successReply(chats);
  await act(async () => {
    await context.queryClient.invalidateQueries({ queryKey: daemonKeys.taskChats("SAGA", "SAGA-3") });
  });
}

beforeEach(() => {
  useNoticeStore.setState({ notices: [], dismissed: new Map() });
});

afterEach(() => {
  cleanup();
});

describe("the words", () => {
  it("ask to stop the agent of a working chat", async () => {
    await renderDialog([chat(1), chat(2)]);

    expect(dialog()).toBe(screen.getByRole("alertdialog", { name: "Stop the agent in chat 2 of SAGA-3?" }));
    expect(dialog().textContent).toContain("The agent is working now. Tasma stops it, and a new chat starts the step research.");
    expect(within(dialog()).getByText("research").className).toContain("font-mono");
    expect(button("Stop and restart")).toBeTruthy();
    expect(button("Cancel")).toBeTruthy();
  });

  it.each<[string, Chat]>([
    ["needs you", chat(2, "needs-you")],
    ["continued outside", chatRecord({ chat: 2, step: "research", seq: 3, state: "continued-outside", where: "vscode" })],
  ])("ask to restart the step for a chat that %s", async (_case, replaced) => {
    await renderDialog([chat(1), replaced]);

    expect(dialog()).toBe(screen.getByRole("alertdialog", { name: "Restart the step of SAGA-3?" }));
    expect(dialog().textContent).toContain("A new chat starts the step research. Chat 2 stays in the list.");
    expect(within(dialog()).getByText("research").className).toContain("font-mono");
    expect(button("Restart")).toBeTruthy();
  });
});

describe("focus and keys", () => {
  it("starts on Cancel, and Esc cancels", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    await renderDialog([chat(2)], {}, { onConfirm });

    await waitFor(() => {
      expect(document.activeElement).toBe(button("Cancel"));
    });

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("calls the confirm once for each open", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    await renderDialog([chat(2)], {}, { onConfirm, closes: false });

    fireEvent.click(button("Stop and restart"));
    fireEvent.click(button("Stop and restart"));

    expect(onConfirm).toHaveBeenCalledOnce();

    await user.click(button("Cancel"));
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    await user.click(screen.getByRole("button", { name: "Opener" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop and restart" }));

    expect(onConfirm).toHaveBeenCalledTimes(2);
  });
});

describe("a change of the chat while open", () => {
  async function focusRestart(user: User): Promise<void> {
    await waitFor(() => {
      expect(document.activeElement).toBe(button("Cancel"));
    });
    await user.tab();
    expect(document.activeElement).toBe(button("Restart"));
  }

  it("to working changes the words, says it, and moves focus from the confirm to Cancel", async () => {
    const user = userEvent.setup();
    const rendered = await renderDialog([chat(2, "needs-you")]);
    await focusRestart(user);

    await chatsChange(rendered, [chat(2)]);

    await waitFor(() => {
      expect(dialog()).toBe(screen.getByRole("alertdialog", { name: "Stop the agent in chat 2 of SAGA-3?" }));
    });
    expect(document.activeElement).toBe(button("Cancel"));
    await frame();
    expect(spoken()).toEqual(["The agent in chat 2 is working now."]);
  });

  it("to working leaves focus on Cancel", async () => {
    const rendered = await renderDialog([chat(2, "needs-you")]);
    await waitFor(() => {
      expect(document.activeElement).toBe(button("Cancel"));
    });

    await chatsChange(rendered, [chat(2)]);

    await waitFor(() => {
      expect(button("Stop and restart")).toBeTruthy();
    });
    expect(document.activeElement).toBe(button("Cancel"));
  });

  it("from working says nothing", async () => {
    const rendered = await renderDialog([chat(2)]);

    await chatsChange(rendered, [chat(2, "needs-you")]);

    await waitFor(() => {
      expect(button("Restart")).toBeTruthy();
    });
    await frame();
    expect(spoken()).toEqual([]);
  });
});

describe("the reads", () => {
  it("keep the dialog open and working while the task is read", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    await renderDialog([chat(1, "failed")], { [TASK_PATH]: heldBack().reply }, { onConfirm });

    await frame();
    expect(screen.queryByRole("alertdialog")).not.toBeNull();

    await user.click(button("Restart"));

    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("keep the dialog open when the read of the task fails", async () => {
    await renderDialog([chat(1, "failed")], {
      [TASK_PATH]: refusalReply(409, { kind: "store", code: "project-invalid", message: "The tasks folder is a file." }),
    });

    await frame();
    await frame();
    expect(screen.queryByRole("alertdialog")).not.toBeNull();
    expect(useNoticeStore.getState().notices).toEqual([]);
  });

  it("keep the dialog open while the workflow is read", async () => {
    await renderDialog([chat(1, "failed")], { "/workflows/dev": heldBack().reply });

    await frame();
    expect(screen.queryByRole("alertdialog")).not.toBeNull();
  });

  it.each<[string, Chat[], TransportReply]>([
    ["the latest chat failed", [chat(1), chat(2, "failed")], ON_STEP],
    ["a newer chat is the chat of the step", [chat(1), chat(2), chat(3)], ON_STEP],
    ["the task moved to another step", [chat(1), chat(2)], task({ fields: { workflow: "dev", step: "approve" } })],
    ["the task has no workflow", [chat(1), chat(2)], task({ fields: { step: "research" } })],
  ])("close the dialog with Nothing restarted when %s", async (_case, chats, taskReply) => {
    const onConfirm = vi.fn();
    await renderDialog(chats, { [TASK_PATH]: taskReply }, { onConfirm });

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(useNoticeStore.getState().notices).toEqual([
      expect.objectContaining({
        key: "chat-restart-skipped:SAGA-3",
        form: "warning",
        title: "Nothing restarted",
        line: "Chat 2 of SAGA-3 is no longer the chat of its step.",
        words: [],
      }),
    ]);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("show the warning only in a commit where the dialog shows closed", async () => {
    const onNoticeShown = vi.fn();
    await renderDialog([chat(1), chat(2, "failed")], {}, { onNoticeShown });

    await waitFor(() => {
      expect(onNoticeShown).toHaveBeenCalled();
    });

    expect(onNoticeShown.mock.calls[0]).toEqual([false]);
  });

  it("decide on the reads of this open, not on an older read in the cache", async () => {
    const onConfirm = vi.fn();
    const rendered = await renderDialog(
      [chat(1), chat(2)],
      {},
      { onConfirm },
      task({ fields: { workflow: "dev", step: "approve" } }),
    );

    await waitFor(() => {
      expect(rendered.taskReads()).toBe(1);
    });
    await frame();
    await frame();

    expect(screen.queryByRole("alertdialog")).not.toBeNull();
    expect(useNoticeStore.getState().notices).toEqual([]);

    fireEvent.click(button("Stop and restart"));

    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("read again at each open", async () => {
    const user = userEvent.setup();
    const rendered = await renderDialog([chat(1), chat(2)]);
    await waitFor(() => {
      expect(rendered.taskReads()).toBe(1);
    });
    await user.click(button("Cancel"));
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    rendered.replies[TASK_PATH] = task({ fields: { workflow: "dev", step: "approve" } });

    await user.click(screen.getByRole("button", { name: "Opener" }));

    await waitFor(() => {
      expect(useNoticeStore.getState().notices.map(({ title }) => title)).toEqual(["Nothing restarted"]);
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("wait at each open for the read of the chats", async () => {
    const user = userEvent.setup();
    const rendered = await renderDialog([chat(1), chat(2)]);
    await user.click(button("Cancel"));
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    const { reply, answer } = heldBack();
    rendered.replies[CHATS_PATH] = reply;

    await user.click(screen.getByRole("button", { name: "Opener" }));
    await frame();
    await frame();

    expect(screen.queryByRole("alertdialog")).not.toBeNull();

    await act(async () => {
      answer(successReply([chat(1), chat(2), chat(3)]));
    });

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(useNoticeStore.getState().notices.map(({ title }) => title)).toEqual(["Nothing restarted"]);
  });

  it("read nothing while closed", async () => {
    const user = userEvent.setup();
    const rendered = await renderDialog([chat(1), chat(2)]);
    await user.click(button("Cancel"));
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    const reads = ["/workflows/dev", TASK_PATH, CHATS_PATH].map((path) => countReads(rendered, path));

    await act(async () => {
      await rendered.context.queryClient.invalidateQueries();
    });
    await frame();

    expect(reads.map((count) => count())).toEqual([0, 0, 0]);
  });

  it("open no notice when the chat stops being the chat of its step after the dialog closed", async () => {
    const user = userEvent.setup();
    const rendered = await renderDialog([chat(1), chat(2)]);
    await user.click(button("Cancel"));
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });

    await chatsChange(rendered, [chat(1), chat(2, "failed")]);
    await frame();

    expect(useNoticeStore.getState().notices).toEqual([]);
  });

  it("close the dialog when a read changes while it is open", async () => {
    const rendered = await renderDialog([chat(1), chat(2)]);
    await frame();
    expect(screen.queryByRole("alertdialog")).not.toBeNull();

    await chatsChange(rendered, [chat(1), chat(2), chat(3)]);

    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(useNoticeStore.getState().notices.map(({ title }) => title)).toEqual(["Nothing restarted"]);
  });
});
