import { Link, useNavigate } from "@tanstack/react-router";
import type { TaskEntry } from "@tasma/protocol";
import { useEffect, useEffectEvent, useId, useRef, type PointerEvent, type ReactNode } from "react";
import { opensHere, opensTask, type StepView } from "../lib/board";
import { DRAG_ATTRIBUTE } from "../lib/drag-place";
import { CardContextMenu, CardMenu } from "./card-menu";
import { CARD_CLASS, CARD_TITLE_CLASS, CardFace } from "./card-face";

type TaskCardProps = {
  /** The tag of the project the task belongs to. */
  tag: string;
  entry: TaskEntry;
  view: StepView;
  /** The task has the first configured priority. */
  top: boolean;
  /** The project's statuses, in order. */
  statuses: readonly string[];
  /** A write the daemon has not answered yet changes the task. */
  pending: boolean;
  /** A drag carries the card, and this one stays at the origin. */
  dragging: boolean;
  onMove: (status: string) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  /** Called before the card opens its task in this tab. */
  onOpen: () => void;
  /** The menu button takes focus once the card has rendered, and `onMenuFocused` is called. */
  focusMenu: boolean;
  onMenuFocused: () => void;
  /** Every press on the card, whether or not it becomes a drag. */
  onPress: (event: PointerEvent<HTMLElement>) => void;
};

/** What the card's state adds to its border and its opacity. */
function stateClass({ dragging, pending }: { dragging: boolean; pending: boolean }): string {
  if (dragging) {
    // A deliberate failure of SC 1.4.3: the fade composites the card's text
    // below 4.5:1. Every word on it is drawn at full contrast on the card the
    // pointer carries.
    return "opacity-35";
  }

  return pending ? "opacity-55" : "hover:border-graphic";
}

export function TaskCard({
  tag,
  entry,
  view,
  top,
  statuses,
  pending,
  dragging,
  onMove,
  onMoveUp,
  onMoveDown,
  onOpen,
  focusMenu,
  onMenuFocused,
  onPress,
}: TaskCardProps): ReactNode {
  const { id, frontmatter: { title, status } } = entry;
  const navigate = useNavigate();
  const cardRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  const takeFocus = useEffectEvent(() => {
    cardRef.current?.scrollIntoView({ block: "nearest" });
    menuButtonRef.current?.focus();
    onMenuFocused();
  });

  useEffect(() => {
    if (focusMenu) {
      takeFocus();
    }
  }, [focusMenu]);

  const menu = { tag, id, status, statuses, onMove, onMoveUp, onMoveDown, onOpen };

  return (
    // The title link is the keyboard path, so the card itself is no control.
    <CardContextMenu
      ref={cardRef}
      menu={menu}
      {...{ [DRAG_ATTRIBUTE.card]: id }}
      aria-busy={pending || undefined}
      onPointerDown={onPress}
      onClick={(event) => {
        if (opensTask(event)) {
          onOpen();
          void navigate({ to: "/tasks/$project/$task", params: { project: tag, task: id } });
        }
      }}
      className={`${CARD_CLASS} ${stateClass({ dragging, pending })}`}
    >
      <CardFace
        entry={entry}
        view={view}
        top={top}
        title={(
          // A link is draggable of itself, and that native drag would run
          // against the card's own.
          <Link
            id={titleId}
            to="/tasks/$project/$task"
            params={{ project: tag, task: id }}
            draggable={false}
            // The board returns focus here, and a link added above must not take it.
            data-task-title=""
            onClick={(event) => {
              if (opensHere(event)) {
                onOpen();
              }
            }}
            className={CARD_TITLE_CLASS}
          >
            {title}
          </Link>
        )}
        menu={<CardMenu buttonRef={menuButtonRef} titleId={titleId} {...menu} />}
      />
    </CardContextMenu>
  );
}
