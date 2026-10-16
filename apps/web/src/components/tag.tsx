import type { ReactNode } from "react";

/**
 * The chip a machine token is shown in: a project tag, a diagnostic code. The
 * token is one unbroken word and a code runs to 28 characters, so it breaks
 * where it has to and the chip grows down with it. Inline in a line of
 * `text-sm` text, `align-top` centers the chip on that line, because the chip
 * height equals the line height. A flex item ignores it.
 */
export function Tag({ children }: { children: ReactNode }): ReactNode {
  return (
    <span className="inline-flex min-h-5 items-center rounded-control align-top border border-line bg-surface-2 px-1.5 font-mono text-xs wrap-anywhere text-subtle">
      {children}
    </span>
  );
}
