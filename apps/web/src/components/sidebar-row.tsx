import type { ReactNode } from "react";

export const ROW_CLASS = "flex h-10 w-full items-center overflow-hidden rounded-control";
export const ICON_BOX_CLASS = "flex size-10 shrink-0 items-center justify-center";
// A duration and an easing with no property of their own: they time whichever
// transition-* utility they are written beside.
export const TIMING_CLASS = "duration-(--duration-base) ease-standard";
export const IDLE_TEXT_CLASS = "text-dim hover:text-text";

// Faded and clipped rather than removed: `display: none` would strip the
// accessible name from the row the label belongs to.
export function CollapsingLabel({
  collapsed,
  className,
  children,
}: {
  collapsed: boolean;
  className: string;
  children: ReactNode;
}): ReactNode {
  const fade = collapsed ? "opacity-0" : "opacity-0 sm:opacity-100";

  return (
    <span className={`shrink-0 whitespace-nowrap transition-opacity ${TIMING_CLASS} ${fade} ${className}`}>
      {children}
    </span>
  );
}
