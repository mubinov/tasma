import type {
  AgentOptions,
  AgentStateReply,
  Chat,
  ChatAgent,
  ChatCancelInput,
  ChatEventsReply,
  ChatInactiveInput,
  ChatListItem,
  ChatListPage,
  ChatMessageInput,
  ChatOf,
  ChatOptionChange,
  ChatSeenInput,
  ChatStart,
  ChatStartInput,
  PermissionAnswer,
  ProjectChatListItem,
  ProjectChatStart,
  ProjectChatStartInput,
  QuestionAnswer,
} from "./chat.js";
import type { UserConfig, UserConfigChange } from "./config.js";
import { ProtocolError, TransportError } from "./errors.js";
import type { Envelope, Failure, Success } from "./errors.js";
import type { EventsReply } from "./events.js";
import type { Health } from "./health.js";
import type { Project, ProjectChange, ProjectInput, ProjectRename, ProjectSummary } from "./project.js";
import type {
  ChatEventsQuery,
  ChatListQuery,
  EventsQuery,
  Method,
  PathQuery,
  ProjectQuery,
  Route,
  SetupQuery,
  TaskFilter,
  TaskReadOptions,
  TaskTextOptions,
} from "./routes.js";
import { buildPath, routes } from "./routes.js";
import type { SetupStatus, SkillInstall } from "./setup.js";
import type { CommentHeader, CommentInput, Task, TaskInput, TaskList, TaskText, WriteResult } from "./task.js";
import type { Workflow, WorkflowChange, WorkflowInput, WorkflowInstall, WorkflowReceipt } from "./workflow.js";

/**
 * The part of an `AbortSignal` a transport reads. This package compiles with no
 * host types, so it declares the shape itself; a DOM or a Node `AbortSignal`
 * matches it.
 */
export type CallSignal = {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void): void;
  removeEventListener(type: "abort", listener: () => void): void;
};

export type CallOptions = { signal?: CallSignal };

type CallParts = { body?: unknown; query?: PathQuery; signal?: CallSignal };

/**
 * One call, as the host that carries it sees it. `body` is a JavaScript value
 * rather than a string, and the reply's `body` is the parsed answer, so both
 * directions are symmetric and a host adapter is a few lines.
 */
export type TransportRequest = {
  method: Method;
  path: string;
  body?: unknown;
  signal?: CallSignal;
};

export type TransportReply = {
  status: number;
  body?: unknown;
};

/**
 * How a host carries a call. The client owns the method, the path and reading
 * the envelope; the transport owns the host, the port, the headers and
 * serialization. Injecting it is what keeps this package free of any platform
 * type, so the same contract compiles for a terminal and for a browser.
 */
export type Transport = (request: TransportRequest) => Promise<TransportReply>;

export type Client = {
  readHealth(): Promise<Success<Health>>;
  listProjects(): Promise<Success<ProjectSummary[]>>;
  createProject(input: ProjectInput): Promise<Success<Project>>;
  readProject(tag: string): Promise<Success<Project>>;
  updateProject(tag: string, change: ProjectChange): Promise<Success<Project>>;
  deleteProject(tag: string): Promise<Success<ProjectSummary>>;
  /** The answer is the project under its new tag, so a caller holding the old one reads `data.tag`. */
  renameProject(tag: string, rename: ProjectRename): Promise<Success<Project>>;
  /** The project of the tree that holds `directory`, and `null` where none of them does. */
  resolveProject(directory: string): Promise<Success<ProjectSummary | null>>;
  listTasks(tag: string, filter?: TaskFilter): Promise<Success<TaskList>>;
  createTask(tag: string, input: TaskInput): Promise<Success<WriteResult>>;
  readTask(tag: string, id: string, options?: TaskReadOptions): Promise<Success<Task>>;
  readTaskText(tag: string, id: string, options?: TaskTextOptions): Promise<Success<TaskText>>;
  updateTask(tag: string, id: string, change: TaskInput): Promise<Success<WriteResult>>;
  deleteTask(tag: string, id: string): Promise<Success<WriteResult>>;
  listComments(tag: string, id: string): Promise<Success<CommentHeader[]>>;
  addComment(tag: string, id: string, input: CommentInput): Promise<Success<WriteResult>>;
  updateComment(tag: string, id: string, commentId: number, change: CommentInput): Promise<Success<WriteResult>>;
  deleteComment(tag: string, id: string, commentId: number): Promise<Success<WriteResult>>;
  listChats(tag: string, id: string): Promise<Success<Chat[]>>;
  /**
   * The chat of the current step of the task, or of the first step of its
   * workflow when the task has no step. The answer is the latest chat of the
   * task when it is of that step, holds its first message and has not failed;
   * in other cases a new chat with its agent started. With `restart`, always a
   * new chat, after the agent of the latest chat of the task has stopped when
   * that chat is of the step; refused with `chat-not-current` when the task
   * moves to another step while that agent stops.
   */
  startChat(tag: string, id: string, input: ChatStartInput): Promise<Success<ChatStart>>;
  /** `id` is the id of the task. With `undefined`, reads chat `chat` of the project `tag`. */
  readChat<Id extends string | undefined>(tag: string, id: Id, chat: number): Promise<Success<ChatOf<Id>>>;
  /**
   * With `after` at the last `seq` of the log the daemon holds the call until
   * the next entry, so a transport timeout must be longer than the hold.
   */
  readChatEvents(
    tag: string,
    id: string | undefined,
    chat: number,
    after?: number,
    options?: CallOptions,
  ): Promise<Success<ChatEventsReply>>;
  /**
   * When no turn runs, starts a turn with the message. A chat with no agent
   * process gets its agent started again, on the conversation of the chat. A
   * message during a turn goes into that turn, and the agent reads it at its
   * next step or when its current work ends. The answer comes when the message
   * is in the log, never after a wait for the agent. Refused with
   * `turn-running` while the chat ends for a restart, and with
   * `chat-not-running` only while the daemon stops.
   */
  sendChatMessage<Id extends string | undefined>(
    tag: string,
    id: Id,
    chat: number,
    input: ChatMessageInput,
  ): Promise<Success<ChatOf<Id>>>;
  /**
   * Cancels the turn that runs. A message that `sendChatMessage` answered with
   * success and that the agent has not read yet can be dropped. A message after the
   * cancel goes into the same turn when that turn has not ended yet. Does
   * nothing when no turn runs.
   */
  cancelChatTurn<Id extends string | undefined>(
    tag: string,
    id: Id,
    chat: number,
    input: ChatCancelInput,
  ): Promise<Success<ChatOf<Id>>>;
  /**
   * `request` is the `request` of the `permission` event in the log. The first
   * answer wins, and a later one is refused with `already-answered`.
   */
  answerChatPermission<Id extends string | undefined>(
    tag: string,
    id: Id,
    chat: number,
    request: string,
    answer: PermissionAnswer,
  ): Promise<Success<ChatOf<Id>>>;
  /** As `answerChatPermission`, for a `question` event. */
  answerChatQuestion<Id extends string | undefined>(
    tag: string,
    id: Id,
    chat: number,
    request: string,
    answer: QuestionAnswer,
  ): Promise<Success<ChatOf<Id>>>;
  /**
   * Sets one config option of the agent of the chat, and makes the value the
   * default of the agent for new chats unless `AGENT_OPTION_RULES` lists it as
   * unsaved. A chat with no agent process gets its agent started again with no
   * prompt. The answer comes after the agent answers. Refused with
   * `option-refused` when the agent does not offer or does not take the value,
   * and with `turn-running` while the chat ends for a restart.
   */
  setChatOption<Id extends string | undefined>(
    tag: string,
    id: Id,
    chat: number,
    change: ChatOptionChange,
  ): Promise<Success<ChatOf<Id>>>;
  /**
   * Moves the `seen` of the chat forward to `seq`, at most to the last `seq` of
   * the log. A `seq` at or below the stored `seen` changes nothing.
   */
  markChatSeen<Id extends string | undefined>(
    tag: string,
    id: Id,
    chat: number,
    input: ChatSeenInput,
  ): Promise<Success<ChatOf<Id>>>;
  /**
   * Marks the chat as not active up to the last `seq` of its log: the chat has
   * no mark in a list until its state changes again. Refused with
   * `turn-running` while the agent works or a request waits.
   */
  markChatInactive<Id extends string | undefined>(
    tag: string,
    id: Id,
    chat: number,
    input: ChatInactiveInput,
  ): Promise<Success<ChatOf<Id>>>;
  /** One page of the chats of all projects, the active chats first and each group newest first. */
  listAllChats(query?: ChatListQuery): Promise<Success<ChatListPage>>;
  /** The one state of the agents of all projects, from the Active group of `listAllChats`. */
  readAgentState(): Promise<Success<AgentStateReply>>;
  /** One chat as `listAllChats` gives it, by the id of its task. */
  readChatItem(id: string, chat: number): Promise<Success<ChatListItem>>;
  /** Starts a new chat of the project, with `text` as its first message. Each call makes a new chat. */
  startProjectChat(tag: string, input: ProjectChatStartInput): Promise<Success<ProjectChatStart>>;
  /** One chat of a project as a row of the list of the chats of all projects. */
  readProjectChatItem(tag: string, chat: number): Promise<Success<ProjectChatListItem>>;
  /**
   * The options of the agent for a new chat. Refused with `agent-unknown` for
   * an agent that Tasma does not know. A read of a list that is missing or
   * older than 7 days starts a refresh in the background, and the new list
   * comes with an `agent-options` event.
   */
  readAgentOptions(agent: ChatAgent): Promise<Success<AgentOptions>>;
  listWorkflows(): Promise<Success<string[]>>;
  createWorkflow(input: WorkflowInput): Promise<Success<Workflow>>;
  readWorkflow(name: string): Promise<Success<Workflow>>;
  updateWorkflow(name: string, change: WorkflowChange): Promise<Success<Workflow>>;
  deleteWorkflow(name: string): Promise<Success<WorkflowReceipt>>;
  installWorkflow(name: string): Promise<Success<WorkflowInstall>>;
  readUserConfig(): Promise<Success<UserConfig>>;
  updateUserConfig(change: UserConfigChange): Promise<Success<UserConfig>>;
  /** A failed check never refuses the call: the check gives `fail` or `unknown`. */
  readSetup(query?: SetupQuery): Promise<Success<SetupStatus>>;
  /**
   * Starts the install of the tasma skill, or joins the install that runs. The
   * daemon answers within its hold: pass the `run` of a `running` answer back
   * to wait for the same install. A failed install is an answer, not a refusal.
   */
  installSkill(run?: string, options?: CallOptions): Promise<Success<SkillInstall>>;
  /**
   * With the current cursor the daemon holds the call until the next event, so
   * a transport timeout must be longer than the hold.
   */
  readEvents(after?: string, options?: CallOptions): Promise<Success<EventsReply>>;
};

const FAILURE_KINDS: Failure["kind"][] = ["store", "parse", "serialize", "daemon"];

/**
 * The discriminant, plus the two fields every arm carries. `ProtocolError`
 * passes the message to `Error`, which coerces it, so a message that refuses to
 * coerce — an own `toString` that is not callable, which `JSON.parse` builds
 * from a field of that name — would throw inside the constructor rather than
 * reach the caller as the refusal it describes.
 */
function isFailure(value: unknown): value is Failure {
  if (typeof value !== "object" || value === null) return false;
  const { kind, code, message } = value as { kind?: unknown; code?: unknown; message?: unknown };
  if (typeof code !== "string" || typeof message !== "string") return false;
  return typeof kind === "string" && (FAILURE_KINDS as string[]).includes(kind);
}

/**
 * Whether an answer is one this client can narrow on: the discriminant, plus
 * every field the arm it names always carries — the data and the diagnostics of
 * a success, the failure of a refusal.
 *
 * `data` is tested for presence rather than for a type: it is the one field
 * whose type the route decides, and JSON cannot carry an explicit `undefined`,
 * so a key that is there holds a value the route meant to send — `null`
 * included.
 *
 * The check reads no further than that, on purpose. A field-by-field check needs
 * a validator, which is a dependency this package refuses to take, and the
 * daemon is the same project on the loopback address rather than an untrusted
 * peer.
 */
function isEnvelope(value: unknown): value is Envelope<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const envelope = value as { ok?: unknown; error?: unknown; diagnostics?: unknown };
  if (typeof envelope.ok !== "boolean") return false;
  if (!envelope.ok) return isFailure(envelope.error);
  return "data" in envelope && Array.isArray(envelope.diagnostics);
}

/**
 * Every route as a named method. Each resolves to the data and the diagnostics
 * of a success, and throws on anything else: `ProtocolError` when the daemon
 * refused the call, `TransportError` when the call produced no answer this
 * client can read.
 *
 * A fault in the arguments themselves is neither. `buildPath` raises it before
 * the call leaves, and it reaches the caller unchanged: a placeholder no
 * argument fills, a value a URL would resolve away, or a string
 * `encodeURIComponent` refuses.
 */
export function createClient(transport: Transport): Client {
  async function call<T>(
    route: Route,
    params: Record<string, string | number>,
    options: CallParts = {},
  ): Promise<Success<T>> {
    const path = buildPath(route, params, options.query);
    const { body, signal } = options;

    let reply: TransportReply;
    try {
      reply = await transport({ method: route.method, path, body, ...(signal === undefined ? {} : { signal }) });
    } catch (cause) {
      throw new TransportError(`${route.method} ${path} reached no daemon`, undefined, cause);
    }

    if (!isEnvelope(reply.body)) {
      throw new TransportError(`${route.method} ${path} answered with no envelope`, reply.status);
    }
    if (!reply.body.ok) {
      throw new ProtocolError(reply.body.error, reply.status);
    }

    return { data: reply.body.data as T, diagnostics: reply.body.diagnostics };
  }

  function callChat<T>(
    taskRoute: Route,
    projectRoute: Route,
    tag: string,
    id: string | undefined,
    params: Record<string, string | number>,
    options?: CallParts,
  ): Promise<Success<T>> {
    return id === undefined
      ? call<T>(projectRoute, { ...params, project: tag }, options)
      : call<T>(taskRoute, { ...params, project: tag, id }, options);
  }

  return {
    readHealth: () => call<Health>(routes.health, {}),
    listProjects: () => call<ProjectSummary[]>(routes.listProjects, {}),
    createProject: (input) => call<Project>(routes.createProject, {}, { body: input }),
    readProject: (tag) => call<Project>(routes.readProject, { project: tag }),
    updateProject: (tag, change) => call<Project>(routes.updateProject, { project: tag }, { body: change }),
    deleteProject: (tag) => call<ProjectSummary>(routes.deleteProject, { project: tag }),
    renameProject: (tag, rename) => call<Project>(routes.renameProject, { project: tag }, { body: rename }),
    resolveProject: (directory) =>
      call<ProjectSummary | null>(routes.resolveProject, {}, { query: { path: directory } satisfies ProjectQuery }),
    listTasks: (tag, filter) => call<TaskList>(routes.listTasks, { project: tag }, { query: filter }),
    createTask: (tag, input) => call<WriteResult>(routes.createTask, { project: tag }, { body: input }),
    readTask: (tag, id, options) => call<Task>(routes.readTask, { project: tag, id }, { query: options }),
    readTaskText: (tag, id, options) => call<TaskText>(routes.readTaskText, { project: tag, id }, { query: options }),
    updateTask: (tag, id, change) => call<WriteResult>(routes.updateTask, { project: tag, id }, { body: change }),
    deleteTask: (tag, id) => call<WriteResult>(routes.deleteTask, { project: tag, id }),
    listComments: (tag, id) => call<CommentHeader[]>(routes.listComments, { project: tag, id }),
    addComment: (tag, id, input) => call<WriteResult>(routes.addComment, { project: tag, id }, { body: input }),
    updateComment: (tag, id, commentId, change) =>
      call<WriteResult>(routes.updateComment, { project: tag, id, commentId }, { body: change }),
    deleteComment: (tag, id, commentId) =>
      call<WriteResult>(routes.deleteComment, { project: tag, id, commentId }),
    listChats: (tag, id) => call<Chat[]>(routes.listChats, { project: tag, id }),
    startChat: (tag, id, input) => call<ChatStart>(routes.startChat, { project: tag, id }, { body: input }),
    readChat: (tag, id, chat) =>
      callChat<ChatOf<typeof id>>(routes.readChat, routes.readProjectChat, tag, id, { chat }),
    readChatEvents: (tag, id, chat, after, options) =>
      callChat<ChatEventsReply>(
        routes.readChatEvents,
        routes.readProjectChatEvents,
        tag,
        id,
        { chat },
        { query: { after } satisfies ChatEventsQuery, signal: options?.signal },
      ),
    sendChatMessage: (tag, id, chat, input) =>
      callChat<ChatOf<typeof id>>(
        routes.sendChatMessage,
        routes.sendProjectChatMessage,
        tag,
        id,
        { chat },
        { body: input },
      ),
    cancelChatTurn: (tag, id, chat, input) =>
      callChat<ChatOf<typeof id>>(
        routes.cancelChatTurn,
        routes.cancelProjectChatTurn,
        tag,
        id,
        { chat },
        { body: input },
      ),
    answerChatPermission: (tag, id, chat, request, answer) =>
      callChat<ChatOf<typeof id>>(
        routes.answerChatPermission,
        routes.answerProjectChatPermission,
        tag,
        id,
        { chat, request },
        { body: answer },
      ),
    answerChatQuestion: (tag, id, chat, request, answer) =>
      callChat<ChatOf<typeof id>>(
        routes.answerChatQuestion,
        routes.answerProjectChatQuestion,
        tag,
        id,
        { chat, request },
        { body: answer },
      ),
    setChatOption: (tag, id, chat, change) =>
      callChat<ChatOf<typeof id>>(
        routes.setChatOption,
        routes.setProjectChatOption,
        tag,
        id,
        { chat },
        { body: change },
      ),
    markChatSeen: (tag, id, chat, input) =>
      callChat<ChatOf<typeof id>>(routes.markChatSeen, routes.markProjectChatSeen, tag, id, { chat }, { body: input }),
    markChatInactive: (tag, id, chat, input) =>
      callChat<ChatOf<typeof id>>(
        routes.markChatInactive,
        routes.markProjectChatInactive,
        tag,
        id,
        { chat },
        { body: input },
      ),
    listAllChats: (query) => call<ChatListPage>(routes.listAllChats, {}, { query }),
    readAgentState: () => call<AgentStateReply>(routes.readAgentState, {}),
    readChatItem: (id, chat) => call<ChatListItem>(routes.readChatItem, { id, chat }),
    startProjectChat: (tag, input) =>
      call<ProjectChatStart>(routes.startProjectChat, { project: tag }, { body: input }),
    readProjectChatItem: (tag, chat) =>
      call<ProjectChatListItem>(routes.readProjectChatItem, { project: tag, chat }),
    readAgentOptions: (agent) => call<AgentOptions>(routes.readAgentOptions, { agent }),
    listWorkflows: () => call<string[]>(routes.listWorkflows, {}),
    createWorkflow: (input) => call<Workflow>(routes.createWorkflow, {}, { body: input }),
    readWorkflow: (name) => call<Workflow>(routes.readWorkflow, { workflow: name }),
    updateWorkflow: (name, change) => call<Workflow>(routes.updateWorkflow, { workflow: name }, { body: change }),
    deleteWorkflow: (name) => call<WorkflowReceipt>(routes.deleteWorkflow, { workflow: name }),
    // The daemon refuses a POST with no content type, and a transport sets one only with a body.
    installWorkflow: (name) => call<WorkflowInstall>(routes.installWorkflow, { workflow: name }, { body: {} }),
    readUserConfig: () => call<UserConfig>(routes.readUserConfig, {}),
    updateUserConfig: (change) => call<UserConfig>(routes.updateUserConfig, {}, { body: change }),
    readSetup: (query) => call<SetupStatus>(routes.readSetup, {}, { query }),
    installSkill: (run, options) =>
      call<SkillInstall>(routes.installSkill, {}, { body: run === undefined ? {} : { run }, signal: options?.signal }),
    readEvents: (after, options) =>
      call<EventsReply>(routes.readEvents, {}, { query: { after } satisfies EventsQuery, signal: options?.signal }),
  };
}
