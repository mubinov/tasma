export { DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT, DEFAULT_DAEMON_URL } from "./address.js";
export { createClient } from "./client.js";
export type { Client, Transport, TransportReply, TransportRequest } from "./client.js";
export type { Diagnostic, DiagnosticCode } from "./diagnostics.js";
export { ProtocolError, TransportError } from "./errors.js";
export type {
  DaemonErrorCode,
  Envelope,
  Failure,
  ParseErrorCode,
  SerializeErrorCode,
  StoreErrorCode,
  Success,
} from "./errors.js";
export { DAEMON_NAME } from "./health.js";
export type { Health } from "./health.js";
export type { Config, Project, ProjectSummary } from "./project.js";
export { buildPath, routes, UNSAFE_IN_SEGMENT } from "./routes.js";
export type { Method, PathQuery, Route, TaskFilter, TaskReadOptions } from "./routes.js";
export type {
  Comment,
  CommentFields,
  CommentHeader,
  CommentInput,
  ExcludedFile,
  ExclusionCode,
  Frontmatter,
  Task,
  TaskEntry,
  TaskInput,
  TaskList,
  WriteResult,
} from "./task.js";
