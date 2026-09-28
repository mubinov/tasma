import { useQueries, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import type { Failure } from "@tasma/protocol";
import { useId, useRef, type ReactNode } from "react";
import { workflowReadQuery, workflowsQuery, workflowTitle, type WorkflowRead } from "../api/queries";
import { useDocumentTitle } from "../lib/document-title";
import { CaretRightIcon, WarningIcon } from "../lib/icons";
import { useFocusLost } from "../lib/use-focus-lost";
import { warningCount } from "../lib/warning-count";
import { NAVIGATION_BY_PATH } from "../navigation";
import { Diagnostics, type WarningItem } from "./diagnostics";
import { ScreenHeading } from "./screen-heading";
import { Tag } from "./tag";
import { WorkflowHint } from "./workflow-hint";

// The route is reached by id rather than imported: the tree in routes.tsx names
// this component, so importing the route back would close a cycle.
const route = getRouteApi("/workflows/");

function refusedWarning(name: string, failure: Failure): WarningItem {
  return {
    code: failure.code,
    message: `${name} was not read: ${failure.message}`,
    path: failure.kind === "store" ? failure.path : undefined,
  };
}

type WorkflowRowProps = { name: string; read: WorkflowRead | undefined; refused: boolean };

/**
 * `read` is absent while the read of a name a refetch added has not answered,
 * and also when that read reached no daemon, which `refused` then marks.
 */
function WorkflowRow({ name, read, refused }: WorkflowRowProps): ReactNode {
  const title = workflowTitle(read, name);
  const itemRef = useRef<HTMLLIElement>(null);

  // A refetch that drops this name, or every name, removes the row under focus.
  useFocusLost(itemRef, (item) => {
    item.closest("main")?.focus();
  });

  return (
    <li ref={itemRef}>
      <Link
        to="/workflows/$workflow"
        params={{ workflow: name }}
        className="flex items-start gap-4 rounded-card border border-line bg-surface px-4 py-3 hover:border-graphic"
      >
        {refused && <WarningIcon size={16} aria-hidden="true" className="mt-0.75 shrink-0 text-signal" />}
        <span className="min-w-0 flex-1">
          <span className="flex min-h-5.5 flex-wrap items-center gap-2">
            <span className="font-chrome text-base font-medium wrap-anywhere">{title}</span>
            {title !== name && <Tag>{name}</Tag>}
          </span>
          {refused && (
            <span className="mt-0.5 block text-sm text-muted">
              The daemon could not read this workflow. Open it to see why.
            </span>
          )}
        </span>
        <CaretRightIcon size={16} aria-hidden="true" className="mt-0.75 shrink-0 text-dim" />
      </Link>
    </li>
  );
}

export function WorkflowsScreen(): ReactNode {
  const { label: title } = NAVIGATION_BY_PATH["/workflows"];
  const { client } = route.useRouteContext();
  const { data: { data: names, diagnostics } } = useSuspenseQuery(workflowsQuery(client));
  // Not under Suspense: a refetch can bring a name the loader did not read, and
  // a new key would suspend the whole screen until its read lands.
  const reads = useQueries({ queries: names.map((name) => workflowReadQuery(client, name)) });
  const headingId = useId();

  useDocumentTitle(title);

  const warnings: WarningItem[] = [
    ...names.flatMap((name, index) => {
      const read = reads[index]?.data;
      return read?.ok === false ? [refusedWarning(name, read.failure)] : [];
    }),
    ...diagnostics,
  ];

  return (
    <>
      <ScreenHeading id={headingId}>{title}</ScreenHeading>
      {/* Stands with no text, so a refetch that turns a warning up is announced. */}
      <div role="status" className="sr-only">
        {warnings.length > 0 ? `${warningCount(warnings.length)} about the workflows.` : ""}
      </div>
      <Diagnostics items={warnings} subject="the workflows" className="mt-4" />
      {names.length === 0
        ? (
            <p className="mt-2 text-base text-muted">
              No workflows yet. The workflows directory holds none. Add one, and it is listed here.
            </p>
          )
        : (
            <ul aria-labelledby={headingId} className="mt-7 flex w-full max-w-2xl flex-col gap-3">
              {names.map((name, index) => {
                const read = reads[index];
                const refused = read?.data?.ok === false || (read?.data === undefined && read?.isError === true);
                return <WorkflowRow key={name} name={name} read={read?.data} refused={refused} />;
              })}
            </ul>
          )}
      <WorkflowHint
        className="mt-7"
        sentence="If you want to add a new workflow, ask your agent, naming what it is for. For example:"
        example="Use the tasma skill. Create a tasma workflow for my engineering tasks."
      />
    </>
  );
}
