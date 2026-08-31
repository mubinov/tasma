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
export type { Config, Project } from "./project.js";
export { buildPath, routes } from "./routes.js";
export type { Method, Route, TaskFilter } from "./routes.js";
export type {
  Comment,
  CommentFields,
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
