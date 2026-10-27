import { Button } from "@base-ui/react/button";
import { Menu } from "@base-ui/react/menu";
import { useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import type { Task } from "@tasma/protocol";
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
import { taskDeleteOptions, useFailedChatStart, usePendingChatStart } from "../api/mutations";
import { projectQuery, taskChatsQuery, taskQuery, tasksQuery, workflowQuery } from "../api/queries";
import { useRefusalNotice } from "../api/refusal-notice";
import { boardHolds, isFinalStatus, isTopPriority, stepView } from "../lib/board";
import { formatClock } from "../lib/clock";
import { deleteTaskWords } from "../lib/delete-words";
import { useDocumentTitle } from "../lib/document-title";
import type { FinalFocus } from "../lib/final-focus";
import { focusChatHeading, focusInView } from "../lib/focus-in-view";
import {
  ArrowLeftIcon,
  DotsThreeVerticalIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  PlusIcon,
  ProhibitIcon,
  TrashIcon,
  XIcon,
} from "../lib/icons";
import { HIDDEN_TEXT } from "../lib/page-find";
import { actionStep, stepAction, type StepAction } from "../lib/step-action";
import { blockingRows, relationRows, type RelationRow } from "../lib/task-page";
import { useChatAnnouncements } from "../lib/use-chat-announcements";
import { useCommentList } from "../lib/use-comment-list";
import { useHiddenFocus } from "../lib/use-hidden-focus";
import { useScrolledPast } from "../lib/use-scrolled-past";
import { useTaskEditing } from "../lib/use-task-editing";
import { useTaskFind } from "../lib/use-task-find";
import { useTaskProperties } from "../lib/use-task-properties";
import { useTopBarLengths } from "../lib/use-top-bar-lengths";
import { useUnsavedGuard } from "../lib/use-unsaved-guard";
import { warningCount } from "../lib/warning-count";
import { noticeWords, useNotice } from "../store/notices";
import { useFindRequest, useUiStore } from "../store/ui";
import { CommentCard } from "./comment-card";
import { EditingComment } from "./comment-editor";
import { ConfirmDialog } from "./confirm-dialog";
import { FindGroup } from "./find-group";
import { FIND_OPEN_FLOOR, FIND_OPEN_WIDTHS } from "./find-open-classes";
import {
  BUTTON_CLASS,
  BUTTON_FILLED_CLASS,
  BUTTON_QUIET_CLASS,
  ICON_BUTTON_CLASS,
  MENU_ITEM_CLASS,
  POPUP_CLASS,
  POSITIONER_CLASS,
} from "./control-classes";
import { Markdown } from "./markdown";
import { ScreenHeading } from "./screen-heading";
import { ScrollToTop, type PageColumn } from "./scroll-to-top";
import { StepActionButton } from "./step-action-button";
import { StepMark } from "./step-view";
import { ChangedOnDisk } from "./changed-on-disk";
import { ChatPanel } from "./chat-panel";
import { TaskChats } from "./task-chats";
import { TaskEditor } from "./task-editor";
import type { Outline } from "./task-outline";
import { TaskSidebar } from "./task-sidebar";
import { Tooltip } from "./tooltip";

// The route is reached by id rather than imported: the tree in routes.tsx names
// this component, so importing the route back would close a cycle.
const route = getRouteApi("/tasks/$project/$task");

/**
 * The classes that put the right column beside the content. The chat panel is beside the content from xl only: in a
 * narrower window with the app navigation open, the content column is narrower than its top bar.
 */
const COLUMN_LAYOUT: Record<PageColumn, { frame: string; content: string; contentEnd: string }> = {
  sidebar: {
    frame: "lg:flex-row lg:items-start",
    content: "lg:block lg:min-w-0 lg:flex-1",
    contentEnd: "lg:pb-[calc(--spacing(12)+var(--notice-stack-height,0px))]",
  },
  chat: {
    frame: "xl:flex-row xl:items-start",
    content: "xl:block xl:min-w-0 xl:flex-1",
    contentEnd: "xl:pb-[calc(--spacing(12)+var(--notice-stack-height,0px))]",
  },
};

/**
 * Below the `--container-step-floor` width of the bar, while the step action shows, the line padding and the gaps of
 * the controls shrink, so Edit and the task menu stay on a 256 px line beside the icon of the action.
 */
const STEP_ACTION_FLOOR = {
  line: "@max-step-floor:data-step-action-shown:px-2",
  controls: "@max-step-floor:group-data-step-action-shown/top-bar:gap-1",
} as const;

/** The text of the element that is on the screen. */
function visibleText(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll(HIDDEN_TEXT)) {
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

type TaskChat = {
  /** The chat that the panel shows in place of the sidebar. */
  chat: number | undefined;
  /** The chat opened after the page loaded. At a load the shell moves focus to <main>. */
  opened: boolean;
  close: () => void;
};

/**
 * The chat of the `?chat` search. When the chat closes and focus has nowhere
 * to be, focus moves to `headingRef`.
 */
function useTaskChat(headingRef: RefObject<HTMLElement | null>): TaskChat {
  const { project: tag, task: taskId } = route.useParams();
  const { chat } = route.useSearch();
  const navigate = route.useNavigate();
  const [shownChat, setShownChat] = useState(chat);
  const [opened, setOpened] = useState(false);
  const lastChatRef = useRef(chat);

  if (chat !== shownChat) {
    setShownChat(chat);
    setOpened(chat !== undefined);
  }

  useLayoutEffect(() => {
    const last = lastChatRef.current;
    lastChatRef.current = chat;
    const active = document.activeElement;
    if (last !== undefined && chat === undefined && (active === null || active === document.body)) {
      focusInView(headingRef.current);
    }
  }, [chat, headingRef]);

  return {
    chat: chat === undefined ? undefined : Number(chat),
    opened,
    close: () => {
      // Replaced, so Back does not open the closed chat again.
      void navigate({ to: "/tasks/$project/$task", params: { project: tag, task: taskId }, search: {}, replace: true });
    },
  };
}

/**
 * Moves focus after the step action button left the page with it, and returns
 * the callback the button calls then. The panel takes focus only when `?chat`
 * changes, and the find field and the editor take it themselves.
 *
 * `shows` is a dependency only so that the effect clears the flag in the
 * render where the button leaves, also when nothing else changes.
 */
function useStepActionFocus(
  action: StepAction | null,
  shows: boolean,
  chat: number | undefined,
  headingRef: RefObject<HTMLElement | null>,
): () => void {
  const focusLostRef = useRef(false);
  const lastChatRef = useRef(chat);
  const kind = action?.kind ?? null;
  const actionChat = action?.kind === "open" ? action.chat : null;

  useLayoutEffect(() => {
    const chatChanged = lastChatRef.current !== chat;
    lastChatRef.current = chat;
    if (!focusLostRef.current) {
      return;
    }
    focusLostRef.current = false;
    if (kind === null) {
      focusInView(headingRef.current);
    } else if (!chatChanged && actionChat === chat) {
      focusChatHeading();
    }
  }, [shows, kind, actionChat, chat, headingRef]);

  return () => {
    focusLostRef.current = true;
  };
}

type CommentsProps = {
  /** The comments the file holds, which a card detached from the list is not one of. */
  count: number;
  listRef: RefObject<HTMLOListElement | null>;
  headingRef: RefObject<HTMLHeadingElement | null>;
  addButtonRef: RefObject<HTMLButtonElement | null>;
  /** The add form stands in place of the Add comment button. */
  adding: boolean;
  onAdd: () => void;
  /** The cards, in file order. */
  children: ReactNode;
  addForm: ReactNode;
};

/**
 * Always rendered, so Add comment is reachable on a task with no comment. The
 * heading takes the caret, because the focus lists after a delete end on it
 * where every card and the form have gone.
 */
function Comments({
  count,
  listRef,
  headingRef,
  addButtonRef,
  adding,
  onAdd,
  children,
  addForm,
}: CommentsProps): ReactNode {
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="mt-10 max-w-2xl">
      {/* The space separates the words in speech; flex drops it from the layout. */}
      <h2
        ref={headingRef}
        id={headingId}
        tabIndex={-1}
        data-find-scope="comments"
        className="flex items-baseline font-chrome text-lg font-semibold"
      >
        Comments
        {" "}
        <span className="ml-1.5 text-xs-plus font-normal text-dim">{count}</span>
      </h2>
      <ol ref={listRef}>{children}</ol>
      {adding
        ? <div data-add-form="">{addForm}</div>
        : (
            <Button ref={addButtonRef} type="button" onClick={onAdd} className={`mt-3 ${BUTTON_CLASS}`}>
              <PlusIcon size={14} aria-hidden="true" />
              Add comment
            </Button>
          )}
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

type ReadingControlsProps = {
  /** The first control. */
  stepActionButton: ReactNode;
  editButtonRef: Ref<HTMLButtonElement>;
  findButtonRef: Ref<HTMLButtonElement>;
  findOpen: boolean;
  onFind: () => void;
  onEdit: () => void;
  onDelete: () => void;
};

function ReadingControls(
  { stepActionButton, editButtonRef, findButtonRef, findOpen, onFind, onEdit, onDelete }: ReadingControlsProps,
): ReactNode {
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // While find is open, a narrow line hides the menu button; the menu closes with it.
  useLayoutEffect(() => {
    if (!menuOpen || typeof ResizeObserver === "undefined") {
      return;
    }
    const trigger = menuTriggerRef.current!;
    const observer = new ResizeObserver(() => {
      if (!trigger.checkVisibility()) {
        setMenuOpen(false);
      }
    });
    observer.observe(trigger);

    return () => {
      observer.disconnect();
    };
  }, [menuOpen]);

  return (
    <>
      {stepActionButton}
      {/* The name says what a press does, so the button has no expanded state. */}
      <Tooltip content={findOpen ? "Close find" : "Find in task ⌘F"}>
        <Button
          ref={findButtonRef}
          type="button"
          aria-label={findOpen ? "Close find" : "Find in task"}
          aria-keyshortcuts={findOpen ? undefined : "Meta+F"}
          onClick={onFind}
          className={`shrink-0 ${ICON_BUTTON_CLASS}`}
        >
          {findOpen
            ? <XIcon size={16} aria-hidden="true" />
            : <MagnifyingGlassIcon size={16} aria-hidden="true" />}
        </Button>
      </Tooltip>
      <Button ref={editButtonRef} type="button" onClick={onEdit} className={`${BUTTON_CLASS} ${FIND_OPEN_WIDTHS.actions}`}>
        <PencilSimpleIcon size={14} aria-hidden="true" />
        Edit
      </Button>
      <Menu.Root highlightItemOnHover={false} open={menuOpen} onOpenChange={setMenuOpen}>
        <Menu.Trigger
          ref={menuTriggerRef}
          aria-label="Task menu"
          className={`${ICON_BUTTON_CLASS} ${FIND_OPEN_WIDTHS.actions}`}
        >
          <DotsThreeVerticalIcon size={16} aria-hidden="true" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner align="end" sideOffset={4} className={POSITIONER_CLASS}>
            <Menu.Popup className={`min-w-52 ${POPUP_CLASS}`}>
              <Menu.Item onClick={onDelete} className={MENU_ITEM_CLASS}>
                <TrashIcon size={14} aria-hidden="true" />
                Delete task
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </>
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
 * Apart from the page, so a read that changes nothing re-renders this alone. Its
 * reads fetch nothing: the page reads them.
 */
function TaskRefusalNotice({ tag, id }: { tag: string; id: string }): ReactNode {
  const { client } = route.useRouteContext();
  const task = taskQuery(client, tag, id);
  const project = projectQuery(client, tag);
  const listing = tasksQuery(client, tag);
  const taskRead = useQuery({ ...task, enabled: false });
  const projectRead = useQuery({ ...project, enabled: false });
  const listingRead = useQuery({ ...listing, enabled: false });

  useRefusalNotice(`task-refusal:${id}`, [
    { queryKey: task.queryKey, result: taskRead },
    { queryKey: project.queryKey, result: projectRead },
    { queryKey: listing.queryKey, result: listingRead },
  ], {
    title: `${id} is not up to date`,
    line: (refusedAt) => `The daemon refused a read of ${id}. The page shows the task as it was before ${formatClock(refusedAt)}.`,
    upToDate: `${id} is up to date.`,
  });

  return null;
}

export function TaskScreen(): ReactNode {
  const { client, queryClient } = route.useRouteContext();
  const { project: tag, task: taskId } = route.useParams();
  const { data: { data: project } } = useSuspenseQuery(projectQuery(client, tag));
  const { data: { data: task, diagnostics } } = useSuspenseQuery(taskQuery(client, tag, taskId));
  const { data: { data: listing } } = useSuspenseQuery(tasksQuery(client, tag));
  const { data: { data: chats }, isFetching: chatsFetching } = useSuspenseQuery(taskChatsQuery(client, tag, taskId));
  const { frontmatter, body, comments = [] } = task;
  // The heading, the document title and the editor's start text read the disk
  // values; every value a property control writes comes from the overlay below.
  const { id, title, workflow: workflowName } = frontmatter;
  // Not under Suspense: a read can bring a workflow name the loader did not
  // read, and a new key would suspend the page until its read lands.
  const { data: workflowRead } = useQuery({
    ...workflowQuery(client, workflowName ?? ""),
    enabled: workflowName !== undefined,
  });
  const lastBoard = useUiStore((state) => state.lastBoard);
  // "Tasks" opens the last board shown when it holds this project, else this
  // project's board, unfiltered.
  const boardSearch = lastBoard !== null && boardHolds(lastBoard.projects, tag) ? lastBoard : { projects: tag };
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
  const final = isFinalStatus(status, config.final_statuses);
  const view = stepView(live, final, workflow);
  const relations = relationRows(live, listing.entries, config.final_statuses);
  const blocking = blockingRows(relations.blockers);
  const barRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const formId = useId();
  const guard = useUnsavedGuard();
  const editing = useTaskEditing({
    queryClient,
    client,
    tag,
    id,
    disk: { title, body },
    updated: frontmatter.updated,
    lineEndRestored: comments.length > 0,
    guard,
  });
  const list = useCommentList(comments);
  const { draft, diskChange } = editing;
  // The bar's scroll check and the scroll-to-top control read the same row: the
  // heading while the page reads, the title input while it is edited.
  const scrolledRef = draft === null ? headingRef : editing.titleRef;
  const findRootRef = useRef<HTMLDivElement>(null);
  const findButtonRef = useRef<HTMLButtonElement>(null);
  const barLineRef = useRef<HTMLDivElement>(null);
  const { barHeight, scrollPaddingTop } = useTopBarLengths(barRef);
  const find = useTaskFind({
    rootRef: findRootRef,
    buttonRef: findButtonRef,
    comments,
    editing: draft !== null,
  });
  useFindRequest(find.request);
  useHiddenFocus({ active: find.open, lineRef: barLineRef, targetRef: findButtonRef });
  const scrolled = useScrolledPast(scrolledRef, barHeight);
  const outline = useOutline(bodyRef, list.listRef, task, draft !== null);
  const navigate = route.useNavigate();
  // In edit mode the h1 is clipped and takes no focus, so the title field takes it.
  const { chat, opened: chatOpened, close: closeChat } = useTaskChat(scrolledRef);
  // The start write speaks for its own start, so the list holds back the chat it starts.
  const pendingStart = usePendingChatStart(id);
  const failedStart = useFailedChatStart(id);
  useChatAnnouncements({
    chats,
    fetching: chatsFetching,
    stateful: !final,
    openChat: chat,
    quiet: pendingStart !== undefined,
    seen: failedStart,
  });
  const step = actionStep(live, workflow);
  // A pending start keeps the text of its press: the list can hold the new chat before the answer.
  const action: StepAction | null = pendingStart !== undefined
    ? { kind: "start", step: pendingStart.step }
    : step === null ? null : stepAction(step, chats);
  const actionShows = action !== null && draft === null && !find.open && !(action.kind === "open" && action.chat === chat);
  const actionFocusLost = useStepActionFocus(action, actionShows, chat, headingRef);
  const column: PageColumn = chat === undefined ? "sidebar" : "chat";
  const layout = COLUMN_LAYOUT[column];
  const { mutate: sendDelete, isIdle: deleteUnsent } = useMutation(taskDeleteOptions(queryClient, client));
  const [deleteAsked, setDeleteAsked] = useState(false);
  const deleteFocusRef = useRef<FinalFocus>(null);

  /**
   * Closes the dialog, leaves for the board and starts the write, in that
   * order. The route change moves focus, and the comment drafts of the page go
   * with the task, so they ask nothing.
   */
  function confirmDelete(): void {
    deleteFocusRef.current = "keep";
    setDeleteAsked(false);
    void navigate({ to: "/tasks", search: boardSearch, replace: true, ignoreBlocker: true });
    sendDelete({ id });
  }

  useDocumentTitle(`${id} ${title}`);
  useNotice(
    `task-read:${id}`,
    diagnostics.length === 0
      ? null
      : { form: "warning", title: `${warningCount(diagnostics.length)} about ${id}`, words: noticeWords(diagnostics) },
  );

  const idLine = <p className="font-mono text-sm text-dim">{id}</p>;

  const metaLine = (
    <div data-find-scope="header" className="mt-2.5 flex flex-wrap items-center gap-x-3.5 gap-y-2 text-sm text-subtle">
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
    <div className={`-m-6 -mb-[calc(--spacing(6)+var(--notice-stack-height,0px))] flex flex-col sm:-m-10 sm:-mb-[calc(--spacing(10)+var(--notice-stack-height,0px))] ${layout.frame}`}>
      {/* A sticky bar stays only inside its parent box, so while the right column
          is under the content, the content gives up its box and the bar stays
          over the right column too. */}
      <div className={`contents ${layout.content}`}>
        {/*
          The page's scroll padding keeps a focus scroll's target and its ring clear of the bar. WebKit applies it to
          the bar's own controls too, so each focus move and keystroke in them would scroll the page: the page has no
          scroll padding while the bar holds focus. WebKit's scroll anchoring scrolls the page by each change of the
          scroll padding; a change of the root's min-height, which never limits the root's height, suppresses it.
        */}
        <div
          ref={barRef}
          className="@container sticky top-0 z-(--layer-top-bar) border-b border-line bg-bg [html:has(&)]:[--page-scroll-padding:--spacing(16)] [html:has(&:not(:focus-within))]:scroll-pt-(--page-scroll-padding) [html:has(&:focus-within)]:min-h-px"
        >
          <div
            ref={barLineRef}
            data-find-open={find.open ? "" : undefined}
            data-step-action-shown={actionShows ? "" : undefined}
            className={`group/top-bar flex h-top-bar items-center gap-4 px-6 sm:px-10 ${FIND_OPEN_FLOOR.line} ${STEP_ACTION_FLOOR.line}`}
          >
            <Link
              to="/tasks"
              search={boardSearch}
              className={`inline-flex items-center gap-1.5 text-sm text-dim hover:text-text ${FIND_OPEN_WIDTHS.back}`}
            >
              <ArrowLeftIcon size={16} aria-hidden="true" />
              {/* At 320 CSS px the word does not fit beside the bar's controls. */}
              <span className="max-sm:sr-only">Tasks</span>
            </Link>
            {/* It repeats the h1, so a screen reader skips it. */}
            <span
              aria-hidden="true"
              className={`inline-flex min-w-0 items-center gap-3 transition-[opacity,visibility] duration-(--duration-fast) ${scrolled ? "opacity-100" : "invisible opacity-0"} ${FIND_OPEN_WIDTHS.title}`}
            >
              <span className="shrink-0 font-mono text-sm text-dim">{id}</span>
              <span className="truncate font-chrome text-base font-medium">{title}</span>
            </span>
            <div className={`ml-auto flex shrink-0 items-center gap-2 ${FIND_OPEN_WIDTHS.controls} ${FIND_OPEN_FLOOR.controls} ${STEP_ACTION_FLOOR.controls}`}>
              {find.open && <FindGroup find={find} />}
              {draft === null
                ? (
                    <ReadingControls
                      stepActionButton={actionShows && (
                        <StepActionButton tag={tag} id={id} action={action} onFocusLost={actionFocusLost} />
                      )}
                      editButtonRef={editing.editRef}
                      findButtonRef={findButtonRef}
                      findOpen={find.open}
                      onFind={find.toggle}
                      onEdit={editing.openEditor}
                      onDelete={() => {
                        setDeleteAsked(true);
                      }}
                    />
                  )
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
        </div>

        <div ref={findRootRef} className={`px-6 pb-12 sm:px-10 ${layout.contentEnd}`}>
          {draft === null
            ? (
                <>
                  {/* The title comes first in the DOM, so the h1 opens the content and is
                      read before the id shown above it. */}
                  <div data-find-scope="header" className="mt-6 flex flex-col-reverse gap-1">
                    <ScreenHeading ref={headingRef} tabIndex={-1} className="max-w-2xl wrap-anywhere">{title}</ScreenHeading>
                    {idLine}
                  </div>
                  {metaLine}
                  <TaskChats tag={tag} task={taskId} chats={chats} stateful={!final} openChat={chat} />
                  {body.trim() !== "" && (
                    <div ref={bodyRef} data-find-scope="body" className={`${chats.length > 0 ? "mt-10" : "mt-8"} max-w-2xl`}>
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
                      subject={{ kind: "task" }}
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

          <Comments
            count={comments.length}
            listRef={list.listRef}
            headingRef={list.headingRef}
            addButtonRef={list.addButtonRef}
            adding={list.adding}
            onAdd={list.openAddForm}
            addForm={(
              <EditingComment
                options={{
                  queryClient,
                  client,
                  tag,
                  taskId: id,
                  subject: { kind: "new" },
                  disk: null,
                  // The form shows no disk line, having no comment to compare with.
                  updated: frontmatter.updated,
                  // A new comment is appended last, so no line end is written back.
                  lineEndRestored: false,
                  guard,
                  onClose: list.closeAddForm,
                }}
                heading="New comment"
              />
            )}
          >
            {list.rows.map(({ comment, onDisk, editing: open, lineEndRestored }, place) => (
              <CommentCard
                key={comment.id}
                comment={comment}
                queryClient={queryClient}
                client={client}
                tag={tag}
                taskId={id}
                taskUpdated={frontmatter.updated}
                lineEndRestored={lineEndRestored}
                editing={open}
                removed={!onDisk}
                guard={guard}
                onEdit={() => {
                  list.openEditor(place);
                }}
                onCloseEditor={(close) => {
                  list.closeEditor(place, close);
                }}
                onDeleted={() => {
                  list.deleted(place);
                }}
                findActive={find.findActive}
                revealRequest={find.reveal?.commentId === comment.id ? find.reveal.count : undefined}
              />
            ))}
          </Comments>
        </div>
        <ScrollToTop scrolled={scrolled} headingRef={scrolledRef} column={column} />
      </div>
      {chat === undefined
        ? (
            <TaskSidebar
              tag={tag}
              view={view}
              relations={relations}
              outline={outline}
              pageScrollPadding={scrollPaddingTop}
              properties={properties}
            />
          )
        : (
            // Under xl the top bar sticks over the panel too, so the panel is shorter than the window by the bar.
            <div className="h-[calc(100vh-var(--spacing-top-bar))] w-full border-t border-line bg-bg pb-(--notice-stack-height) xl:sticky xl:top-0 xl:h-screen xl:w-chat-panel xl:shrink-0 xl:self-start xl:border-t-0 xl:border-l">
              <ChatPanel tag={tag} task={taskId} chat={chat} onClose={closeChat} focusOnMount={chatOpened} />
            </div>
          )}
      {/* Cancel asks about one editor, so it keeps the editor's own dialog. */}
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
      {/* Leaving the page asks about every editor at once, so it is one dialog. */}
      <ConfirmDialog
        open={guard.asked}
        title="Discard your changes?"
        description={guard.description}
        cancelLabel="Keep editing"
        confirmLabel="Discard"
        onCancel={guard.keepEditing}
        onConfirm={guard.discard}
        finalFocus={guard.finalFocusRef}
        status={guard.status}
      />
      <ConfirmDialog
        open={deleteAsked}
        {...deleteTaskWords(id, title)}
        confirmLabel="Delete"
        onCancel={() => {
          // Base UI returns focus to the menu button the dialog opened from.
          deleteFocusRef.current = null;
          setDeleteAsked(false);
        }}
        onConfirm={confirmDelete}
        finalFocus={deleteFocusRef}
      />
      {/* A sent delete leaves the page, which stays until the board commits: the task read can refuse until then. */}
      {deleteUnsent && <TaskRefusalNotice tag={tag} id={taskId} />}
    </div>
  );
}
