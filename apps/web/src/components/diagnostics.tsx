import { Collapsible } from "@base-ui/react/collapsible";
import type { Diagnostic, ExcludedFile } from "@tasma/protocol";
import { useId, useRef, useState, type ReactNode } from "react";
import { WarningIcon } from "../lib/icons";
import { useFocusLost } from "../lib/use-focus-lost";
import { warningCount } from "../lib/warning-count";
import { Tag } from "./tag";

type DiagnosticsProps = {
  items: readonly Diagnostic[];
  /** Rendered before `items`. */
  excluded?: readonly ExcludedFile[];
  subject: "this project" | "the projects";
  className?: string;
};

/**
 * The warnings of one answer: a line with their count, folded by default, that
 * unfolds into the list.
 *
 * It switches on no code: a warning is its code, its message and where it was
 * found, so a code added to the union later renders like every other one.
 *
 * The folded state lives in `WarningsLine`, which unmounts when the count goes
 * to zero, so warnings that come back show folded.
 */
export function Diagnostics(props: DiagnosticsProps): ReactNode {
  if (props.items.length === 0 && (props.excluded ?? []).length === 0) {
    return null;
  }

  return <WarningsLine {...props} />;
}

function WarningsLine({ items, excluded = [], subject, className }: DiagnosticsProps): ReactNode {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const countId = useId();
  const subjectId = useId();
  const actionId = useId();
  const count = excluded.length + items.length;

  // A refetch that clears the warnings removes the line, Show or Hide included.
  useFocusLost(rootRef, (root) => {
    root.closest("main")?.focus();
  });

  return (
    <Collapsible.Root ref={rootRef} open={open} onOpenChange={setOpen} className={className ?? ""}>
      {/* The button stays out of the heading: its label repeats the count, which
          would then be said twice in the heading's name. */}
      <div className="flex items-center gap-2 text-sm">
        {/* The space separates the words in speech; flex drops it from the layout. */}
        <h2 className="flex items-center gap-2">
          <WarningIcon size={16} aria-hidden="true" className="shrink-0 text-signal" />
          <span id={countId} className="font-medium text-signal">
            {warningCount(count)}
          </span>
          {" "}
          <span id={subjectId} className="text-muted">
            {`about ${subject}`}
          </span>
        </h2>
        <Collapsible.Trigger
          aria-labelledby={`${actionId} ${countId} ${subjectId}`}
          className="ml-1 text-muted underline underline-offset-2 hover:text-text"
        >
          <span id={actionId}>{open ? "Hide" : "Show"}</span>
        </Collapsible.Trigger>
      </div>
      <Collapsible.Panel
        render={<ul />}
        aria-labelledby={`${countId} ${subjectId}`}
        className="mt-2 w-full max-w-2xl divide-y divide-line rounded-card border border-line bg-surface"
      >
        {excluded.map(({ path, code, message }) => (
          <li key={path} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Tag>{code}</Tag>
              <span className="text-base">{`The file was not read: ${message}`}</span>
            </div>
            <span className="mt-0.5 block font-mono text-xs text-dim wrap-anywhere">{path}</span>
          </li>
        ))}
        {items.map(({ code, message, path, line }, index) => (
          // A report is rendered as the call answered it and is never reordered
          // in place, and two warnings can be identical, so the position is the
          // only stable identity a row has.
          // eslint-disable-next-line @eslint-react/no-array-index-key
          <li key={index} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Tag>{code}</Tag>
              <span className="text-base">{message}</span>
            </div>
            {path !== undefined && (
              <span className="mt-0.5 block font-mono text-xs text-dim wrap-anywhere">
                {line === undefined ? path : `${path}:${String(line)}`}
              </span>
            )}
          </li>
        ))}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
