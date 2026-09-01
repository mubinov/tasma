import { ProtocolError, TransportError } from "./errors.js";
import type { Envelope, Failure, Success } from "./errors.js";
import type { Health } from "./health.js";
import type { Project } from "./project.js";
import type { Method, Route, TaskFilter } from "./routes.js";
import { buildPath, routes } from "./routes.js";
import type { CommentInput, Task, TaskInput, TaskList, WriteResult } from "./task.js";

/**
 * One call, as the host that carries it sees it. `body` is a JavaScript value
 * rather than a string, and the reply's `body` is the parsed answer, so both
 * directions are symmetric and a host adapter is a few lines.
 */
export type TransportRequest = {
  method: Method;
  path: string;
  body?: unknown;
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
  listProjects(): Promise<Success<Project[]>>;
  readProject(tag: string): Promise<Success<Project>>;
  listTasks(tag: string, filter?: TaskFilter): Promise<Success<TaskList>>;
  createTask(tag: string, input: TaskInput): Promise<Success<WriteResult>>;
  readTask(tag: string, id: string): Promise<Success<Task>>;
  updateTask(tag: string, id: string, change: TaskInput): Promise<Success<WriteResult>>;
  deleteTask(tag: string, id: string): Promise<Success<WriteResult>>;
  addComment(tag: string, id: string, input: CommentInput): Promise<Success<WriteResult>>;
  updateComment(tag: string, id: string, commentId: number, change: CommentInput): Promise<Success<WriteResult>>;
  deleteComment(tag: string, id: string, commentId: number): Promise<Success<WriteResult>>;
};

const FAILURE_KINDS: Failure["kind"][] = ["store", "parse", "serialize", "daemon"];

function isFailure(value: unknown): value is Failure {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
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
    options: { body?: unknown; query?: TaskFilter } = {},
  ): Promise<Success<T>> {
    const path = buildPath(route, params, options.query);

    let reply: TransportReply;
    try {
      reply = await transport({ method: route.method, path, body: options.body });
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
    listProjects: () => call<Project[]>(routes.listProjects, {}),
    readProject: (tag) => call<Project>(routes.readProject, { project: tag }),
    listTasks: (tag, filter) => call<TaskList>(routes.listTasks, { project: tag }, { query: filter }),
    createTask: (tag, input) => call<WriteResult>(routes.createTask, { project: tag }, { body: input }),
    readTask: (tag, id) => call<Task>(routes.readTask, { project: tag, id }),
    updateTask: (tag, id, change) => call<WriteResult>(routes.updateTask, { project: tag, id }, { body: change }),
    deleteTask: (tag, id) => call<WriteResult>(routes.deleteTask, { project: tag, id }),
    addComment: (tag, id, input) => call<WriteResult>(routes.addComment, { project: tag, id }, { body: input }),
    updateComment: (tag, id, commentId, change) =>
      call<WriteResult>(routes.updateComment, { project: tag, id, commentId }, { body: change }),
    deleteComment: (tag, id, commentId) =>
      call<WriteResult>(routes.deleteComment, { project: tag, id, commentId }),
  };
}
