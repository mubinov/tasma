import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import type { Comment } from "@tasma/protocol";
import { Fragment, useId, type ReactNode } from "react";
import { POLL_INTERVAL, projectQuery, taskQuery, tasksQuery, workflowQuery } from "../api/queries";
import { isFinalStatus, isTopPriority, stepView } from "../lib/board";
import { useDocumentTitle } from "../lib/document-title";
import { ArrowLeftIcon, ProhibitIcon } from "../lib/icons";
import { blockingRows, relationRows, type RelationRow } from "../lib/task-page";
import { warningCount } from "../lib/warning-count";
import { noticeWords, useNotice } from "../store/notices";
import { CommentCard } from "./comment-card";
import { Markdown } from "./markdown";
import { ScreenHeading } from "./screen-heading";
import { StepMark } from "./step-view";
import { TaskSidebar } from "./task-sidebar";

// The route is reached by id rather than imported: the tree in routes.tsx names
// this component, so importing the route back would close a cycle.
const route = getRouteApi("/tasks/$project/$task");

function Comments({ comments }: { comments: readonly Comment[] }): ReactNode {
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="mt-10 max-w-2xl">
      {/* The space separates the words in speech; flex drops it from the layout. */}
      <h2 id={headingId} className="flex items-baseline font-chrome text-lg font-semibold tracking-tight">
        Comments
        {" "}
        <span className="ml-1.5 text-xs-plus font-normal text-dim">{comments.length}</span>
      </h2>
      <ol>
        {comments.map((comment) => <CommentCard key={comment.id} comment={comment} />)}
      </ol>
    </section>
  );
}

function BlockedSummary({ tag, blocking }: { tag: string; blocking: readonly RelationRow[] }): ReactNode {
  return (
    <span>
      {/* Aligned by its top: an inline-flex box takes its baseline from the icon, not from the words. */}
      <span className="inline-flex h-5 items-center gap-1 align-top whitespace-nowrap text-signal">
        <ProhibitIcon size={14} aria-hidden="true" />
        blocked by
      </span>
      {" "}
      {blocking.map(({ id, status }, index) => (
        // A hand-edited task file can hold the same id twice.
        // eslint-disable-next-line @eslint-react/no-array-index-key
        <Fragment key={index}>
          {index > 0 && ", "}
          {status === undefined
            ? <span className="text-text wrap-anywhere">{id}</span>
            : (
                <Link
                  to="/tasks/$project/$task"
                  params={{ project: tag, task: id }}
                  className="text-text underline underline-offset-2 wrap-anywhere"
                >
                  {id}
                </Link>
              )}
        </Fragment>
      ))}
    </span>
  );
}

export function TaskScreen(): ReactNode {
  const { client } = route.useRouteContext();
  const { project: tag, task: taskId } = route.useParams();
  const { data: { data: project } } = useSuspenseQuery({
    ...projectQuery(client, tag),
    refetchInterval: POLL_INTERVAL,
  });
  const { data: { data: task, diagnostics } } = useSuspenseQuery({
    ...taskQuery(client, tag, taskId),
    refetchInterval: POLL_INTERVAL,
  });
  const { data: { data: listing } } = useSuspenseQuery({
    ...tasksQuery(client, tag),
    refetchInterval: POLL_INTERVAL,
  });
  const { frontmatter, body, comments = [] } = task;
  const { id, title, status, priority, workflow: workflowName } = frontmatter;
  // Not under Suspense: a poll can bring a workflow name the loader did not
  // read, and a new key would suspend the page until its read lands.
  const { data: workflowRead } = useQuery({
    ...workflowQuery(client, workflowName ?? ""),
    enabled: workflowName !== undefined,
  });
  const { config } = project;
  const workflow = workflowRead === null ? null : workflowRead?.data;
  const view = stepView(frontmatter, isFinalStatus(status, config.final_statuses), workflow);
  const relations = relationRows(frontmatter, listing.entries, config.final_statuses);
  const blocking = blockingRows(relations.blockers);

  useDocumentTitle(`${id} ${title}`);
  useNotice(
    `task-read:${id}`,
    diagnostics.length === 0
      ? null
      : { form: "warning", title: `${warningCount(diagnostics.length)} about ${id}`, words: noticeWords(diagnostics) },
  );

  return (
    // A sticky sidebar cannot move past the end of its parent, so the frame reaches the page's end and its children
    // keep the notice stack's room in place of <main>.
    <div className="-m-6 -mb-[calc(--spacing(6)+var(--notice-stack-height,0px))] flex flex-col sm:-m-10 sm:-mb-[calc(--spacing(10)+var(--notice-stack-height,0px))] lg:flex-row lg:items-start">
      {/* A sticky bar stays only inside its parent box, so under lg the column
          gives up its box and the bar stays over the sidebar too. */}
      <div className="contents lg:block lg:min-w-0 lg:flex-1">
        {/* The page's scroll padding keeps a focus scroll's target and its ring clear of the bar. */}
        <div className="sticky top-0 z-(--layer-top-bar) flex items-center gap-4 border-b border-line bg-bg px-6 py-2.5 sm:px-10 [html:has(&)]:scroll-pt-12">
          <Link
            to="/tasks"
            search={{ projects: tag }}
            className="inline-flex items-center gap-1.5 text-sm text-dim hover:text-text"
          >
            <ArrowLeftIcon size={16} aria-hidden="true" />
            Tasks
          </Link>
        </div>

        <div className="px-6 pb-12 sm:px-10 lg:pb-[calc(--spacing(12)+var(--notice-stack-height,0px))]">
          {/* The title comes first in the DOM, so the h1 opens the content and is
              read before the id shown above it. */}
          <div className="mt-6 flex flex-col-reverse gap-1">
            <ScreenHeading className="max-w-2xl wrap-anywhere">{title}</ScreenHeading>
            <p className="font-mono text-sm text-dim">{id}</p>
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-x-3.5 gap-y-2 text-sm text-muted">
            <span className="inline-flex min-h-5.5 items-center rounded-control border border-line bg-surface-2 px-2 text-text">
              {status}
            </span>
            {priority !== undefined && (
              <span className={isTopPriority(priority, config.priorities) ? "font-medium text-text" : undefined}>
                {priority}
              </span>
            )}
            {view.kind !== "none" && (
              <span className="inline-flex items-center gap-2">
                <StepMark view={view} />
              </span>
            )}
            {blocking.length > 0 && <BlockedSummary tag={tag} blocking={blocking} />}
          </div>

          {body.trim() !== "" && (
            <div className="mt-8 max-w-2xl">
              <Markdown text={body} base={2} title={title} />
            </div>
          )}

          {comments.length > 0 && <Comments comments={comments} />}
        </div>
      </div>
      <TaskSidebar tag={tag} frontmatter={frontmatter} view={view} relations={relations} />
    </div>
  );
}
