import { CHAT_START, foldChat, type AcpObject, type ChatEntry, type ChatFold, type ChatOutside } from "@tasma/protocol";

export type ChatView = {
  /** The `seq` of the last folded entry, 0 for none. */
  seq: number;
  /** `foldChat` of `@tasma/protocol` over the same events. `fold.status` is the chat state. */
  fold: ChatFold;
  messages: readonly ChatMessage[];
  /** The `select` config options of the agent, from the last `config_option_update`. */
  options: readonly ChatOption[];
};

export type ChatOption = {
  id: string;
  name: string;
  description?: string;
  category?: string;
  /** The current value, by its id. */
  current: string;
  values: readonly ChatOptionValue[];
};

export type ChatOptionValue = { value: string; name: string; description?: string };

export type ChatMessage = ChatUserMessage | ChatAgentMessage;

export type ChatUserMessage = { role: "user"; id: string; at: string; text: string };

export type ChatAgentMessage = {
  role: "assistant";
  id: string;
  at: string;
  parts: readonly ChatPart[];
  /** The message takes new parts: until its turn ends, the chat stops, or a user message comes. */
  open: boolean;
  /** The turn of the message runs: the message was added while a turn ran, and it is still open. */
  running: boolean;
};

export type ChatPart
  = | { type: "text"; text: string; messageId?: string }
    | { type: "reasoning"; text: string; messageId?: string }
    | { type: "plan"; entries: readonly ChatPlanEntry[] }
    | { type: "tool"; tool: ChatTool }
    | { type: "question"; question: ChatQuestion }
    | { type: "notice"; notice: ChatNotice };

export type ChatPlanEntry = { content: string; status: "pending" | "in_progress" | "completed" };

export type ChatTool = {
  /** The ACP `toolCallId`. */
  id: string;
  /** "" until the agent gives a title. */
  title: string;
  /** The ACP `ToolKind`, "other" when the agent gives none. */
  kind: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  /** A turn ended while the tool was pending or in progress. */
  stopped: boolean;
  /** The ACP `rawInput`. */
  input?: unknown;
  /** The ACP `rawOutput`. */
  output?: unknown;
  content: readonly ChatToolContent[];
  /** The output and the exit code of each terminal of the tool, by terminal id. */
  terminals: Readonly<Record<string, ChatTerminal>>;
  permission?: ChatPermission;
  question?: ChatQuestion;
};

export type ChatToolContent
  = | { type: "text"; text: string }
    | { type: "diff"; path: string; oldText: string | null; newText: string }
    | { type: "terminal"; terminal: string };

export type ChatTerminal = { output?: string; exitCode?: number | null };

export type ChatPermissionOption = { id: string; name: string; kind: string };

export type ChatPermission = {
  request: string;
  options: readonly ChatPermissionOption[];
  /** `ended`: the turn ended while the request was open, with no resolution. */
  state: "open" | "selected" | "cancelled" | "ended";
  /** The chosen option, when `state` is `selected`. */
  option?: string;
};

export type ChatQuestion = {
  request: string;
  message: string;
  /** The `title` of the schema. */
  title?: string;
  /** The `description` of the schema. */
  description?: string;
  fields: readonly ChatQuestionField[];
  state: "open" | "accepted" | "declined" | "cancelled" | "ended";
  /** The answer values, when `state` is `accepted`. */
  answer?: Readonly<Record<string, unknown>>;
};

/** One property of the schema of a question. The limits are those of ACP, with the same names. */
export type ChatQuestionField = {
  name: string;
  /** The type of the value: `string`, `number`, `integer`, `boolean`, `array`, or a custom type of the agent. */
  type?: string;
  title?: string;
  description?: string;
  /** The `required` list of the schema names the field. */
  required: boolean;
  /** The value is a list (`type: "array"`): more than one choice. */
  multiple: boolean;
  choices: readonly ChatQuestionChoice[];
  /** The `default` of the property, when it fits the `type`. */
  default?: string | number | boolean | readonly string[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};

/** `value` is what an answer holds, `label` is what the user reads. */
export type ChatQuestionChoice = { value: string; label: string; description?: string };

/** `stopped` is a turn that ended with a stop reason other than `end_turn`. */
export type ChatNotice
  = | { kind: "failed"; reason: string }
    | { kind: "stopped"; stopReason: string }
    | { kind: "interrupted" }
    | { kind: "resumed" }
    | { kind: "continued-outside"; where: ChatOutside };

export const CHAT_VIEW_START: ChatView = { seq: 0, fold: CHAT_START, messages: [], options: [] };

/** A turn runs or a request is open. The runner can open a request outside a turn. */
export function chatBusy({ turn, open }: ChatFold): boolean {
  return turn || open.length > 0;
}

/** One entry as the fold applies it: the list it changes, and whether a turn ran before it. */
type Step = { messages: ChatMessage[]; entry: ChatEntry; turn: boolean };

/** A part that a search found, with the value that the search took from it. */
type Found<T> = { index: number; message: ChatAgentMessage; position: number; part: ChatPart; value: T };

const TOOL_STATUSES: readonly ChatTool["status"][] = ["pending", "in_progress", "completed", "failed"];

const PLAN_STATUSES: readonly ChatPlanEntry["status"][] = ["pending", "in_progress", "completed"];

const FIELD_TEXTS = ["title", "description", "pattern", "format"] as const;

const FIELD_NUMBERS = ["minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems"] as const;

/**
 * The view after the entries. An entry at or below `view.seq` is skipped. A
 * message or a part that the entries do not change keeps its identity, and a
 * list with no new entry gives the same view.
 *
 * The ACP objects inside the events are read with no schema: a field with an
 * unexpected type counts as absent, and an unknown kind of event or update is
 * skipped.
 */
export function foldChatEntries(view: ChatView, entries: readonly ChatEntry[]): ChatView {
  let { seq, fold, options } = view;
  let messages: ChatMessage[] | undefined;

  for (const entry of entries) {
    if (entry.seq <= seq) {
      continue;
    }
    messages ??= [...view.messages];
    applyEvent({ messages, entry, turn: fold.turn });
    options = foldOptions(options, entry.event);
    fold = foldChat(fold, entry.event);
    seq = entry.seq;
  }

  return messages === undefined ? view : { seq, fold, messages, options };
}

function foldOptions(options: readonly ChatOption[], event: ChatEntry["event"]): readonly ChatOption[] {
  if (event.kind !== "update" || !isRecord(event.update)) {
    return options;
  }

  const { sessionUpdate, configOptions, currentModeId } = event.update;
  if (sessionUpdate === "config_option_update" && Array.isArray(configOptions)) {
    return configOptions.flatMap(chatOption);
  }
  if (sessionUpdate !== "current_mode_update" || typeof currentModeId !== "string") {
    return options;
  }

  const index = options.findIndex((option) => option.category === "mode");
  const mode = options[index];
  return mode === undefined || mode.current === currentModeId
    ? options
    : options.with(index, { ...mode, current: currentModeId });
}

function chatOption(item: unknown): ChatOption[] {
  const { type, id, name, currentValue, description, category, options } = recordOf(item);
  if (type !== "select" || typeof id !== "string" || !isFilledString(name) || typeof currentValue !== "string") {
    return [];
  }

  const entries: readonly unknown[] = Array.isArray(options) ? options : [];
  const values = entries.flatMap((entry): readonly unknown[] => {
    const group = recordOf(entry);
    if (!("group" in group)) {
      return [entry];
    }
    return Array.isArray(group.options) ? group.options : [];
  });
  return [{
    id,
    name,
    ...(typeof description === "string" ? { description } : {}),
    ...(typeof category === "string" ? { category } : {}),
    current: currentValue,
    values: values.flatMap(optionValue),
  }];
}

function optionValue(item: unknown): ChatOptionValue[] {
  const { value, name, description } = recordOf(item);
  if (typeof value !== "string" || !isFilledString(name)) {
    return [];
  }
  return [{ value, name, ...(typeof description === "string" ? { description } : {}) }];
}

function applyEvent(step: Step): void {
  const { messages, entry } = step;
  const { event } = entry;

  switch (event.kind) {
    case "user":
      closeOpen(messages);
      messages.push({ role: "user", id: `u${entry.seq}`, at: entry.at, text: event.text });
      break;
    case "update":
      if (isRecord(event.update)) {
        applyUpdate(step, event.update);
      }
      break;
    case "permission":
      openPermission(step, event.request, recordOf(event.permission));
      break;
    case "permission-resolved":
      resolvePermission(messages, event.request, recordOf(event.outcome));
      break;
    case "question":
      openQuestion(step, event.request, recordOf(event.question));
      break;
    case "question-resolved":
      resolveQuestion(messages, event.request, recordOf(event.answer));
      break;
    case "turn-end":
      if (event.stopReason !== "end_turn") {
        addNotice(step, { kind: "stopped", stopReason: event.stopReason });
      }
      endTurn(messages);
      break;
    case "failed":
      addNotice(step, { kind: "failed", reason: event.reason });
      endTurn(messages);
      break;
    case "interrupted":
      addNotice(step, { kind: "interrupted" });
      endTurn(messages);
      break;
    case "continued-outside":
      addNotice(step, { kind: "continued-outside", where: event.where });
      endTurn(messages);
      break;
    case "resumed":
      addNotice(step, { kind: "resumed" });
      break;
  }
}

function applyUpdate(step: Step, update: AcpObject): void {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      addChunk(step, "text", update);
      break;
    case "agent_thought_chunk":
      addChunk(step, "reasoning", update);
      break;
    case "plan":
      setPlan(step, update);
      break;
    case "tool_call":
    case "tool_call_update": {
      const id = stringOf(update.toolCallId);
      if (id !== undefined) {
        changeTool(step, id, (tool) => mergeTool(tool, update));
      }
      break;
    }
  }
}

/**
 * Changes the parts of the open message. With no open message, the parts go
 * into a new assistant message, which is open unless `open` is false.
 */
function changeOpen(step: Step, change: (parts: readonly ChatPart[]) => readonly ChatPart[], open = true): void {
  const { messages, entry } = step;
  const last = messages.at(-1);

  if (last?.role === "assistant" && last.open) {
    messages[messages.length - 1] = { ...last, parts: change(last.parts) };
    return;
  }

  messages.push({
    role: "assistant",
    id: `a${entry.seq}`,
    at: entry.at,
    parts: change([]),
    open,
    running: open && step.turn,
  });
}

function closeOpen(messages: ChatMessage[]): void {
  const last = messages.at(-1);
  if (last?.role === "assistant" && last.open) {
    messages[messages.length - 1] = { ...last, open: false, running: false };
  }
}

function addNotice(step: Step, notice: ChatNotice): void {
  changeOpen(step, (parts) => [...parts, { type: "notice", notice }], false);
}

function addChunk(step: Step, type: "text" | "reasoning", update: AcpObject): void {
  const content = recordOf(update.content);
  const text = content.type === "text" ? stringOf(content.text) : undefined;
  if (text === undefined) {
    return;
  }

  const messageId = stringOf(update.messageId);
  changeOpen(step, (parts) => {
    const last = parts.at(-1);
    if ((last?.type === "text" || last?.type === "reasoning") && last.type === type && last.messageId === messageId) {
      return parts.with(-1, { ...last, text: last.text + text });
    }
    return [...parts, { type, text, ...(messageId === undefined ? {} : { messageId }) }];
  });
}

function setPlan(step: Step, update: AcpObject): void {
  const entries = Array.isArray(update.entries) ? update.entries.flatMap(planEntry) : [];
  const plan: ChatPart = { type: "plan", entries };

  changeOpen(step, (parts) => {
    const position = parts.findIndex((part) => part.type === "plan");
    return position === -1 ? [...parts, plan] : parts.with(position, plan);
  });
}

function planEntry(entry: unknown): ChatPlanEntry[] {
  const { content, status } = recordOf(entry);
  if (typeof content !== "string") {
    return [];
  }
  return [{ content, status: isOneOf(PLAN_STATUSES, status) ? status : "pending" }];
}

/** Finds the tool by its id in all messages, newest first, or adds it to the open message, and changes it. */
function changeTool(step: Step, id: string, change: (tool: ChatTool) => ChatTool): void {
  const found = findPart(step.messages, (part) => (part.type === "tool" && part.tool.id === id ? part.tool : undefined));

  if (found === undefined) {
    const tool = change({ id, title: "", kind: "other", status: "pending", stopped: false, content: [], terminals: {} });
    changeOpen(step, (parts) => [...parts, { type: "tool", tool }]);
    return;
  }

  const tool = change(found.value);
  if (tool !== found.value) {
    setPart(step.messages, found, { type: "tool", tool });
  }
}

/** The tool with the fields of an ACP `ToolCall` or `ToolCallUpdate`: each field that is present and not null. */
function mergeTool(tool: ChatTool, update: AcpObject): ChatTool {
  const change: Partial<ChatTool> = {};
  const { title, kind, status, rawInput, rawOutput, content } = update;

  if (typeof title === "string") {
    change.title = title;
  }
  if (typeof kind === "string") {
    change.kind = kind;
  }
  if (isOneOf(TOOL_STATUSES, status)) {
    change.status = status;
  }
  if (rawInput !== undefined && rawInput !== null) {
    change.input = rawInput;
  }
  if (rawOutput !== undefined && rawOutput !== null) {
    change.output = rawOutput;
  }
  if (Array.isArray(content)) {
    change.content = content.flatMap(toolContent);
  }
  const terminals = mergeTerminals(tool.terminals, update._meta);
  if (terminals !== tool.terminals) {
    change.terminals = terminals;
  }

  return Object.keys(change).length === 0 ? tool : { ...tool, ...change };
}

function toolContent(item: unknown): ChatToolContent[] {
  const fields = recordOf(item);

  switch (fields.type) {
    case "content": {
      const block = recordOf(fields.content);
      const text = block.type === "text" ? stringOf(block.text) : undefined;
      return text === undefined ? [] : [{ type: "text", text }];
    }
    case "diff": {
      const { path, oldText = null, newText } = fields;
      if (typeof path !== "string" || typeof newText !== "string" || (oldText !== null && typeof oldText !== "string")) {
        return [];
      }
      return [{ type: "diff", path, oldText, newText }];
    }
    case "terminal": {
      const terminal = stringOf(fields.terminalId);
      return terminal === undefined ? [] : [{ type: "terminal", terminal }];
    }
    default:
      return [];
  }
}

/** The terminals with `_meta.terminal_output` and `_meta.terminal_exit` of a tool call update. */
function mergeTerminals(terminals: ChatTool["terminals"], meta: unknown): ChatTool["terminals"] {
  const { terminal_output: output, terminal_exit: exit } = recordOf(meta);
  let next = terminals;

  const { terminal_id: outputId, data } = recordOf(output);
  if (typeof outputId === "string" && typeof data === "string") {
    next = { ...next, [outputId]: { ...next[outputId], output: data } };
  }

  const { terminal_id: exitId, exit_code: exitCode } = recordOf(exit);
  if (typeof exitId === "string") {
    next = { ...next, [exitId]: { ...next[exitId], exitCode: typeof exitCode === "number" ? exitCode : null } };
  }

  return next;
}

function openPermission(step: Step, request: string, permission: AcpObject): void {
  const toolCall = recordOf(permission.toolCall);
  const id = stringOf(toolCall.toolCallId) ?? request;
  const options = Array.isArray(permission.options) ? permission.options.flatMap(permissionOption) : [];

  changeTool(step, id, (tool) => ({ ...mergeTool(tool, toolCall), permission: { request, options, state: "open" } }));
}

function permissionOption(option: unknown): ChatPermissionOption[] {
  const { optionId, name, kind } = recordOf(option);
  if (typeof optionId !== "string") {
    return [];
  }
  return [{ id: optionId, name: typeof name === "string" ? name : optionId, kind: typeof kind === "string" ? kind : "" }];
}

function resolvePermission(messages: ChatMessage[], request: string, outcome: AcpObject): void {
  const found = findPart(messages, (part) => {
    if (part.type === "tool" && part.tool.permission?.request === request) {
      return { tool: part.tool, permission: part.tool.permission };
    }
    return undefined;
  });
  if (found === undefined) {
    return;
  }

  const { tool, permission } = found.value;
  const { options } = permission;
  const option = stringOf(outcome.optionId);
  const resolved: ChatPermission = outcome.outcome === "selected"
    ? { request, options, state: "selected", ...(option === undefined ? {} : { option }) }
    : { request, options, state: "cancelled" };

  setPart(messages, found, { type: "tool", tool: { ...tool, permission: resolved } });
}

function openQuestion(step: Step, request: string, acp: AcpObject): void {
  const schema = recordOf(acp.requestedSchema);
  const required = Array.isArray(schema.required) ? schema.required.filter((name) => typeof name === "string") : [];
  const { title, description } = schema;
  const question: ChatQuestion = {
    request,
    message: stringOf(acp.message) ?? "",
    ...(typeof title === "string" ? { title } : {}),
    ...(typeof description === "string" ? { description } : {}),
    fields: Object.entries(recordOf(schema.properties)).map(([name, property]) =>
      questionField(name, recordOf(property), required.includes(name)),
    ),
    state: "open",
  };

  const toolId = stringOf(acp.toolCallId);
  if (toolId === undefined) {
    changeOpen(step, (parts) => [...parts, { type: "question", question }]);
  } else {
    changeTool(step, toolId, (tool) => ({ ...tool, question }));
  }
}

function questionField(name: string, property: AcpObject, required: boolean): ChatQuestionField {
  const type = stringOf(property.type);
  const field: ChatQuestionField = { name, required, multiple: type === "array", choices: choicesOf(property) };

  if (type !== undefined) {
    field.type = type;
  }
  for (const key of FIELD_TEXTS) {
    const value = property[key];
    if (typeof value === "string") {
      field[key] = value;
    }
  }
  for (const key of FIELD_NUMBERS) {
    const value = property[key];
    if (typeof value === "number") {
      field[key] = value;
    }
  }
  const value = defaultOf(type, property.default);
  if (value !== undefined) {
    field.default = value;
  }

  return field;
}

function defaultOf(type: string | undefined, value: unknown): ChatQuestionField["default"] {
  switch (type) {
    case "string":
      return stringOf(value);
    case "number":
    case "integer":
      return typeof value === "number" ? value : undefined;
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "array":
      return isStringList(value) ? value : undefined;
    default:
      return undefined;
  }
}

/**
 * The choices of a property: the items of `oneOf` or `anyOf`, of the property
 * or of its `items`, else the strings of `enum`.
 */
function choicesOf(property: AcpObject): ChatQuestionChoice[] {
  const items = recordOf(property.items);

  const options = [property.oneOf, property.anyOf, items.oneOf, items.anyOf].find(isFilledList);
  if (options !== undefined) {
    return options.flatMap(enumChoice);
  }

  const values = [property.enum, items.enum].find(isFilledList);
  return values === undefined ? [] : values.flatMap((value) => (typeof value === "string" ? [{ value, label: value }] : []));
}

function enumChoice(option: unknown): ChatQuestionChoice[] {
  const { const: value, title, description } = recordOf(option);
  if (typeof value !== "string") {
    return [];
  }
  return [{ value, label: stringOf(title) ?? value, ...(typeof description === "string" ? { description } : {}) }];
}

function resolveQuestion(messages: ChatMessage[], request: string, answer: AcpObject): void {
  const found = findPart(messages, (part) => {
    const question = questionOf(part);
    return question?.request === request ? question : undefined;
  });
  if (found === undefined) {
    return;
  }

  const resolved: ChatQuestion = { ...found.value, state: answeredState(answer.action) };
  delete resolved.answer;
  if (resolved.state === "accepted" && isRecord(answer.content)) {
    resolved.answer = answer.content;
  }

  setPart(messages, found, withQuestion(found.part, resolved));
}

function answeredState(action: unknown): ChatQuestion["state"] {
  switch (action) {
    case "accept":
      return "accepted";
    case "decline":
      return "declined";
    default:
      return "cancelled";
  }
}

function questionOf(part: ChatPart): ChatQuestion | undefined {
  if (part.type === "question") {
    return part.question;
  }
  return part.type === "tool" ? part.tool.question : undefined;
}

function withQuestion(part: ChatPart, question: ChatQuestion): ChatPart {
  return part.type === "tool" ? { type: "tool", tool: { ...part.tool, question } } : { type: "question", question };
}

/** Ends the open requests and stops the running tools of all messages, and closes the open message. */
function endTurn(messages: ChatMessage[]): void {
  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant") {
      const parts = endParts(message.parts);
      if (parts !== message.parts) {
        messages[index] = { ...message, parts };
      }
    }
  }
  closeOpen(messages);
}

function endParts(parts: readonly ChatPart[]): readonly ChatPart[] {
  let changed = false;
  const next = parts.map((part) => {
    const ended = endPart(part);
    changed ||= ended !== part;
    return ended;
  });
  return changed ? next : parts;
}

function endPart(part: ChatPart): ChatPart {
  if (part.type === "question" && part.question.state === "open") {
    return { type: "question", question: { ...part.question, state: "ended" } };
  }
  if (part.type !== "tool") {
    return part;
  }

  let { tool } = part;
  if (!tool.stopped && (tool.status === "pending" || tool.status === "in_progress")) {
    tool = { ...tool, stopped: true };
  }
  if (tool.permission?.state === "open") {
    tool = { ...tool, permission: { ...tool.permission, state: "ended" } };
  }
  if (tool.question?.state === "open") {
    tool = { ...tool, question: { ...tool.question, state: "ended" } };
  }
  return tool === part.tool ? part : { type: "tool", tool };
}

/** The first part, newest message first, from which `select` takes a value. */
function findPart<T>(
  messages: readonly ChatMessage[],
  select: (part: ChatPart) => T | undefined,
): Found<T> | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") {
      continue;
    }
    for (const [position, part] of message.parts.entries()) {
      const value = select(part);
      if (value !== undefined) {
        return { index, message, position, part, value };
      }
    }
  }
  return undefined;
}

function setPart(messages: ChatMessage[], found: Found<unknown>, part: ChatPart): void {
  const { index, message, position } = found;
  messages[index] = { ...message, parts: message.parts.with(position, part) };
}

function isRecord(value: unknown): value is AcpObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordOf(value: unknown): AcpObject {
  return isRecord(value) ? value : {};
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isFilledString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return (values as readonly unknown[]).includes(value);
}

function isFilledList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value) && value.length > 0;
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
