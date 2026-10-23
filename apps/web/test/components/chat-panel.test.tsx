import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type { Chat, ChatEntry, ChatEvent } from "@tasma/protocol";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { daemonKeys } from "../../src/api/queries";
import { ChatPanel } from "../../src/components/chat-panel";
import type { RouterContext } from "../../src/routes";
import { useNoticeStore } from "../../src/store/notices";
import { chatPath, chatRecord, eventsPath, stubChatLog, type ChatLogStub } from "../chat-daemon";
import {
  BASH_OPTIONS,
  chatEntries,
  EDIT_LOG,
  PERMISSION_LOG,
  permissionRequest,
  permissionResolved,
  QUESTION_LOG,
  questionRequest,
  questionResolved,
  QUESTIONS_LOG,
  REFUSAL_LOG,
  TERMINAL_LOG,
  TEXT_LOG,
  textChunk,
  thoughtChunk,
  toolCall,
  toolCallUpdate,
  turnEnd,
  userMessage,
} from "../chat-fixtures";
import { heldBack, refusalReply, stubHitTest, stubThreadDom, successReply, testContext } from "../helpers";
import { bareBorders, KIT_BORDER_SELECTOR } from "../kit/borders";
import { colouredTokens, SHIKI_LOAD } from "../kit/shiki";
import { frame } from "../setup/notice-store";

beforeEach(() => {
  stubThreadDom();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type PanelOptions = {
  focusOnMount?: boolean;
  onClose?: () => void;
  /** The record of chat 2 in the cache before the panel mounts. */
  cached?: Chat;
  /** A host to render in place of the panel of chat 2. */
  host?: ReactNode;
};

async function renderPanel(log: ChatLogStub, { focusOnMount, onClose = () => {}, cached, host }: PanelOptions = {}) {
  const context: RouterContext = { ...testContext(log.transport), client: log.client };
  if (cached !== undefined) {
    cacheRecord(context, cached);
  }
  const rootRoute = createRootRouteWithContext<RouterContext>()({ component: Outlet });
  const panel = host ?? (
    <ChatPanel
      tag="SAGA"
      task="SAGA-3"
      chat={2}
      onClose={onClose}
      {...(focusOnMount === undefined ? {} : { focusOnMount })}
    />
  );
  const router = createRouter({
    routeTree: rootRoute.addChildren([createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => panel })]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    context,
  });

  await act(async () => {
    await router.load();
  });
  render(
    <QueryClientProvider client={context.queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );

  return context;
}

function cacheRecord(context: RouterContext, record: Chat): void {
  context.queryClient.setQueryData(daemonKeys.chat("SAGA", "SAGA-3", record.chat), { data: record, diagnostics: [] });
}

/** A daemon with the record of a chat whose log holds the entries, served at once. */
function logOf(entries: readonly ChatEntry[]): ChatLogStub {
  const log = stubChatLog({ [chatPath()]: successReply(chatRecord({ seq: entries.length })) });
  log.serve(0, { cursor: entries.length, entries: [...entries] });
  return log;
}

function panel(): HTMLElement {
  return screen.getByRole("region", { name: /Chat 2|Claude · build/ });
}

/** The status line of the panel, which the kit thread does not hold. */
function statusLine(): HTMLElement {
  return panel().querySelector<HTMLElement>(':scope > [role="status"]')!;
}

function heading(): HTMLElement {
  return screen.getByRole("heading", { level: 2 });
}

function spoken(): string[] {
  return useNoticeStore.getState().announced.map(({ words }) => words);
}

async function readStarted(log: ChatLogStub, path: string, count = 1): Promise<void> {
  await waitFor(() => {
    expect(log.readsOf(path)).toBe(count);
  });
}

it("shows the agent and the step in the heading, and the number of the chat", async () => {
  await renderPanel(logOf(TEXT_LOG));

  expect(await screen.findByRole("heading", { level: 2, name: "Claude · build" })).toBeTruthy();
  expect(within(panel()).getByText("Chat 2")).toBeTruthy();
});

it.each<[string, readonly ChatEvent[], string]>([
  ["working", [userMessage("Build.")], "Agent works"],
  ["needs-you", [userMessage("Build."), turnEnd()], "Needs you"],
  ["failed", [userMessage("Build."), { kind: "failed", reason: "The agent exited." }], "Failed"],
  ["continued-outside", [userMessage("Build."), { kind: "continued-outside", where: "vscode" }], "Continued in VS Code"],
  ["continued-outside", [userMessage("Build."), { kind: "continued-outside", where: "terminal" }], "Continued in terminal"],
])("shows the state %s of a log as text", async (_state, events, text) => {
  await renderPanel(logOf(chatEntries(events)));

  expect(await screen.findByText(text)).toBeTruthy();
});

it("shows Loading the chat until the log reaches the seq of the record, and the transcript only then", async () => {
  const log = stubChatLog({ [chatPath()]: successReply(chatRecord({ seq: 5 })) });
  await renderPanel(log);
  await readStarted(log, eventsPath(0));
  expect(statusLine().textContent).toBe("Loading the chat");

  log.answer(0, { cursor: 3, entries: TEXT_LOG.slice(0, 3) });
  await readStarted(log, eventsPath(3));

  expect(statusLine().textContent).toBe("Loading the chat");
  expect(screen.queryByRole("log")).toBeNull();
  expect(screen.queryByText("Needs you")).toBeNull();

  log.answer(3, { cursor: 5, entries: TEXT_LOG.slice(3, 5) });

  expect(await screen.findByRole("log")).toBeTruthy();
  expect(statusLine().textContent).toBe("");
});

it("shows the user text, the agent text and the plan", async () => {
  await renderPanel(logOf(TEXT_LOG));

  expect(await screen.findByText("Rename the parser module.")).toBeTruthy();
  expect(screen.getByText("I renamed the module.")).toBeTruthy();
  expect(screen.getByText("Plan")).toBeTruthy();
  expect(screen.getByText("Rename the module")).toBeTruthy();
  expect(screen.getByText("Update the imports")).toBeTruthy();
});

it("shows a diff in its tool group, with the path in the chat folder and the changed lines", async () => {
  const user = userEvent.setup();
  await renderPanel(logOf(EDIT_LOG));

  await user.click(await screen.findByRole("button", { name: "2 tool calls" }));

  expect(screen.getByRole("button", { name: "Used tool: Edit src/parser.ts" })).toBeTruthy();
  expect(screen.getByText("src/parser.ts")).toBeTruthy();
  expect(screen.getByText("export function parse(input: string) {").previousElementSibling?.textContent).toBe("−");
  expect(screen.getByText("export function parseAll(input: string) {").previousElementSibling?.textContent).toBe("+");
  expect(screen.getByRole("button", { name: "Used tool: Write src/lexer.ts" })).toBeTruthy();
  expect(screen.getByText("src/lexer.ts")).toBeTruthy();
});

it("shows a terminal in its tool group, with the command, the output and the exit code", async () => {
  const user = userEvent.setup();
  await renderPanel(logOf(TERMINAL_LOG));

  await user.click(await screen.findByRole("button", { name: "1 tool call" }));

  expect(screen.getByRole("button", { name: "Used tool: pnpm test" })).toBeTruthy();
  const terminal = document.querySelector<HTMLElement>('[data-slot="terminal-block"]')!;
  expect(within(terminal).getByText("pnpm test")).toBeTruthy();
  expect(within(terminal).getByText("12 passed")).toBeTruthy();
  expect(within(terminal).getByText("exit 0")).toBeTruthy();
});

it("shows any other tool with the kit fallback, and the answer of its question under it", async () => {
  const user = userEvent.setup();
  await renderPanel(logOf(QUESTION_LOG));

  await user.click(await screen.findByRole("button", { name: "1 tool call" }));

  expect(screen.getByRole("button", { name: "Used tool: Which name should the module take?" })).toBeTruthy();
  expect(screen.getByText("Answered: lexer.")).toBeTruthy();
});

const ENDED_TOOLS_LOG = chatEntries([
  userMessage("Check the code."),
  toolCall({ toolCallId: "t1", title: "Read src/a.ts", kind: "read", status: "failed" }),
  toolCall({
    toolCallId: "t2",
    title: "pnpm lint",
    kind: "execute",
    status: "pending",
    content: [{ type: "terminal", terminalId: "t2" }],
  }),
  toolCallUpdate({ toolCallId: "t2", _meta: { terminal_output: { terminal_id: "t2", data: "lint error\n" } } }),
  toolCallUpdate({ toolCallId: "t2", status: "failed" }),
  toolCall({ toolCallId: "t3", title: "Fetch the page", kind: "fetch", status: "in_progress" }),
  toolCall({
    toolCallId: "t4",
    title: "pnpm dev",
    kind: "execute",
    status: "in_progress",
    content: [{ type: "terminal", terminalId: "t4" }],
  }),
  toolCallUpdate({ toolCallId: "t4", _meta: { terminal_exit: { terminal_id: "t4", exit_code: 130, signal: null } } }),
  turnEnd("cancelled"),
]);

it("does not show a failed or a stopped tool as done", async () => {
  const user = userEvent.setup();
  await renderPanel(logOf(ENDED_TOOLS_LOG));

  await user.click(await screen.findByRole("button", { name: "4 tool calls" }));

  expect(screen.getByRole("button", { name: "Failed tool: Read src/a.ts" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Failed tool: pnpm lint" })).toBeTruthy();
  expect(screen.getByText("lint error")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Cancelled tool: Fetch the page" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Cancelled tool: pnpm dev" })).toBeTruthy();
  const terminals = document.querySelectorAll<HTMLElement>('[data-slot="terminal-block"]');
  expect(terminals).toHaveLength(1);
  expect(terminals[0]!.dataset.state).toBe("failed");
  expect(within(terminals[0]!).getByText("exit 130")).toBeTruthy();
  expect(screen.queryByText("exit 0")).toBeNull();
  expect(screen.getByText("The turn was cancelled.")).toBeTruthy();
});

it("opens the tool group of a new permission request, and announces it, with no button that answers it", async () => {
  const log = stubChatLog({ [chatPath()]: successReply(chatRecord({ seq: 5 })) });
  const start = chatEntries([
    ...PERMISSION_LOG.slice(0, 4).map(({ event }) => event),
    toolCall({ toolCallId: "t9", title: "Read the docs", kind: "read", status: "in_progress" }),
  ]);
  await renderPanel(log);
  await readStarted(log, eventsPath(0));
  log.answer(0, { cursor: 5, entries: start });
  expect(await screen.findByText("Agent works")).toBeTruthy();
  expect(screen.queryByText("Waiting for your permission.")).toBeNull();

  log.answer(5, { cursor: 6, entries: chatEntries([PERMISSION_LOG[4]!.event], 6) });

  expect(await screen.findByText("Waiting for your permission.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Waiting on tool: pnpm build" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Running tool: Read the docs" })).toBeTruthy();
  const names = BASH_OPTIONS.map(({ name }) => name as string);
  expect(screen.getByText(`Options: ${names.join(", ")}.`)).toBeTruthy();
  expect(screen.getByText("Needs you")).toBeTruthy();
  for (const name of [...names, "Allow", "Deny", "Approve", "Reject"]) {
    expect(screen.queryByRole("button", { name })).toBeNull();
  }
  await frame();
  expect(spoken()).toEqual(["Claude asks for permission: pnpm build"]);
});

it("does not announce a request that is open when the panel opens", async () => {
  await renderPanel(logOf(PERMISSION_LOG.slice(0, 5)));

  expect(await screen.findByText("Waiting for your permission.")).toBeTruthy();
  await frame();
  expect(spoken()).toEqual([]);
});

it("shows a failed chat as Failed, with the whole reason", async () => {
  const reason = `The agent exited: ${"x".repeat(200)}`;
  await renderPanel(logOf(chatEntries([userMessage("Build."), { kind: "failed", reason }])));

  expect(await screen.findByText("Failed")).toBeTruthy();
  expect(screen.getByText(`The chat failed: ${reason}`)).toBeTruthy();
});

const REQUESTS_LOG = chatEntries([
  userMessage("Do the work."),
  permissionRequest("p1", { toolCallId: "t1", title: "Chosen", kind: "execute" }, [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
  ]),
  permissionResolved("p1", { outcome: "selected", optionId: "allow" }),
  permissionRequest("p2", { toolCallId: "t2", title: "Chosen by id", kind: "execute" }, []),
  permissionResolved("p2", { outcome: "selected", optionId: "allow-always" }),
  permissionRequest("p3", { toolCallId: "t3", title: "Chosen with no option", kind: "execute" }, []),
  permissionResolved("p3", { outcome: "selected" }),
  permissionRequest("p4", { toolCallId: "t4", title: "Cancelled", kind: "execute" }, []),
  permissionResolved("p4", { outcome: "cancelled" }),
  permissionRequest("p5", { toolCallId: "t5", title: "Ended", kind: "execute" }, []),
  questionRequest("q1", { toolCallId: "t6", message: "Declined question", requestedSchema: {} }),
  questionResolved("q1", { action: "decline" }),
  questionRequest("q2", { toolCallId: "t7", message: "Cancelled question", requestedSchema: {} }),
  questionResolved("q2", { action: "cancel" }),
  questionRequest("q3", { toolCallId: "t8", message: "Ended question", requestedSchema: {} }),
  turnEnd(),
]);

it("shows each request that ended as text", async () => {
  const user = userEvent.setup();
  await renderPanel(logOf(REQUESTS_LOG));

  await user.click(await screen.findByRole("button", { name: "8 tool calls" }));

  expect(screen.getByText("Answered: Allow.")).toBeTruthy();
  expect(screen.getByText("Answered: allow-always.")).toBeTruthy();
  expect(screen.getByText("Answered.")).toBeTruthy();
  expect(screen.getByText("The request was cancelled.")).toBeTruthy();
  expect(screen.getByText("The request ended with no answer.")).toBeTruthy();
  expect(screen.getByText("Declined.")).toBeTruthy();
  expect(screen.getByText("The question was cancelled.")).toBeTruthy();
  expect(screen.getByText("The question ended with no answer.")).toBeTruthy();
});

it("shows an open question with its fields and their choices", async () => {
  await renderPanel(logOf(QUESTIONS_LOG.slice(0, 4)));

  expect(await screen.findByText("Please answer the following questions.")).toBeTruthy();
  expect(screen.getByText("Version")).toBeTruthy();
  expect(screen.getByText("Which version should the release take?")).toBeTruthy();
  expect(screen.getByText("2.0.0")).toBeTruthy();
  expect(screen.getByText("— A major release")).toBeTruthy();
  expect(screen.getByText("Checks")).toBeTruthy();
  expect(screen.getByText("lint")).toBeTruthy();
  expect(screen.getByText("Waiting for your answer.")).toBeTruthy();
});

it("shows a question with no tool in the transcript, by the name and the description of a field with no title", async () => {
  const log = logOf(chatEntries([
    userMessage("Pick a colour."),
    questionRequest("q1", {
      message: "Which colour?",
      requestedSchema: {
        type: "object",
        properties: { colour: { type: "string", description: "The colour of the badge.", enum: ["red", "blue"] } },
      },
    }),
  ]));
  await renderPanel(log);

  expect(await screen.findByText("Which colour?")).toBeTruthy();
  expect(screen.getByText("colour")).toBeTruthy();
  expect(screen.getByText("The colour of the badge.")).toBeTruthy();
  expect(screen.getByText("red")).toBeTruthy();
  expect(screen.getByText("Waiting for your answer.")).toBeTruthy();
});

it("shows the answer of a question with no tool", async () => {
  await renderPanel(logOf(REFUSAL_LOG));

  expect(await screen.findByText("Answered: retry_fallback.")).toBeTruthy();
});

it("shows a chat with no messages as empty", async () => {
  await renderPanel(logOf([]));

  expect(await screen.findByText("This chat has no messages yet.")).toBeTruthy();
});

it("says that the log cannot be read after two failed reads, before and after it is ready, until a read succeeds", async () => {
  const log = stubChatLog({ [chatPath()]: successReply(chatRecord({ seq: 3 })) });
  await renderPanel(log);
  await readStarted(log, eventsPath(0));
  vi.useFakeTimers();

  log.refuse(0);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(statusLine().textContent).toBe("Loading the chat");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(statusLine().textContent).toBe("The chat cannot be read now. Tasma tries again.");

  log.serve(0, { cursor: 3, entries: TEXT_LOG.slice(0, 3) });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  expect(statusLine().textContent).toBe("");

  log.refuse(3);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(statusLine().textContent).toBe("The chat cannot be read now. Tasma tries again.");
  expect(screen.getByText("Rename the parser module.")).toBeTruthy();

  log.serve(3, { cursor: 4, entries: TEXT_LOG.slice(3, 4) });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  expect(statusLine().textContent).toBe("");
});

it("says that a chat that does not exist does not exist, and reads no events", async () => {
  const log = stubChatLog({
    [chatPath()]: refusalReply(404, { kind: "store", code: "chat-not-found", message: "no chat 2" }),
  });
  await renderPanel(log);

  await waitFor(() => {
    expect(statusLine().textContent).toBe("This chat does not exist.");
  });
  expect(heading().textContent).toBe("Chat 2");
  expect(within(panel()).getAllByText("Chat 2")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(log.readsOf(eventsPath(0))).toBe(0);
});

const UNREADABLE = refusalReply(500, { kind: "store", code: "chat-unreadable", message: "broken" });

it("offers to read the record again after another failure, and moves focus to the heading", async () => {
  const user = userEvent.setup();
  const log = stubChatLog({ [chatPath()]: UNREADABLE });
  await renderPanel(log);
  await waitFor(() => {
    expect(statusLine().textContent).toBe("The chat cannot be read.");
  });
  log.replies[chatPath()] = successReply(chatRecord({ seq: 0 }));

  await user.click(screen.getByRole("button", { name: "Try again" }));

  expect(document.activeElement).toBe(heading());
  expect(await screen.findByRole("heading", { level: 2, name: "Claude · build" })).toBeTruthy();
  expect(log.readsOf(chatPath())).toBe(2);
  expect(statusLine().textContent).toBe("");
});

it("moves focus from Try again to the heading when a read that the user did not start removes the button", async () => {
  const log = stubChatLog({ [chatPath()]: UNREADABLE });
  const context = await renderPanel(log);
  const retry = await screen.findByRole("button", { name: "Try again" });
  act(() => {
    retry.focus();
  });
  log.replies[chatPath()] = successReply(chatRecord({ seq: 0 }));

  await act(async () => {
    await context.queryClient.refetchQueries({ queryKey: daemonKeys.chat("SAGA", "SAGA-3", 2) });
  });

  await waitFor(() => {
    expect(retry.isConnected).toBe(false);
  });
  expect(document.activeElement).toBe(heading());
});

it("shows no failure, and keeps the transcript, when a read of the record fails after the log started", async () => {
  const log = logOf(TEXT_LOG.slice(0, 3));
  const context = await renderPanel(log);
  expect(await screen.findByText("Rename the parser module.")).toBeTruthy();
  log.replies[chatPath()] = UNREADABLE;

  await act(async () => {
    await context.queryClient.refetchQueries({ queryKey: daemonKeys.chat("SAGA", "SAGA-3", 2) });
  });

  expect(log.readsOf(chatPath())).toBe(2);
  expect(statusLine().textContent).toBe("");
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(screen.getByText("Rename the parser module.")).toBeTruthy();
});

it("says that the chat cannot be read when the read of a cached record fails, and starts the log only after a read succeeds", async () => {
  const user = userEvent.setup();
  const log = stubChatLog({ [chatPath()]: UNREADABLE });
  await renderPanel(log, { cached: chatRecord({ seq: 2 }) });

  await waitFor(() => {
    expect(statusLine().textContent).toBe("The chat cannot be read.");
  });
  expect(heading().textContent).toBe("Claude · build");
  expect(log.readsOf(eventsPath(0))).toBe(0);
  log.replies[chatPath()] = successReply(chatRecord({ seq: 3 }));

  await user.click(screen.getByRole("button", { name: "Try again" }));
  await readStarted(log, eventsPath(0));
  log.answer(0, { cursor: 3, entries: TEXT_LOG.slice(0, 3) });

  expect(await screen.findByText("Rename the parser module.")).toBeTruthy();
  expect(statusLine().textContent).toBe("");
});

it("starts the log of a cached record only after the record is read again, with its new seq", async () => {
  const record = heldBack();
  const log = stubChatLog({ [chatPath()]: record.reply });
  await renderPanel(log, { cached: chatRecord({ seq: 2 }) });

  expect(await screen.findByRole("heading", { level: 2, name: "Claude · build" })).toBeTruthy();
  expect(statusLine().textContent).toBe("Loading the chat");
  expect(log.readsOf(eventsPath(0))).toBe(0);

  record.answer(successReply(chatRecord({ seq: 5 })));
  await readStarted(log, eventsPath(0));
  log.answer(0, { cursor: 3, entries: TEXT_LOG.slice(0, 3) });
  await readStarted(log, eventsPath(3));
  expect(statusLine().textContent).toBe("Loading the chat");

  log.answer(3, { cursor: 5, entries: TEXT_LOG.slice(3, 5) });
  await waitFor(() => {
    expect(statusLine().textContent).toBe("");
  });
});

it("unmounts the transcript on a reset, moves focus from it to the heading, and announces no old request again", async () => {
  const log = stubChatLog({ [chatPath()]: successReply(chatRecord({ seq: 5 })) });
  await renderPanel(log);
  await readStarted(log, eventsPath(0));
  log.answer(0, { cursor: 5, entries: PERMISSION_LOG.slice(0, 5) });
  const trigger = await screen.findByRole("button", { name: "Waiting on tool: pnpm build" });
  act(() => {
    trigger.focus();
  });
  await readStarted(log, eventsPath(5));

  // The log is now shorter than the cursor of the panel, and still holds the request.
  log.replies[chatPath()] = successReply(chatRecord({ seq: 2 }));

  log.answer(5, { reset: true, cursor: 0 });

  await waitFor(() => {
    expect(screen.queryByRole("log")).toBeNull();
  });
  expect(document.activeElement).toBe(heading());
  expect(statusLine().textContent).toBe("Loading the chat");
  await readStarted(log, chatPath(), 2);

  log.answer(0, { cursor: 2, entries: chatEntries([PERMISSION_LOG[0]!.event, PERMISSION_LOG[4]!.event]) });

  expect(await screen.findByText("Waiting for your permission.")).toBeTruthy();
  await frame();
  expect(spoken()).toEqual([]);
});

it("after a reset shows the transcript, and announces, only when the log reaches the seq of the record read again", async () => {
  const log = stubChatLog({ [chatPath()]: successReply(chatRecord({ seq: 2 })) });
  await renderPanel(log);
  await readStarted(log, eventsPath(0));
  log.answer(0, { cursor: 2, entries: TEXT_LOG.slice(0, 2) });
  await readStarted(log, eventsPath(2));
  log.answer(2, { cursor: 9, entries: TEXT_LOG.slice(2) });
  expect(await screen.findByText("Needs you")).toBeTruthy();
  await frame();
  expect(spoken()).toEqual(["Claude finished the turn"]);
  await readStarted(log, eventsPath(9));
  const rewritten = chatEntries([...TEXT_LOG.slice(0, 5).map(({ event }) => event), turnEnd()]);
  log.replies[chatPath()] = successReply(chatRecord({ seq: 6 }));

  log.answer(9, { reset: true, cursor: 0 });
  await readStarted(log, chatPath(), 2);
  log.answer(0, { cursor: 3, entries: rewritten.slice(0, 3) });
  await readStarted(log, eventsPath(3));

  expect(screen.queryByRole("log")).toBeNull();
  expect(statusLine().textContent).toBe("Loading the chat");

  log.answer(3, { cursor: 6, entries: rewritten.slice(3) });

  expect(await screen.findByRole("log")).toBeTruthy();
  expect(statusLine().textContent).toBe("");
  await frame();
  expect(spoken()).toEqual(["Claude finished the turn"]);
});

it("ends the transcript on a reset of a log whose record had seq 0, and announces no end of a turn", async () => {
  const log = stubChatLog({ [chatPath()]: successReply(chatRecord({ seq: 0 })) });
  await renderPanel(log);
  await readStarted(log, eventsPath(0));
  log.answer(0, { cursor: 2, entries: chatEntries([userMessage("Build."), textChunk("Building.")]) });
  const text = await screen.findByText("Building.");
  expect(screen.getByText("Agent works")).toBeTruthy();
  await readStarted(log, eventsPath(2));
  log.replies[chatPath()] = successReply(chatRecord({ seq: 1 }));

  log.answer(2, { reset: true, cursor: 0 });

  await waitFor(() => {
    expect(text.isConnected).toBe(false);
  });
  expect(screen.queryByText("This chat has no messages yet.")).toBeNull();
  await readStarted(log, chatPath(), 2);
  log.answer(0, { cursor: 1, entries: chatEntries([userMessage("Build again.")]) });

  expect(await screen.findByText("Build again.")).toBeTruthy();
  await frame();
  expect(spoken()).toEqual([]);
});

it("leaves focus that moved out of the transcript where it is on a reset", async () => {
  const log = stubChatLog({ [chatPath()]: successReply(chatRecord({ seq: 5 })) });
  await renderPanel(log);
  await readStarted(log, eventsPath(0));
  log.answer(0, { cursor: 5, entries: PERMISSION_LOG.slice(0, 5) });
  const trigger = await screen.findByRole("button", { name: "Waiting on tool: pnpm build" });
  const close = screen.getByRole("button", { name: "Close the chat" });
  act(() => {
    trigger.focus();
    close.focus();
  });
  await readStarted(log, eventsPath(5));

  log.answer(5, { reset: true, cursor: 0 });

  await waitFor(() => {
    expect(screen.queryByRole("log")).toBeNull();
  });
  expect(document.activeElement).toBe(close);
});

it("moves focus to the heading when it mounts with focusOnMount", async () => {
  await renderPanel(logOf(TEXT_LOG), { focusOnMount: true });

  await waitFor(() => {
    expect(document.activeElement).toBe(heading());
  });
});

it("moves focus to the heading with no scroll when the heading shows whole", async () => {
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  stubHitTest(() => screen.queryByRole("heading", { level: 2 }));
  await renderPanel(logOf(TEXT_LOG), { focusOnMount: true });

  await waitFor(() => {
    expect(document.activeElement).toBe(heading());
  });
  expect(focus.mock.contexts).toEqual([heading()]);
  expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
});

it("moves focus to the heading with the scroll that reveals it when another element covers the heading", async () => {
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  stubHitTest(() => document.body);
  await renderPanel(logOf(TEXT_LOG), { focusOnMount: true });

  await waitFor(() => {
    expect(document.activeElement).toBe(heading());
  });
  expect(focus.mock.contexts).toEqual([heading()]);
  expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: false });
});

it("leaves focus where it is when it mounts without focusOnMount", async () => {
  await renderPanel(logOf(TEXT_LOG));

  expect(await screen.findByRole("log")).toBeTruthy();
  expect(document.activeElement).toBe(document.body);
});

it("makes the message list a silent log with no busy state", async () => {
  await renderPanel(logOf(chatEntries([userMessage("Build.")])));

  const list = await screen.findByRole("log");
  expect(screen.getByText("Agent works")).toBeTruthy();
  expect(list.getAttribute("aria-live")).toBe("off");
  expect(list.hasAttribute("aria-busy")).toBe(false);
});

it("shows no composer and no attachment button", async () => {
  await renderPanel(logOf(TEXT_LOG));

  expect(await screen.findByRole("log")).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button", { name: /attachment/i })).toBeNull();
});

it("calls onClose from the close button", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  await renderPanel(logOf(TEXT_LOG), { onClose });

  await user.click(await screen.findByRole("button", { name: "Close the chat" }));

  expect(onClose).toHaveBeenCalledOnce();
});

it("shows another chat when its host changes the chat with no remount, and reads its cached record again", async () => {
  const user = userEvent.setup();
  const log = logOf(TEXT_LOG);
  log.replies[chatPath(3)] = successReply(chatRecord({ chat: 3, step: "review", seq: 1 }));
  log.serve(0, { cursor: 1, entries: chatEntries([userMessage("Review the parser.")]) }, 3);

  function Host(): ReactNode {
    const [chat, setChat] = useState(2);
    return (
      <>
        <button type="button" onClick={() => { setChat(3); }}>Next chat</button>
        <ChatPanel tag="SAGA" task="SAGA-3" chat={chat} onClose={() => {}} />
      </>
    );
  }

  const context = await renderPanel(log, { host: <Host /> });
  expect(await screen.findByText("Rename the parser module.")).toBeTruthy();
  cacheRecord(context, chatRecord({ chat: 3, step: "review", seq: 0 }));

  await user.click(screen.getByRole("button", { name: "Next chat" }));

  expect(await screen.findByText("Review the parser.")).toBeTruthy();
  expect(screen.getByRole("heading", { level: 2, name: "Claude · review" })).toBeTruthy();
  expect(screen.queryByText("Rename the parser module.")).toBeNull();
  expect(log.readsOf(chatPath(3))).toBe(1);
});

it("shows where a link in agent text goes, and keeps no link to an address of the app", async () => {
  await renderPanel(logOf(chatEntries([
    userMessage("Open the pull request."),
    textChunk("See [https://github.com/acme/app/pull/12](https://evil.example/login) and [the projects](/daemon/projects)."),
    turnEnd(),
  ])));

  const link = await screen.findByRole("link", { name: /^https:\/\/github\.com\/acme\/app\/pull\/12/ });
  expect(link.getAttribute("href")).toBe("https://evil.example/login");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.textContent).toContain("(warning: goes to evil.example)");
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.getByText(/the projects/)).toBeTruthy();
});

it("shows an image in agent text as a link, and loads no image", async () => {
  await renderPanel(logOf(chatEntries([
    userMessage("Show the chart."),
    textChunk("![The chart](https://evil.example/p.png?d=1) and ![](https://evil.example/q.png)"),
    turnEnd(),
  ])));

  const link = await screen.findByRole("link", { name: /^The chart/ });
  expect(link.getAttribute("href")).toBe("https://evil.example/p.png?d=1");
  expect(screen.getByRole("link", { name: /^https:\/\/evil\.example\/q\.png/ })).toBeTruthy();
  expect(document.querySelector("img")).toBeNull();
});

const CODE_REPLY = ["Here is the sum:", "", "```ts", "// sum", "const total = 1 + 2;", "```"].join("\n");

it("shows a fenced block of a complete agent message in Shiki colours", async () => {
  await renderPanel(logOf(chatEntries([userMessage("Add the numbers."), textChunk(CODE_REPLY), turnEnd()])));

  await waitFor(() => expect(colouredTokens(panel()).length).toBeGreaterThan(0), SHIKI_LOAD);
  expect(panel().querySelector("pre.shiki")!.textContent).toBe("// sum\nconst total = 1 + 2;");
});

it("shows a fenced block of complete reasoning in Shiki colours", async () => {
  const user = userEvent.setup();
  await renderPanel(logOf(chatEntries([
    userMessage("Add the numbers."),
    thoughtChunk(CODE_REPLY, "msg_01"),
    textChunk("The sum is 3.", "msg_02"),
    turnEnd(),
  ])));

  await user.click(await screen.findByRole("button", { name: /^Reasoning/ }));

  await waitFor(() => expect(colouredTokens(panel()).length).toBeGreaterThan(0), SHIKI_LOAD);
  expect(colouredTokens(panel()).every((span) => span.closest(".aui-reasoning-content") !== null)).toBe(true);
});

/**
 * Renders a log of 2 entries, the user message and a running reply with a
 * fenced block, and waits until the block shows plain. The next read of the
 * log asks for the entries after entry 2.
 */
async function renderRunningCodeReply(): Promise<ChatLogStub> {
  const log = logOf(chatEntries([userMessage("Add the numbers."), textChunk(CODE_REPLY)]));
  await renderPanel(log);
  await waitFor(() => {
    expect(panel().querySelector(".aui-shiki-streaming pre")?.textContent).toBe("// sum\nconst total = 1 + 2;");
  }, SHIKI_LOAD);
  return log;
}

it("shows a fenced block of an agent message plain while the message runs, and in Shiki colours when it ends", async () => {
  const log = await renderRunningCodeReply();
  expect(colouredTokens(panel())).toEqual([]);

  log.answer(2, { cursor: 3, entries: chatEntries([turnEnd()], 3) });

  await waitFor(() => expect(colouredTokens(panel()).length).toBeGreaterThan(0), SHIKI_LOAD);
  expect(panel().querySelector(".aui-shiki-streaming")).toBeNull();
});

it("shows a fenced block in Shiki colours when a tool call follows its text, while the message still runs", async () => {
  const user = userEvent.setup();
  const log = await renderRunningCodeReply();

  log.answer(2, {
    cursor: 3,
    entries: chatEntries([toolCall({ toolCallId: "t1", title: "Read src/a.ts", kind: "read", status: "in_progress" })], 3),
  });

  await waitFor(() => expect(colouredTokens(panel()).length).toBeGreaterThan(0), SHIKI_LOAD);
  expect(panel().querySelector(".aui-shiki-streaming")).toBeNull();
  await user.click(screen.getByRole("button", { name: "1 tool call" }));
  expect(screen.getByRole("button", { name: "Running tool: Read src/a.ts" })).toBeTruthy();
});

it("gives each kit element whose border has no colour a mark of the kit border rule", async () => {
  const user = userEvent.setup();
  await renderPanel(logOf(chatEntries([
    userMessage("Compare the parsers."),
    thoughtChunk("Looking at both.", "msg_01"),
    textChunk("| Parser | Speed |\n| --- | --- |\n| old | slow |", "msg_02"),
    turnEnd(),
  ])));
  await screen.findByRole("table");

  await user.click(screen.getByRole("button", { name: "More" }));
  await screen.findByRole("menuitem", { name: "Export as Markdown" });

  const bare = bareBorders(document.body);
  expect(bare.map((element) => [...element.classList].find((name) => name.startsWith("aui-"))))
    .toEqual(expect.arrayContaining(["aui-reasoning-root", "aui-md-tr", "aui-action-bar-more-content"]));
  expect(bare.filter((element) => !element.matches(KIT_BORDER_SELECTOR)).map((element) => element.className))
    .toEqual([]);
});

it("keeps focus on the trigger of a running tool when its diff comes", async () => {
  const user = userEvent.setup();
  const log = stubChatLog({ [chatPath()]: successReply(chatRecord({ seq: 2 })) });
  await renderPanel(log);
  await readStarted(log, eventsPath(0));
  log.answer(0, {
    cursor: 2,
    entries: chatEntries([
      userMessage("Edit the file."),
      toolCall({ toolCallId: "t1", title: "Edit src/a.ts", kind: "edit", status: "in_progress" }),
    ]),
  });
  await user.click(await screen.findByRole("button", { name: "1 tool call" }));
  const trigger = screen.getByRole("button", { name: "Running tool: Edit src/a.ts" });
  act(() => {
    trigger.focus();
  });
  await readStarted(log, eventsPath(2));

  log.answer(2, {
    cursor: 3,
    entries: chatEntries([
      toolCallUpdate({
        toolCallId: "t1",
        content: [{ type: "diff", path: "/work/saga/src/a.ts", oldText: "one\n", newText: "two\n" }],
      }),
    ], 3),
  });

  expect(await screen.findByText("src/a.ts")).toBeTruthy();
  expect(document.activeElement).toBe(trigger);
});

/** More lines than a terminal that ended shows. */
const SERVER_OUTPUT = Array.from({ length: 13 }, (_, index) => `request ${String(index + 1)}\n`).join("");

/** A terminal of tool t1 that runs the server and has printed its lines. */
const SERVER_LOG = chatEntries([
  userMessage("Run the server."),
  toolCall({
    toolCallId: "t1",
    title: "pnpm dev",
    kind: "execute",
    status: "in_progress",
    content: [{ type: "terminal", terminalId: "t1" }],
  }),
  toolCallUpdate({ toolCallId: "t1", _meta: { terminal_output: { terminal_id: "t1", data: SERVER_OUTPUT } } }),
]);

it("keeps focus on the trigger of a running terminal when it gives way to the output of the tool", async () => {
  const user = userEvent.setup();
  const log = stubChatLog({ [chatPath()]: successReply(chatRecord({ seq: 3 })) });
  await renderPanel(log);
  await readStarted(log, eventsPath(0));
  log.answer(0, { cursor: 3, entries: SERVER_LOG });
  await user.click(await screen.findByRole("button", { name: "1 tool call" }));
  const trigger = screen.getByRole("button", { name: "Running tool: pnpm dev" });
  const terminal = document.querySelector<HTMLElement>('[data-slot="terminal-block"]')!;
  act(() => {
    trigger.focus();
  });
  await readStarted(log, eventsPath(3));

  log.answer(3, { cursor: 4, entries: chatEntries([toolCallUpdate({ toolCallId: "t1", status: "failed" })], 4) });

  expect(await screen.findByRole("button", { name: "Failed tool: pnpm dev" })).toBe(trigger);
  expect(terminal.isConnected).toBe(false);
  expect(screen.getByText(/request 13/)).toBeTruthy();
  expect(document.activeElement).toBe(trigger);
});

it("moves focus from a control of a terminal to the trigger when the output of the tool takes its place", async () => {
  const user = userEvent.setup();
  const log = stubChatLog({ [chatPath()]: successReply(chatRecord({ seq: 4 })) });
  await renderPanel(log);
  await readStarted(log, eventsPath(0));
  log.answer(0, {
    cursor: 4,
    entries: [
      ...SERVER_LOG,
      ...chatEntries([
        toolCallUpdate({ toolCallId: "t1", _meta: { terminal_exit: { terminal_id: "t1", exit_code: 1, signal: null } } }),
      ], 4),
    ],
  });
  await user.click(await screen.findByRole("button", { name: "1 tool call" }));
  const trigger = screen.getByRole("button", { name: "Running tool: pnpm dev" });
  act(() => {
    screen.getByRole("button", { name: "Show all 13 lines" }).focus();
  });
  await readStarted(log, eventsPath(4));

  log.answer(4, {
    cursor: 5,
    entries: chatEntries([
      toolCallUpdate({
        toolCallId: "t1",
        status: "failed",
        _meta: { terminal_exit: { terminal_id: "t1", exit_code: null, signal: "SIGTERM" } },
      }),
    ], 5),
  });

  expect(await screen.findByRole("button", { name: "Failed tool: pnpm dev" })).toBe(trigger);
  expect(screen.queryByRole("button", { name: "Show all 13 lines" })).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("keeps a tool group that the reader closed closed while its request is open, and opens it for a new request", async () => {
  const user = userEvent.setup();
  const log = stubChatLog({ [chatPath()]: successReply(chatRecord({ seq: 5 })) });
  await renderPanel(log);
  await readStarted(log, eventsPath(0));
  log.answer(0, { cursor: 5, entries: PERMISSION_LOG.slice(0, 5) });
  const group = await screen.findByRole("button", { name: "1 tool call" });
  expect(group.getAttribute("aria-expanded")).toBe("true");

  await user.click(group);
  await readStarted(log, eventsPath(5));
  log.answer(5, { cursor: 6, entries: chatEntries([textChunk("Waiting.")], 6) });
  expect(await screen.findByText("Waiting.")).toBeTruthy();
  expect(group.getAttribute("aria-expanded")).toBe("false");
  await readStarted(log, eventsPath(6));

  log.answer(6, { cursor: 7, entries: chatEntries([permissionResolved("r1", { outcome: "selected", optionId: "allow-once" })], 7) });
  expect(await screen.findByText("Agent works")).toBeTruthy();
  expect(group.getAttribute("aria-expanded")).toBe("false");
  await readStarted(log, eventsPath(7));

  log.answer(7, {
    cursor: 8,
    entries: chatEntries([permissionRequest("r2", { toolCallId: "toolu_04BuildApp", title: "pnpm build" }, [])], 8),
  });

  await waitFor(() => {
    expect(group.getAttribute("aria-expanded")).toBe("true");
  });
});

it("shows the diff of a tool that has a diff and a terminal, and not the terminal", async () => {
  const user = userEvent.setup();
  await renderPanel(logOf(chatEntries([
    userMessage("Format the file."),
    toolCall({
      toolCallId: "t1",
      title: "Format src/a.ts",
      kind: "edit",
      status: "completed",
      content: [
        { type: "terminal", terminalId: "t1" },
        { type: "diff", path: "/work/saga/src/a.ts", oldText: "one\n", newText: "two\n" },
      ],
    }),
    toolCallUpdate({ toolCallId: "t1", _meta: { terminal_output: { terminal_id: "t1", data: "formatted\n" } } }),
    turnEnd(),
  ])));

  await user.click(await screen.findByRole("button", { name: "1 tool call" }));

  expect(screen.getByText("src/a.ts")).toBeTruthy();
  expect(document.querySelector('[data-slot="terminal-block"]')).toBeNull();
  expect(screen.queryByText("formatted")).toBeNull();
});

it("keeps a tool open when the answer to its request comes, and closes it on a click", async () => {
  const user = userEvent.setup();
  const log = stubChatLog({ [chatPath()]: successReply(chatRecord({ seq: 2 })) });
  await renderPanel(log);
  await readStarted(log, eventsPath(0));
  log.answer(0, {
    cursor: 2,
    entries: chatEntries([
      userMessage("Fetch the page."),
      permissionRequest("p1", { toolCallId: "t1", title: "Fetch the page", kind: "fetch" }, [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
      ]),
    ]),
  });
  const tool = await screen.findByRole("button", { name: "Waiting on tool: Fetch the page" });
  expect(tool.getAttribute("aria-expanded")).toBe("true");
  await readStarted(log, eventsPath(2));

  log.answer(2, { cursor: 3, entries: chatEntries([permissionResolved("p1", { outcome: "selected", optionId: "allow" })], 3) });

  expect(await screen.findByRole("button", { name: "Running tool: Fetch the page" })).toBe(tool);
  expect(tool.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("Answered: Allow.")).toBeTruthy();

  await user.click(tool);

  expect(tool.getAttribute("aria-expanded")).toBe("false");
});
