import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import type { Chat, ChatEntry, ChatEvent, Diagnostic, TransportRequest } from "@tasma/protocol";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { CHAT_CLIENT } from "../../src/api/mutations";
import { daemonKeys } from "../../src/api/queries";
import { ChatBody, ChatPanel } from "../../src/components/chat-panel";
import type { RouterContext } from "../../src/routes";
import { useChatDraftStore } from "../../src/store/chat-drafts";
import { useNoticeStore } from "../../src/store/notices";
import { useUiStore } from "../../src/store/ui";
import {
  chatPath,
  chatRecord,
  eventsPath,
  projectChatPath,
  projectChatRecord,
  projectEventsPath,
  stubChatLog,
  type ChatLogStub,
} from "../chat-daemon";
import {
  agentUpdate,
  background,
  BASH_OPTIONS,
  chatEntries,
  CONFIRM_LOG,
  EDIT_LOG,
  FORM_LOG,
  modeOption,
  modeUpdate,
  optionsUpdate,
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
import { heldBack, refusalReply, stubFocusVisible, stubHitTest, stubResizeObservers, stubThreadDom, successReply, testContext } from "../helpers";
import { bareBorders, KIT_BORDER_SELECTOR } from "../kit/borders";
import { colouredTokens, SHIKI_LOAD } from "../kit/shiki";
import { frame } from "../setup/notice-store";

beforeEach(() => {
  stubThreadDom();
  useChatDraftStore.setState({ drafts: new Map() });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type PanelOptions = {
  focusOnMount?: boolean;
  /** True by default. */
  marked?: boolean;
  onClose?: () => void;
  /** The record of chat 2 in the cache before the panel mounts. */
  cached?: Chat;
  /** A host to render in place of the panel of chat 2. */
  host?: ReactNode;
};

async function renderPanel(
  log: ChatLogStub,
  { focusOnMount, marked = true, onClose = () => {}, cached, host }: PanelOptions = {},
) {
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
      marked={marked}
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
function logOf(entries: readonly ChatEntry[], fields: Partial<Chat> = {}): ChatLogStub {
  const log = stubChatLog({ [chatPath()]: successReply(chatRecord({ seq: entries.length, ...fields })) });
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

const COMPOSER = { name: "Message input" };

function composer(): HTMLTextAreaElement {
  return screen.getByRole<HTMLTextAreaElement>("textbox", COMPOSER);
}

async function findComposer(): Promise<HTMLTextAreaElement> {
  return screen.findByRole<HTMLTextAreaElement>("textbox", COMPOSER);
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>("button", { name });
}

const PERMISSION_GROUP = "Waiting on tool: pnpm build Waiting for your permission.";

function permissionGroup(): HTMLElement {
  return screen.getByRole("group", { name: PERMISSION_GROUP });
}

async function findPermissionOption(name: string): Promise<HTMLElement> {
  return within(await screen.findByRole("group", { name: PERMISSION_GROUP })).findByRole("button", { name });
}

/** Whether each option of the open permission request is disabled. */
function optionsDisabled(): boolean[] {
  return within(permissionGroup()).getAllByRole<HTMLButtonElement>("button").map((option) => option.disabled);
}

const FORM_RULE = "Answer each question, then press Send. Dismiss declines the question.";

/** The name of the group of a kit form: its label, then the rule of the form. */
function formGroupName(label: string): string {
  return `${label} ${FORM_RULE}`;
}

const RELEASE_LABEL = "Waiting on tool: Asking for your input Please answer the following questions.";

const RELEASE_GROUP = formGroupName(RELEASE_LABEL);

const FORM_LABEL = "The deploy server needs two answers.";

const FORM_GROUP = formGroupName(FORM_LABEL);

const REFUSAL_GROUP = formGroupName("Model A declined this request. Retry with Model B?");

function optionNames(group: HTMLElement): (string | null)[] {
  return within(group).getAllByRole("button").map((option) => option.textContent);
}

function posts(log: ChatLogStub): TransportRequest[] {
  return log.requests.filter(({ method }) => method === "POST");
}

function notices() {
  return useNoticeStore.getState().notices;
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

/** The heading of the panel and the line under it, which holds the state. */
function header(): HTMLElement {
  return heading().parentElement!;
}

const QUESTION = questionRequest("r1", { message: "Which one?" });

it("shows no state in the header of a chat that is not marked and not busy", async () => {
  await renderPanel(logOf(chatEntries([userMessage("Build."), turnEnd()])), { marked: false });
  await waitFor(() => {
    expect(screen.getByRole("log")).toBeTruthy();
    expect(statusLine().textContent).toBe("");
  });

  expect(within(header()).queryByText("Needs you")).toBeNull();
});

it.each<[string, readonly ChatEvent[], string]>([
  ["Agent works while a turn runs", [userMessage("Build.")], "Agent works"],
  ["Needs you while the turn waits at a request", [userMessage("Build."), QUESTION], "Needs you"],
])("shows %s in the header of a chat that is not marked", async (_case, events, text) => {
  await renderPanel(logOf(chatEntries(events)), { marked: false });

  expect(await within(header()).findByText(text)).toBeTruthy();
});

it("shows the state of a chat that is not marked when only its busy time changes", async () => {
  const log = stubChatLog({ [chatPath()]: successReply(chatRecord({ seq: 2 })) });
  await renderPanel(log, { marked: false });
  await readStarted(log, eventsPath(0));
  log.answer(0, { cursor: 2, entries: chatEntries([userMessage("Build."), turnEnd()]) });
  await waitFor(() => {
    expect(statusLine().textContent).toBe("");
  });
  expect(within(header()).queryByText("Needs you")).toBeNull();

  log.answer(2, { cursor: 3, entries: chatEntries([QUESTION], 3) });
  expect(await within(header()).findByText("Needs you")).toBeTruthy();

  log.answer(3, { cursor: 4, entries: chatEntries([turnEnd()], 4) });
  await waitFor(() => {
    expect(within(header()).queryByText("Needs you")).toBeNull();
  });
});

it("writes seen from the composer of a chat with no mode picker when its end stays in view", async () => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ bottom: 700 } as DOMRect);
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
  onTestFinished(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  });
  const log = logOf(TEXT_LOG);
  const seenPath = `${chatPath()}/seen`;
  log.replies[`POST ${seenPath}`] = successReply(chatRecord({ seq: TEXT_LOG.length, seen: TEXT_LOG.length }));
  await renderPanel(log);
  expect(await screen.findByText("Rename the parser module.")).toBeTruthy();
  expect(screen.queryByRole("button", MODE_TRIGGER)).toBeNull();

  await waitFor(() => {
    const sent = log.requests.filter(({ path }) => path === seenPath).map(({ body }) => body);
    expect(sent).toEqual([{ seq: TEXT_LOG.length, client: CHAT_CLIENT }]);
  }, { timeout: 3_000 });
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
  await waitFor(() => {
    expect(statusLine().textContent).toBe("");
  });
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

it("opens the tool group of a new permission request, announces it, and shows one button for each option", async () => {
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
  expect(optionNames(permissionGroup())).toEqual(BASH_OPTIONS.map(({ name }) => name as string));
  expect(screen.queryByText(/^Options: /)).toBeNull();
  expect(screen.getByText("Needs you")).toBeTruthy();
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
  expect(await screen.findByText(`The chat failed: ${reason}`)).toBeTruthy();
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

it("shows an open question in the kit form, with its fields, their choices and the free text", async () => {
  await renderPanel(logOf(QUESTIONS_LOG.slice(0, 4)));

  expect(await screen.findByText("Please answer the following questions.")).toBeTruthy();
  const version = screen.getByRole("group", { name: "Which version should the release take?" });
  expect(within(version).getByText("Version")).toBeTruthy();
  expect(within(version).getByRole("button", { name: /^2\.0\.0/ }).getAttribute("aria-pressed")).toBe("false");
  expect(within(version).getByRole("textbox", { name: "Which version should the release take?" })).toBeTruthy();
  const checks = screen.getByRole("group", { name: "Which checks should run first?" });
  expect(within(checks).getByText("Checks")).toBeTruthy();
  expect(within(checks).getByRole("button", { name: /^lint/ })).toBeTruthy();
  expect(screen.getByText("Waiting for your answer.")).toBeTruthy();
  expect(button("Send").disabled).toBe(true);
  expect(button("Dismiss").disabled).toBe(false);
});

it("shows a question with no tool in the transcript, by the description of a field with no title", async () => {
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

  const group = await screen.findByRole("group", { name: formGroupName("Which colour?") });
  const field = within(group).getByRole("group", { name: "The colour of the badge." });
  expect(optionNames(field)).toEqual(["red", "blue"]);
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

it.each(["task-not-found", "project-not-found"] as const)("says that a chat does not exist after a refusal %s, with no Try again", async (code) => {
  const log = stubChatLog({ [chatPath()]: refusalReply(404, { kind: "store", code, message: "gone" }) });
  await renderPanel(log);

  await waitFor(() => {
    expect(statusLine().textContent).toBe("This chat does not exist.");
  });
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
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

it("says that the chat does not exist when a read of the record after the log started says so", async () => {
  const log = logOf(TEXT_LOG.slice(0, 3));
  const context = await renderPanel(log);
  expect(await screen.findByText("Rename the parser module.")).toBeTruthy();
  log.replies[chatPath()] = refusalReply(404, { kind: "store", code: "task-not-found", message: "no task SAGA-3" });

  await act(async () => {
    await context.queryClient.refetchQueries({ queryKey: daemonKeys.chat("SAGA", "SAGA-3", 2) });
  });

  await waitFor(() => {
    expect(statusLine().textContent).toBe("This chat does not exist.");
  });
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
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
  await waitFor(() => {
    expect(statusLine().textContent).toBe("");
  });
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

it("shows a composer with no attachment button", async () => {
  await renderPanel(logOf(TEXT_LOG));

  expect(await screen.findByRole("log")).toBeTruthy();
  expect(composer()).toBeTruthy();
  expect(button("Send message")).toBeTruthy();
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
        <ChatPanel tag="SAGA" task="SAGA-3" chat={chat} marked onClose={() => {}} />
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

it("shows each line of agent text on its own line, also when the lines come in two parts", async () => {
  await renderPanel(logOf(chatEntries([
    userMessage("Frame the scope."),
    textChunk("**Problem**: one\n", "msg_01"),
    textChunk("**Outcome**: two", "msg_01"),
    turnEnd(),
  ])));

  const paragraph = (await screen.findByText("Outcome")).closest("p");
  expect(paragraph?.querySelectorAll("br")).toHaveLength(1);
  expect(paragraph?.textContent).toBe("Problem: one\nOutcome: two");
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

const WRITTEN = successReply(chatRecord({ seq: 5 }));

const MESSAGES_PATH = `${chatPath()}/messages`;

const CANCEL_PATH = `${chatPath()}/cancel`;

const PERMISSION_PATH = `${chatPath()}/permissions/r1`;

function refused(status: number, code: "turn-running" | "already-answered" | "malformed-request") {
  return refusalReply(status, { kind: "daemon", code, message: `refused: ${code}` });
}

/** A log of the entries, served at once, and the write of each route answered with `WRITTEN`. */
function writableLogOf(entries: readonly ChatEntry[], ...paths: string[]): ChatLogStub {
  const log = logOf(entries);
  for (const path of paths) {
    log.replies[`POST ${path}`] = WRITTEN;
  }
  return log;
}

it("posts the message of the composer with the client of the window, and clears the composer", async () => {
  const user = userEvent.setup();
  const log = writableLogOf(TEXT_LOG, MESSAGES_PATH);
  await renderPanel(log);

  await user.type(await findComposer(), "Split the lexer.");
  await user.click(button("Send message"));

  await waitFor(() => {
    expect(posts(log)).toEqual([
      { method: "POST", path: MESSAGES_PATH, body: { text: "Split the lexer.", client: CHAT_CLIENT } },
    ]);
  });
  expect(composer().value).toBe("");
});

it("shows the log of a chat of a project in the body, and posts a message to the route of the project", async () => {
  const user = userEvent.setup();
  const messagesPath = `${projectChatPath()}/messages`;
  const log = stubChatLog({
    [projectChatPath()]: successReply(projectChatRecord({ seq: TEXT_LOG.length })),
    [`POST ${messagesPath}`]: successReply(projectChatRecord({ seq: TEXT_LOG.length + 1 })),
  }, projectEventsPath);
  log.serve(0, { cursor: TEXT_LOG.length, entries: [...TEXT_LOG] });

  function Host(): ReactNode {
    const headingRef = useRef<HTMLHeadingElement>(null);
    return (
      <section>
        <h2 ref={headingRef} tabIndex={-1}>Plan the release</h2>
        <ChatBody tag="SAGA" task={undefined} chat={2} headingRef={headingRef} />
      </section>
    );
  }

  await renderPanel(log, { host: <Host /> });
  expect(await screen.findByText("Rename the parser module.")).toBeTruthy();
  await user.type(await findComposer(), "Split the lexer.{Enter}");

  await waitFor(() => {
    expect(posts(log)).toEqual([
      { method: "POST", path: messagesPath, body: { text: "Split the lexer.", client: CHAT_CLIENT } },
    ]);
  });
  expect(log.readsOf(projectChatPath())).toBeGreaterThan(0);
  expect(log.readsOf(projectEventsPath(0))).toBe(1);
  expect(log.paths.filter((path) => path.includes("/tasks/"))).toEqual([]);
});

it("puts a refused message back in the composer, and opens its notice", async () => {
  const user = userEvent.setup();
  const log = logOf(TEXT_LOG);
  log.replies[`POST ${MESSAGES_PATH}`] = refused(409, "turn-running");
  await renderPanel(log);

  await user.type(await findComposer(), "Split the lexer.{Enter}");

  await waitFor(() => {
    expect(composer().value).toBe("Split the lexer.");
  });
  expect(posts(log)).toHaveLength(1);
  expect(notices()).toEqual([
    expect.objectContaining({
      form: "failure",
      title: "The message to chat 2 of SAGA-3 was not sent.",
      line: "Chat 2 stops for a restart. Write to the new chat when it opens.",
      words: ["daemon/turn-running · refused: turn-running"],
    }),
  ]);
});

/** The labels of Stop and Send of the composer, in page order. */
function composerButtons(): (string | null)[] {
  return screen.queryAllByRole("button", { name: /^(Stop generating|Send message)$/ }).map((one) => one.getAttribute("aria-label"));
}

const TURN_PLACEHOLDER = "Queue another message";

const IDLE_PLACEHOLDER = "Send a message...";

it.each<[string, readonly ChatEntry[]]>([
  ["runs", chatEntries([userMessage("Build.")])],
  ["waits at a request", PERMISSION_LOG.slice(0, 5)],
])("shows only Stop while a turn %s and the message input is empty, and Stop posts the cancel", async (_name, entries) => {
  const user = userEvent.setup();
  const log = writableLogOf(entries, CANCEL_PATH);
  await renderPanel(log);

  await user.click(await screen.findByRole("button", { name: "Stop generating" }));

  expect(composerButtons()).toEqual(["Stop generating"]);
  await waitFor(() => {
    expect(posts(log)).toEqual([{ method: "POST", path: CANCEL_PATH, body: { client: CHAT_CLIENT } }]);
  });
});

it("posts no cancel and keeps the text when Escape is pressed in the composer during a turn", async () => {
  const user = userEvent.setup();
  const log = writableLogOf(chatEntries([userMessage("Build.")]), CANCEL_PATH);
  await renderPanel(log);
  await screen.findByRole("button", { name: "Stop generating" });

  await user.type(composer(), "Split the lexer.{Escape}");
  await act(async () => {});

  expect(posts(log)).toEqual([]);
  expect(composer().value).toBe("Split the lexer.");
  expect(composerButtons()).toEqual(["Send message"]);
  expect(composer().placeholder).toBe(TURN_PLACEHOLDER);
});

const SPACES_AND_NEW_LINE = "  {Shift>}{Enter}{/Shift}";

it.each<[string, readonly ChatEntry[], string, string, string, boolean]>([
  ["an idle chat and an empty input", TEXT_LOG, IDLE_PLACEHOLDER, "", "Send message", true],
  ["an idle chat and a text", TEXT_LOG, IDLE_PLACEHOLDER, "Then test it.", "Send message", false],
  ["an idle chat and only spaces", TEXT_LOG, IDLE_PLACEHOLDER, "   ", "Send message", true],
  ["a turn and an empty input", chatEntries([userMessage("Build.")]), TURN_PLACEHOLDER, "", "Stop generating", false],
  ["a turn and a text", chatEntries([userMessage("Build.")]), TURN_PLACEHOLDER, "Then test it.", "Send message", false],
  ["a turn and only spaces and a new line", chatEntries([userMessage("Build.")]), TURN_PLACEHOLDER, SPACES_AND_NEW_LINE, "Stop generating", false],
  ["a turn at a request and an empty input", PERMISSION_LOG.slice(0, 5), TURN_PLACEHOLDER, "", "Stop generating", false],
  ["a turn at a request and a text", PERMISSION_LOG.slice(0, 5), TURN_PLACEHOLDER, "Then test it.", "Send message", false],
])("shows one button for %s", async (_case, entries, placeholder, typed, label, disabled) => {
  const user = userEvent.setup();
  await renderPanel(logOf(entries));
  await waitFor(() => {
    expect(composer().placeholder).toBe(placeholder);
  });

  if (typed !== "") {
    await user.type(composer(), typed);
  }

  expect(composerButtons()).toEqual([label]);
  expect(button(label).disabled).toBe(disabled);
});

it("changes Stop to Send at the first character during a turn, and back when the character is deleted", async () => {
  const user = userEvent.setup();
  await renderPanel(logOf(chatEntries([userMessage("Build.")])));
  await screen.findByRole("button", { name: "Stop generating" });

  await user.type(composer(), "T");

  expect(composerButtons()).toEqual(["Send message"]);
  expect(button("Send message").disabled).toBe(false);

  await user.keyboard("{Backspace}");

  expect(composerButtons()).toEqual(["Stop generating"]);
});

it("does nothing on Enter in an empty message input during a turn", async () => {
  const user = userEvent.setup();
  const log = writableLogOf(chatEntries([userMessage("Build.")]), CANCEL_PATH, MESSAGES_PATH);
  await renderPanel(log);
  await screen.findByRole("button", { name: "Stop generating" });

  await user.type(composer(), "{Enter}");
  await act(async () => {});

  expect(posts(log)).toEqual([]);
  expect(composer().value).toBe("");
  expect(composerButtons()).toEqual(["Stop generating"]);
});

it("moves focus from Send to the message input when a key press on Send sends the text during a turn", async () => {
  const user = userEvent.setup();
  const log = writableLogOf(chatEntries([userMessage("Build.")]), MESSAGES_PATH);
  await renderPanel(log);
  await screen.findByRole("button", { name: "Stop generating" });
  await user.type(composer(), "Then test it.");
  act(() => {
    button("Send message").focus();
  });

  await user.keyboard("{Enter}");

  await waitFor(() => {
    expect(posts(log)).toEqual([{ method: "POST", path: MESSAGES_PATH, body: { text: "Then test it.", client: CHAT_CLIENT } }]);
  });
  expect(composer().value).toBe("");
  expect(composerButtons()).toEqual(["Stop generating"]);
  expect(document.activeElement).toBe(composer());
});

it("moves focus from Stop to the heading when a refused send puts its text back during a turn", async () => {
  const user = userEvent.setup();
  const log = logOf(chatEntries([userMessage("Build.")]));
  const write = heldBack();
  log.replies[`POST ${MESSAGES_PATH}`] = write.reply;
  await renderPanel(log);
  await screen.findByRole("button", { name: "Stop generating" });
  await user.type(composer(), "Then test it.{Enter}");
  const stop = await screen.findByRole("button", { name: "Stop generating" });
  act(() => {
    stop.focus();
  });

  write.answer(refused(409, "turn-running"));

  await waitFor(() => {
    expect(composer().value).toBe("Then test it.");
  });
  expect(composerButtons()).toEqual(["Send message"]);
  expect(document.activeElement).toBe(heading());
});

function ownTurnStarts(log: ChatLogStub, after: number): void {
  log.answer(after, { cursor: after + 1, entries: chatEntries([background({ ownTurn: true })], after + 1) });
}

describe("with a background job and an own turn", () => {
  const ENDED = [userMessage("Build."), turnEnd()];

  it.each<[string, readonly ChatEvent[], string, readonly string[]]>([
    ["a job wait", [userMessage("Build."), background({ job: true }), turnEnd()], "Agent works", ["Send message"]],
    ["an own turn", [...ENDED, background({ job: true, ownTurn: true })], "Agent works", ["Stop generating"]],
    ["the end of both", [...ENDED, background({ job: true, ownTurn: true }), background()], "Needs you", ["Send message"]],
  ])("shows the state and the buttons of %s", async (_case, events, state, buttons) => {
    await renderPanel(logOf(chatEntries(events)));

    await waitFor(() => {
      expect(composerButtons()).toEqual(buttons);
    });
    expect(within(header()).getByText(state)).toBeTruthy();
  });

  it("shows the state of a job wait in a chat that is not marked, because the chat is busy", async () => {
    await renderPanel(logOf(chatEntries([userMessage("Build."), background({ job: true }), turnEnd()])), { marked: false });

    await screen.findByRole("button", { name: "Send message" });
    expect(within(header()).getByText("Agent works")).toBeTruthy();
  });

  it("sends a message during a job wait", async () => {
    const user = userEvent.setup();
    const entries = chatEntries([userMessage("Build."), background({ job: true }), turnEnd()]);
    const log = writableLogOf(entries, MESSAGES_PATH);
    await renderPanel(log);

    await user.type(await findComposer(), "Then test it.{Enter}");

    await waitFor(() => {
      expect(posts(log)).toEqual([{ method: "POST", path: MESSAGES_PATH, body: { text: "Then test it.", client: CHAT_CLIENT } }]);
    });
  });

  it("keeps the buttons of a request when its own turn ends, and posts the answer", async () => {
    const user = userEvent.setup();
    const log = writableLogOf(chatEntries([
      ...ENDED,
      background({ ownTurn: true }),
      permissionRequest("r1", { toolCallId: "t1", title: "pnpm build", kind: "execute" }, BASH_OPTIONS),
      background(),
    ]), PERMISSION_PATH);
    await renderPanel(log);

    await user.click(await findPermissionOption("Yes"));

    await waitFor(() => {
      expect(posts(log)).toEqual([
        { method: "POST", path: PERMISSION_PATH, body: { optionId: "allow-once", client: CHAT_CLIENT } },
      ]);
    });
    expect(within(header()).getByText("Needs you")).toBeTruthy();
  });

  it("posts the cancel from Stop in an own turn", async () => {
    const user = userEvent.setup();
    const log = writableLogOf(chatEntries([...ENDED, background({ ownTurn: true })]), CANCEL_PATH);
    await renderPanel(log);

    await user.click(await screen.findByRole("button", { name: "Stop generating" }));

    await waitFor(() => {
      expect(posts(log)).toEqual([{ method: "POST", path: CANCEL_PATH, body: { client: CHAT_CLIENT } }]);
    });
  });

  it("keeps focus on Send when an own turn starts, and Enter in the message input posts the message", async () => {
    const user = userEvent.setup();
    const log = writableLogOf(chatEntries(ENDED), MESSAGES_PATH);
    await renderPanel(log);
    await user.type(await findComposer(), "Then test it.");
    act(() => {
      button("Send message").focus();
    });

    ownTurnStarts(log, 2);

    await waitFor(() => {
      expect(composer().placeholder).toBe(TURN_PLACEHOLDER);
    });
    expect(composerButtons()).toEqual(["Send message"]);
    expect(document.activeElement).toBe(button("Send message"));
    act(() => {
      composer().focus();
    });
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(posts(log)).toEqual([{ method: "POST", path: MESSAGES_PATH, body: { text: "Then test it.", client: CHAT_CLIENT } }]);
    });
  });

  it("moves focus from Stop to the heading when an own turn ends", async () => {
    const log = logOf(chatEntries([...ENDED, background({ ownTurn: true })]));
    await renderPanel(log);
    const stop = await screen.findByRole("button", { name: "Stop generating" });
    act(() => {
      stop.focus();
    });

    log.answer(3, { cursor: 4, entries: chatEntries([background()], 4) });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Stop generating" })).toBeNull();
    });
    expect(document.activeElement).toBe(heading());
    expect(composerButtons()).toEqual(["Send message"]);
  });

  it("keeps the text, an enabled Send and the focus on Send when an own turn ends", async () => {
    const user = userEvent.setup();
    const log = logOf(chatEntries([...ENDED, background({ ownTurn: true })]));
    await renderPanel(log);
    await screen.findByRole("button", { name: "Stop generating" });
    await user.type(composer(), "Then test it.");
    act(() => {
      button("Send message").focus();
    });

    log.answer(3, { cursor: 4, entries: chatEntries([background()], 4) });

    await waitFor(() => {
      expect(composer().placeholder).toBe(IDLE_PLACEHOLDER);
    });
    expect(composer().value).toBe("Then test it.");
    expect(composerButtons()).toEqual(["Send message"]);
    expect(button("Send message").disabled).toBe(false);
    expect(document.activeElement).toBe(button("Send message"));
  });

  it("moves focus from a control of a message to the heading when an own turn removes it", async () => {
    const log = logOf(TEXT_LOG);
    await renderPanel(log);
    const copy = await screen.findByRole("button", { name: "Copy" });
    act(() => {
      copy.focus();
    });

    ownTurnStarts(log, TEXT_LOG.length);

    await screen.findByRole("button", { name: "Stop generating" });
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
    expect(document.activeElement).toBe(heading());
  });

  it("leaves the focus alone when an own turn removes a control that the focus already left", async () => {
    const log = logOf(TEXT_LOG);
    await renderPanel(log);
    const copy = await screen.findByRole("button", { name: "Copy" });
    act(() => {
      copy.focus();
      copy.blur();
    });

    ownTurnStarts(log, TEXT_LOG.length);

    await screen.findByRole("button", { name: "Stop generating" });
    expect(document.activeElement).toBe(document.body);
  });

  it("moves focus from the item of an open menu of a message to the heading when an own turn removes it", async () => {
    const user = userEvent.setup();
    const log = logOf(TEXT_LOG);
    await renderPanel(log);
    const more = await screen.findByRole("button", { name: "More" });
    act(() => {
      more.focus();
    });
    await user.keyboard("{Enter}");
    const item = await screen.findByRole("menuitem", { name: "Export as Markdown" });
    await waitFor(() => {
      expect(document.activeElement).toBe(item);
    });

    ownTurnStarts(log, TEXT_LOG.length);

    await waitFor(() => {
      expect(item.isConnected).toBe(false);
    });
    expect(document.activeElement).toBe(heading());
  });

  it("moves focus to the heading when an own turn removes the control that an inactive window holds", async () => {
    const log = logOf(TEXT_LOG);
    await renderPanel(log);
    const copy = await screen.findByRole("button", { name: "Copy" });
    act(() => {
      copy.focus();
      copy.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });

    ownTurnStarts(log, TEXT_LOG.length);

    await screen.findByRole("button", { name: "Stop generating" });
    expect(document.activeElement).toBe(heading());
  });

  it("moves focus to the heading from a control that sends `focusout` as it leaves, as Chrome does", async () => {
    const log = logOf(TEXT_LOG);
    await renderPanel(log);
    const copy = await screen.findByRole("button", { name: "Copy" });
    act(() => {
      copy.focus();
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the spy calls it with its own `this`
    const remove = Node.prototype.removeChild;
    vi.spyOn(Node.prototype, "removeChild").mockImplementation(function <T extends Node>(this: Node, child: T): T {
      if (child.contains(copy) && document.activeElement === copy) {
        copy.blur();
      }
      return remove.call(this, child) as T;
    });

    ownTurnStarts(log, TEXT_LOG.length);

    await screen.findByRole("button", { name: "Stop generating" });
    expect(document.activeElement).toBe(heading());
  });

  it("moves focus from Send to the message input when a key press sends the draft, before the message is in the log", async () => {
    const user = userEvent.setup();
    const log = logOf(chatEntries(ENDED));
    const write = heldBack();
    log.replies[`POST ${MESSAGES_PATH}`] = write.reply;
    await renderPanel(log);
    await user.type(await findComposer(), "Then test it.");
    act(() => {
      button("Send message").focus();
    });

    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(document.activeElement).toBe(composer());
    });
    expect(posts(log)).toHaveLength(1);
    write.answer(WRITTEN);
  });

  it("leaves focus in the empty message input when Stop takes the place of Send", async () => {
    const log = logOf(chatEntries(ENDED));
    await renderPanel(log);
    const input = await findComposer();
    act(() => {
      input.focus();
    });

    ownTurnStarts(log, 2);

    await screen.findByRole("button", { name: "Stop generating" });
    expect(document.activeElement).toBe(composer());
  });

  it("leaves focus in the empty message input when Stop leaves", async () => {
    const log = logOf(chatEntries([...ENDED, background({ ownTurn: true })]));
    await renderPanel(log);
    await screen.findByRole("button", { name: "Stop generating" });
    act(() => {
      composer().focus();
    });

    log.answer(3, { cursor: 4, entries: chatEntries([background()], 4) });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Stop generating" })).toBeNull();
    });
    expect(document.activeElement).toBe(composer());
  });
});

it("opens a notice when the daemon refuses Stop", async () => {
  const user = userEvent.setup();
  const log = logOf(chatEntries([userMessage("Build.")]));
  log.replies[`POST ${CANCEL_PATH}`] = refused(400, "malformed-request");
  await renderPanel(log);

  await user.click(await screen.findByRole("button", { name: "Stop generating" }));

  await waitFor(() => {
    expect(notices()).toEqual([
      expect.objectContaining({
        title: "The turn of chat 2 of SAGA-3 did not stop.",
        line: "The daemon refused it, so nothing changed in the chat. Its own words are below.",
      }),
    ]);
  });
});

it("posts the message on Enter during a turn, and clears the composer", async () => {
  const user = userEvent.setup();
  const log = writableLogOf(chatEntries([userMessage("Build.")]), MESSAGES_PATH);
  await renderPanel(log);

  await user.type(await findComposer(), "Then test it.{Enter}");

  await waitFor(() => {
    expect(posts(log)).toEqual([{ method: "POST", path: MESSAGES_PATH, body: { text: "Then test it.", client: CHAT_CLIENT } }]);
  });
  expect(composer().value).toBe("");
});

it("asks to queue another message during a turn, and to send a message after it", async () => {
  const log = logOf(chatEntries([userMessage("Build.")]));
  await renderPanel(log);
  expect((await findComposer()).placeholder).toBe(TURN_PLACEHOLDER);

  log.answer(1, { cursor: 2, entries: chatEntries([turnEnd()], 2) });

  await waitFor(() => {
    expect(composer().placeholder).toBe(IDLE_PLACEHOLDER);
  });
  expect(composerButtons()).toEqual(["Send message"]);
});

it("keeps a permission request open to an answer after a message that comes during it", async () => {
  const user = userEvent.setup();
  const log = writableLogOf(PERMISSION_LOG.slice(0, 5), PERMISSION_PATH);
  await renderPanel(log);
  await findPermissionOption("Yes");

  log.answer(5, { cursor: 6, entries: chatEntries([userMessage("Use the other script.")], 6) });
  expect(await screen.findByText("Use the other script.")).toBeTruthy();
  await user.click(await findPermissionOption("Yes"));

  await waitFor(() => {
    expect(posts(log)).toEqual([{ method: "POST", path: PERMISSION_PATH, body: { optionId: "allow-once", client: CHAT_CLIENT } }]);
  });
});

/** A host that shows chat 2 of SAGA-3, and chat 3 after a click on Other chat. */
function TwoChats(): ReactNode {
  const [chat, setChat] = useState(2);
  return (
    <>
      <button type="button" onClick={() => { setChat(chat === 2 ? 3 : 2); }}>Other chat</button>
      <ChatPanel tag="SAGA" task="SAGA-3" chat={chat} marked onClose={() => {}} />
    </>
  );
}

/** Chat 2 with the log of the stub, and chat 3 with a short log, in a host that shows one of them. */
async function renderTwoChats(log: ChatLogStub): Promise<void> {
  log.replies[chatPath(3)] = successReply(chatRecord({ chat: 3, step: "review", seq: 1 }));
  log.serve(0, { cursor: 1, entries: chatEntries([userMessage("Review the parser."), turnEnd()]) }, 3);
  await renderPanel(log, { host: <TwoChats /> });
}

/** Shows the other chat, and waits for a text of its log. */
async function showOtherChat(user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> {
  await user.click(screen.getByRole("button", { name: "Other chat" }));
  expect(await screen.findByText(text)).toBeTruthy();
}

it("keeps the draft of a chat when its host shows another chat and comes back", async () => {
  const user = userEvent.setup();
  await renderTwoChats(logOf(TEXT_LOG));
  await user.type(await findComposer(), "Rename the tests too.");

  await showOtherChat(user, "Review the parser.");
  expect(composer().value).toBe("");

  await showOtherChat(user, "Rename the parser module.");
  await waitFor(() => {
    expect(composer().value).toBe("Rename the tests too.");
  });
});

it("keeps a message that the daemon refuses after its chat closed, and shows it when the chat opens again", async () => {
  const user = userEvent.setup();
  const log = logOf(TEXT_LOG);
  const write = heldBack();
  log.replies[`POST ${MESSAGES_PATH}`] = write.reply;
  await renderTwoChats(log);
  await user.type(await findComposer(), "Split the lexer.{Enter}");
  await waitFor(() => {
    expect(posts(log)).toHaveLength(1);
  });
  await showOtherChat(user, "Review the parser.");

  write.answer(refused(400, "malformed-request"));

  await waitFor(() => {
    expect(notices()).toEqual([expect.objectContaining({ title: "The message to chat 2 of SAGA-3 was not sent." })]);
  });
  expect(composer().value).toBe("");
  await showOtherChat(user, "Rename the parser module.");
  await waitFor(() => {
    expect(composer().value).toBe("Split the lexer.");
  });
});

it("puts a message that the daemon refuses in front of the text of a composer of its chat that opened after the send", async () => {
  const user = userEvent.setup();
  const log = logOf(TEXT_LOG);
  const write = heldBack();
  log.replies[`POST ${MESSAGES_PATH}`] = write.reply;
  await renderTwoChats(log);
  await user.type(await findComposer(), "Split the lexer.{Enter}");
  await waitFor(() => {
    expect(posts(log)).toHaveLength(1);
  });
  await showOtherChat(user, "Review the parser.");
  await showOtherChat(user, "Rename the parser module.");
  await user.type(composer(), "Then test it.");

  write.answer(refused(400, "malformed-request"));

  await waitFor(() => {
    expect(composer().value).toBe("Split the lexer.\nThen test it.");
  });
});

it("posts the option of a clicked button, locks the buttons, and shows the answer with focus on its line when the log closes the request", async () => {
  const user = userEvent.setup();
  const log = writableLogOf(PERMISSION_LOG.slice(0, 5), PERMISSION_PATH);
  await renderPanel(log);

  await user.click(await findPermissionOption("Yes"));

  await waitFor(() => {
    expect(posts(log)).toEqual([
      { method: "POST", path: PERMISSION_PATH, body: { optionId: "allow-once", client: CHAT_CLIENT } },
    ]);
  });
  expect(optionsDisabled()).toEqual([true, true, true]);

  log.answer(5, { cursor: 6, entries: chatEntries([permissionResolved("r1", { outcome: "selected", optionId: "allow-once" })], 6) });

  const answered = await screen.findByText("Answered: Yes.");
  expect(screen.queryByRole("group", { name: PERMISSION_GROUP })).toBeNull();
  expect(document.activeElement).toBe(answered.parentElement);
});

it("closes a request that another window answers, with no write, and moves focus from its buttons to its line", async () => {
  const log = logOf(PERMISSION_LOG.slice(0, 5));
  await renderPanel(log);
  const yes = await findPermissionOption("Yes");
  act(() => {
    yes.focus();
  });

  log.answer(5, {
    cursor: 6,
    entries: chatEntries([
      { kind: "permission-resolved", request: "r1", outcome: { outcome: "selected", optionId: "reject" }, client: "app-0a1b2c3d" },
    ], 6),
  });

  const answered = await screen.findByText("Answered: No.");
  expect(screen.queryByRole("group", { name: PERMISSION_GROUP })).toBeNull();
  expect(posts(log)).toEqual([]);
  expect(document.activeElement).toBe(answered.parentElement);
});

it("opens the warning notice for an answer that came too late, and keeps the buttons locked until the log closes the request", async () => {
  const user = userEvent.setup();
  const log = logOf(PERMISSION_LOG.slice(0, 5));
  log.replies[`POST ${PERMISSION_PATH}`] = refused(409, "already-answered");
  await renderPanel(log);

  await user.click(await findPermissionOption("Yes"));

  await waitFor(() => {
    expect(notices()).toEqual([
      expect.objectContaining({
        form: "warning",
        title: "Your answer to chat 2 of SAGA-3 was not used.",
        line: "The request was already closed: another window answered it, or it was cancelled or ended. "
          + "The chat shows the outcome.",
      }),
    ]);
  });
  expect(optionsDisabled()).toEqual([true, true, true]);
  expect(within(permissionGroup()).queryByRole("alert")).toBeNull();

  log.answer(5, { cursor: 6, entries: chatEntries([permissionResolved("r1", { outcome: "selected", optionId: "reject" })], 6) });

  expect(await screen.findByText("Answered: No.")).toBeTruthy();
  expect(screen.queryByRole("group", { name: PERMISSION_GROUP })).toBeNull();
});

it("shows Not sent and makes the buttons active again when the daemon refuses an answer, and opens its notice", async () => {
  const user = userEvent.setup();
  const log = logOf(PERMISSION_LOG.slice(0, 5));
  log.replies[`POST ${PERMISSION_PATH}`] = refused(400, "malformed-request");
  await renderPanel(log);

  await user.click(await findPermissionOption("Yes"));

  expect((await within(permissionGroup()).findByRole("alert")).textContent).toBe("Not sent. The notice gives the reason.");
  expect(optionsDisabled()).toEqual([false, false, false]);
  expect(notices()).toEqual([
    expect.objectContaining({
      form: "failure",
      title: "The answer to chat 2 of SAGA-3 was not sent.",
      line: "The daemon refused it, so nothing changed in the chat. Its own words are below.",
    }),
  ]);
});

it("shows the kit Deny of a request with no reject option, and writes nothing for it", async () => {
  const user = userEvent.setup();
  const log = logOf(chatEntries([
    userMessage("Fetch the page."),
    permissionRequest("p1", { toolCallId: "t1", title: "Fetch the page", kind: "fetch" }, [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
    ]),
  ]));
  await renderPanel(log);
  const group = await screen.findByRole("group", { name: "Waiting on tool: Fetch the page Waiting for your permission." });

  await user.click(within(group).getByRole("button", { name: "Deny" }));

  expect((await within(group).findByRole("alert")).textContent).toBe(
    "This request has no option for this answer. To end it, stop the turn with the Stop generating button. The button shows when the message field is empty.",
  );
  expect(posts(log)).toEqual([]);
});

const QUESTIONS_PATH = `${chatPath()}/questions/r3`;

it.each<[string, readonly ChatEntry[], string]>([
  ["on a tool by the tool and the message", QUESTIONS_LOG.slice(0, 4), RELEASE_LABEL],
  ["with no tool by the message", FORM_LOG.slice(0, 2), FORM_LABEL],
])("names an open question %s, then by the rule of its kit form", async (_name, entries, label) => {
  await renderPanel(logOf(entries));

  expect(await screen.findByRole("group", { name: formGroupName(label) })).toBeTruthy();
  expect(screen.getByText(FORM_RULE)).toBeTruthy();
});

it("answers a question with no fields and no tool with Accept, with no rule, and shows Answered when the log closes it", async () => {
  const user = userEvent.setup();
  const path = `${chatPath()}/questions/r6`;
  const log = writableLogOf(CONFIRM_LOG.slice(0, 2), path);
  await renderPanel(log);
  const group = await screen.findByRole("group", { name: "Publish the preview to the team?" });

  expect(optionNames(group)).toEqual(["Accept", "Decline"]);
  expect(screen.queryByText(FORM_RULE)).toBeNull();
  await user.click(within(group).getByRole("button", { name: "Accept" }));

  await waitFor(() => {
    expect(posts(log)).toEqual([{ method: "POST", path, body: { action: "accept", content: {}, client: CHAT_CLIENT } }]);
  });

  log.answer(2, { cursor: 3, entries: chatEntries([CONFIRM_LOG[2]!.event], 3) });

  expect(await screen.findByText("Answered.")).toBeTruthy();
});

it("declines a question with no fields on a tool with Decline, with no rule", async () => {
  const user = userEvent.setup();
  const path = `${chatPath()}/questions/q2`;
  const log = writableLogOf(chatEntries([
    userMessage("Publish the preview."),
    toolCall({ toolCallId: "t2", title: "Publish", kind: "execute", status: "pending" }),
    questionRequest("q2", { toolCallId: "t2", message: "Publish to the team?", requestedSchema: { type: "object", properties: {} } }),
  ]), path);
  await renderPanel(log);
  const group = await screen.findByRole("group", { name: "Waiting on tool: Publish Publish to the team?" });

  expect(optionNames(group)).toEqual(["Accept", "Decline"]);
  expect(screen.queryByText(FORM_RULE)).toBeNull();
  await user.click(within(group).getByRole("button", { name: "Decline" }));

  await waitFor(() => {
    expect(posts(log)).toEqual([{ method: "POST", path, body: { action: "decline", client: CHAT_CLIENT } }]);
  });
});

it("posts the answers of the kit form of a question on a tool", async () => {
  const user = userEvent.setup();
  const log = writableLogOf(QUESTIONS_LOG.slice(0, 4), QUESTIONS_PATH);
  await renderPanel(log);
  const group = await screen.findByRole("group", { name: RELEASE_GROUP });

  await user.click(within(group).getByRole("button", { name: /^2\.0\.0/ }));
  await user.click(within(group).getByRole("button", { name: /^lint/ }));
  await user.click(within(group).getByRole("button", { name: /^test/ }));
  await user.click(within(group).getByRole("button", { name: "Send" }));

  await waitFor(() => {
    expect(posts(log)).toEqual([
      {
        method: "POST",
        path: QUESTIONS_PATH,
        body: { action: "accept", content: { question_0: "2.0.0", question_1: ["lint", "test"] }, client: CHAT_CLIENT },
      },
    ]);
  });
});

it("posts a decline for Dismiss", async () => {
  const user = userEvent.setup();
  const log = writableLogOf(QUESTIONS_LOG.slice(0, 4), QUESTIONS_PATH);
  await renderPanel(log);

  await user.click(within(await screen.findByRole("group", { name: RELEASE_GROUP })).getByRole("button", { name: "Dismiss" }));

  await waitFor(() => {
    expect(posts(log)).toEqual([{ method: "POST", path: QUESTIONS_PATH, body: { action: "decline", client: CHAT_CLIENT } }]);
  });
});

it("posts the answer of a question with no tool, and moves focus from its form to its line when the log closes it", async () => {
  const user = userEvent.setup();
  const path = `${chatPath()}/questions/r4`;
  const log = writableLogOf(REFUSAL_LOG.slice(0, 2), path);
  await renderPanel(log);
  const group = await screen.findByRole("group", { name: REFUSAL_GROUP });

  await user.click(within(group).getByRole("button", { name: /^Retry with Model B/ }));
  await user.click(within(group).getByRole("button", { name: "Send" }));

  await waitFor(() => {
    expect(posts(log)).toEqual([
      { method: "POST", path, body: { action: "accept", content: { choice: "retry_fallback" }, client: CHAT_CLIENT } },
    ]);
  });
  expect(group.contains(document.activeElement)).toBe(true);

  log.answer(2, { cursor: 3, entries: chatEntries([REFUSAL_LOG[2]!.event], 3) });

  const answered = await screen.findByText("Answered: retry_fallback.");
  expect(screen.queryByRole("group", { name: REFUSAL_GROUP })).toBeNull();
  expect(document.activeElement).toBe(answered.parentElement);
});

it("shows the kit text for a bad number and posts nothing, then posts the fixed answer", async () => {
  const user = userEvent.setup();
  const path = `${chatPath()}/questions/r5`;
  const log = writableLogOf(FORM_LOG.slice(0, 2), path);
  await renderPanel(log);
  const group = await screen.findByRole("group", { name: FORM_GROUP });
  await user.click(within(group).getByRole("button", { name: "Yes" }));
  const retries = within(group).getByRole("textbox", { name: "Retries" });

  await user.type(retries, "9");
  await user.click(within(group).getByRole("button", { name: "Send" }));

  expect((await within(group).findByRole("alert")).textContent).toBe("Retries: type a whole number from 1 to 5.");
  expect(posts(log)).toEqual([]);

  await user.clear(retries);
  await user.type(retries, "3");
  await user.click(within(group).getByRole("button", { name: "Send" }));

  await waitFor(() => {
    expect(posts(log)).toEqual([
      { method: "POST", path, body: { action: "accept", content: { confirm: true, retries: 3 }, client: CHAT_CLIENT } },
    ]);
  });
});

it("keeps the text of an open question form when the log changes", async () => {
  const user = userEvent.setup();
  const log = logOf(FORM_LOG.slice(0, 2));
  await renderPanel(log);
  const group = await screen.findByRole("group", { name: FORM_GROUP });
  await user.type(within(group).getByRole("textbox", { name: "Retries" }), "4");

  log.answer(2, { cursor: 3, entries: chatEntries([textChunk("Waiting for the form.")], 3) });

  expect(await screen.findByText("Waiting for the form.")).toBeTruthy();
  expect(within(group).getByRole<HTMLTextAreaElement>("textbox", { name: "Retries" }).value).toBe("4");
});

it("answers the open question of a tool whose permission closed, under the question and not under the permission", async () => {
  const user = userEvent.setup();
  const path = `${chatPath()}/questions/q1`;
  const log = writableLogOf(chatEntries([
    userMessage("Deploy the preview."),
    permissionRequest("p1", { toolCallId: "t1", title: "Deploy", kind: "execute" }, [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
    ]),
    permissionResolved("p1", { outcome: "selected", optionId: "allow" }),
    questionRequest("q1", {
      toolCallId: "t1",
      message: "Which host?",
      requestedSchema: { type: "object", properties: { host: { type: "string", enum: ["preview", "staging"] } } },
    }),
  ]), path);
  await renderPanel(log);

  const group = await screen.findByRole("group", { name: formGroupName("Waiting on tool: Deploy Which host?") });
  expect(screen.getByText("Answered: Allow.")).toBeTruthy();
  expect(screen.queryByRole("group", { name: /Waiting for your permission/ })).toBeNull();
  await user.click(within(group).getByRole("button", { name: "staging" }));
  await user.click(within(group).getByRole("button", { name: "Send" }));

  await waitFor(() => {
    expect(posts(log)).toEqual([
      { method: "POST", path, body: { action: "accept", content: { host: "staging" }, client: CHAT_CLIENT } },
    ]);
  });
});

const OPTIONS_PATH = `${chatPath()}/options`;

/** A turn that ended, after the first list of the options, in Accept edits. */
const MODE_LOG = chatEntries([
  optionsUpdate(modeOption("acceptEdits")),
  userMessage("Build."),
  textChunk("Built."),
  turnEnd(),
]);

const AUTO_LIST = optionsUpdate(modeOption("auto"));

const MODE_TRIGGER = { name: /^Mode / };

function modeTrigger(): HTMLElement {
  return screen.getByRole("button", MODE_TRIGGER);
}

/** Picks the value by its name in the mode menu. */
async function pickMode(user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> {
  await user.click(await screen.findByRole("button", MODE_TRIGGER));
  await user.click(await screen.findByRole("menuitemradio", { name }));
}

/** The answer of the option route: the record with the `seq` of the log when the daemon answered. */
function optionAnswer(seq: number, diagnostics: Diagnostic[] = []) {
  return successReply(chatRecord({ seq }), diagnostics);
}

/** A held answer of the option route for the next pick. */
function holdPick(log: ChatLogStub) {
  const held = heldBack();
  log.replies[`POST ${OPTIONS_PATH}`] = held.reply;
  return held;
}

/** Gives the pending writes and the log reads time to land. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** Each text that the mode trigger shows from now on, one for each change. */
function watchTrigger(): string[] {
  const seen: string[] = [modeTrigger().textContent];
  const observer = new MutationObserver(() => {
    const text = screen.queryByRole("button", MODE_TRIGGER)?.textContent;
    if (text !== undefined && text !== seen.at(-1)) {
      seen.push(text);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  onTestFinished(() => {
    observer.disconnect();
  });
  return seen;
}

function modeWords(): string[] {
  return spoken().filter((words) => words.startsWith("Mode:"));
}

it("shows the mode of the chat in the composer, and no picker for a log with no options", async () => {
  await renderPanel(logOf(MODE_LOG));

  const trigger = await screen.findByRole("button", { name: "Mode Accept edits" });
  expect(composer().closest("form")?.contains(trigger)).toBe(true);
  cleanup();

  await renderPanel(logOf(TEXT_LOG));

  await findComposer();
  expect(screen.queryByRole("button", MODE_TRIGGER)).toBeNull();
});

it("puts the Mode picker in the picker row, whose start padding is the start padding of the message input", async () => {
  await renderPanel(logOf(MODE_LOG));

  const trigger = await screen.findByRole("button", { name: "Mode Accept edits" });
  expect(trigger.closest(".ps-2\\.5")?.className).toContain("flex-wrap");
  expect(composer().className).toContain("px-2.5");
});

it.each([
  ["with another number", { tag: "SAGA", chat: 7 }],
  ["of another project", { tag: "ACME", chat: 2 }],
])("leaves a started chat %s alone when the composer of a project chat shows", async (_name, chat) => {
  const started = { ...chat, focus: true, words: "The chat started." };
  useUiStore.setState({ startedChat: started });
  onTestFinished(() => {
    useUiStore.setState({ startedChat: null });
  });
  const record = successReply(projectChatRecord({ seq: TEXT_LOG.length }));
  const log = stubChatLog({ [projectChatPath()]: record }, projectEventsPath);
  log.serve(0, { cursor: TEXT_LOG.length, entries: [...TEXT_LOG] });

  await renderPanel(log, { host: <ChatBody tag="SAGA" task={undefined} chat={2} headingRef={{ current: null }} /> });
  await findComposer();

  expect(useUiStore.getState().startedChat).toEqual(started);
  expect(spoken()).not.toContain("The chat started.");
});

it("offers the values of the agent without the hidden ones", async () => {
  const user = userEvent.setup();
  await renderPanel(logOf(MODE_LOG));

  await user.click(await screen.findByRole("button", MODE_TRIGGER));

  const menu = await screen.findByRole("menu", { name: "Mode" });
  const names = ["Manual", "Accept edits", "Auto", "Bypass permissions"];
  expect(within(menu).getAllByRole("menuitemradio")).toEqual(
    names.map((name) => within(menu).getByRole("menuitemradio", { name })),
  );
});

it("posts a pick with the client of the window, keeps Send on while it runs, and announces its mode one time after a message in it", async () => {
  const user = userEvent.setup();
  const log = writableLogOf(MODE_LOG, MESSAGES_PATH);
  const held = holdPick(log);
  await renderPanel(log);
  await user.type(await findComposer(), "Then test it.");
  const pickPost = { method: "POST", path: OPTIONS_PATH, body: { configId: "mode", value: "auto", client: CHAT_CLIENT } };

  await pickMode(user, "Auto");

  await waitFor(() => {
    expect(posts(log)).toEqual([pickPost]);
  });
  expect(modeTrigger().textContent).toBe("Auto…");
  expect(button("Send message").disabled).toBe(false);
  await user.type(composer(), "{Enter}");
  await waitFor(() => {
    expect(posts(log)).toEqual([
      pickPost,
      { method: "POST", path: MESSAGES_PATH, body: { text: "Then test it.", client: CHAT_CLIENT } },
    ]);
  });

  log.answer(4, { cursor: 5, entries: chatEntries([userMessage("Then test it.")], 5) });
  held.answer(optionAnswer(6));
  await settle();
  expect(modeTrigger().textContent).toBe("Auto…");
  log.answer(5, { cursor: 6, entries: chatEntries([AUTO_LIST], 6) });
  await waitFor(() => {
    expect(modeTrigger().textContent).toBe("Auto");
  });
  log.answer(6, { cursor: 8, entries: chatEntries([textChunk("Tested."), turnEnd()], 7) });

  expect(await screen.findByRole("button", { name: "Send message" })).toBeTruthy();
  await frame();
  expect(modeWords()).toEqual(["Mode: Auto"]);
});

it("keeps Auto… until the log reaches the seq of an answer that comes first, and announces Mode: Auto one time", async () => {
  const user = userEvent.setup();
  const log = logOf(MODE_LOG);
  const held = holdPick(log);
  await renderPanel(log);
  await screen.findByRole("button", MODE_TRIGGER);
  const seen = watchTrigger();

  await pickMode(user, "Auto");
  await waitFor(() => {
    expect(modeTrigger().textContent).toBe("Auto…");
  });
  held.answer(optionAnswer(6));
  await settle();
  log.answer(4, { cursor: 5, entries: chatEntries([agentUpdate({ sessionUpdate: "usage_update", used: 9 })], 5) });
  await settle();
  expect(modeTrigger().textContent).toBe("Auto…");

  log.answer(5, { cursor: 6, entries: chatEntries([AUTO_LIST], 6) });

  await waitFor(() => {
    expect(modeTrigger().textContent).toBe("Auto");
  });
  expect(seen).toEqual(["Accept edits", "Auto…", "Auto"]);
  await frame();
  expect(modeWords()).toEqual(["Mode: Auto"]);
});

it("ends the period at the answer when the log reaches its seq first, with one announcement", async () => {
  const user = userEvent.setup();
  const log = logOf(MODE_LOG);
  const held = holdPick(log);
  await renderPanel(log);

  await pickMode(user, "Auto");
  log.answer(4, { cursor: 5, entries: chatEntries([AUTO_LIST], 5) });
  await settle();
  expect(modeTrigger().textContent).toBe("Auto…");
  await frame();
  expect(modeWords()).toEqual([]);

  held.answer(optionAnswer(5));

  await waitFor(() => {
    expect(modeTrigger().textContent).toBe("Auto");
  });
  await frame();
  expect(modeWords()).toEqual(["Mode: Auto"]);
});

it.each(["answer", "log"] as const)(
  "announces Mode: Accept edits one time for a pick of Auto that the adapter keeps in Accept edits, with the %s first",
  async (first) => {
    const user = userEvent.setup();
    const log = logOf(MODE_LOG);
    const held = holdPick(log);
    await renderPanel(log);
    const kept = optionsUpdate(modeOption("acceptEdits"));

    await pickMode(user, "Auto");
    await settle();
    if (first === "answer") {
      held.answer(optionAnswer(5));
      await settle();
      log.answer(4, { cursor: 5, entries: chatEntries([kept], 5) });
    } else {
      log.answer(4, { cursor: 5, entries: chatEntries([kept], 5) });
      await settle();
      held.answer(optionAnswer(5));
    }

    await waitFor(() => {
      expect(modeTrigger().textContent).toBe("Accept edits");
    });
    await frame();
    expect(modeWords()).toEqual(["Mode: Accept edits"]);
  },
);

/** Resets the log while a pick is pending: the record is read again, and the new transcript reads the log from 0. */
async function resetDuringPick(log: ChatLogStub, user: ReturnType<typeof userEvent.setup>) {
  const held = holdPick(log);
  await pickMode(user, "Auto");
  await waitFor(() => {
    expect(modeTrigger().textContent).toBe("Auto…");
  });
  log.replies[chatPath()] = successReply(chatRecord({ seq: 4 }));
  log.answer(4, { reset: true, cursor: 0 });
  await readStarted(log, chatPath(), 2);
  await readStarted(log, eventsPath(0), 2);
  return held;
}

it("announces at the end of the period a mode that the log changes before the answer, in a transcript that mounts during the pick", async () => {
  const user = userEvent.setup();
  const log = logOf(MODE_LOG);
  await renderPanel(log);
  const held = await resetDuringPick(log, user);

  log.answer(0, { cursor: 4, entries: [...MODE_LOG] });
  await waitFor(() => {
    expect(modeTrigger().textContent).toBe("Auto…");
  });
  log.answer(4, { cursor: 5, entries: chatEntries([AUTO_LIST], 5) });
  await settle();
  await frame();
  expect(modeWords()).toEqual([]);

  held.answer(optionAnswer(5));

  await waitFor(() => {
    expect(modeTrigger().textContent).toBe("Auto");
  });
  await frame();
  expect(modeWords()).toEqual(["Mode: Auto"]);
});

it("announces later, one time, a mode that the log changes after the answer, in a transcript that mounts during the pick", async () => {
  const user = userEvent.setup();
  const log = logOf(MODE_LOG);
  await renderPanel(log);
  const held = await resetDuringPick(log, user);

  log.answer(0, { cursor: 4, entries: [...MODE_LOG] });
  await waitFor(() => {
    expect(modeTrigger().textContent).toBe("Auto…");
  });
  held.answer(optionAnswer(5));
  await waitFor(() => {
    expect(modeTrigger().textContent).toBe("Accept edits");
  });
  await frame();
  expect(modeWords()).toEqual([]);

  log.answer(4, { cursor: 5, entries: chatEntries([AUTO_LIST], 5) });

  await waitFor(() => {
    expect(modeTrigger().textContent).toBe("Auto");
  });
  await frame();
  expect(modeWords()).toEqual(["Mode: Auto"]);
});

it("starts no period in a transcript whose first view comes after the answer, and announces a later change one time", async () => {
  const user = userEvent.setup();
  const log = logOf(MODE_LOG);
  await renderPanel(log);
  const held = await resetDuringPick(log, user);
  held.answer(optionAnswer(5));
  await settle();

  log.answer(0, { cursor: 4, entries: [...MODE_LOG] });
  expect(await screen.findByRole("button", { name: "Mode Accept edits" })).toBeTruthy();
  log.answer(4, { cursor: 5, entries: chatEntries([AUTO_LIST], 5) });

  await waitFor(() => {
    expect(modeTrigger().textContent).toBe("Auto");
  });
  await frame();
  expect(modeWords()).toEqual(["Mode: Auto"]);
});

it("announces nothing at the end of a period whose view has no mode option", async () => {
  const user = userEvent.setup();
  const log = logOf(MODE_LOG);
  const held = holdPick(log);
  await renderPanel(log);

  await pickMode(user, "Auto");
  await settle();
  log.answer(4, { cursor: 5, entries: chatEntries([optionsUpdate()], 5) });
  await waitFor(() => {
    expect(screen.queryByRole("button", MODE_TRIGGER)).toBeNull();
  });
  held.answer(optionAnswer(5));
  await settle();

  await frame();
  expect(modeWords()).toEqual([]);
});

it("announces the mode of a pick that succeeds and opens the notice of a later pick that fails", async () => {
  const user = userEvent.setup();
  const log = logOf(MODE_LOG);
  const held = holdPick(log);
  await renderPanel(log);
  await pickMode(user, "Auto");
  await waitFor(() => {
    expect(posts(log)).toHaveLength(1);
  });
  log.replies[`POST ${OPTIONS_PATH}`] = refusalReply(422, {
    kind: "daemon",
    code: "option-refused",
    message: "the agent refused \"default\" for \"mode\"",
  });

  await pickMode(user, "Manual");
  await waitFor(() => {
    expect(notices()).toEqual([expect.objectContaining({ title: "Mode of chat 2 of SAGA-3 did not change." })]);
  });
  expect(modeTrigger().textContent).toBe("Auto…");
  held.answer(optionAnswer(5));
  log.answer(4, { cursor: 5, entries: chatEntries([AUTO_LIST], 5) });

  await waitFor(() => {
    expect(modeTrigger().textContent).toBe("Auto");
  });
  await frame();
  expect(modeWords()).toEqual(["Mode: Auto"]);
});

it("announces the mode that the log changes during a pick that fails", async () => {
  const user = userEvent.setup();
  const log = logOf(MODE_LOG);
  const held = holdPick(log);
  await renderPanel(log);

  await pickMode(user, "Auto");
  log.answer(4, { cursor: 5, entries: chatEntries([modeUpdate("default")], 5) });
  await settle();
  await frame();
  expect(modeWords()).toEqual([]);
  held.answer(refused(400, "malformed-request"));

  await waitFor(() => {
    expect(modeTrigger().textContent).toBe("Manual");
  });
  await frame();
  expect(modeWords()).toEqual(["Mode: Manual"]);
});

it("announces nothing for a pick that fails with no change of the mode", async () => {
  const user = userEvent.setup();
  const log = logOf(MODE_LOG);
  log.replies[`POST ${OPTIONS_PATH}`] = refused(400, "malformed-request");
  await renderPanel(log);

  await pickMode(user, "Auto");

  await waitFor(() => {
    expect(notices()).toHaveLength(1);
  });
  expect(modeTrigger().textContent).toBe("Accept edits");
  await frame();
  expect(modeWords()).toEqual([]);
});

it("announces a change of the mode in the log outside a pick", async () => {
  const log = logOf(MODE_LOG);
  await renderPanel(log);
  await screen.findByRole("button", MODE_TRIGGER);

  log.answer(4, { cursor: 5, entries: chatEntries([modeUpdate("default")], 5) });

  await waitFor(() => {
    expect(modeTrigger().textContent).toBe("Manual");
  });
  await frame();
  expect(modeWords()).toEqual(["Mode: Manual"]);
});

it("opens the failure notice of a refused pick with the words of the daemon", async () => {
  const user = userEvent.setup();
  const log = logOf(MODE_LOG);
  log.replies[`POST ${OPTIONS_PATH}`] = refusalReply(422, {
    kind: "daemon",
    code: "option-refused",
    message: "the agent of chat 2 of SAGA-3 refused \"auto\" for \"mode\": no auto mode",
  });
  await renderPanel(log);

  await pickMode(user, "Auto");

  await waitFor(() => {
    expect(notices()).toEqual([
      expect.objectContaining({
        form: "failure",
        title: "Mode of chat 2 of SAGA-3 did not change.",
        line: "The daemon refused it, so Mode did not change. Its own words are below.",
        words: ["daemon/option-refused · the agent of chat 2 of SAGA-3 refused \"auto\" for \"mode\": no auto mode"],
      }),
    ]);
  });
});

it("opens the warning notice, with the path of the file, of a pick that the daemon did not save", async () => {
  const user = userEvent.setup();
  const log = logOf(MODE_LOG);
  log.replies[`POST ${OPTIONS_PATH}`] = optionAnswer(4, [
    {
      code: "option-not-saved",
      message: "the value \"auto\" of \"mode\" is not saved as the default of claude: disk full",
      path: "/work/home/.tasma/agent-defaults.json",
    },
  ]);
  await renderPanel(log);

  await pickMode(user, "Auto");

  await waitFor(() => {
    expect(notices()).toEqual([
      expect.objectContaining({
        form: "warning",
        title: "Mode of chat 2 of SAGA-3 changed, but it is not saved.",
        words: [
          "/work/home/.tasma/agent-defaults.json: the value \"auto\" of \"mode\" is not saved as the default of claude: disk full",
        ],
      }),
    ]);
  });
});

it("posts a pick during a turn", async () => {
  const user = userEvent.setup();
  const log = writableLogOf(chatEntries([optionsUpdate(modeOption("acceptEdits")), userMessage("Build.")]), OPTIONS_PATH);
  await renderPanel(log);
  expect(await screen.findByRole("button", { name: "Stop generating" })).toBeTruthy();

  await pickMode(user, "Auto");

  await waitFor(() => {
    expect(posts(log)).toEqual([
      { method: "POST", path: OPTIONS_PATH, body: { configId: "mode", value: "auto", client: CHAT_CLIENT } },
    ]);
  });
});

it("moves focus to the heading when the option leaves the log with its menu open", async () => {
  const user = userEvent.setup();
  const log = logOf(MODE_LOG);
  await renderPanel(log);
  const trigger = await screen.findByRole("button", MODE_TRIGGER);
  act(() => {
    trigger.focus();
  });
  await user.keyboard("{Enter}");
  const menu = await screen.findByRole("menu", { name: "Mode" });
  await waitFor(() => {
    expect(menu.contains(document.activeElement)).toBe(true);
  });

  log.answer(4, { cursor: 5, entries: chatEntries([optionsUpdate()], 5) });

  await waitFor(() => {
    expect(document.activeElement).toBe(heading());
  });
});

it("shows a mode option with the id constructor", async () => {
  await renderPanel(logOf(chatEntries([optionsUpdate({ ...modeOption("auto"), id: "constructor" })])));

  expect(await screen.findByRole("button", { name: "Mode Auto" })).toBeTruthy();
});

it("keeps the newer of two picks whose answers come in the wrong order", async () => {
  const user = userEvent.setup();
  const log = logOf(MODE_LOG);
  const first = holdPick(log);
  await renderPanel(log);
  await pickMode(user, "Auto");
  await waitFor(() => {
    expect(posts(log)).toHaveLength(1);
  });
  const second = holdPick(log);
  await pickMode(user, "Manual");
  await waitFor(() => {
    expect(posts(log)).toHaveLength(2);
  });

  second.answer(optionAnswer(6));
  await settle();
  first.answer(optionAnswer(5));
  await settle();
  log.answer(4, { cursor: 5, entries: chatEntries([AUTO_LIST], 5) });
  await settle();
  expect(modeTrigger().textContent).toBe("Manual…");

  log.answer(5, { cursor: 6, entries: chatEntries([modeUpdate("default")], 6) });

  await waitFor(() => {
    expect(modeTrigger().textContent).toBe("Manual");
  });
  await frame();
  expect(modeWords()).toEqual(["Mode: Manual"]);
});

/** A finished chat of two turns. */
const TWO_TURNS = chatEntries([
  userMessage("Rename the parser."),
  textChunk("I renamed it."),
  turnEnd(),
  userMessage("Update the imports."),
  textChunk("I updated them."),
  turnEnd(),
]);

const RUNNING_TURN = TWO_TURNS.slice(0, -1);

/** The first unread message is `u4`. */
const SEEN_FIRST_TURN = 3;

const CONTENT_HEIGHT = 5000;

const UNREAD_TOP = 1200;

function threadViewport(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]')!;
}

/**
 * Gives the thread a layout, since jsdom has none: `u4` sits at `UNREAD_TOP`,
 * the content is `box.scrollHeight` high, and `scrollTo` moves `scrollTop` as
 * far as the content lets it.
 */
function stubThreadLayout() {
  const resize = stubResizeObservers();
  const scrolls: ScrollToOptions[] = [];
  const scrollTexts: string[] = [];
  const box = { scrollTop: 0, scrollHeight: CONTENT_HEIGHT, clientHeight: 600 };

  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.messageId === "u4" ? UNREAD_TOP : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(function (this: HTMLElement) {
    return this.closest('[data-slot="aui_thread-viewport"]');
  });
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(() => box.scrollHeight);
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(() => box.clientHeight);
  vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(() => box.scrollTop);
  Object.defineProperty(Element.prototype, "scrollTo", {
    configurable: true,
    value(this: Element, options: ScrollToOptions) {
      scrolls.push(options);
      scrollTexts.push(this.textContent);
      box.scrollTop = Math.min(options.top ?? box.scrollTop, box.scrollHeight - box.clientHeight);
    },
  });

  return {
    scrolls,
    scrollTexts,
    box,
    growContent: (): void => {
      box.scrollHeight += 100;
      resize.report(threadViewport());
    },
  };
}

/** Reports a scroll of the viewport to the end of its content. */
function scrollToContentEnd(box: ReturnType<typeof stubThreadLayout>["box"]): void {
  box.scrollTop = box.scrollHeight - box.clientHeight;
  act(() => {
    threadViewport().dispatchEvent(new Event("scroll"));
  });
}

async function waitForOpenScroll(scrolls: readonly ScrollToOptions[], top: number): Promise<void> {
  await waitFor(() => {
    expect(scrolls).toContainEqual({ top, behavior: "instant" });
  });
}

it("opens a chat that is not busy at the first message after seen", async () => {
  const { scrolls } = stubThreadLayout();

  await renderPanel(logOf(TWO_TURNS, { seen: SEEN_FIRST_TURN }));

  await waitForOpenScroll(scrolls, UNREAD_TOP);
  expect(scrolls).not.toContainEqual({ top: CONTENT_HEIGHT, behavior: "instant" });
});

it.each<[string, readonly ChatEntry[], Partial<Chat>]>([
  ["a busy chat, also with messages after seen,", RUNNING_TURN, { seen: SEEN_FIRST_TURN }],
  ["a chat with no seen", TWO_TURNS, {}],
  ["a chat seen to its last entry", TWO_TURNS, { seen: TWO_TURNS.length }],
])("opens %s at its end", async (_chat, entries, fields) => {
  const { scrolls } = stubThreadLayout();

  await renderPanel(logOf(entries, fields));

  await waitForOpenScroll(scrolls, CONTENT_HEIGHT);
  expect(scrolls).not.toContainEqual({ top: UNREAD_TOP, behavior: "instant" });
});

/**
 * Serves a log in two reads, split after `first` entries. The kit store takes
 * the first read before the second read arrives.
 */
async function renderInTwoReads(
  entries: readonly ChatEntry[],
  first: number,
  fields: Partial<Chat> = {},
): Promise<void> {
  const log = stubChatLog({ [chatPath()]: successReply(chatRecord({ seq: entries.length, ...fields })) });

  await renderPanel(log);
  await settle();
  log.answer(0, { cursor: first, entries: entries.slice(0, first) });
  await settle();
  log.answer(first, { cursor: entries.length, entries: entries.slice(first) });
}

it("has the text of a reply that crossed a read in the page when a chat opens at its end", async () => {
  const { scrolls, scrollTexts } = stubThreadLayout();

  await renderInTwoReads(TWO_TURNS, TWO_TURNS.length - 1, { seen: TWO_TURNS.length });

  await waitForOpenScroll(scrolls, CONTENT_HEIGHT);
  expect(scrollTexts[scrolls.findIndex(({ behavior }) => behavior === "instant")]).toContain("I updated them.");
});

it("has the text of a reply that crossed a read in the page when a chat opens at a message below it", async () => {
  const { scrolls, scrollTexts } = stubThreadLayout();

  await renderInTwoReads(TWO_TURNS, 2, { seen: SEEN_FIRST_TURN });

  await waitForOpenScroll(scrolls, UNREAD_TOP);
  expect(scrollTexts[scrolls.findIndex(({ top }) => top === UNREAD_TOP)]).toContain("I renamed it.");
});

it("shows only messages of the log when a finished chat comes in two reads", async () => {
  stubThreadLayout();
  const shown = new Set<string>();
  const observer = new MutationObserver(() => {
    for (const message of document.querySelectorAll<HTMLElement>("[data-message-id]")) {
      shown.add(message.dataset.messageId!);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  onTestFinished(() => {
    observer.disconnect();
  });

  await renderInTwoReads(TWO_TURNS, 2);

  await waitFor(() => {
    expect(shown).toContain("a5");
  });
  expect([...shown].sort()).toEqual(["a2", "a5", "u1", "u4"]);
});

it("takes no run start from the open of a busy chat, so new content follows with no smooth scroll", async () => {
  const { scrolls, box, growContent } = stubThreadLayout();

  await renderPanel(logOf(RUNNING_TURN));
  await waitForOpenScroll(scrolls, CONTENT_HEIGHT);
  await frame();
  expect(scrolls.filter(({ behavior }) => behavior !== "instant")).toEqual([]);

  scrolls.length = 0;
  growContent();

  expect(scrolls).toEqual([{ top: box.scrollHeight, behavior: "instant" }]);
});

it("takes no run start from the open of a busy chat that comes in two reads", async () => {
  const { scrolls } = stubThreadLayout();

  await renderInTwoReads(RUNNING_TURN, 2);

  await waitForOpenScroll(scrolls, CONTENT_HEIGHT);
  await frame();
  expect(scrolls.filter(({ behavior }) => behavior !== "instant")).toEqual([]);
});

it("follows a chat that opened at a message only after the reader reached its end", async () => {
  const { scrolls, box, growContent } = stubThreadLayout();

  await renderPanel(logOf(TWO_TURNS, { seen: SEEN_FIRST_TURN }));
  await waitForOpenScroll(scrolls, UNREAD_TOP);

  scrolls.length = 0;
  growContent();
  expect(scrolls).toEqual([]);

  scrollToContentEnd(box);
  growContent();
  expect(scrolls).toEqual([{ top: box.scrollHeight, behavior: "instant" }]);
});

it("scrolls a chat that opened at a message to the end at a run start, and follows after that", async () => {
  const { scrolls, box, growContent } = stubThreadLayout();
  const log = logOf(TWO_TURNS, { seen: SEEN_FIRST_TURN });

  await renderPanel(log);
  await waitForOpenScroll(scrolls, UNREAD_TOP);

  scrolls.length = 0;
  log.answer(TWO_TURNS.length, {
    cursor: TWO_TURNS.length + 1,
    entries: chatEntries([userMessage("Run the tests.")], TWO_TURNS.length + 1),
  });
  await waitFor(() => {
    expect(scrolls).toContainEqual({ top: box.scrollHeight, behavior: "auto" });
  });

  scrolls.length = 0;
  scrollToContentEnd(box);
  growContent();
  expect(scrolls).toEqual([{ top: box.scrollHeight, behavior: "instant" }]);
});

describe("with a reader away from the end during a turn", () => {
  async function renderAwayFromEnd() {
    const layout = stubThreadLayout();
    const log = logOf(RUNNING_TURN);

    await renderPanel(log);
    await waitForOpenScroll(layout.scrolls, CONTENT_HEIGHT);
    await frame();
    layout.box.scrollTop = 0;
    act(() => {
      threadViewport().dispatchEvent(new Event("scroll"));
    });
    layout.scrolls.length = 0;
    return { ...layout, log };
  }

  it("scrolls to the end at a message of the user", async () => {
    const { scrolls, box, log } = await renderAwayFromEnd();

    log.answer(RUNNING_TURN.length, {
      cursor: RUNNING_TURN.length + 1,
      entries: chatEntries([userMessage("Run the tests.")], RUNNING_TURN.length + 1),
    });

    await waitFor(() => {
      expect(scrolls).toContainEqual({ top: box.scrollHeight, behavior: "auto" });
    });
  });

  it("keeps the place of the reader at more text of the agent", async () => {
    const { scrolls, log } = await renderAwayFromEnd();

    log.answer(RUNNING_TURN.length, {
      cursor: RUNNING_TURN.length + 1,
      entries: chatEntries([textChunk(" Now the tests.")], RUNNING_TURN.length + 1),
    });

    await screen.findByText(/Now the tests/);
    expect(scrolls).toEqual([]);
  });
});

it("keeps the place of the reader when an own turn starts", async () => {
  const { scrolls, growContent } = stubThreadLayout();
  const log = logOf(TWO_TURNS, { seen: SEEN_FIRST_TURN });

  await renderPanel(log);
  await waitForOpenScroll(scrolls, UNREAD_TOP);

  scrolls.length = 0;
  ownTurnStarts(log, TWO_TURNS.length);
  await screen.findByRole("button", { name: "Stop generating" });
  await frame();
  growContent();

  expect(scrolls).toEqual([]);
});

it("follows the output of an own turn when the reader is at the end", async () => {
  const { scrolls, box, growContent } = stubThreadLayout();
  const log = logOf(TWO_TURNS, { seen: SEEN_FIRST_TURN });

  await renderPanel(log);
  await waitForOpenScroll(scrolls, UNREAD_TOP);
  scrollToContentEnd(box);

  ownTurnStarts(log, TWO_TURNS.length);
  await screen.findByRole("button", { name: "Stop generating" });
  scrolls.length = 0;
  growContent();

  expect(scrolls).toEqual([{ top: box.scrollHeight, behavior: "instant" }]);
});

it("follows an own turn whose first output comes in the commit of its start, when the reader is at the end", async () => {
  const { scrolls, box, growContent } = stubThreadLayout();
  const log = logOf(TWO_TURNS, { seen: SEEN_FIRST_TURN });

  await renderPanel(log);
  await waitForOpenScroll(scrolls, UNREAD_TOP);
  scrollToContentEnd(box);

  box.scrollHeight += 100;
  ownTurnStarts(log, TWO_TURNS.length);
  await screen.findByRole("button", { name: "Stop generating" });
  scrolls.length = 0;
  growContent();

  expect(scrolls).toEqual([{ top: box.scrollHeight, behavior: "instant" }]);
});

it("keeps the place of a pointer reader with an opened disclosure at the first output of an own turn", async () => {
  const { scrolls, box, growContent } = stubThreadLayout();
  const user = userEvent.setup();
  stubFocusVisible(false);
  const entries = chatEntries([
    userMessage("Read the file."),
    toolCall({ toolCallId: "t1", title: "Read src/a.ts", kind: "read", status: "completed" }),
    turnEnd(),
  ]);
  const log = logOf(entries);

  await renderPanel(log);
  await waitForOpenScroll(scrolls, CONTENT_HEIGHT);
  scrollToContentEnd(box);
  await user.click(threadViewport().querySelector('[data-message-id] [aria-expanded="false"]')!);
  scrolls.length = 0;
  growContent();
  expect(scrolls).toEqual([]);

  ownTurnStarts(log, entries.length);
  await screen.findByRole("button", { name: "Stop generating" });
  await frame();
  growContent();

  expect(scrolls).toEqual([]);

  scrollToContentEnd(box);
  growContent();

  expect(scrolls).toEqual([{ top: box.scrollHeight, behavior: "instant" }]);
});

it("stops the follow while keyboard focus is in a message, and starts it again only at the end", async () => {
  const { scrolls, box, growContent } = stubThreadLayout();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  stubFocusVisible(true);

  await renderPanel(logOf(RUNNING_TURN));
  await waitForOpenScroll(scrolls, CONTENT_HEIGHT);
  const control = document.createElement("button");
  threadViewport().querySelector("[data-message-id]")!.append(control);

  act(() => {
    control.focus();
  });
  scrolls.length = 0;
  growContent();
  expect(scrolls).toEqual([]);

  act(() => {
    composer().focus();
  });
  growContent();
  expect(scrolls).toEqual([]);

  scrollToContentEnd(box);
  growContent();
  expect(scrolls).toEqual([{ top: box.scrollHeight, behavior: "instant" }]);
});

it("marks no message of the thread with a placeholder height", async () => {
  await renderPanel(logOf(TEXT_LOG));

  const messages = await waitFor(() => {
    const found = [...document.querySelectorAll("[data-message-id]")];
    expect(found).not.toEqual([]);
    return found;
  });
  for (const message of messages) {
    expect(message.className).not.toMatch(/content-visibility|contain-intrinsic-size/);
  }
});

it("takes the smooth scroll off the viewport under reduced motion", async () => {
  await renderPanel(logOf(TEXT_LOG));

  await findComposer();
  expect(threadViewport().className).toContain("motion-reduce:scroll-auto");
});
