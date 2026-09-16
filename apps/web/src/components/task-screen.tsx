import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import type { Comment } from "@tasma/protocol";
import { useId, type ReactNode } from "react";
import { POLL_INTERVAL, projectQuery, taskQuery, workflowQuery } from "../api/queries";
import { isFinalStatus, isTopPriority, stepView } from "../lib/board";
import { useDocumentTitle } from "../lib/document-title";
import { ArrowLeftIcon } from "../lib/icons";
import { warningCount } from "../lib/warning-count";
import { noticeWords, useNotice } from "../store/notices";
import { CommentCard } from "./comment-card";
import { Markdown } from "./markdown";
import { ScreenHeading } from "./screen-heading";
import { StepMark } from "./step-view";

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

  useDocumentTitle(`${id} ${title}`);
  useNotice(
    `task-read:${id}`,
    diagnostics.length === 0
      ? null
      : { form: "warning", title: `${warningCount(diagnostics.length)} about ${id}`, words: noticeWords(diagnostics) },
  );

  return (
    <div className="-m-6 sm:-m-10">
      <div className="min-w-0 px-6 pb-12 sm:px-10">
        {/* The page's scroll padding keeps a focus scroll's target and its ring clear of the bar. */}
        <div className="sticky top-0 z-(--layer-top-bar) -mx-6 flex items-center gap-4 border-b border-line bg-bg px-6 py-2.5 sm:-mx-10 sm:px-10 [html:has(&)]:scroll-pt-12">
          <Link
            to="/tasks"
            search={{ projects: tag }}
            className="inline-flex items-center gap-1.5 text-sm text-dim hover:text-text"
          >
            <ArrowLeftIcon size={16} aria-hidden="true" />
            Tasks
          </Link>
        </div>

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
        </div>

        {body.trim() !== "" && (
          <div className="mt-8 max-w-2xl">
            <Markdown text={body} base={2} title={title} />
          </div>
        )}

        {comments.length > 0 && <Comments comments={comments} />}
      </div>
    </div>
  );
}
