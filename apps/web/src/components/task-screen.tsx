import { Button } from "@base-ui/react/button";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import type { Comment, Task } from "@tasma/protocol";
import {
  Fragment,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEventHandler,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { usePollNotice } from "../api/poll-notice";
import { POLL_INTERVAL, projectQuery, taskQuery, tasksQuery, workflowQuery } from "../api/queries";
import { isFinalStatus, isTopPriority, stepView } from "../lib/board";
import { formatClock } from "../lib/clock";
import { useDocumentTitle } from "../lib/document-title";
import { ArrowLeftIcon, PencilSimpleIcon, ProhibitIcon } from "../lib/icons";
import { blockingRows, relationRows, type RelationRow } from "../lib/task-page";
import { useScrolledPast } from "../lib/use-scrolled-past";
import { useTaskEditing } from "../lib/use-task-editing";
import { useTaskProperties } from "../lib/use-task-properties";
import { useTopBarLengths } from "../lib/use-top-bar-lengths";
import { warningCount } from "../lib/warning-count";
import { noticeWords, useNotice } from "../store/notices";
import { useUiStore } from "../store/ui";
import { CommentCard } from "./comment-card";
import { ConfirmDialog } from "./confirm-dialog";
import { BUTTON_CLASS, BUTTON_FILLED_CLASS, BUTTON_QUIET_CLASS } from "./control-classes";
import { Markdown } from "./markdown";
import { ScreenHeading } from "./screen-heading";
import { ScrollToTop } from "./scroll-to-top";
import { StepMark } from "./step-view";
import { ChangedOnDisk, TaskEditor } from "./task-editor";
import type { Outline } from "./task-outline";
import { TaskSidebar } from "./task-sidebar";

// The route is reached by id rather than imported: the tree in routes.tsx names
// this component, so importing the route back would close a cycle.
const route = getRouteApi("/tasks/$project/$task");

/** The text of the element that is on the screen, without the words only a screen reader hears. */
function visibleText(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll(".sr-only")) {
    hidden.remove();
  }
  return copy.textContent;
}

/**
 * The body's top headings and the comments, read from the DOM after each render
 * of a changed task. The editor renders no body, so opening and closing it is
 * read again too: a kept list would link to elements that are no longer there.
 */
function useOutline(
  bodyRef: RefObject<HTMLElement | null>,
  commentsRef: RefObject<HTMLElement | null>,
  task: Task,
  editing: boolean,
): Outline {
  const [outline, setOutline] = useState<Outline>({ headings: [], comments: [] });

  useLayoutEffect(() => {
    const headings = [...(bodyRef.current?.querySelectorAll("h2") ?? [])];
    const list = commentsRef.current;
    setOutline({
      headings: headings.map((heading) => ({ label: visibleText(heading), target: heading, sentinel: heading })),
      comments: (task.comments ?? []).flatMap(({ id, title }) => {
        const target = list?.querySelector<HTMLElement>(`[data-comment-id="${String(id)}"]`);
        const sentinel = target?.querySelector("[data-outline-sentinel]");
        return target && sentinel ? [{ label: title, target, sentinel }] : [];
      }),
    });
  }, [bodyRef, commentsRef, task, editing]);

  return outline;
}

type CommentsProps = {
  comments: readonly Comment[];
  listRef: RefObject<HTMLOListElement | null>;
};

function Comments({ comments, listRef }: CommentsProps): ReactNode {
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="mt-10 max-w-2xl">
      {/* The space separates the words in speech; flex drops it from the layout. */}
      <h2 id={headingId} className="flex items-baseline font-chrome text-lg font-semibold">
        Comments
        {" "}
        <span className="ml-1.5 text-xs-plus font-normal text-dim">{comments.length}</span>
      </h2>
      <ol ref={listRef}>
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

type ReadingControlsProps = { buttonRef: Ref<HTMLButtonElement>; onEdit: () => void };

function ReadingControls({ buttonRef, onEdit }: ReadingControlsProps): ReactNode {
  return (
    <Button ref={buttonRef} type="button" onClick={onEdit} className={BUTTON_CLASS}>
      <PencilSimpleIcon size={14} aria-hidden="true" />
      Edit
    </Button>
  );
}

type EditControlsProps = {
  /** Ties the Save control to the form it submits, which stands below the bar. */
  formId: string;
  saving: boolean;
  cancelButtonRef: Ref<HTMLButtonElement>;
  saveButtonRef: Ref<HTMLButtonElement>;
  onCancel: () => void;
  onKeyDown: KeyboardEventHandler;
};

function EditControls(
  { formId, saving, cancelButtonRef, saveButtonRef, onCancel, onKeyDown }: EditControlsProps,
): ReactNode {
  return (
    <>
      {/* Not offered while a write runs, so the text cannot be dropped on its way to disk. */}
      {!saving && (
        <Button
          ref={cancelButtonRef}
          type="button"
          onClick={onCancel}
          onKeyDown={onKeyDown}
          className={BUTTON_QUIET_CLASS}
        >
          Cancel
        </Button>
      )}
      {/* A wait shows in the label, never in `disabled`. */}
      <Button
        ref={saveButtonRef}
        type="submit"
        form={formId}
        onKeyDown={onKeyDown}
        className={BUTTON_FILLED_CLASS}
      >
        {saving ? "Saving…" : "Save"}
      </Button>
    </>
  );
}

/**
 * Apart from the page, so a poll that changes nothing re-renders this alone. Its
 * reads fetch nothing: the page polls them.
 */
function TaskPollNotice({ tag, id }: { tag: string; id: string }): ReactNode {
  const { client } = route.useRouteContext();
  const taskRead = useQuery({ ...taskQuery(client, tag, id), enabled: false });
  const projectRead = useQuery({ ...projectQuery(client, tag), enabled: false });
  const listingRead = useQuery({ ...tasksQuery(client, tag), enabled: false });

  usePollNotice(`task-poll:${id}`, [taskRead, projectRead, listingRead], {
    title: `${id} is not up to date`,
    line: (readAt) => `The last reads of ${id} failed. The page shows the task as it was at ${formatClock(readAt)}.`,
  });

  return null;
}

export function TaskScreen(): ReactNode {
  const { client, queryClient } = route.useRouteContext();
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
  // The heading, the document title and the editor's start text read the disk
  // values; every value a property control writes comes from the overlay below.
  const { id, title, workflow: workflowName } = frontmatter;
  // Not under Suspense: a poll can bring a workflow name the loader did not
  // read, and a new key would suspend the page until its read lands.
  const { data: workflowRead } = useQuery({
    ...workflowQuery(client, workflowName ?? ""),
    enabled: workflowName !== undefined,
  });
  const boardReturn = useUiStore((state) => state.boardReturn);
  // A page opened directly, or reached from the board of another project, has
  // no board to go back to: "Tasks" then opens this project's, unfiltered.
  const boardLabels = boardReturn?.projects === tag ? boardReturn.labels : undefined;
  const boardSearch = boardLabels === undefined ? { projects: tag } : { projects: tag, labels: boardLabels };
  const { config } = project;
  const workflow = workflowRead === null ? null : workflowRead?.data;
  const properties = useTaskProperties({
    queryClient,
    client,
    tag,
    id,
    frontmatter,
    config,
    entries: listing.entries,
    workflow,
  });
  // The sidebar and the meta line show the same three values, so both read the
  // frontmatter the pending writes leave.
  const live = properties.frontmatter;
  const { status, priority } = live;
  const view = stepView(live, isFinalStatus(status, config.final_statuses), workflow);
  const relations = relationRows(live, listing.entries, config.final_statuses);
  const blocking = blockingRows(relations.blockers);
  const barRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const commentsRef = useRef<HTMLOListElement>(null);
  const formId = useId();
  const editing = useTaskEditing({
    queryClient,
    client,
    tag,
    id,
    disk: { title, body },
    updated: frontmatter.updated,
    hasComments: comments.length > 0,
  });
  const { draft, diskChange } = editing;
  // The bar's scroll check and the scroll-to-top control read the same row: the
  // heading while the page reads, the title input while it is edited.
  const scrolledRef = draft === null ? headingRef : editing.titleRef;
  const { barHeight, scrollPaddingTop } = useTopBarLengths(barRef);
  const scrolled = useScrolledPast(scrolledRef, barHeight);
  const outline = useOutline(bodyRef, commentsRef, task, draft !== null);

  useDocumentTitle(`${id} ${title}`);
  useNotice(
    `task-read:${id}`,
    diagnostics.length === 0
      ? null
      : { form: "warning", title: `${warningCount(diagnostics.length)} about ${id}`, words: noticeWords(diagnostics) },
  );

  const idLine = <p className="font-mono text-sm text-dim">{id}</p>;

  const metaLine = (
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
  );

  return (
    // A sticky sidebar cannot move past the end of its parent, so the frame reaches the page's end and its children
    // keep the notice stack's room in place of <main>.
    <div className="-m-6 -mb-[calc(--spacing(6)+var(--notice-stack-height,0px))] flex flex-col sm:-m-10 sm:-mb-[calc(--spacing(10)+var(--notice-stack-height,0px))] lg:flex-row lg:items-start">
      {/* A sticky bar stays only inside its parent box, so under lg the column
          gives up its box and the bar stays over the sidebar too. */}
      <div className="contents lg:block lg:min-w-0 lg:flex-1">
        {/* The page's scroll padding keeps a focus scroll's target and its ring clear of the bar. */}
        <div ref={barRef} className="sticky top-0 z-(--layer-top-bar) flex h-top-bar items-center gap-4 border-b border-line bg-bg px-6 sm:px-10 [html:has(&)]:scroll-pt-16">
          <Link
            to="/tasks"
            search={boardSearch}
            className="inline-flex items-center gap-1.5 text-sm text-dim hover:text-text"
          >
            <ArrowLeftIcon size={16} aria-hidden="true" />
            Tasks
          </Link>
          {/* It repeats the h1, so a screen reader skips it. */}
          <span
            aria-hidden="true"
            className={`inline-flex min-w-0 items-center gap-3 transition-[opacity,visibility] duration-(--duration-fast) ${scrolled ? "opacity-100" : "invisible opacity-0"}`}
          >
            <span className="shrink-0 font-mono text-sm text-dim">{id}</span>
            <span className="truncate font-chrome text-base font-medium">{title}</span>
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {draft === null
              ? <ReadingControls buttonRef={editing.editRef} onEdit={editing.openEditor} />
              : (
                  <EditControls
                    formId={formId}
                    saving={editing.saving}
                    cancelButtonRef={editing.cancelRef}
                    saveButtonRef={editing.saveRef}
                    onCancel={editing.cancel}
                    onKeyDown={editing.onKeyDown}
                  />
                )}
          </div>
        </div>

        <div className="px-6 pb-12 sm:px-10 lg:pb-[calc(--spacing(12)+var(--notice-stack-height,0px))]">
          {draft === null
            ? (
                <>
                  {/* The title comes first in the DOM, so the h1 opens the content and is
                      read before the id shown above it. */}
                  <div className="mt-6 flex flex-col-reverse gap-1">
                    <ScreenHeading ref={headingRef} tabIndex={-1} className="max-w-2xl wrap-anywhere">{title}</ScreenHeading>
                    {idLine}
                  </div>
                  {metaLine}
                  {body.trim() !== "" && (
                    <div ref={bodyRef} className="mt-8 max-w-2xl">
                      <Markdown text={body} base={2} title={title} />
                    </div>
                  )}
                </>
              )
            : (
                <div className="mt-6">
                  {/* The page keeps its one h1 while the title is an input: clipped
                      rather than hidden, so it stays in the accessibility tree, and
                      holding the title on disk rather than the typed one. */}
                  <ScreenHeading ref={headingRef} className="sr-only">{title}</ScreenHeading>
                  {diskChange.showing && (
                    <ChangedOnDisk
                      at={diskChange.at}
                      lineRef={editing.diskLineRef}
                      onReload={editing.reload}
                      onKeyDown={editing.onKeyDown}
                      onFocusLost={editing.diskLineFocusLost}
                    />
                  )}
                  {idLine}
                  <TaskEditor
                    formId={formId}
                    formRef={editing.formRef}
                    draft={draft}
                    onDraftChange={editing.changeDraft}
                    titleRef={editing.titleRef}
                    titleError={editing.titleError}
                    bodyError={editing.bodyError}
                    meta={metaLine}
                    onSubmit={editing.save}
                    onKeyDown={editing.onKeyDown}
                  />
                </div>
              )}

          {comments.length > 0 && <Comments comments={comments} listRef={commentsRef} />}
        </div>
        <ScrollToTop scrolled={scrolled} headingRef={scrolledRef} />
      </div>
      <TaskSidebar
        tag={tag}
        view={view}
        relations={relations}
        outline={outline}
        pageScrollPadding={scrollPaddingTop}
        properties={properties}
      />
      <ConfirmDialog
        open={editing.discardAsked}
        title="Discard your changes?"
        description="The title and the body you edited are not saved. There is no undo."
        cancelLabel="Keep editing"
        confirmLabel="Discard"
        onCancel={editing.keepEditing}
        onConfirm={editing.discard}
        finalFocus={editing.discardFocusRef}
        status={editing.saving ? "Saving…" : undefined}
      />
      <TaskPollNotice tag={tag} id={taskId} />
    </div>
  );
}
