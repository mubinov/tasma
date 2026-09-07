import type { Diagnostic } from "@tasma/protocol";
import { useId, type ReactNode } from "react";
import { SectionHeading } from "./section-heading";
import { Tag } from "./tag";

type DiagnosticsProps = {
  items: readonly Diagnostic[];
};

/**
 * What one call corrected, passed over or read as questionable.
 *
 * It switches on no code: a finding is its code, its message and where it was
 * found, so a code added to the union later renders like every other one. The
 * codes it carries run from a repair already applied to a path that is gone, so
 * no chip claims `signal`, which this application reserves for what needs a
 * human.
 */
export function Diagnostics({ items }: DiagnosticsProps): ReactNode {
  const labelId = useId();

  if (items.length === 0) {
    return null;
  }

  return (
    <>
      <SectionHeading id={labelId}>Diagnostics</SectionHeading>
      <ul
        aria-labelledby={labelId}
        className="mt-2 w-full max-w-2xl divide-y divide-line rounded-card border border-line bg-surface"
      >
        {items.map(({ code, message, path, line }, index) => (
          // A report is rendered as the call answered it and is never reordered
          // in place, and two findings can be identical, so the position is the
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
      </ul>
    </>
  );
}
