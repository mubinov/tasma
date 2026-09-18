import { Link, useNavigate } from "@tanstack/react-router";
import type { TaskEntry } from "@tasma/protocol";
import { useEffect, useEffectEvent, useId, useRef, type ReactNode } from "react";
import { opensHere, opensTask, type StepView } from "../lib/board";
import { ProhibitIcon } from "../lib/icons";
import { CardContextMenu, CardMenu } from "./card-menu";
import { LabelList } from "./label-list";
import { StepMark, StepTrack } from "./step-view";

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
  onMove: (status: string) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  /** Called before the card opens its task in this tab. */
  onOpen: () => void;
  /** The menu button takes focus once the card has rendered, and `onMenuFocused` is called. */
  focusMenu: boolean;
  onMenuFocused: () => void;
};

function FlowRow({ view }: { view: StepView }): ReactNode {
  if (view.kind === "none") {
    return null;
  }

  return (
    <div className="mt-2.5 flex items-center gap-2">
      <StepMark view={view} />
      {view.kind === "step" && <StepTrack owners={view.owners} current={view.current} className="ml-auto" />}
    </div>
  );
}

export function TaskCard({
  tag,
  entry,
  view,
  top,
  statuses,
  pending,
  onMove,
  onMoveUp,
  onMoveDown,
  onOpen,
  focusMenu,
  onMenuFocused,
}: TaskCardProps): ReactNode {
  const { id, blocked, frontmatter: { title, status, priority, labels = [] } } = entry;
  const navigate = useNavigate();
  const cardRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const menu = { tag, id, status, statuses, onMove, onMoveUp, onMoveDown, onOpen };

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

  return (
    // The title link is the keyboard path, so the card itself is no control.
    <CardContextMenu
      ref={cardRef}
      menu={menu}
      data-task-id={id}
      aria-busy={pending || undefined}
      onClick={(event) => {
        if (opensTask(event)) {
          onOpen();
          void navigate({ to: "/tasks/$project/$task", params: { project: tag, task: id } });
        }
      }}
      className={`group/card relative cursor-pointer rounded-card border border-line bg-surface px-3 pt-2.5 pb-3 ${
        pending ? "opacity-55" : "hover:border-graphic"
      }`}
    >
      {/* The menu button sits over the right padding. */}
      <div className="flex h-4.25 items-center gap-2 pr-6">
        <span className="font-mono text-xs text-dim">{id}</span>
        {blocked && (
          <span className="inline-flex items-center gap-1 text-xs text-dim">
            <ProhibitIcon size={12} aria-hidden="true" />
            blocked
          </span>
        )}
        {priority !== undefined && (
          <span className={`ml-auto text-xs ${top ? "font-medium text-text" : "text-muted"}`}>{priority}</span>
        )}
      </div>
      <Link
        id={titleId}
        to="/tasks/$project/$task"
        params={{ project: tag, task: id }}
        // The board returns focus here, and a link added above must not take it.
        data-task-title=""
        onClick={(event) => {
          if (opensHere(event)) {
            onOpen();
          }
        }}
        className="mt-1 block text-sm font-medium wrap-anywhere"
      >
        {title}
      </Link>
      {/* After the title link, so the menu button follows it in the tab order. */}
      <CardMenu buttonRef={menuButtonRef} titleId={titleId} {...menu} />
      <FlowRow view={view} />
      {labels.length > 0 && <LabelList labels={labels} className="mt-2 text-xs" />}
    </CardContextMenu>
  );
}
