import type { ThreadMessageLike, ToolCallMessagePartStatus } from "@assistant-ui/react";
import { ProtocolError, type ChatAgent, type ChatOutside, type ChatStatus } from "@tasma/protocol";
import { diffLines } from "diff";
import { permissionApproval, questionApproval, type ChatApproval } from "./chat-approval";
import type {
  ChatAgentMessage,
  ChatMessage,
  ChatNotice,
  ChatOption,
  ChatPart,
  ChatTool,
  ChatToolContent,
  ChatView,
} from "./chat-fold";

/** What a tool part carries to the views of the panel. */
export type ChatToolArtifact = { tool: ChatTool; folder: string };

export type ChatDiffLine = { kind: "context" | "added" | "removed"; text: string };

export type ChatDiff = { filename: string; lines: ChatDiffLine[]; additions: number; deletions: number };

/** A terminal as the kit `TerminalBlock` shows it, or the output of a tool that ended with no exit code. */
export type ChatTerminalView
  = | { kind: "block"; command: string; lines: string[]; done: boolean; exitCode?: number }
    | { kind: "result"; output: unknown };

type MessageStatus = NonNullable<ThreadMessageLike["status"]>;

type ThreadPart = Exclude<ThreadMessageLike["content"], string>[number];

/** The longest tool title or reason that an announcement keeps whole. */
const SPOKEN_LIMIT = 120;

/** jsdiff takes time quadratic in the edit distance: 500 lines keep one diff under about 40 ms. */
const DIFF_EDIT_LIMIT = 500;

/** The unchanged lines that a diff shows on each side of a change. */
const DIFF_CONTEXT = 3;

/** The lines that a diff shows of one run of removed or added lines. */
const DIFF_CHANGE_LIMIT = 100;

/** The rows of a diff, marks included. The kit draws each row, and fades it in after the row before it. */
const DIFF_ROW_LIMIT = 300;

/** The kit `TerminalBlock` draws every line of a running terminal, and parses each line on each render. */
const TERMINAL_LINE_LIMIT = 200;

const TERMINAL_LINE_WIDTH = 1_000;

/** The end of an output that holds every line a terminal shows, so a render reads no more of a long output. */
const TERMINAL_WINDOW = TERMINAL_LINE_LIMIT * (TERMINAL_LINE_WIDTH + 2);

const EARLIER_OUTPUT = "⋯ The start of the output is not shown.";

const AGENT_NAMES: Record<ChatAgent, string> = { claude: "Claude", codex: "Codex" };

const OUTSIDE_NAMES: Record<ChatOutside, string> = { vscode: "VS Code", terminal: "terminal" };

/** The status of a part or a message that waits for an answer. */
export const REQUIRES_ACTION = { type: "requires-action", reason: "tool-calls" } as const;

const ENDING_NOTICES: readonly ChatNotice["kind"][] = ["stopped", "failed", "interrupted", "continued-outside"];

export function chatAgentName(agent: ChatAgent): string {
  return AGENT_NAMES[agent];
}

export function chatOutsideName(where: ChatOutside): string {
  return OUTSIDE_NAMES[where];
}

export function chatStateText(status: ChatStatus): string {
  switch (status.state) {
    case "working":
      return "Agent works";
    case "needs-you":
      return "Needs you";
    case "failed":
      return "Failed";
    case "continued-outside":
      return `Continued in ${chatOutsideName(status.where)}`;
  }
}

const MISSING_CODES: ReadonlySet<string> = new Set(["chat-not-found", "task-not-found", "project-not-found"]);

/** A refusal that says the chat, its task or its project does not exist. */
export function isChatMissing(error: Error | null): boolean {
  return error instanceof ProtocolError && MISSING_CODES.has(error.failure.code);
}

export function chatToolName(tool: ChatTool): string {
  return tool.title === "" ? tool.kind : tool.title;
}

export function chatToolWaits(tool: ChatTool): boolean {
  return tool.permission?.state === "open" || tool.question?.state === "open";
}

/** The status of the tool itself, which a message that still runs does not give to a tool that ended. */
export function chatToolStatus(tool: ChatTool): ToolCallMessagePartStatus {
  if (chatToolWaits(tool)) {
    return REQUIRES_ACTION;
  }
  if (tool.stopped) {
    return { type: "incomplete", reason: "cancelled" };
  }
  switch (tool.status) {
    case "failed":
      return { type: "incomplete", reason: "error" };
    case "completed":
      return { type: "complete" };
    default:
      return { type: "running" };
  }
}

export function chatThreadMessage(message: ChatMessage, folder: string): ThreadMessageLike {
  const createdAt = new Date(message.at);

  if (message.role === "user") {
    return { role: "user", id: message.id, createdAt, content: [{ type: "text", text: message.text }] };
  }

  return {
    role: "assistant",
    id: message.id,
    createdAt,
    content: message.parts.map((part) => threadPart(part, folder)),
    status: messageStatus(message),
  };
}

function threadPart(part: ChatPart, folder: string): ThreadPart {
  switch (part.type) {
    case "text":
    case "reasoning":
      return { type: part.type, text: part.text };
    case "plan":
      return { type: "data-plan", data: part.entries };
    case "notice":
      return { type: "data-notice", data: part.notice };
    case "question":
      return { type: "data-question", data: part.question };
    case "tool":
      return toolPart(part.tool, folder);
  }
}

function toolPart(tool: ChatTool, folder: string): ThreadPart {
  const { input } = tool;
  const ended = tool.status === "completed" || tool.status === "failed";
  const artifact: ChatToolArtifact = { tool, folder };
  const approval = toolApproval(tool);

  return {
    type: "tool-call",
    toolCallId: tool.id,
    toolName: chatToolName(tool),
    args: isObject(input) ? (input as Extract<ThreadPart, { type: "tool-call" }>["args"]) : {},
    argsText: input === undefined ? "" : JSON.stringify(input, null, 2),
    ...(ended ? { result: toolResult(tool) } : {}),
    isError: tool.status === "failed",
    artifact,
    ...(approval === undefined ? {} : { approval }),
  };
}

/** The approval of the open request of the tool. A tool can have a closed permission and then an open question. */
function toolApproval(tool: ChatTool): ChatApproval | undefined {
  if (tool.permission?.state === "open") {
    return permissionApproval(tool.permission);
  }
  return tool.question?.state === "open" ? questionApproval(tool.question) : undefined;
}

function toolResult(tool: ChatTool): string {
  const texts = tool.content.flatMap((item) => (item.type === "text" ? [item.text] : []));
  if (texts.length > 0) {
    return texts.join("\n\n");
  }
  if (tool.output === undefined) {
    return "";
  }
  return typeof tool.output === "string" ? tool.output : JSON.stringify(tool.output, null, 2);
}

function partWaits(part: ChatPart): boolean {
  if (part.type === "question") {
    return part.question.state === "open";
  }
  return part.type === "tool" && chatToolWaits(part.tool);
}

function messageStatus(message: ChatAgentMessage): MessageStatus {
  if (message.running) {
    return message.parts.some(partWaits) ? REQUIRES_ACTION : { type: "running" };
  }

  const notice = endingNotice(message.parts);
  switch (notice?.kind) {
    case "stopped":
      return { type: "incomplete", reason: stopReason(notice.stopReason) };
    case "failed":
    case "interrupted":
    case "continued-outside":
      return { type: "incomplete", reason: "cancelled" };
    default:
      return { type: "complete", reason: "stop" };
  }
}

function stopReason(reason: string): Extract<MessageStatus, { type: "incomplete" }>["reason"] {
  switch (reason) {
    case "cancelled":
      return "cancelled";
    case "max_tokens":
      return "length";
    case "refusal":
      return "content-filter";
    default:
      return "other";
  }
}

function endingNotice(parts: readonly ChatPart[]): ChatNotice | undefined {
  return findNotice(parts, (notice) => ENDING_NOTICES.includes(notice.kind));
}

function findNotice(parts: readonly ChatPart[], select: (notice: ChatNotice) => boolean): ChatNotice | undefined {
  const found = parts.findLast((part) => part.type === "notice" && select(part.notice));
  return found?.type === "notice" ? found.notice : undefined;
}

export function chatNoticeText(notice: ChatNotice): string {
  return noticeText(notice, (text) => text);
}

function noticeText(notice: ChatNotice, shorten: (text: string) => string): string {
  switch (notice.kind) {
    case "failed":
      return `The chat failed: ${shorten(notice.reason)}`;
    case "stopped":
      return stoppedText(notice.stopReason, shorten);
    case "interrupted":
      return "The turn was interrupted.";
    case "resumed":
      return "Continued in Tasma.";
    case "continued-outside":
      return `Continued in ${chatOutsideName(notice.where)}.`;
  }
}

function stoppedText(reason: string, shorten: (text: string) => string): string {
  switch (reason) {
    case "cancelled":
      return "The turn was cancelled.";
    case "max_tokens":
      return "The agent stopped: the answer was too long.";
    case "max_turn_requests":
      return "The agent stopped: the turn made too many requests.";
    case "refusal":
      return "The agent refused to continue.";
    default:
      return `The turn stopped: ${shorten(reason)}.`;
  }
}

/** The text cut to `SPOKEN_LIMIT` characters, the last of them an ellipsis. */
function spoken(text: string): string {
  const characters = [...text];
  return characters.length > SPOKEN_LIMIT ? `${characters.slice(0, SPOKEN_LIMIT - 1).join("")}…` : text;
}

export function chatModeOption(view: ChatView): ChatOption | undefined {
  return view.options.find((option) => option.category === "mode");
}

/** The name of a value of the option, or its id when the option does not offer it. */
export function chatOptionValueName(option: ChatOption, value: string): string {
  return option.values.find((one) => one.value === value)?.name ?? value;
}

export function chatOptionWords(option: ChatOption, value: string): string {
  return `${option.name}: ${chatOptionValueName(option, value)}`;
}

/**
 * What a screen reader hears about the change from `before` to `after`, in the
 * order it hears it. `announceMode` false leaves out a change of the mode,
 * which a pick period of this window announces at its end.
 */
export function chatAnnouncements(before: ChatView, after: ChatView, agent: ChatAgent, announceMode = true): string[] {
  if (before === after) {
    return [];
  }

  const name = chatAgentName(agent);
  const words = after.fold.open
    .filter((request) => !before.fold.open.includes(request))
    .flatMap((request) => requestWords(after.messages, request, name));
  const was = before.fold.status.state;
  const status = after.fold.status;
  const failed = status.state === "failed" && was !== "failed"
    ? lastNotice(after.messages, (notice) => notice.kind === "failed")
    : undefined;

  if (failed !== undefined) {
    words.push(noticeText(failed, spoken));
  }
  if (status.state === "continued-outside" && was !== "continued-outside") {
    words.push(`The chat continued in ${chatOutsideName(status.where)}`);
  }
  if (before.fold.turn && !after.fold.turn && status.state === "needs-you") {
    const ended = turnNotice(after.messages);
    words.push(ended === undefined ? `${name} finished the turn` : noticeText(ended, spoken));
  }
  const modeBefore = chatModeOption(before);
  const modeAfter = chatModeOption(after);
  if (announceMode && modeBefore !== undefined && modeAfter !== undefined && modeBefore.current !== modeAfter.current) {
    words.push(chatOptionWords(modeAfter, modeAfter.current));
  }

  return words;
}

function agentParts(messages: readonly ChatMessage[]): ChatPart[] {
  return messages.flatMap((message) => (message.role === "assistant" ? message.parts : []));
}

function requestWords(messages: readonly ChatMessage[], request: string, name: string): string[] {
  for (const part of agentParts(messages)) {
    if (part.type === "tool" && part.tool.permission?.request === request) {
      return [`${name} asks for permission: ${spoken(chatToolName(part.tool))}`];
    }
    const question = part.type === "question" ? part.question : part.type === "tool" ? part.tool.question : undefined;
    if (question?.request === request) {
      return [`${name} asks a question`];
    }
  }
  return [];
}

function lastNotice(messages: readonly ChatMessage[], select: (notice: ChatNotice) => boolean): ChatNotice | undefined {
  return findNotice(agentParts(messages), select);
}

/** The stopped or interrupted notice of the last turn: a turn starts with a user message. */
function turnNotice(messages: readonly ChatMessage[]): ChatNotice | undefined {
  const start = messages.findLastIndex((message) => message.role === "user");
  return lastNotice(messages.slice(start + 1), (notice) => notice.kind === "stopped" || notice.kind === "interrupted");
}

/**
 * The rows of a diff, with the path inside the chat folder as the file name
 * when the file is in the folder. A change above `DIFF_EDIT_LIMIT` lines shows
 * the whole old text as removed and the whole new text as added. A mark row
 * stands for the lines that the diff leaves out: the unchanged lines away from
 * a change, the end of a long run of changes, and the lines after the last row.
 */
export function chatDiff(diff: Omit<Extract<ChatToolContent, { type: "diff" }>, "type">, folder: string): ChatDiff {
  const oldText = diff.oldText ?? "";
  const changes = diffLines(oldText, diff.newText, { maxEditLength: DIFF_EDIT_LIMIT }) ?? [
    { removed: true, added: false, value: oldText },
    { removed: false, added: true, value: diff.newText },
  ];
  const lines = changes.flatMap((change) => {
    const kind = change.added ? "added" : change.removed ? "removed" : "context";
    return lineTexts(change.value).map((text): ChatDiffLine => ({ kind, text }));
  });

  return {
    filename: pathIn(diff.path, folder),
    lines: diffRows(lines),
    additions: lines.filter((line) => line.kind === "added").length,
    deletions: lines.filter((line) => line.kind === "removed").length,
  };
}

/** A row of a diff, and the count of the lines of the diff that it stands for. */
type DiffRow = { line: ChatDiffLine; count: number };

function diffRows(lines: readonly ChatDiffLine[]): ChatDiffLine[] {
  const rows: DiffRow[] = [];
  for (let start = 0; start < lines.length;) {
    const { kind } = lines[start]!;
    let end = start + 1;
    while (end < lines.length && lines[end]!.kind === kind) {
      end += 1;
    }
    const run = lines.slice(start, end);
    rows.push(...(kind === "context"
      ? foldRun(run, start === 0 ? 0 : DIFF_CONTEXT, end === lines.length ? 0 : DIFF_CONTEXT, "unchanged lines")
      : foldRun(run, DIFF_CHANGE_LIMIT, 0, `more ${kind} lines`)));
    start = end;
  }

  if (rows.length <= DIFF_ROW_LIMIT) {
    return rows.map(({ line }) => line);
  }
  const shown = rows.slice(0, DIFF_ROW_LIMIT - 1);
  const rest = lines.length - shown.reduce((sum, { count }) => sum + count, 0);
  return [...shown.map(({ line }) => line), { kind: "context", text: `⋯ ${String(rest)} more lines` }];
}

/** The first `head` and the last `tail` lines of a run, and a mark for 2 or more lines between them. */
function foldRun(run: readonly ChatDiffLine[], head: number, tail: number, words: string): DiffRow[] {
  const hidden = run.length - head - tail;
  const rows = (part: readonly ChatDiffLine[]): DiffRow[] => part.map((line) => ({ line, count: 1 }));

  if (hidden < 2) {
    return rows(run);
  }
  return [
    ...rows(run.slice(0, head)),
    { line: { kind: run[0]!.kind, text: `⋯ ${String(hidden)} ${words}` }, count: hidden },
    ...rows(run.slice(run.length - tail)),
  ];
}

function pathIn(path: string, folder: string): string {
  const base = folder.endsWith("/") ? folder : `${folder}/`;
  return path.startsWith(base) && path.length > base.length ? path.slice(base.length) : path;
}

/** The lines of a text, with no empty line after a final line end. */
function lineTexts(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

/**
 * The kit `TerminalBlock` shows a missing exit code as "exit 0", so a tool that
 * ended with no exit code shows its output as a result.
 */
export function chatTerminalView(tool: ChatTool, terminal: string): ChatTerminalView {
  const { output, exitCode } = tool.terminals[terminal] ?? {};
  const runs = (tool.status === "pending" || tool.status === "in_progress") && !tool.stopped;
  const exited = typeof exitCode === "number";
  const lines = output === undefined ? undefined : terminalLines(output);

  if (!runs && !exited) {
    return { kind: "result", output: lines === undefined ? tool.output : lines.join("\n") };
  }

  const command = isObject(tool.input) && typeof tool.input.command === "string" ? tool.input.command : chatToolName(tool);
  return {
    kind: "block",
    command,
    lines: lines ?? [],
    done: !runs || exited,
    ...(exited ? { exitCode } : {}),
  };
}

/**
 * The last `TERMINAL_LINE_LIMIT` lines of an output, each cut to
 * `TERMINAL_LINE_WIDTH` characters, after a line that says so when the start
 * of the output is left out.
 */
function terminalLines(output: string): string[] {
  const long = output.length > TERMINAL_WINDOW;
  const lines = lineTexts(long ? output.slice(-TERMINAL_WINDOW) : output);
  // The window can start inside a line.
  if (long && lines.length > 1) {
    lines.shift();
  }
  const shown = lines.slice(-TERMINAL_LINE_LIMIT).map(cutLine);
  return long || lines.length > TERMINAL_LINE_LIMIT ? [EARLIER_OUTPUT, ...shown] : shown;
}

function cutLine(line: string): string {
  if (line.length <= TERMINAL_LINE_WIDTH) {
    return line;
  }
  const end = TERMINAL_LINE_WIDTH - 1;
  const code = line.charCodeAt(end - 1);
  // A cut after the first half of a surrogate pair leaves half a character.
  return `${line.slice(0, code >= 0xd8_00 && code <= 0xdb_ff ? end - 1 : end)}…`;
}

/** The values of an answer, the items of a list each on its own, joined with commas. */
export function chatAnswerText(answer: Readonly<Record<string, unknown>> | undefined): string {
  return Object.values(answer ?? {})
    .flatMap((value) => (Array.isArray(value) ? (value as unknown[]) : [value]))
    .map((value) => (typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)))
    .join(", ");
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
