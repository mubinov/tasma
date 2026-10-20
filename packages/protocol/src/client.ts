import type { Chat, ChatEventsReply } from "./chat.js";
import type { UserConfig, UserConfigChange } from "./config.js";
import { ProtocolError, TransportError } from "./errors.js";
import type { Envelope, Failure, Success } from "./errors.js";
import type { EventsReply } from "./events.js";
import type { Health } from "./health.js";
import type { Project, ProjectChange, ProjectInput, ProjectRename, ProjectSummary } from "./project.js";
import type {
  ChatEventsQuery,
  EventsQuery,
  Method,
  PathQuery,
  ProjectQuery,
  Route,
  TaskFilter,
  TaskReadOptions,
  TaskTextOptions,
} from "./routes.js";
import { buildPath, routes } from "./routes.js";
import type { CommentHeader, CommentInput, Task, TaskInput, TaskList, TaskText, WriteResult } from "./task.js";
import type { Workflow, WorkflowChange, WorkflowInput, WorkflowReceipt } from "./workflow.js";

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
  readChat(tag: string, id: string, chat: number): Promise<Success<Chat>>;
  /**
   * With `after` at the last `seq` of the log the daemon holds the call until
   * the next entry, so a transport timeout must be longer than the hold.
   */
  readChatEvents(
    tag: string,
    id: string,
    chat: number,
    after?: number,
    options?: CallOptions,
  ): Promise<Success<ChatEventsReply>>;
  listWorkflows(): Promise<Success<string[]>>;
  createWorkflow(input: WorkflowInput): Promise<Success<Workflow>>;
  readWorkflow(name: string): Promise<Success<Workflow>>;
  updateWorkflow(name: string, change: WorkflowChange): Promise<Success<Workflow>>;
  deleteWorkflow(name: string): Promise<Success<WorkflowReceipt>>;
  readUserConfig(): Promise<Success<UserConfig>>;
  updateUserConfig(change: UserConfigChange): Promise<Success<UserConfig>>;
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
    options: { body?: unknown; query?: PathQuery; signal?: CallSignal } = {},
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
    readChat: (tag, id, chat) => call<Chat>(routes.readChat, { project: tag, id, chat }),
    readChatEvents: (tag, id, chat, after, options) =>
      call<ChatEventsReply>(
        routes.readChatEvents,
        { project: tag, id, chat },
        { query: { after } satisfies ChatEventsQuery, signal: options?.signal },
      ),
    listWorkflows: () => call<string[]>(routes.listWorkflows, {}),
    createWorkflow: (input) => call<Workflow>(routes.createWorkflow, {}, { body: input }),
    readWorkflow: (name) => call<Workflow>(routes.readWorkflow, { workflow: name }),
    updateWorkflow: (name, change) => call<Workflow>(routes.updateWorkflow, { workflow: name }, { body: change }),
    deleteWorkflow: (name) => call<WorkflowReceipt>(routes.deleteWorkflow, { workflow: name }),
    readUserConfig: () => call<UserConfig>(routes.readUserConfig, {}),
    updateUserConfig: (change) => call<UserConfig>(routes.updateUserConfig, {}, { body: change }),
    readEvents: (after, options) =>
      call<EventsReply>(routes.readEvents, {}, { query: { after } satisfies EventsQuery, signal: options?.signal }),
  };
}
