// A chat of a task as it crosses the wire: its events, its state, and the fold
// that derives the state from the events. No file stores the state: the daemon
// and every client derive it from the log with `foldChat`.

/** As the engine declares it; `test/protocol-contract.test.ts` keeps the two equal. */
export type ChatAgent = "claude" | "codex";

export type ChatState = "working" | "needs-you" | "failed" | "continued-outside";

/** Where a chat continues after it leaves Tasma. */
export type ChatOutside = "vscode" | "terminal";

export type ChatStatus
  = | { state: Exclude<ChatState, "continued-outside"> }
    | { state: "continued-outside"; where: ChatOutside };

/** An ACP object as the agent sent it. The protocol depends on nothing, so it does not type the ACP shapes. */
export type AcpObject = Readonly<Record<string, unknown>>;

/**
 * One event of a chat log. `request` is the id the daemon gives to a
 * permission request or a question, so that its resolution names it. `client`
 * names the client that sent a message or an answer; a resolution without it
 * was made by the daemon.
 */
export type ChatEvent
  = | { kind: "user"; text: string; client: string }
    | { kind: "update"; update: AcpObject }
    | { kind: "permission"; request: string; permission: AcpObject }
    | { kind: "permission-resolved"; request: string; outcome: AcpObject; client?: string }
    | { kind: "question"; request: string; question: AcpObject }
    | { kind: "question-resolved"; request: string; answer: AcpObject; client?: string }
    | { kind: "turn-end"; stopReason: string }
    | { kind: "failed"; reason: string }
    | { kind: "interrupted" }
    | { kind: "resumed" }
    | { kind: "continued-outside"; where: ChatOutside };

export type ChatEntry = { seq: number; at: string; event: ChatEvent };

export type Chat = {
  /** The id of the task, for example `ALPHA-3`. */
  task: string;
  chat: number;
  step: string;
  agent: ChatAgent;
  /** The folder the agent works in. */
  folder: string;
  created: string;
  /** The session id of the agent, once the agent gives one. */
  session?: string;
  /**
   * The last value picked in this chat for each config option of the agent,
   * by option id. The current values are in the log.
   */
  options?: Record<string, string>;
  /** The `seq` of the last entry of the log, 0 for an empty log. */
  seq: number;
} & ChatStatus;

/** One chat in the list of the chats of all projects. */
export type ChatListItem = {
  tag: string;
  /** The id of the task, for example `ALPHA-3`. */
  task: string;
  title: string;
  chat: number;
  step: string;
  agent: ChatAgent;
  created: string;
  /** Only on the latest chat of a task whose status is not final. */
  status?: ChatStatus;
};

/** One page of the list of the chats of all projects, newest first. */
export type ChatListPage = {
  items: ChatListItem[];
  /** The count of all chats that match `project` and `q`, on all pages. */
  total: number;
  /** The `after` of the next page. Absent on the last page. */
  next?: string;
};

/**
 * The answer to a read of a chat log. `cursor` is the `seq` of the last entry
 * of the answer, or the `after` of the read for an answer with no entries, and
 * the next read passes it back as `after`. `reset` answers an `after` above the
 * last `seq` of the log, and the client then reads the log again from 0.
 */
export type ChatEventsReply
  = | { cursor: number; entries: ChatEntry[] }
    | { reset: true; cursor: 0 };

/**
 * The bodies of the commands on a chat. `client` names the client that sends
 * the command; the daemon writes it into the events the command causes and
 * does not interpret it.
 */
export type ChatMessageInput = { text: string; client: string };

export type ChatCancelInput = { client: string };

export type ChatStartInput = { client: string };

/** A value for one config option of the agent of a chat, as ACP's `session/set_config_option` takes it. */
export type ChatOptionChange = { configId: string; value: string; client: string };

type OptionValues = Readonly<Record<string, readonly string[]>>;

/**
 * The config option values of each agent that a pick treats apart, by option
 * id. A `hidden` value is not offered, and a pick of it is refused. An
 * `unsaved` value applies to its chat but never becomes the default of the
 * agent for new chats.
 */
export const AGENT_OPTION_RULES: Readonly<Record<ChatAgent, { hidden: OptionValues; unsaved: OptionValues }>> = {
  claude: { hidden: { mode: ["plan"] }, unsaved: { mode: ["plan", "bypassPermissions"] } },
  codex: { hidden: {}, unsaved: {} },
};

/** `started` is false when the answer is a chat that the task already had. */
export type ChatStart = { chat: Chat; started: boolean };

/** `optionId` is one of the options of the permission request. */
export type PermissionAnswer = { optionId: string; client: string };

/** As ACP's `ElicitationContentValue`. */
export type QuestionValue = string | number | boolean | string[];

export type QuestionAnswer
  = | { action: "accept"; content: Readonly<Record<string, QuestionValue>>; client: string }
    | { action: "decline"; client: string };

/**
 * What a fold of a chat log keeps: whether a turn runs, the requests that wait
 * for an answer, and the stop that holds the chat until a message or `resumed`.
 */
export type ChatFold = { turn: boolean; open: readonly string[]; stopped?: ChatStatus; status: ChatStatus };

const NEEDS_YOU: ChatStatus = { state: "needs-you" };

const WORKING: ChatStatus = { state: "working" };

/** The fold of an empty log. */
export const CHAT_START: ChatFold = { turn: false, open: [], status: NEEDS_YOU };

function settle(parts: Omit<ChatFold, "status">): ChatFold {
  const status = parts.stopped ?? (parts.turn && parts.open.length === 0 ? WORKING : NEEDS_YOU);
  return { ...parts, status };
}

/**
 * The fold after one more event. It accepts every event in every state, and an
 * event of a kind it does not know changes nothing. The end of a turn clears
 * the open requests, because a request of an ended turn cannot be answered.
 */
export function foldChat(fold: ChatFold, event: ChatEvent): ChatFold {
  const { turn, open, stopped } = fold;
  switch (event.kind) {
    case "user":
      return settle({ turn: true, open });
    case "permission":
    case "question":
      return settle({ turn, open: [...open.filter((id) => id !== event.request), event.request], stopped });
    case "permission-resolved":
    case "question-resolved":
      return settle({ turn, open: open.filter((id) => id !== event.request), stopped });
    case "turn-end":
    case "interrupted":
      return settle({ turn: false, open: [], stopped });
    case "failed":
      return settle({ turn: false, open: [], stopped: { state: "failed" } });
    case "continued-outside":
      return settle({ turn: false, open: [], stopped: { state: "continued-outside", where: event.where } });
    case "resumed":
      return settle({ turn, open });
    default:
      return fold;
  }
}
