import type { ReactNode } from "react";

// A control in the first line starts less than one row height below the top of the
// page, so this margin takes a focus scroll to the top of the page. Without it, a
// control partly under the band moves only until its box is clear, and the ring,
// which is outside the box, stays under the band.
const LINE_CLASS = "flex min-h-top-bar flex-wrap items-center gap-x-5 gap-y-2 px-6 py-2.5 sm:px-10 [&_*]:scroll-mt-top-bar";

const WIDE_LINE_CLASS = "sticky left-(--sidebar-width) w-[min(100%,calc(100vw-var(--sidebar-width)))]";

type TopRowProps = {
  children: ReactNode;
  /**
   * For a row inside a box wider than the page panel: the row stays at the left
   * of the page during a sideways scroll. A sticky box cannot leave its parent,
   * so that box is as wide as the content and cancels the padding of `<main>`.
   */
  wide?: boolean;
};

/** The first row of a screen, directly below the band. It scrolls with the page. */
export function TopRow({ children, wide = false }: TopRowProps): ReactNode {
  return (
    // The negative margins cancel the padding of <main>. The containment keeps the
    // one-line width of a wide row from widening its box.
    <div className={`border-b border-line ${wide ? "[contain:inline-size]" : "-mx-6 -mt-6 sm:-mx-10 sm:-mt-10"}`}>
      <div className={wide ? `${LINE_CLASS} ${WIDE_LINE_CLASS}` : LINE_CLASS}>{children}</div>
    </div>
  );
}

type TopRowTitleProps = {
  children: ReactNode;
  /** Set where something below the heading is labelled by it. */
  id?: string;
};

/** The `<h1>` of a screen whose title is in its top row. */
export function TopRowTitle({ children, id }: TopRowTitleProps): ReactNode {
  return <h1 id={id} className="font-chrome text-lg font-semibold">{children}</h1>;
}
