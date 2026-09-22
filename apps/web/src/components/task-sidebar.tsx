import { Link } from "@tanstack/react-router";
import { useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { StepView } from "../lib/board";
import { ProhibitIcon } from "../lib/icons";
import { customLines, formatStamp, type RelationRow, type Relations } from "../lib/task-page";
import type { TaskProperties } from "../lib/use-task-properties";
import { PENCIL_BUTTON_CLASS } from "./control-classes";
import { LabelPicker } from "./label-picker";
import { PropertyMenu } from "./property-menu";
import { StepMark, StepTrack } from "./step-view";
import { TaskOutline, type Outline } from "./task-outline";
import { TaskPicker } from "./task-picker";

const GROUP_CLASS = "grid grid-cols-[5.25rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-sm";

const NEXT_GROUP_CLASS = `${GROUP_CLASS} mt-4 border-t border-line pt-4`;

const ROW_CLASS = "flex items-start gap-x-2";

const TEXT_CLASS = "min-w-0 flex-1";

const ID_CLASS = "font-mono text-xs-plus leading-5";

/** A relation row: the pencil keeps its place at the top right, whatever the list holds. */
const RELATION_DD_CLASS = "group flex items-start gap-2";

/*
 * First in the DOM and last on screen, so Tab reaches it before the links of a
 * long list. Base UI marks the trigger itself while its popup is open, and the
 * popup renders through a portal, where focus leaves the row.
 */
const REVEALED_PENCIL_CLASS = `${PENCIL_BUTTON_CLASS} order-last opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-[popup-open]:opacity-100`;

const STATE_CLASS: Record<RelationRow["state"], { row: string; status?: string }> = {
  blocking: { row: "text-text", status: "text-signal" },
  resolved: { row: "text-dim" },
  neutral: { row: "text-text", status: "text-muted" },
};

type TaskSidebarProps = {
  /** The tag of the project the task belongs to. */
  tag: string;
  view: StepView;
  relations: Relations;
  outline: Outline;
  /** The page's top scroll padding in px, undefined before it is measured. */
  pageScrollPadding: number | undefined;
  /**
   * Every value of the rows, with the pending writes laid over them, and what
   * each editable row offers. One door to the values, so a trigger and the item
   * its menu checks cannot disagree.
   */
  properties: TaskProperties;
};

function None(): ReactNode {
  return <span className="text-dim">None</span>;
}

type FieldProps = {
  label: string;
  labelId?: string;
  wide?: boolean;
  /** Added to the value's own classes. */
  ddClass?: string;
  children: ReactNode;
};

function Field({ label, labelId, wide = false, ddClass = "", children }: FieldProps): ReactNode {
  const spanClass = wide ? "col-span-full" : "";

  return (
    <>
      <dt id={labelId} className={`${spanClass} text-dim`}>{label}</dt>
      <dd className={`${spanClass} min-w-0 wrap-anywhere ${ddClass}`}>{children}</dd>
    </>
  );
}

function Stamp({ value }: { value: string }): ReactNode {
  return <time dateTime={value} className="font-mono text-xs-plus">{formatStamp(value)}</time>;
}

/** The step value alone. The track stands beside it, outside the control that wraps this. */
function StepValue({ view, step }: { view: StepView; step: string | undefined }): ReactNode {
  if (view.kind === "step") {
    return (
      <span className="flex items-center gap-2">
        <StepMark view={view} />
      </span>
    );
  }

  // A stale view names the step the row already holds, and a `none` view over a
  // stored step names nothing, so the row's own value covers both.
  return step === undefined ? <None /> : <span className="font-mono text-xs text-dim">{step}</span>;
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
  const { tag, view, relations, outline, pageScrollPadding, properties } = props;
  const { id, status, priority, labels = [], workflow, step, created, updated, custom } = properties.frontmatter;
  const { blocked_by: blockedBy = [], parent } = properties.frontmatter;
  const lines = custom === undefined ? [] : customLines(custom);
  const asideRef = useRef<HTMLElement>(null);
  const scrolls = useOverflows(asideRef);
  const statusId = useId();
  const priorityId = useId();
  const labelsId = useId();
  const stepId = useId();
  const blockedById = useId();
  const parentId = useId();

  // A control that leaves while it holds focus drops it to <body>, and the
  // aside is focusable whether or not it scrolls.
  function focusAside(): void {
    asideRef.current?.focus();
  }

  const stepValue = <StepValue view={view} step={step} />;

  return (
    // A scroll container with no link inside is a tab stop only in some engines, so the aside is one while it
    // scrolls. -1 keeps the focus on it when it stops scrolling. The aside meets the window's edges, so its focus
    // ring is drawn inside.
    <aside
      ref={asideRef}
      tabIndex={scrolls ? 0 : -1}
      aria-label="Task details"
      className="w-full border-t border-line bg-surface-2 px-6 pt-5 pb-[calc(--spacing(8)+var(--notice-stack-height,0px))] focus-visible:-outline-offset-2 lg:sticky lg:top-0 lg:h-screen lg:w-task-sidebar lg:shrink-0 lg:self-start lg:scroll-pb-(--notice-stack-height) lg:overflow-y-auto lg:border-t-0 lg:border-l"
    >
      <dl className={GROUP_CLASS}>
        <Field label="Status" labelId={statusId}>
          <PropertyMenu
            labelId={statusId}
            value={status}
            row={properties.status}
            clearable={false}
            trigger={status}
            onFocusLost={focusAside}
          />
        </Field>
        <Field label="Priority" labelId={priorityId}>
          <PropertyMenu
            labelId={priorityId}
            value={priority}
            row={properties.priority}
            clearable
            trigger={priority ?? <None />}
            onFocusLost={focusAside}
          />
        </Field>
        <Field label="Labels" labelId={labelsId}>
          <LabelPicker labelId={labelsId} entries={properties.entries} labels={labels} row={properties.labels} />
        </Field>
      </dl>
      <dl className={NEXT_GROUP_CLASS}>
        <Field label="Workflow">{workflow ?? <None />}</Field>
        <Field label="Step" labelId={stepId}>
          {properties.step === null
            ? stepValue
            : (
                <div className="flex flex-col items-start">
                  <PropertyMenu
                    labelId={stepId}
                    value={step}
                    row={properties.step}
                    clearable
                    trigger={stepValue}
                    onFocusLost={focusAside}
                  />
                  {view.kind === "step" && (
                    <StepTrack owners={view.owners} current={view.current} className="mt-1.5" />
                  )}
                </div>
              )}
        </Field>
      </dl>
      <dl className={NEXT_GROUP_CLASS}>
        <Field label="Blocked by" labelId={blockedById} wide ddClass={RELATION_DD_CLASS}>
          <TaskPicker
            multiple
            labelId={blockedById}
            className={REVEALED_PENCIL_CLASS}
            entries={properties.entries}
            id={id}
            value={blockedBy}
            row={properties.blockedBy}
          />
          <div className="min-w-0 flex-1">
            <RelationList tag={tag} rows={relations.blockers} />
          </div>
        </Field>
        <Field label="Parent" labelId={parentId} wide ddClass={RELATION_DD_CLASS}>
          <TaskPicker
            multiple={false}
            labelId={parentId}
            className={REVEALED_PENCIL_CLASS}
            entries={properties.entries}
            id={id}
            value={parent}
            row={properties.parent}
          />
          <div className="min-w-0 flex-1">
            <RelationList tag={tag} rows={relations.parent === null ? [] : [relations.parent]} />
          </div>
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
