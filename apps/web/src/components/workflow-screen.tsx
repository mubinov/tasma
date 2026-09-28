import { useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import type { Failure, Workflow, WorkflowStep } from "@tasma/protocol";
import type { ReactNode } from "react";
import { workflowReadQuery, workflowTitle, type WorkflowRead } from "../api/queries";
import { useDocumentTitle } from "../lib/document-title";
import { ArrowLeftIcon, WarningIcon } from "../lib/icons";
import { warningCount } from "../lib/warning-count";
import { Diagnostics } from "./diagnostics";
import { InstructionLines } from "./instruction-lines";
import { ScreenHeading } from "./screen-heading";
import { SectionHeading } from "./section-heading";
import { Tag } from "./tag";
import { WorkflowHint } from "./workflow-hint";

// The route is reached by id rather than imported: the tree in routes.tsx names
// this component, so importing the route back would close a cycle.
const route = getRouteApi("/workflows/$workflow");

const CHANGE_SENTENCE = "If you want to change this workflow, ask your agent, naming it and the change you want. For example:";

const OWNER_DOT_CLASS = { agent: "bg-running", human: "bg-signal" } as const;

function StepRow({ step, position }: { step: WorkflowStep; position: number }): ReactNode {
  return (
    <li className="flex items-start gap-3 px-4 py-2.5">
      <span className="w-5 shrink-0 pt-0.75 text-right font-mono text-xs text-dim">{position}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-mono text-sm wrap-anywhere">{step.name}</span>
        <span className="mt-0.5 block font-mono text-xs text-dim wrap-anywhere">{step.file}</span>
      </span>
      <span className="inline-flex shrink-0 items-center gap-1.5 text-sm text-muted">
        <span aria-hidden="true" className={`size-2 rounded-full ${OWNER_DOT_CLASS[step.owner]}`} />
        {step.owner}
      </span>
    </li>
  );
}

function WorkflowBody({ workflow }: { workflow: Workflow }): ReactNode {
  // The engine refuses a workflow with no steps, so the last one exists.
  const lastStep = workflow.steps.at(-1)!.name;

  return (
    <>
      <SectionHeading>Steps</SectionHeading>
      {/* The role is stated rather than inherited: list-style: none drops it in WebKit. */}
      <ol role="list" className="mt-2 divide-y divide-line rounded-card border border-line bg-surface">
        {workflow.steps.map((step, index) => (
          // eslint-disable-next-line @eslint-react/no-array-index-key
          <StepRow key={index} step={step} position={index + 1} />
        ))}
      </ol>
      <SectionHeading>Workflow instructions</SectionHeading>
      <div className="mt-2 rounded-card border border-line bg-surface px-4 py-3">
        <InstructionLines paths={workflow.instructions} />
      </div>
      <WorkflowHint
        className="mt-7"
        sentence={CHANGE_SENTENCE}
        example={`Use the tasma skill. In the "${workflow.name}" workflow, add a step "docs" after "${lastStep}", owned by an agent.`}
      />
    </>
  );
}

function FaultBody({ name, failure }: { name: string; failure: Failure }): ReactNode {
  return (
    <>
      <h2 className="mt-7 flex items-start gap-2 font-chrome text-sm font-medium text-signal">
        <WarningIcon size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
        The daemon could not read this workflow
      </h2>
      <div className="mt-2 rounded-card border border-line bg-surface p-4">
        <p className="text-sm text-muted">Its steps and its instruction documents are unknown until the file is valid.</p>
        <p className="mt-3 rounded-card bg-surface-2 px-3 py-2.5 font-mono text-xs text-dim wrap-anywhere">{failure.message}</p>
      </div>
      <WorkflowHint
        className="mt-7"
        sentence={CHANGE_SENTENCE}
        example={`Use the tasma skill. In the "${name}" workflow, fix the file so it can be read.`}
      />
    </>
  );
}

/**
 * The path of `workflow.yml`. Of the refusals, only `workflow-invalid` names the
 * file: the path of `workflow-unknown` is the workflow's directory.
 */
function filePath(read: WorkflowRead): string | undefined {
  if (read.ok) {
    return read.workflow.file;
  }

  return read.failure.kind === "store" && read.failure.code === "workflow-invalid" ? read.failure.path : undefined;
}

function statusText(read: WorkflowRead): string {
  if (!read.ok) {
    return "This workflow was not read.";
  }

  return read.diagnostics.length > 0 ? `${warningCount(read.diagnostics.length)} about this workflow.` : "";
}

export function WorkflowScreen(): ReactNode {
  const { client } = route.useRouteContext();
  const { workflow: name } = route.useParams();
  const { data: read } = useSuspenseQuery(workflowReadQuery(client, name));
  const title = workflowTitle(read, name);
  const path = filePath(read);
  const diagnostics = read.ok ? read.diagnostics : [];

  useDocumentTitle(title);

  return (
    <div className="w-full max-w-2xl">
      {/* A link, not a heading: the page's one h1 opens the content. */}
      <Link to="/workflows" className="inline-flex min-h-6 items-center gap-1.5 text-sm text-dim hover:text-text">
        <ArrowLeftIcon size={16} aria-hidden="true" />
        Workflows
      </Link>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <ScreenHeading>{title}</ScreenHeading>
        {title !== name && <Tag>{name}</Tag>}
      </div>
      {path !== undefined && <p className="mt-2 font-mono text-sm text-muted wrap-anywhere">{path}</p>}

      {/* Stands with no text, so a refetch that breaks the file or turns a warning up is announced. */}
      <div role="status" className="sr-only">
        {statusText(read)}
      </div>
      <Diagnostics key={name} items={diagnostics} subject="this workflow" className="mt-7" />

      {read.ok ? <WorkflowBody workflow={read.workflow} /> : <FaultBody name={name} failure={read.failure} />}
    </div>
  );
}
