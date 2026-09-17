import { Link } from "@tanstack/react-router";
import type { Frontmatter } from "@tasma/protocol";
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { StepView } from "../lib/board";
import { ProhibitIcon } from "../lib/icons";
import { customLines, formatStamp, type RelationRow, type Relations } from "../lib/task-page";
import { LabelList } from "./label-list";
import { StepMark, StepTrack } from "./step-view";
import { TaskOutline, type Outline } from "./task-outline";

const GROUP_CLASS = "grid grid-cols-[5.25rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-sm";

const NEXT_GROUP_CLASS = `${GROUP_CLASS} mt-4 border-t border-line pt-4`;

const ROW_CLASS = "flex items-start gap-x-2";

const TEXT_CLASS = "min-w-0 flex-1";

const ID_CLASS = "font-mono text-xs-plus leading-5";

const STATE_CLASS: Record<RelationRow["state"], { row: string; status?: string }> = {
  blocking: { row: "text-text", status: "text-signal" },
  resolved: { row: "text-dim" },
  neutral: { row: "text-text", status: "text-muted" },
};

type TaskSidebarProps = {
  /** The tag of the project the task belongs to. */
  tag: string;
  frontmatter: Frontmatter;
  view: StepView;
  relations: Relations;
  outline: Outline;
  /** The page's top scroll padding in px, undefined before it is measured. */
  pageScrollPadding: number | undefined;
};

function None(): ReactNode {
  return <span className="text-dim">None</span>;
}

function Field({ label, wide = false, children }: { label: string; wide?: boolean; children: ReactNode }): ReactNode {
  const spanClass = wide ? "col-span-full" : "";

  return (
    <>
      <dt className={`${spanClass} text-dim`}>{label}</dt>
      <dd className={`${spanClass} min-w-0 wrap-anywhere`}>{children}</dd>
    </>
  );
}

function Stamp({ value }: { value: string }): ReactNode {
  return <time dateTime={value} className="font-mono text-xs-plus">{formatStamp(value)}</time>;
}

function Step({ view, step }: { view: StepView; step: string | undefined }): ReactNode {
  if (view.kind === "step") {
    return (
      <div className="flex flex-col items-start">
        <span className="flex items-center gap-2">
          <StepMark view={view} />
        </span>
        <StepTrack owners={view.owners} current={view.current} className="mt-1.5" />
      </div>
    );
  }
  if (step === undefined) {
    return <None />;
  }

  return <span className="font-mono text-xs text-dim">{step}</span>;
}

function Relation({ tag, row }: { tag: string; row: RelationRow }): ReactNode {
  const { id, state, status, title } = row;
  const tone = STATE_CLASS[state];
  const mark = (
    <span className="flex h-5 w-3.5 shrink-0 items-center">
      {state === "blocking" && <ProhibitIcon size={14} aria-hidden="true" className="text-signal" />}
    </span>
  );
  const statusText = <span className={tone.status}>{`[${status ?? "Not found"}]`}</span>;

  if (status === undefined) {
    return (
      <div className={`${ROW_CLASS} ${tone.row}`}>
        {mark}
        <span className={TEXT_CLASS}>
          {statusText}
          {" "}
          <span className={ID_CLASS}>{id}</span>
        </span>
      </div>
    );
  }

  return (
    <Link to="/tasks/$project/$task" params={{ project: tag, task: id }} className={`${ROW_CLASS} ${tone.row}`}>
      {mark}
      <span className={TEXT_CLASS}>
        {statusText}
        {" "}
        <span className={`${ID_CLASS} underline underline-offset-2`}>{id}</span>
        {" "}
        <span className="block">{title}</span>
      </span>
    </Link>
  );
}

function RelationList({ tag, rows }: { tag: string; rows: readonly RelationRow[] }): ReactNode {
  if (rows.length === 0) {
    return <None />;
  }

  return (
    <ul className="space-y-2">
      {rows.map((row, index) => (
        // A hand-edited task file can hold the same id twice.
        // eslint-disable-next-line @eslint-react/no-array-index-key
        <li key={index}>
          <Relation tag={tag} row={row} />
        </li>
      ))}
    </ul>
  );
}

/** The element's content is taller than its box. */
function useOverflows(ref: RefObject<HTMLElement | null>): boolean {
  const [overflows, setOverflows] = useState(false);

  // The box resizes with the window and the children with their content, so both are observed.
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      setOverflows(element.scrollHeight > element.clientHeight);
    });
    observer.observe(element);
    for (const child of element.children) {
      observer.observe(child);
    }

    return () => {
      observer.disconnect();
    };
  }, [ref]);

  return overflows;
}

export function TaskSidebar(props: TaskSidebarProps): ReactNode {
  const { tag, frontmatter, view, relations, outline, pageScrollPadding } = props;
  const { status, priority, labels = [], workflow, step, created, updated, custom } = frontmatter;
  const lines = custom === undefined ? [] : customLines(custom);
  const asideRef = useRef<HTMLElement>(null);
  const scrolls = useOverflows(asideRef);

  return (
    // A scroll container with no link inside is a tab stop only in some engines, so the aside is one while it
    // scrolls. -1 keeps the focus on it when it stops scrolling. The aside meets the window's edges, so its focus
    // ring is drawn inside.
    <aside
      ref={asideRef}
      tabIndex={scrolls ? 0 : -1}
      aria-label="Task details"
      className="w-full border-t border-line bg-surface-2 px-6 pt-5 pb-[calc(--spacing(8)+var(--notice-stack-height,0px))] focus-visible:-outline-offset-3 lg:sticky lg:top-0 lg:h-screen lg:w-task-sidebar lg:shrink-0 lg:self-start lg:scroll-pb-(--notice-stack-height) lg:overflow-y-auto lg:border-t-0 lg:border-l"
    >
      <dl className={GROUP_CLASS}>
        <Field label="Status">{status}</Field>
        <Field label="Priority">{priority ?? <None />}</Field>
        <Field label="Labels">{labels.length === 0 ? <None /> : <LabelList labels={labels} />}</Field>
      </dl>
      <dl className={NEXT_GROUP_CLASS}>
        <Field label="Workflow">{workflow ?? <None />}</Field>
        <Field label="Step">
          <Step view={view} step={step} />
        </Field>
      </dl>
      <dl className={NEXT_GROUP_CLASS}>
        <Field label="Blocked by" wide>
          <RelationList tag={tag} rows={relations.blockers} />
        </Field>
        <Field label="Parent" wide>
          <RelationList tag={tag} rows={relations.parent === null ? [] : [relations.parent]} />
        </Field>
      </dl>
      <dl className={NEXT_GROUP_CLASS}>
        <Field label="Created">
          <Stamp value={created} />
        </Field>
        <Field label="Updated">
          <Stamp value={updated} />
        </Field>
        {lines.length > 0 && (
          <Field label="Custom">
            {lines.map((line) => <div key={line} className="font-mono text-xs-plus">{line}</div>)}
          </Field>
        )}
      </dl>
      {/* Present with no outline too: the overflow observer watches the children the aside has when it mounts. */}
      <div>
        <TaskOutline
          headings={outline.headings}
          comments={outline.comments}
          sidebarRef={asideRef}
          pageScrollPadding={pageScrollPadding}
        />
      </div>
    </aside>
  );
}
