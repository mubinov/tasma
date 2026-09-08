import { describe, expectTypeOf, it } from "vitest";
import type {
  CommentFields as EngineCommentFields,
  CreateProjectInput,
  ExcludedFile as EngineExcludedFile,
  ExclusionCode as EngineExclusionCode,
  Frontmatter as EngineFrontmatter,
  IndexEntry,
  InstructionDocument as EngineInstructionDocument,
  ProjectChange as EngineProjectChange,
  ProjectDeclaration,
  QueryResult,
  ResolvedConfig,
  SNAPSHOT,
  StepOwner as EngineStepOwner,
  StoreDiagnostic,
  StoreDiagnosticCode,
  Task as EngineTask,
  TaskParseErrorCode,
  TaskSerializeErrorCode,
  TaskStoreErrorCode,
  TextResult,
  TextSelection,
  Workflow as EngineWorkflow,
  WorkflowStep as EngineWorkflowStep,
  WorkflowStepResult,
  WriteResult as EngineWriteResult,
} from "@tasma/engine";
import type {
  Comment,
  CommentFields,
  Config,
  Diagnostic,
  DiagnosticCode,
  ExcludedFile,
  ExclusionCode,
  Frontmatter,
  InstructionDocument,
  ParseErrorCode,
  ProjectChange,
  ProjectInput,
  ProjectSummary,
  SerializeErrorCode,
  StepDefinition,
  StepOwner,
  StoreErrorCode,
  Task,
  TaskEntry,
  TaskList,
  TaskText,
  TaskTextOptions,
  Workflow,
  WorkflowStep,
  WriteResult,
} from "@tasma/protocol";

/** One comment of a task, as the engine declares it. */
type EngineComment = EngineTask["comments"][number];

/** The fields a type presents, written out, so an intersection compares against the same fields. */
type Flat<T> = Pick<T, keyof T>;

/**
 * The guard against the wire contract drifting away from the engine.
 *
 * `@tasma/protocol` depends on nothing, so it repeats the engine's unions and
 * shapes rather than importing them. These assertions are what keeps the copy
 * honest: `expectTypeOf` fails at compile time, so `pnpm typecheck` breaks as
 * soon as the engine adds a code the contract does not carry.
 *
 * The assertions erase, so this test does nothing at run time. It is a test only
 * because vitest refuses a `*.test.ts` file that declares no suite.
 */
describe("the wire contract", () => {
  it("repeats the engine's code unions", () => {
    expectTypeOf<DiagnosticCode>().toEqualTypeOf<StoreDiagnosticCode>();
    expectTypeOf<StoreErrorCode>().toEqualTypeOf<TaskStoreErrorCode>();
    expectTypeOf<ParseErrorCode>().toEqualTypeOf<TaskParseErrorCode>();
    expectTypeOf<SerializeErrorCode>().toEqualTypeOf<TaskSerializeErrorCode>();
    expectTypeOf<ExclusionCode>().toEqualTypeOf<EngineExclusionCode>();
    expectTypeOf<StepOwner>().toEqualTypeOf<EngineStepOwner>();
  });

  it("repeats the engine's shapes", () => {
    expectTypeOf<Diagnostic>().toEqualTypeOf<StoreDiagnostic>();
    expectTypeOf<Frontmatter>().toEqualTypeOf<EngineFrontmatter>();
    expectTypeOf<CommentFields>().toEqualTypeOf<EngineCommentFields>();
    expectTypeOf<TaskEntry>().toEqualTypeOf<IndexEntry>();
    expectTypeOf<ExcludedFile>().toEqualTypeOf<EngineExcludedFile>();
    expectTypeOf<TaskList>().toEqualTypeOf<QueryResult>();
    expectTypeOf<Config>().toEqualTypeOf<Omit<ResolvedConfig, "name" | "path">>();
    // The tree a daemon serves is no field of the wire, so a create states every
    // key of the engine's input but the root.
    expectTypeOf<ProjectInput>().toEqualTypeOf<Omit<CreateProjectInput, "root">>();
    expectTypeOf<ProjectChange>().toEqualTypeOf<EngineProjectChange>();
    // A summary is the declaration plus the tag, so a field added to either side
    // of a project breaks the typecheck until the wire carries it.
    expectTypeOf<Omit<ProjectSummary, "tag">>().toEqualTypeOf<ProjectDeclaration>();
    expectTypeOf<WorkflowStep>().toEqualTypeOf<EngineWorkflowStep>();
    expectTypeOf<Workflow>().toEqualTypeOf<EngineWorkflow>();
    expectTypeOf<InstructionDocument>().toEqualTypeOf<EngineInstructionDocument>();
    // The envelope carries the diagnostics, so the wire's step read is the engine's less them.
    expectTypeOf<StepDefinition>().toEqualTypeOf<Omit<WorkflowStepResult, "diagnostics">>();
  });

  it("keeps the task and the write result in step, less what JSON cannot carry", () => {
    // The task is compared with the symbol key removed and its comment list
    // compared on its own, so a field added on either side breaks the
    // typecheck while the engine's own task stays usable where the wire's is
    // expected. A write result loses only the diagnostics, which the envelope
    // carries instead.
    expectTypeOf<EngineTask>().toExtend<Task>();
    expectTypeOf<Omit<Task, "comments">>().toEqualTypeOf<Omit<EngineTask, typeof SNAPSHOT | "comments">>();
    expectTypeOf<Flat<Comment>>().toEqualTypeOf<Omit<EngineComment, typeof SNAPSHOT>>();
    expectTypeOf<WriteResult>().toEqualTypeOf<Omit<EngineWriteResult, "diagnostics">>();
    expectTypeOf<TaskText>().toEqualTypeOf<Omit<TextResult, "diagnostics">>();
  });

  it("refuses a text selection that states both of its keys", () => {
    expectTypeOf<{ collapsed: false; comment: 2 }>().not.toExtend<TaskTextOptions>();
    expectTypeOf<{ collapsed: false; comment: 2 }>().not.toExtend<TextSelection>();
  });
});
