import type { ReactNode } from "react";

const HEADING_CLASS = "font-chrome text-xl font-semibold tracking-tight";

type ScreenHeadingProps = {
  children: ReactNode;
  /** Set where something below the heading is labelled by it. */
  id?: string;
  /** Added to the heading's own classes. */
  className?: string;
};

export function ScreenHeading({ children, id, className }: ScreenHeadingProps): ReactNode {
  return (
    <h1 id={id} className={className === undefined ? HEADING_CLASS : `${HEADING_CLASS} ${className}`}>
      {children}
    </h1>
  );
}
