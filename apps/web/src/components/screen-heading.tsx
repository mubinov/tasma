import type { ReactNode, Ref } from "react";

const HEADING_CLASS = "font-chrome text-xl font-semibold tracking-tight";

type ScreenHeadingProps = {
  children: ReactNode;
  ref?: Ref<HTMLHeadingElement>;
  /** Set where something below the heading is labelled by it. */
  id?: string;
  /** Set to -1 where a script moves focus to the heading. */
  tabIndex?: number;
  /** Added to the heading's own classes. */
  className?: string;
};

export function ScreenHeading({ children, ref, id, tabIndex, className }: ScreenHeadingProps): ReactNode {
  return (
    <h1
      ref={ref}
      id={id}
      tabIndex={tabIndex}
      className={className === undefined ? HEADING_CLASS : `${HEADING_CLASS} ${className}`}
    >
      {children}
    </h1>
  );
}
