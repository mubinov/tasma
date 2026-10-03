import { Link, useNavigate } from "@tanstack/react-router";
import type { TaskEntry } from "@tasma/protocol";
import { useEffect, useEffectEvent, useId, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { opensHere, opensTask, type StepView } from "../lib/board";
import { DRAG_ATTRIBUTE } from "../lib/drag-place";
import { useFocusLost } from "../lib/use-focus-lost";
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
  onDelete: (id: string) => void;
  /** The part that takes focus once the card has rendered, after which `onFocused` is called. */
  focusPart: CardPart | null;
  onFocused: () => void;
  /** Every press on the card, whether or not it becomes a drag. */
  onPress: (event: PointerEvent<HTMLElement>) => void;
  /** Called when the card leaves the page while focus is inside it or in one of its open menus. */
  onFocusLost: () => void;
};

/** A part of the card the board can hand focus to: the menu button after a move, the title link after a create. */
export type CardPart = "menu" | "title";

/** The card that takes focus once it renders, and the part of it that does. */
export type CardFocus = { id: string; part: CardPart };

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
  onDelete,
  focusPart,
  onFocused,
  onPress,
  onFocusLost,
}: TaskCardProps): ReactNode {
  const { id, frontmatter: { title, status } } = entry;
  const navigate = useNavigate();
  const cardRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLAnchorElement>(null);
  const titleId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);

  useFocusLost(cardRef, onFocusLost, menuOpen || contextMenuOpen);

  const takeFocus = useEffectEvent((part: CardPart) => {
    cardRef.current?.scrollIntoView({ block: "nearest" });
    (part === "menu" ? menuButtonRef : titleRef).current?.focus();
    onFocused();
  });

  useEffect(() => {
    if (focusPart !== null) {
      takeFocus(focusPart);
    }
  }, [focusPart]);

  const menu = { tag, id, status, statuses, onMove, onMoveUp, onMoveDown, onOpen, onDelete };

  return (
    // The title link is the keyboard path, so the card itself is no control.
    <CardContextMenu
      ref={cardRef}
      menu={menu}
      onOpenChange={setContextMenuOpen}
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
            ref={titleRef}
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
        menu={<CardMenu buttonRef={menuButtonRef} titleId={titleId} onOpenChange={setMenuOpen} {...menu} />}
      />
    </CardContextMenu>
  );
}
