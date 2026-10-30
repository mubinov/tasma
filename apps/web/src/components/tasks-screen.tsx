import { useMutation, useQueries, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import type { ExcludedFile, Workflow } from "@tasma/protocol";
import { useDeferredValue, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import {
  openCreateWarnings,
  taskDeleteOptions,
  taskWriteOptions,
  usePendingTaskDeletes,
  usePendingTaskWrites,
  type Created,
} from "../api/mutations";
import { projectQuery, projectsQuery, tasksQuery, workflowQuery } from "../api/queries";
import {
  applyPending,
  boardOrder,
  boardValue,
  boardWarnings,
  buildColumns,
  cardConfig,
  cardMarks,
  cardPlace,
  columnKeys,
  createdTarget,
  distinctLabels,
  isSeveral,
  moveTarget,
  readBoard,
  splitList,
  statusColumn,
  tagOf,
  takesCard,
  workflowNames,
  type BoardSubject,
  type CardConfig,
  type HiddenBy,
  type TaskWrite,
} from "../lib/board";
import { deleteTaskWords } from "../lib/delete-words";
import { useDocumentTitle } from "../lib/document-title";
import type { DropPlace } from "../lib/drag-place";
import type { FinalFocus } from "../lib/final-focus";
import { fullIndex, placeWrites } from "../lib/order";
import { PlusIcon } from "../lib/icons";
import { cachedShownTags, useBoardProjects, type FailedProject } from "../lib/use-board-projects";
import { useBoardReturn } from "../lib/use-board-return";
import { cachedSearchIds, useBoardSearch } from "../lib/use-board-search";
import { useCardDrag, type BoardSnapshot } from "../lib/use-card-drag";
import { useFocusLost } from "../lib/use-focus-lost";
import { warningCount } from "../lib/warning-count";
import { boardFailureLine } from "../lib/write-failure";
import { NAVIGATION_BY_PATH } from "../navigation";
import { useNoticeStore } from "../store/notices";
import { useUiStore } from "../store/ui";
import { BoardColumn } from "./board-column";
import { BoardRefusalNotice, ProjectListReload, RefusedProjectsReload } from "./board-reads";
import { ConfirmDialog } from "./confirm-dialog";
import { BUTTON_CLASS } from "./control-classes";
import { CreateTaskDialog } from "./create-task-dialog";
import { Diagnostics, type WarningItem } from "./diagnostics";
import { DraggedCard } from "./dragged-card";
import { RouteFailure } from "./error-boundary";
import { LabelFilter } from "./label-filter";
import { LiveNotice } from "./live-notice";
import { ProjectFailureNote } from "./project-failure-note";
import { ProjectSelect } from "./project-select";
import { ScreenHeading } from "./screen-heading";
import { SearchField } from "./search-field";
import type { CardFocus } from "./task-card";

// The route is reached by id rather than imported: the tree in routes.tsx names
// this component, so importing the route back would close a cycle.
const route = getRouteApi("/tasks");

const { label: TITLE } = NAVIGATION_BY_PATH["/tasks"];

const EMPTY_CLASS = "mt-2 max-w-2xl text-base text-subtle";

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

/** The warnings line of one project the board shows. */
type ProjectReport = { tag: string; items: readonly WarningItem[]; excluded: readonly ExcludedFile[] };

/** What the board state region says: what a read can change about the projects while the page stays put. */
function boardStateWords(
  failed: readonly FailedProject[],
  unlive: readonly string[],
  reports: readonly ProjectReport[],
): string {
  return [
    ...failed.map(({ tag, missing }) => (missing ? `${tag} is not a project.` : `${tag} did not load.`)),
    ...unlive.map((tag) => `The index of ${tag} is not following the disk.`),
    ...reports.map(({ tag, items, excluded }) => `${warningCount(items.length + excluded.length)} about ${tag}.`),
  ].join(" ");
}

/**
 * The board state region. Its words land one animation frame after they
 * change: a read that takes out the focused card also moves the focus, and a
 * live message in the same commit as a focus move loses to it.
 */
function BoardStateRegion({ words }: { words: string }): ReactNode {
  const [said, setSaid] = useState(words);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setSaid(words);
    });

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [words]);

  return <div role="status" aria-live="polite" className="sr-only">{said}</div>;
}

function emptyWords(projectsName: string, labelled: boolean, searchApplied: boolean): string {
  if (labelled && searchApplied) {
    return `No task in ${projectsName} matches the search and carries a selected label.`;
  }

  return searchApplied
    ? `No task in ${projectsName} matches the search.`
    : `No task in ${projectsName} carries any of the selected labels.`;
}

/**
 * A column a focus move goes back to after a render that can have changed the
 * row: its key from `columnKeys`, and its index for a row that no longer has
 * that key.
 */
type ColumnSpot = { key: string; index: number };

/** The column of `spot` in `keys`, else the one at its index, else the last one; `null` for a row with no column. */
function spotColumn(keys: readonly string[], spot: ColumnSpot): number | null {
  if (keys.length === 0) {
    return null;
  }

  const index = keys.indexOf(spot.key);

  return index >= 0 ? index : Math.min(spot.index, keys.length - 1);
}

/**
 * The task the delete dialog asks about, kept after the close so the closing
 * dialog keeps its words. `column` is where the card stood when the dialog
 * opened, for a card a read removes while it is open.
 */
type DeleteAsk = { id: string; title: string; column: ColumnSpot; open: boolean };

/** Focus that left the page with a column or a card: `id` names the card, `null` for focus elsewhere in the column. */
type LostFocus = { id: string | null; column: ColumnSpot };

type BoardProps = {
  /** The projects the loader read, in board order. */
  tags: readonly string[];
  /** The projects whose reads the daemon refused at the load, in board order. */
  refused: readonly string[];
  /** The tags the daemon's project list did not hold at the load, in board order. */
  missing: readonly string[];
  /** The board follows the project list of the tree. */
  all: boolean;
  /** The board of all projects, or of two or more tags. */
  several: boolean;
  /** The board value of the address. */
  board: string;
  labels: string | undefined;
  q: string | undefined;
};

function Board({ tags, refused, missing, all, several, board, labels, q }: BoardProps): ReactNode {
  const { client, queryClient } = route.useRouteContext();
  const { data: { data: projects } } = useSuspenseQuery(projectsQuery(client));
  const {
    loaded,
    shown: shownProjects,
    failed: failedProjects,
  } = useBoardProjects(client, queryClient, { tags, refused, missing, several });
  const shown = shownProjects.map((shownProject) => shownProject.tag);
  // The project of a board of one project; nothing reads it on a board of several projects.
  const tag = tags[0]!;
  const setLastTasksProject = useUiStore((state) => state.setLastTasksProject);
  const lastCreateProject = useUiStore((state) => state.lastCreateProject);
  const setLastCreateProject = useUiStore((state) => state.setLastCreateProject);
  const setBoardReturn = useUiStore((state) => state.setBoardReturn);
  const { mutateAsync: write } = useMutation(taskWriteOptions(queryClient, client));
  const pending = usePendingTaskWrites(shown);
  const { mutate: sendDelete } = useMutation(taskDeleteOptions(queryClient, client));
  const deletingIds = usePendingTaskDeletes(shown);
  const [deleteAsk, setDeleteAsk] = useState<DeleteAsk | null>(null);
  const deleteFocusRef = useRef<FinalFocus>(null);
  const [focusCard, setFocusCard] = useState<CardFocus | null>(null);
  const [focusColumn, setFocusColumn] = useState<number | null>(null);
  // A count, so each request moves the focus once and none has to be cleared.
  const [mainFocusRequests, setMainFocusRequests] = useState(0);
  // The opener is kept, not read from focus: WebKit focuses no button on a pointer press.
  const [creating, setCreating] = useState<{
    column: Readonly<Record<string, string>> | null;
    startTag: string;
    opener: HTMLElement;
  } | null>(null);
  const newTaskRef = useRef<HTMLButtonElement>(null);
  const listed = shownProjects
    .flatMap(({ listing: { data: listing } }) => listing.entries)
    .filter(({ id }) => !deletingIds.has(id));
  const names = workflowNames(listed);
  // Not under Suspense: a read can bring a name the loader did not read, and a
  // new key would suspend the whole board until its read lands.
  const workflowReads = useQueries({ queries: names.map((name) => workflowQuery(client, name)) });
  const selected = distinctLabels(splitList(labels));
  const deferredSelected = distinctLabels(splitList(useDeferredValue(labels)));
  const { searchText, busy, failed, searching, applied, ids, settled } = useBoardSearch(client, shown, board, q);
  const failureId = useId();
  const [lostFocus, setLostFocus] = useState<LostFocus | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLastTasksProject(board);
  }, [board, setLastTasksProject]);

  // When the last project leaves the board of all projects, the empty-tree
  // screen replaces the board at the same path, where the shell moves no focus.
  // An open dialog renders outside the board, so it counts as focus inside.
  useFocusLost(rootRef, (root) => {
    root.closest("main")?.focus();
  }, creating !== null || deleteAsk?.open === true);

  useBoardReturn(board, labels, q, settled);

  useEffect(() => {
    if (mainFocusRequests > 0) {
      rootRef.current?.closest("main")?.focus();
    }
  }, [mainFocusRequests]);

  const { name } = loaded[0]!.project.data;
  const unlive = shownProjects.filter(({ project }) => !project.data.live).map((shownProject) => shownProject.tag);
  const reports: ProjectReport[] = shownProjects
    .map(({ tag: reportTag, project, listing }) => ({
      tag: reportTag,
      items: boardWarnings(project.diagnostics, listing.diagnostics),
      excluded: listing.data.excluded,
    }))
    .filter(({ items, excluded }) => items.length + excluded.length > 0);
  const boardProjects = shownProjects.map((shownProject) => ({
    tag: shownProject.tag,
    config: shownProject.project.data.config,
  }));
  const configs: ReadonlyMap<string, CardConfig> = new Map(
    boardProjects.map((project) => [project.tag, project.config]),
  );
  const subject: BoardSubject = several ? "these projects" : "this project";
  const projectsName = several ? "these projects" : name ?? tag;
  const workflows = new Map<string, Workflow | null | undefined>(
    names.map((workflowName, index) => {
      const read = workflowReads[index]?.data;
      return [workflowName, read === null ? null : read?.data];
    }),
  );
  const liveEntries = applyPending(listed, pending.writes);
  const liveBoard: BoardSnapshot = {
    projects: boardProjects,
    entries: liveEntries,
    columns: buildColumns(boardProjects, liveEntries, deferredSelected, ids),
    pendingIds: new Set(pending.writes.map(({ id }) => id)),
    movedIds: pending.movedIds,
  };
  const { drag, board: shownBoard, liftedRef, press } = useCardDrag({ board: liveBoard, onDrop: dropCard });
  const { entries, columns, pendingIds, movedIds } = shownBoard;
  const keys = columnKeys(columns);
  const origin = drag === null ? null : cardPlace(columns, drag.taskId);
  const labelled = deferredSelected.length > 0;
  const searchApplied = applied !== null;
  const filtered = labelled || searchApplied;
  const matching = columns.reduce((sum, column) => sum + column.matching.length, 0);
  const total = columns.reduce((sum, column) => sum + column.total, 0);

  // A card or a column the board no longer shows took the focus with it: focus
  // goes to the heading of the column with the same key, or else of the column
  // at the old index. A card with a focus target of its own and one that moved
  // to another column keep theirs. Read here rather than in the card or the
  // column, which cannot see the render that removes it.
  if (lostFocus !== null) {
    setLostFocus(null);
    const gone = lostFocus.id === null || cardPlace(columns, lostFocus.id) === null;

    if (focusCard === null && focusColumn === null && gone) {
      focusSpot(lostFocus.column);
    }
  }

  /** Focus to the heading of the column of `spot`, or to `<main>` when no column is left. */
  function focusSpot(spot: ColumnSpot): void {
    const index = spotColumn(keys, spot);

    if (index === null) {
      setMainFocusRequests((count) => count + 1);
    } else {
      setFocusColumn(index);
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

  /** Opens the dialog on the project of the last create when the board shows it, else on the first project shown. */
  function startCreate(column: Readonly<Record<string, string>> | null, opener: HTMLElement): void {
    const startTag = lastCreateProject !== null && shown.includes(lastCreateProject) ? lastCreateProject : shown[0]!;

    setCreating({ column, startTag, opener });
  }

  /** A create in a project that left the board while the dialog was open: no column takes its card. */
  function createdOffBoard(result: Created, createdTag: string): void {
    const projectRead = queryClient.getQueryData(projectQuery(client, createdTag).queryKey);
    const listingRead = queryClient.getQueryData(tasksQuery(client, createdTag).queryKey);

    // eslint-disable-next-line @eslint-react/dom-no-flush-sync -- the dialog closes before any notice opens
    flushSync(() => {
      setCreating(null);
      setMainFocusRequests((count) => count + 1);
    });

    useNoticeStore.getState().announce(`${result.id} was created. The board does not show ${createdTag}.`);
    openCreateWarnings(result, boardWarnings(projectRead?.diagnostics ?? [], listingRead?.diagnostics ?? []));
  }

  /**
   * The mutation resolves once the query cache holds the new task, but the
   * query tells its observers later, not in this call, so the projects and the
   * target are read from the cache rather than from this render.
   */
  function created(result: Created): void {
    const createdTag = tagOf(result.id);
    const onBoard = cachedShownTags(queryClient, client, { tags, several });

    setLastCreateProject(createdTag);
    if (!onBoard.includes(createdTag)) {
      createdOffBoard(result, createdTag);
      return;
    }

    const projectsNow = onBoard.map((onBoardTag) => ({
      tag: onBoardTag,
      config: queryClient.getQueryData(projectQuery(client, onBoardTag).queryKey)!.data.config,
    }));
    const { data: read, diagnostics } = queryClient.getQueryData(tasksQuery(client, createdTag).queryKey)!;
    // The write refetched the search with the listing. A failed search shows every card.
    const searchIds = cachedSearchIds(queryClient, client, onBoard, searchText);
    const target = createdTarget(projectsNow, read.entries, selected, searchIds, result.id, result.status);

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
      queryClient.getQueryData(projectQuery(client, createdTag).queryKey)!.diagnostics,
      diagnostics,
    ));
  }

  function recordReturn(id: string): void {
    setBoardReturn({
      projects: board,
      ...(labels === undefined ? {} : { labels }),
      ...(q === undefined ? {} : { q }),
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      taskId: id,
    });
  }

  function move(id: string, status: string): void {
    // The menu offers only the statuses of the card's project, and each of them has a column.
    const index = statusColumn(columns, tagOf(id), status);
    const { unfiltered, card } = moveTarget(shownBoard.projects, entries, columns, index, id);

    // The top of the column, the tasks the filters hide counted in.
    moveFromMenu(id, placeWrites(unfiltered, card, 0, status));
  }

  function moveBy(index: number, id: string, by: -1 | 1): void {
    const { unfiltered, visible, card } = moveTarget(shownBoard.projects, entries, columns, index, id);
    const at = columns[index]!.matching.findIndex((entry) => entry.id === id);

    moveFromMenu(id, placeWrites(unfiltered, card, fullIndex(unfiltered, visible, at + by)));
  }

  function askDelete(id: string): void {
    // Asked from a card, which the board renders in these columns.
    const { entry: { frontmatter: { title: taskTitle } }, column } = cardPlace(columns, id)!;

    setDeleteAsk({ id, title: taskTitle, column: { key: keys[column]!, index: column }, open: true });
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
    } else if (place !== null) {
      setFocusColumn(place.column);
    } else {
      focusSpot(ask.column);
    }
    sendDelete({ id });
  }

  /**
   * A drop reads the board the drag started on, never the live one: a read can
   * have moved the card since. It moves no focus.
   */
  function dropCard(id: string, place: DropPlace, snapshot: BoardSnapshot): void {
    const target = snapshot.columns[place.column]!;
    // A column that the card's project has no status for takes no card of it.
    if (!takesCard(target, id)) {
      return;
    }

    const changesColumn = cardPlace(snapshot.columns, id)!.column !== place.column;
    const status = changesColumn ? target.byTag[tagOf(id)] : undefined;

    const { unfiltered, visible, card } = moveTarget(
      snapshot.projects,
      snapshot.entries,
      snapshot.columns,
      place.column,
      id,
    );
    sendMove(id, placeWrites(unfiltered, card, fullIndex(unfiltered, visible, place.index), status));
  }

  return (
    <div ref={rootRef} className="contents">
      <div className={HEADING_LINE_CLASS}>
        <ScreenHeading>{TITLE}</ScreenHeading>
        <div className="ml-auto flex max-w-full min-w-0 flex-wrap items-center gap-x-5 gap-y-3">
          <ProjectSelect projects={projects} board={board} labels={labels} q={q} />
          <SearchField board={board} q={q} busy={busy} describedBy={failed ? failureId : undefined} />
          <LabelFilter entries={listed} selected={selected} subject={subject} />
          {shown.length > 0 && (
            <button
              ref={newTaskRef}
              type="button"
              onClick={(event) => {
                startCreate(null, event.currentTarget);
              }}
              className={`ml-1 ${BUTTON_CLASS}`}
            >
              <PlusIcon size={14} aria-hidden="true" />
              New task
            </button>
          )}
        </div>
      </div>

      {/* Rendered whether or not they say anything: a live region inserted
          together with its content announces nothing. Two regions, so a change
          of the filters does not say the state of every project again.
          `aria-live` as well as the role: only the attribute exempts a region
          from the `aria-hidden` a modal dialog puts on the page behind it.
          Outside <main>: a modal dialog hides <main> as one element only while
          no `[aria-live]` element is inside it. */}
      {createPortal(
        <>
          <BoardStateRegion words={boardStateWords(failedProjects, unlive, reports)} />
          <div role="status" aria-live="polite" className="sr-only">
            {filterSentences({
              labelled,
              searchText: applied?.text ?? null,
              searching,
              failed,
              matching,
              total,
            }).join(" ")}
          </div>
        </>,
        document.body,
      )}
      {/* Subtle, not signal: a failed search needs no human. */}
      {failed && <p id={failureId} className="mt-3 text-sm text-subtle">{SEARCH_FAILED}</p>}
      {failedProjects.map((failedProject, index) => (
        <ProjectFailureNote
          key={failedProject.tag}
          tag={failedProject.tag}
          missing={failedProject.missing}
          className={index === 0 ? "mt-6" : "mt-3"}
        />
      ))}
      {unlive.map((unliveTag, index) => (
        <LiveNotice
          key={unliveTag}
          project={unliveTag}
          className={`${failedProjects.length + index === 0 ? "mt-6" : "mt-3"} max-w-2xl`}
        />
      ))}
      {reports.map((report, index) => (
        // The board stays mounted when the address changes, so the board in
        // the key starts the line folded for the next board.
        <Diagnostics
          key={`${board}:${report.tag}`}
          items={report.items}
          excluded={report.excluded}
          subject={report.tag}
          className={failedProjects.length + unlive.length + index === 0 ? "mt-4" : "mt-3"}
        />
      ))}
      {/* With no project shown, the notes say why the board is empty. */}
      {listed.length === 0 && shown.length > 0 && <p className={EMPTY_CLASS}>{`No tasks in ${projectsName} yet.`}</p>}
      {listed.length > 0 && filtered && matching === 0 && (
        <p className={EMPTY_CLASS}>{emptyWords(projectsName, labelled, searchApplied)}</p>
      )}

      {/* The right padding of main is not part of the page's sideways overflow, so
          the row extends into it and the last column carries the same padding. */}
      <div className="mt-6 -mr-6 flex items-start gap-6 *:last:box-content *:last:pr-6 sm:-mr-10 sm:*:last:pr-10">
        {columns.map((column, index) => (
          // Keyed by the column key, so a project that joins or leaves the board
          // of all projects inserts or removes only its own columns. The board
          // value resets a column's state for the next board.
          <BoardColumn
            key={`${board}:${keys[index]!}`}
            board={board}
            columnKey={keys[index]!}
            place={index}
            column={column}
            filtered={filtered}
            workflows={workflows}
            configs={configs}
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
              setLostFocus({ id, column: { key: keys[index]!, index } });
            }}
            onFocusLost={() => {
              setLostFocus({ id: null, column: { key: keys[index]!, index } });
            }}
            focusHeading={focusColumn === index}
            onHeaderFocused={() => {
              setFocusColumn(null);
            }}
            onCreate={(_status, opener) => {
              startCreate(column.byTag, opener);
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
          {...cardMarks(
            origin.entry,
            columns[origin.column]!,
            cardConfig(configs, origin.entry.id),
            workflows.get(origin.entry.frontmatter.workflow ?? ""),
          )}
        />
      )}
      {!several && <BoardRefusalNotice tag={tag} searchText={searchText} />}
      {(all || missing.length > 0) && (
        <ProjectListReload all={all} tags={boardOrder(tags, refused)} missing={missing} />
      )}
      {refused.length > 0 && <RefusedProjectsReload tags={refused} />}
      {creating !== null && (
        <CreateTaskDialog
          queryClient={queryClient}
          client={client}
          projects={shownProjects.map(({ tag: shownTag, project: { data }, listing }) => ({
            tag: shownTag,
            name: data.name,
            config: data.config,
            entries: listing.data.entries.filter(({ id }) => !deletingIds.has(id)),
          }))}
          startTag={creating.startTag}
          column={creating.column}
          chooseProject={several}
          opener={creating.opener}
          newTaskRef={newTaskRef}
          focusFallback={() => {
            setMainFocusRequests((count) => count + 1);
          }}
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
    </div>
  );
}

function EmptyTree(): ReactNode {
  const { client } = route.useRouteContext();
  const router = useRouter();
  const { data: { data: projects } } = useSuspenseQuery(projectsQuery(client));
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
  const { tags, refused, missing } = route.useLoaderData();
  const address = readBoard(projects);

  useDocumentTitle(TITLE);

  // Also the board of all projects in an empty tree: the address keeps `all`,
  // so the board of all projects opens when a project appears.
  if (tags.length === 0) {
    return <EmptyTree />;
  }

  return (
    <Board
      tags={tags}
      refused={refused}
      missing={missing}
      all={address.all}
      several={isSeveral(address)}
      board={boardValue(address)}
      labels={labels}
      q={q}
    />
  );
}

/**
 * The failure panel, then the project selector when the listing of projects was
 * read. Without the selector, no other board can be opened: `/tasks` redirects to
 * the refused project again.
 */
export function TasksFailure(props: ErrorComponentProps): ReactNode {
  const { client } = route.useRouteContext();
  const { projects, labels, q } = route.useSearch();
  const { data: read } = useQuery({ ...projectsQuery(client), enabled: false });

  return (
    <>
      <RouteFailure {...props} />
      {read !== undefined && (
        <div className="mt-6">
          <ProjectSelect projects={read.data} board={boardValue(readBoard(projects))} labels={labels} q={q} />
        </div>
      )}
    </>
  );
}
