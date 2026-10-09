import { useMutation, useQueries, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import type { Workflow } from "@tasma/protocol";
import { useDeferredValue, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import {
  openCreateWarnings,
  taskDeleteOptions,
  taskWriteOptions,
  usePendingTaskDeletes,
  usePendingTaskWrites,
  type Created,
} from "../api/mutations";
import { usePollNotice } from "../api/poll-notice";
import { POLL_INTERVAL, projectQuery, projectsQuery, taskSearchQuery, tasksQuery, workflowQuery } from "../api/queries";
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
  type HiddenBy,
  type TaskWrite,
} from "../lib/board";
import { formatClock } from "../lib/clock";
import { deleteTaskWords } from "../lib/delete-words";
import { useDocumentTitle } from "../lib/document-title";
import type { DropPlace } from "../lib/drag-place";
import type { FinalFocus } from "../lib/final-focus";
import { fullIndex, placeWrites } from "../lib/order";
import { PlusIcon } from "../lib/icons";
import { useBoardReturn } from "../lib/use-board-return";
import { idsOf, useBoardSearch } from "../lib/use-board-search";
import { useCardDrag, type BoardSnapshot } from "../lib/use-card-drag";
import { warningCount } from "../lib/warning-count";
import { boardFailureLine } from "../lib/write-failure";
import { NAVIGATION_BY_PATH } from "../navigation";
import { useNoticeStore } from "../store/notices";
import { useUiStore } from "../store/ui";
import { BoardColumn } from "./board-column";
import { ConfirmDialog } from "./confirm-dialog";
import { BUTTON_CLASS } from "./control-classes";
import { CreateTaskDialog } from "./create-task-dialog";
import { Diagnostics } from "./diagnostics";
import { DraggedCard } from "./dragged-card";
import { RouteFailure } from "./error-boundary";
import { LabelFilter } from "./label-filter";
import { LiveNotice } from "./live-notice";
import { ProjectSelect } from "./project-select";
import { ScreenHeading } from "./screen-heading";
import { SearchField } from "./search-field";
import type { CardFocus } from "./task-card";

// The route is reached by id rather than imported: the tree in routes.tsx names
// this component, so importing the route back would close a cycle.
const route = getRouteApi("/tasks");

const { label: TITLE } = NAVIGATION_BY_PATH["/tasks"];

const EMPTY_CLASS = "mt-2 max-w-2xl text-base text-muted";

const HEADING_LINE_CLASS = "flex min-h-8 flex-wrap items-center gap-x-4 gap-y-3";

const SEARCH_FAILED = "The search failed. The board shows all tasks.";

const HIDDEN_WORDS: Record<HiddenBy, string> = {
  labels: "The label filter hides it.",
  search: "The search hides it.",
  both: "The filters hide it.",
};

/**
 * The filters as the rendered columns apply them. `searchText` is the text of
 * the search result the columns use, `null` while they use none. `searching`
 * is the text of a long search wait, `null` while none is said.
 */
type BoardFilter = {
  labelled: boolean;
  searchText: string | null;
  searching: string | null;
  failed: boolean;
  matching: number;
  total: number;
};

function filterSentences({ labelled, searchText, searching, failed, matching, total }: BoardFilter): string[] {
  if (searching !== null) {
    return [`Searching for "${searching}".`];
  }

  const count = `${String(matching)} of ${String(total)} tasks`;
  const said = failed ? [SEARCH_FAILED] : [];

  if (searchText !== null) {
    said.push(labelled
      ? `${count} match "${searchText}" and carry a selected label.`
      : `${count} match "${searchText}".`);
  } else if (labelled) {
    said.push(`${count} carry a selected label.`);
  }

  return said;
}

/** What the live region says: a summary of what a poll can change while the page stays put. */
function boardSummary(live: boolean, warnings: number, filter: BoardFilter): string {
  const said: string[] = [];

  if (!live) {
    said.push("The index is not following the disk.");
  }
  if (warnings > 0) {
    said.push(`${warningCount(warnings)} about this project.`);
  }

  return [...said, ...filterSentences(filter)].join(" ");
}

function emptyWords(title: string, labelled: boolean, searchApplied: boolean): string {
  if (labelled && searchApplied) {
    return `No task in ${title} matches the search and carries a selected label.`;
  }

  return searchApplied
    ? `No task in ${title} matches the search.`
    : `No task in ${title} carries any of the selected labels.`;
}

/**
 * Apart from the board, so a poll that changes nothing re-renders this alone.
 * Its reads fetch nothing: the board polls them.
 *
 * The search read counts only once it has a result: until then the board shows
 * the full listing, and the search's own line reports its failure.
 */
function BoardPollNotice({ tag, searchText }: { tag: string; searchText: string }): ReactNode {
  const { client } = route.useRouteContext();
  const projectRead = useQuery({ ...projectQuery(client, tag), enabled: false });
  const listingRead = useQuery({ ...tasksQuery(client, tag), enabled: false });
  const searchRead = useQuery({ ...taskSearchQuery(client, tag, searchText), enabled: false });
  const reads = searchText !== "" && searchRead.dataUpdatedAt > 0
    ? [listingRead, projectRead, searchRead]
    : [listingRead, projectRead];

  usePollNotice(`board-poll:${tag}`, reads, {
    title: "The board is not up to date",
    line: (readAt) => `The last reads of ${tag} failed. The board shows the tasks as they were at ${formatClock(readAt)}.`,
  });

  return null;
}

/**
 * The task the delete dialog asks about, kept after the close so the closing
 * dialog keeps its words. `column` is where the card stood when the dialog
 * opened, for a card a poll removes while it is open.
 */
type DeleteAsk = { id: string; title: string; column: number; open: boolean };

type BoardProps = { tag: string; labels: string | undefined; q: string | undefined };

function Board({ tag, labels, q }: BoardProps): ReactNode {
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
  const { mutate: sendDelete } = useMutation(taskDeleteOptions(queryClient, client, tag));
  const deletingIds = usePendingTaskDeletes(tag);
  const [deleteAsk, setDeleteAsk] = useState<DeleteAsk | null>(null);
  const deleteFocusRef = useRef<FinalFocus>(null);
  const [focusCard, setFocusCard] = useState<CardFocus | null>(null);
  const [focusColumn, setFocusColumn] = useState<number | null>(null);
  // The opener is kept, not read from focus: WebKit focuses no button on a pointer press.
  const [creating, setCreating] = useState<{ status: string; opener: HTMLElement } | null>(null);
  const newTaskRef = useRef<HTMLButtonElement>(null);
  const listed = listing.entries.filter(({ id }) => !deletingIds.has(id));
  const names = workflowNames(listed);
  // Not under Suspense: a poll can bring a name the loader did not read, and a
  // new key would suspend the whole board until its read lands.
  const workflowReads = useQueries({ queries: names.map((name) => workflowQuery(client, name)) });
  const selected = distinctLabels(splitList(labels));
  const deferredSelected = distinctLabels(splitList(useDeferredValue(labels)));
  const { searchText, searchRequested, busy, failed, searching, applied, ids, settled }
    = useBoardSearch(client, tag, q);
  const failureId = useId();
  const [lostFocus, setLostFocus] = useState<{ id: string; column: number } | null>(null);

  useEffect(() => {
    setLastTasksProject(tag);
  }, [tag, setLastTasksProject]);

  useBoardReturn(tag, labels, q, settled);

  const { name, live, config } = project;
  const title = name ?? tag;
  const workflows = new Map<string, Workflow | null | undefined>(
    names.map((workflowName, index) => {
      const read = workflowReads[index]?.data;
      return [workflowName, read === null ? null : read?.data];
    }),
  );
  const liveEntries = applyPending(listed, pending.writes);
  const liveBoard: BoardSnapshot = {
    entries: liveEntries,
    columns: buildColumns(config, liveEntries, deferredSelected, ids),
    pendingIds: new Set(pending.writes.map(({ id }) => id)),
    movedIds: pending.movedIds,
  };
  const { drag, board, liftedRef, press } = useCardDrag({ board: liveBoard, onDrop: dropCard });
  const { entries, columns, pendingIds, movedIds } = board;
  const origin = drag === null ? null : cardPlace(columns, drag.taskId);
  const labelled = deferredSelected.length > 0;
  const searchApplied = applied !== null;
  const filtered = labelled || searchApplied;
  const warnings = boardWarnings(projectWarnings, listingWarnings);
  const matching = columns.reduce((sum, column) => sum + column.matching.length, 0);
  const total = columns.reduce((sum, column) => sum + column.total, 0);

  // A card the board no longer shows took the focus with it: focus goes to the
  // heading of its column. A card with a focus target of its own and one that
  // moved to another column keep theirs. Read here rather than in the card,
  // which cannot see the render that removes it.
  if (lostFocus !== null) {
    setLostFocus(null);
    if (focusCard === null && focusColumn === null && cardPlace(columns, lostFocus.id) === null) {
      setFocusColumn(lostFocus.column);
    }
  }

  /** Sends the writes of a move. `refused` runs when the daemon turns them down. */
  function sendMove(id: string, writes: TaskWrite[], refused?: () => void): void {
    write({ id, writes, failure: { title: `${id} was not moved`, line: boardFailureLine } }).catch(() => refused?.());
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
    // The write refetched the search with the listing. A failed search shows every card.
    const searchIds = idsOf(searchRequested
      ? queryClient.getQueryData(taskSearchQuery(client, tag, searchText).queryKey)
      : undefined);
    const target = createdTarget(config, read.entries, selected, searchIds, result.id, result.status);

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
      target.kind === "column" && target.hiddenBy !== null
        ? `${result.id} was created. ${HIDDEN_WORDS[target.hiddenBy]}`
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
      ...(q === undefined ? {} : { q }),
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

    // The top of the column, the tasks the filters hide counted in.
    moveFromMenu(id, placeWrites(unfiltered, card, 0, status));
  }

  function moveBy(index: number, id: string, by: -1 | 1): void {
    const { unfiltered, visible, card } = moveTarget(config, entries, columns, index, id);
    const at = columns[index]!.matching.findIndex((entry) => entry.id === id);

    moveFromMenu(id, placeWrites(unfiltered, card, fullIndex(unfiltered, visible, at + by)));
  }

  function askDelete(id: string): void {
    // Asked from a card, which the board renders in these columns.
    const { entry: { frontmatter: { title: taskTitle } }, column } = cardPlace(columns, id)!;

    setDeleteAsk({ id, title: taskTitle, column, open: true });
  }

  /**
   * The dialog closes as the write starts, so a refusal opens the floating
   * notice. Focus moves to the card after the deleted one as the column shows
   * it, or to the column's heading where none follows.
   */
  function confirmDelete(ask: DeleteAsk): void {
    const { id } = ask;
    const place = cardPlace(columns, id);
    const next = place === null ? undefined : columns[place.column]!.matching[place.index + 1];

    deleteFocusRef.current = "keep";
    setDeleteAsk({ ...ask, open: false });
    if (next !== undefined) {
      setFocusCard({ id: next.id, part: "menu" });
    } else {
      setFocusColumn(place?.column ?? ask.column);
    }
    sendDelete({ id });
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
          <SearchField tag={tag} q={q} busy={busy} describedBy={failed ? failureId : undefined} />
          <LabelFilter entries={listed} selected={selected} />
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
        {boardSummary(live, warnings.length + listing.excluded.length, {
          labelled,
          searchText: applied?.text ?? null,
          searching,
          failed,
          matching,
          total,
        })}
      </div>
      {/* Muted, not signal: a failed search needs no human. */}
      {failed && <p id={failureId} className="mt-3 text-sm text-muted">{SEARCH_FAILED}</p>}
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
      {listed.length === 0 && <p className={EMPTY_CLASS}>{`No tasks in ${title} yet.`}</p>}
      {listed.length > 0 && filtered && matching === 0 && (
        <p className={EMPTY_CLASS}>{emptyWords(title, labelled, searchApplied)}</p>
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
            onDelete={askDelete}
            focusCard={focusCard}
            onCardFocused={() => {
              setFocusCard(null);
            }}
            onCardFocusLost={(id) => {
              setLostFocus({ id, column: index });
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
      <BoardPollNotice tag={tag} searchText={searchText} />
      {creating !== null && (
        <CreateTaskDialog
          queryClient={queryClient}
          client={client}
          tag={tag}
          config={config}
          entries={listed}
          status={creating.status}
          opener={creating.opener}
          newTaskRef={newTaskRef}
          onClose={() => {
            setCreating(null);
          }}
          onCreated={created}
        />
      )}
      {deleteAsk !== null && (
        <ConfirmDialog
          open={deleteAsk.open}
          {...deleteTaskWords(deleteAsk.id, deleteAsk.title)}
          confirmLabel="Delete"
          onCancel={() => {
            // Base UI returns focus to the menu button the dialog opened from.
            deleteFocusRef.current = null;
            setDeleteAsk({ ...deleteAsk, open: false });
          }}
          onConfirm={() => {
            confirmDelete(deleteAsk);
          }}
          finalFocus={deleteFocusRef}
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
  const { projects, labels, q } = route.useSearch();
  const [tag] = splitList(projects);

  useDocumentTitle(TITLE);

  if (tag === undefined) {
    return <EmptyTree />;
  }

  return <Board tag={tag} labels={labels} q={q} />;
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
