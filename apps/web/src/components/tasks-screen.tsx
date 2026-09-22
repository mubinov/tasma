import { useMutation, useQueries, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import type { Workflow } from "@tasma/protocol";
import { useDeferredValue, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { openCreateWarnings, taskWriteOptions, usePendingTaskWrites, type Created } from "../api/mutations";
import { usePollNotice } from "../api/poll-notice";
import { POLL_INTERVAL, projectQuery, projectsQuery, tasksQuery, workflowQuery } from "../api/queries";
import {
  applyPending,
  boardWarnings,
  buildColumns,
  cardPlace,
  createdTarget,
  distinctLabels,
  isTopPriority,
  moveTarget,
  splitList,
  stepView,
  workflowNames,
  type TaskWrite,
} from "../lib/board";
import { formatClock } from "../lib/clock";
import { useDocumentTitle } from "../lib/document-title";
import type { DropPlace } from "../lib/drag-place";
import { fullIndex, placeWrites } from "../lib/order";
import { PlusIcon } from "../lib/icons";
import { useCardDrag, type BoardSnapshot } from "../lib/use-card-drag";
import { warningCount } from "../lib/warning-count";
import { NAVIGATION_BY_PATH } from "../navigation";
import { useNoticeStore } from "../store/notices";
import { useUiStore } from "../store/ui";
import { BoardColumn } from "./board-column";
import { BUTTON_CLASS } from "./control-classes";
import { CreateTaskDialog } from "./create-task-dialog";
import { Diagnostics } from "./diagnostics";
import { DraggedCard } from "./dragged-card";
import { RouteFailure } from "./error-boundary";
import { LabelFilter } from "./label-filter";
import { LiveNotice } from "./live-notice";
import { ProjectSelect } from "./project-select";
import { ScreenHeading } from "./screen-heading";
import type { CardFocus } from "./task-card";

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

/**
 * Puts the board back where the reader left it when they opened a card: the
 * scroll position that was recorded, and focus on that card.
 *
 * The router resets the scroll to the top from an `onRendered` subscriber it
 * registered when it was created, so a restore in a layout effect is undone.
 * This one waits for the same event, later in the subscriber list and therefore
 * after the reset, and it runs once: a later visit opens the board at the top.
 */
function useBoardReturn(tag: string, labels: string | undefined): void {
  const router = useRouter();
  const boardReturn = useUiStore((state) => state.boardReturn);
  const pending = useUiStore((state) => state.boardRestorePending);
  const endBoardRestore = useUiStore((state) => state.endBoardRestore);

  useLayoutEffect(() => {
    if (boardReturn === null || !pending) {
      return;
    }
    if (boardReturn.projects !== tag || boardReturn.labels !== labels) {
      endBoardRestore();
      return;
    }

    const { scrollX, scrollY, taskId } = boardReturn;
    let frame = 0;
    const stop = router.subscribe("onRendered", () => {
      stop();
      window.scrollTo(scrollX, scrollY);
      // A frame after the effect AppShell moves focus to <main> in. A card the
      // filter now hides, or a task that is gone, leaves the focus there.
      frame = requestAnimationFrame(() => {
        // Focus scrolls of its own accord where the restored offset leaves the
        // card out of view or under the sticky column header.
        document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(taskId)}"] [data-task-title]`)?.focus();
        endBoardRestore();
      });
    });

    return () => {
      stop();
      cancelAnimationFrame(frame);
    };
  }, [boardReturn, pending, tag, labels, router, endBoardRestore]);
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
  const setBoardReturn = useUiStore((state) => state.setBoardReturn);
  const { mutateAsync: write } = useMutation(taskWriteOptions(queryClient, client, tag));
  const pending = usePendingTaskWrites(tag);
  const [focusCard, setFocusCard] = useState<CardFocus | null>(null);
  const [focusColumn, setFocusColumn] = useState<number | null>(null);
  // The opener is kept, not read from focus: WebKit focuses no button on a pointer press.
  const [creating, setCreating] = useState<{ status: string; opener: HTMLElement } | null>(null);
  const newTaskRef = useRef<HTMLButtonElement>(null);
  const names = workflowNames(listing.entries);
  // Not under Suspense: a poll can bring a name the loader did not read, and a
  // new key would suspend the whole board until its read lands.
  const workflowReads = useQueries({ queries: names.map((name) => workflowQuery(client, name)) });
  const selected = distinctLabels(splitList(labels));
  const deferredSelected = distinctLabels(splitList(useDeferredValue(labels)));

  useEffect(() => {
    setLastTasksProject(tag);
  }, [tag, setLastTasksProject]);

  useBoardReturn(tag, labels);

  const { name, live, config } = project;
  const title = name ?? tag;
  const workflows = new Map<string, Workflow | null | undefined>(
    names.map((workflowName, index) => {
      const read = workflowReads[index]?.data;
      return [workflowName, read === null ? null : read?.data];
    }),
  );
  const liveEntries = applyPending(listing.entries, pending.writes);
  const liveBoard: BoardSnapshot = {
    entries: liveEntries,
    columns: buildColumns(config, liveEntries, deferredSelected),
    pendingIds: new Set(pending.writes.map(({ id }) => id)),
    movedIds: pending.movedIds,
  };
  const { drag, board, liftedRef, press } = useCardDrag({ board: liveBoard, onDrop: dropCard });
  const { entries, columns, pendingIds, movedIds } = board;
  const origin = drag === null ? null : cardPlace(columns, drag.taskId);
  const filtered = deferredSelected.length > 0;
  const warnings = boardWarnings(projectWarnings, listingWarnings);
  const matching = columns.reduce((sum, column) => sum + column.matching.length, 0);
  const total = columns.reduce((sum, column) => sum + column.total, 0);

  /** Sends the writes of a move. `refused` runs when the daemon turns them down. */
  function sendMove(id: string, writes: TaskWrite[], refused?: () => void): void {
    write({ id, writes, title: `${id} was not moved`, place: "board" }).catch(() => refused?.());
  }

  /**
   * A move from the card menu. The card takes focus where it renders next: at
   * its new place, and at its old place again after a refusal.
   */
  function moveFromMenu(id: string, writes: TaskWrite[]): void {
    setFocusCard({ id, part: "menu" });
    sendMove(id, writes, () => {
      setFocusCard({ id, part: "menu" });
    });
  }

  /**
   * The mutation resolves once the query cache holds the new task, but the
   * query tells its observers later, not in this call, so the target is read
   * from the cache rather than from this render.
   */
  function created(result: Created): void {
    const { data: read, diagnostics } = queryClient.getQueryData(tasksQuery(client, tag).queryKey)!;
    const target = createdTarget(config, read.entries, selected, result.id, result.status);

    // Inside a promise continuation these would commit after the notice store's
    // update, and the warning notice would show for a frame under the scrim.
    // eslint-disable-next-line @eslint-react/dom-no-flush-sync -- the dialog closes before any notice opens
    flushSync(() => {
      setCreating(null);
      if (target.kind === "card") {
        setFocusCard({ id: result.id, part: "title" });
      } else {
        setFocusColumn(target.column);
      }
    });

    useNoticeStore.getState().announce(
      target.kind === "column" && target.hidden
        ? `${result.id} was created. The label filter hides it.`
        : `${result.id} was created.`,
    );
    openCreateWarnings(result, boardWarnings(
      queryClient.getQueryData(projectQuery(client, tag).queryKey)!.diagnostics,
      diagnostics,
    ));
  }

  function recordReturn(id: string): void {
    setBoardReturn({
      projects: tag,
      ...(labels === undefined ? {} : { labels }),
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      taskId: id,
    });
  }

  function move(id: string, status: string): void {
    const key = status.toLowerCase();
    // The menu offers only configured statuses, and each of them has a column.
    const index = config.statuses.findIndex((candidate) => candidate.toLowerCase() === key);
    const { unfiltered, card } = moveTarget(config, entries, columns, index, id);

    // The top of the column, the tasks the label filter hides counted in.
    moveFromMenu(id, placeWrites(unfiltered, card, 0, status));
  }

  function moveBy(index: number, id: string, by: -1 | 1): void {
    const { unfiltered, visible, card } = moveTarget(config, entries, columns, index, id);
    const at = columns[index]!.matching.findIndex((entry) => entry.id === id);

    moveFromMenu(id, placeWrites(unfiltered, card, fullIndex(unfiltered, visible, at + by)));
  }

  /**
   * A drop reads the board the drag started on, never the live one: a poll can
   * have moved the card since. It moves no focus.
   */
  function dropCard(id: string, place: DropPlace, snapshot: BoardSnapshot): void {
    const { unfiltered, visible, card } = moveTarget(config, snapshot.entries, snapshot.columns, place.column, id);
    const from = cardPlace(snapshot.columns, id)!;
    const status = from.column === place.column ? undefined : snapshot.columns[place.column]!.status;

    sendMove(id, placeWrites(unfiltered, card, fullIndex(unfiltered, visible, place.index), status));
  }

  return (
    <>
      <div className={HEADING_LINE_CLASS}>
        <ScreenHeading>{TITLE}</ScreenHeading>
        <div className="ml-auto flex max-w-full min-w-0 flex-wrap items-center gap-x-5 gap-y-3">
          <ProjectSelect projects={projects} tag={tag} />
          <LabelFilter entries={listing.entries} selected={selected} />
          <button
            ref={newTaskRef}
            type="button"
            onClick={(event) => {
              setCreating({ status: config.default_status, opener: event.currentTarget });
            }}
            className={`ml-1 ${BUTTON_CLASS}`}
          >
            <PlusIcon size={14} aria-hidden="true" />
            New task
          </button>
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
            place={index}
            column={column}
            filtered={filtered}
            priorities={config.priorities}
            workflows={workflows}
            statuses={config.statuses}
            pendingIds={pendingIds}
            movedIds={movedIds}
            onMove={move}
            onMoveBy={(id, by) => {
              moveBy(index, id, by);
            }}
            onOpen={recordReturn}
            focusCard={focusCard}
            onCardFocused={() => {
              setFocusCard(null);
            }}
            focusHeading={focusColumn === index}
            onHeaderFocused={() => {
              setFocusColumn(null);
            }}
            onCreate={(status, opener) => {
              setCreating({ status, opener });
            }}
            draggingId={drag?.taskId ?? null}
            slot={drag?.place?.column === index
              ? { index: drag.place.index, height: drag.box.height }
              : undefined}
            onPress={press}
          />
        ))}
      </div>
      {drag !== null && origin !== null && (
        <DraggedCard
          elementRef={liftedRef}
          width={drag.box.width}
          entry={origin.entry}
          view={stepView(origin.entry.frontmatter, origin.final, workflows.get(origin.entry.frontmatter.workflow ?? ""))}
          top={isTopPriority(origin.entry.frontmatter.priority, config.priorities)}
        />
      )}
      <BoardPollNotice tag={tag} />
      {creating !== null && (
        <CreateTaskDialog
          queryClient={queryClient}
          client={client}
          tag={tag}
          config={config}
          entries={listing.entries}
          status={creating.status}
          opener={creating.opener}
          newTaskRef={newTaskRef}
          onClose={() => {
            setCreating(null);
          }}
          onCreated={created}
        />
      )}
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
