export { TaskStoreError } from "./errors.js";
export type { TaskStoreErrorCode } from "./errors.js";
export type { ProjectPaths } from "./paths.js";
export { discoverProjects, readProjectDeclaration } from "./projects.js";
export { openProject } from "./store.js";
export type { Project } from "./store.js";
export { endsLiveness } from "./types.js";
export type {
  CommentChange,
  ConfigResult,
  IndexLivenessLost,
  ListResult,
  ProjectDeclaration,
  ProjectOptions,
  ReadResult,
  ResolvedConfig,
  StoreDiagnostic,
  StoreDiagnosticCode,
  TaskChange,
  WriteResult,
} from "./types.js";
