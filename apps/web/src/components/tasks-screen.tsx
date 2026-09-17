import { useMutation, useQueries, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import type { Workflow } from "@tasma/protocol";
import { useDeferredValue, useEffect, useState, type ReactNode } from "react";
import { taskWriteOptions, usePendingTaskWrites } from "../api/mutations";
import { usePollNotice } from "../api/poll-notice";
import { POLL_INTERVAL, projectQuery, projectsQuery, tasksQuery, workflowQuery } from "../api/queries";
import {
  applyPending,
  boardWarnings,
  buildColumns,
  distinctLabels,
  splitList,
  topOrder,
  workflowNames,
} from "../lib/board";
import { formatClock } from "../lib/clock";
import { useDocumentTitle } from "../lib/document-title";
import { warningCount } from "../lib/warning-count";
import { NAVIGATION_BY_PATH } from "../navigation";
import { useUiStore } from "../store/ui";
import { BoardColumn } from "./board-column";
import { Diagnostics } from "./diagnostics";
import { RouteFailure } from "./error-boundary";
import { LabelFilter } from "./label-filter";
import { LiveNotice } from "./live-notice";
import { ProjectSelect } from "./project-select";
import { ScreenHeading } from "./screen-heading";

// The route is reached by id rather than imported: the tree in routes.tsx names
// this component, so importing the route back would close a cycle.
const route = getRouteApi("/tasks");

const { label: TITLE } = NAVIGATION_BY_PATH["/tasks"];

const EMPTY_CLASS = "mt-2 max-w-2xl text-base text-muted";

const HEADING_LINE_CLASS = "flex min-h-8 flex-wrap items-center gap-x-4 gap-y-3";

/** What the live region says: a summary of what a poll can change while the page stays put. */
function boardSummary(live: boolean, warnings: number, filter: { matching: number; total: number } | null): string {
  const said: string[] = [];

  if (!live) {
    said.push("The index is not following the disk.");
  }
  if (warnings > 0) {
    said.push(`${warningCount(warnings)} about this project.`);
  }
  if (filter !== null) {
    said.push(`${String(filter.matching)} of ${String(filter.total)} tasks carry a selected label.`);
  }

  return said.join(" ");
}

/**
 * Apart from the board, so a poll that changes nothing re-renders this alone.
 * Its reads fetch nothing: the board polls them.
 */
function BoardPollNotice({ tag }: { tag: string }): ReactNode {
  const { client } = route.useRouteContext();
  const projectRead = useQuery({ ...projectQuery(client, tag), enabled: false });
  const listingRead = useQuery({ ...tasksQuery(client, tag), enabled: false });

  usePollNotice(`board-poll:${tag}`, [listingRead, projectRead], {
    title: "The board is not up to date",
    line: (readAt) => `The last reads of ${tag} failed. The board shows the tasks as they were at ${formatClock(readAt)}.`,
  });

  return null;
}

function Board({ tag, labels }: { tag: string; labels: string | undefined }): ReactNode {
  const { client, queryClient } = route.useRouteContext();
  const { data: { data: projects } } = useSuspenseQuery(projectsQuery(client));
  const { data: { data: project, diagnostics: projectWarnings } } = useSuspenseQuery({
    ...projectQuery(client, tag),
    refetchInterval: POLL_INTERVAL,
  });
  const { data: { data: listing, diagnostics: listingWarnings } } = useSuspenseQuery({
    ...tasksQuery(client, tag),
    refetchInterval: POLL_INTERVAL,
  });
  const setLastTasksProject = useUiStore((state) => state.setLastTasksProject);
  const { mutateAsync: write } = useMutation(taskWriteOptions(queryClient, client, tag));
  const pending = usePendingTaskWrites(tag);
  const [focusId, setFocusId] = useState<string | null>(null);
  const names = workflowNames(listing.entries);
  // Not under Suspense: a poll can bring a name the loader did not read, and a
  // new key would suspend the whole board until its read lands.
  const workflowReads = useQueries({ queries: names.map((name) => workflowQuery(client, name)) });
  const selected = distinctLabels(splitList(labels));
  const deferredSelected = distinctLabels(splitList(useDeferredValue(labels)));

  useEffect(() => {
    setLastTasksProject(tag);
  }, [tag, setLastTasksProject]);

  const { name, live, config } = project;
  const title = name ?? tag;
  const workflows = new Map<string, Workflow | null | undefined>(
    names.map((workflowName, index) => {
      const read = workflowReads[index]?.data;
      return [workflowName, read === null ? null : read?.data];
    }),
  );
  const entries = applyPending(listing.entries, pending);
  const pendingIds = new Set(pending.map(({ id }) => id));
  const columns = buildColumns(config, entries, deferredSelected);
  const filtered = deferredSelected.length > 0;
  const warnings = boardWarnings(projectWarnings, listingWarnings);
  const matching = columns.reduce((sum, column) => sum + column.matching.length, 0);
  const total = columns.reduce((sum, column) => sum + column.total, 0);

  function move(id: string, status: string): void {
    const key = status.toLowerCase();
    // Unfiltered, so the tasks the label filter hides count too.
    // The menu offers only configured statuses, and each of them has a column.
    const target = buildColumns(config, entries, []).find((column) => column.status.toLowerCase() === key)!;
    const order = topOrder(target.matching, id);

    // The card takes focus where it renders next: at its new place, and at its
    // old place again after a refusal.
    write({ writes: [{ id, change: { status, order } }], title: `${id} was not moved` }).catch(() => {
      setFocusId(id);
    });
    setFocusId(id);
  }

  return (
    <>
      <div className={HEADING_LINE_CLASS}>
        <ScreenHeading>{TITLE}</ScreenHeading>
        <div className="ml-auto flex max-w-full min-w-0 flex-wrap items-center gap-x-5 gap-y-3">
          <ProjectSelect projects={projects} tag={tag} />
          <LabelFilter entries={listing.entries} selected={selected} />
        </div>
      </div>

      {/* Rendered whether or not it says anything: a live region inserted
          together with its content announces nothing. */}
      <div role="status" className="sr-only">
        {boardSummary(live, warnings.length + listing.excluded.length, filtered ? { matching, total } : null)}
      </div>
      {!live && <LiveNotice className="mt-6 max-w-2xl" />}
      {/* The board stays mounted when the project changes, so the key starts
          the line folded for the next project. */}
      <Diagnostics
        key={tag}
        items={warnings}
        excluded={listing.excluded}
        subject="this project"
        className={live ? "mt-4" : "mt-3"}
      />
      {listing.entries.length === 0 && <p className={EMPTY_CLASS}>{`No tasks in ${title} yet.`}</p>}
      {listing.entries.length > 0 && filtered && matching === 0 && (
        <p className={EMPTY_CLASS}>{`No task in ${title} carries any of the selected labels.`}</p>
      )}

      {/* The right padding of main is not part of the page's sideways overflow, so
          the row extends into it and the last column carries the same padding. */}
      <div className="mt-6 -mr-6 flex items-start gap-6 *:last:box-content *:last:pr-6 sm:-mr-10 sm:*:last:pr-10">
        {columns.map((column, index) => (
          // Keyed by position: a hand-edited configuration can hold the same
          // status twice. The tag resets a column's state for the next project.
          <BoardColumn
            key={`${tag}:${String(index)}`}
            tag={tag}
            column={column}
            filtered={filtered}
            priorities={config.priorities}
            workflows={workflows}
            statuses={config.statuses}
            pendingIds={pendingIds}
            onMove={move}
            focusId={focusId}
            onMenuFocused={() => {
              setFocusId(null);
            }}
          />
        ))}
      </div>
      <BoardPollNotice tag={tag} />
    </>
  );
}

function EmptyTree(): ReactNode {
  const { client } = route.useRouteContext();
  const router = useRouter();
  const { data: { data: projects } } = useSuspenseQuery({ ...projectsQuery(client), refetchInterval: POLL_INTERVAL });
  const found = projects.length > 0;

  // The route redirects to a project only before it loads, so a project that
  // appears later loads the route again.
  useEffect(() => {
    if (found) {
      void router.invalidate();
    }
  }, [found, router]);

  return (
    <>
      <div className={HEADING_LINE_CLASS}>
        <ScreenHeading>{TITLE}</ScreenHeading>
      </div>
      <p className={EMPTY_CLASS}>
        No projects yet. The daemon&apos;s tree holds no project directory. Add one, and its tasks are shown here.
        {" "}
        <Link to="/projects" className="underline underline-offset-2">
          Projects
        </Link>
      </p>
    </>
  );
}

export function TasksScreen(): ReactNode {
  const { projects, labels } = route.useSearch();
  const [tag] = splitList(projects);

  useDocumentTitle(TITLE);

  if (tag === undefined) {
    return <EmptyTree />;
  }

  return <Board tag={tag} labels={labels} />;
}

/**
 * The failure panel, then the project selector when the listing of projects was
 * read. Without the selector, no other board can be opened: `/tasks` redirects to
 * the refused project again.
 */
export function TasksFailure(props: ErrorComponentProps): ReactNode {
  const { client } = route.useRouteContext();
  const [tag] = splitList(route.useSearch().projects);
  const { data: read } = useQuery({ ...projectsQuery(client), enabled: false });

  return (
    <>
      <RouteFailure {...props} />
      {tag !== undefined && read !== undefined && (
        <div className="mt-6">
          <ProjectSelect projects={read.data} tag={tag} />
        </div>
      )}
    </>
  );
}
