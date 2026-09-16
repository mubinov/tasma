import { Link, useNavigate } from "@tanstack/react-router";
import type { TaskEntry } from "@tasma/protocol";
import type { ReactNode } from "react";
import { opensTask, type StepView } from "../lib/board";
import { ProhibitIcon } from "../lib/icons";
import { LabelList } from "./label-list";
import { StepMark, StepTrack } from "./step-view";

type TaskCardProps = {
  /** The tag of the project the task belongs to. */
  tag: string;
  entry: TaskEntry;
  view: StepView;
  /** The task has the first configured priority. */
  top: boolean;
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

export function TaskCard({ tag, entry, view, top }: TaskCardProps): ReactNode {
  const { id, blocked, frontmatter: { title, priority, labels = [] } } = entry;
  const navigate = useNavigate();

  return (
    // The title link is the keyboard path, so the card itself is no control.
    <div
      onClick={(event) => {
        if (opensTask(event)) {
          void navigate({ to: "/tasks/$project/$task", params: { project: tag, task: id } });
        }
      }}
      className="cursor-pointer rounded-card border border-line bg-surface px-3 pt-2.5 pb-3 hover:border-graphic"
    >
      <div className="flex h-4.25 items-center gap-2">
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
        to="/tasks/$project/$task"
        params={{ project: tag, task: id }}
        className="mt-1 block pr-6 text-sm font-medium wrap-anywhere"
      >
        {title}
      </Link>
      <FlowRow view={view} />
      {labels.length > 0 && <LabelList labels={labels} className="mt-2 text-xs" />}
    </div>
  );
}
