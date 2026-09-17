import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { scrollBehavior } from "../lib/scroll-behavior";
import { scrollPadding } from "../lib/scroll-padding";
import { useCurrentTarget } from "../lib/use-current-target";

export type OutlineEntry = {
  label: string;
  /** Where the line scrolls to and moves focus. */
  target: HTMLElement;
  /** The element whose top counts as the top of the target. */
  sentinel: Element;
};

export type Outline = {
  headings: readonly OutlineEntry[];
  comments: readonly OutlineEntry[];
};

type TaskOutlineProps = Outline & {
  /** The sidebar that holds the outline and scrolls on its own. */
  sidebarRef: RefObject<HTMLElement | null>;
  /** The page's top scroll padding in px, undefined before it is measured. */
  pageScrollPadding: number | undefined;
};

const LINE_CLASS = "block w-full truncate border-l-2 py-0.5 pl-2.5 text-left text-xs-plus hover:text-text";

const LIST_CLASS = "mt-1.5 space-y-0.5";

function activate(target: HTMLElement): void {
  target.tabIndex = -1;
  target.scrollIntoView({ block: "start", behavior: scrollBehavior() });
  target.focus({ preventScroll: true });
}

type LinesProps = {
  entries: readonly OutlineEntry[];
  /** The index of the first entry among all the outline's entries. */
  first: number;
  current: number;
};

function Lines({ entries, first, current }: LinesProps): ReactNode {
  return (
    <ul className={LIST_CLASS}>
      {entries.map(({ label, target }, index) => {
        const isCurrent = first + index === current;

        return (
          // Two headings or two comments can have the same title.
          // eslint-disable-next-line @eslint-react/no-array-index-key
          <li key={index}>
            {/* A button, not a `#` link: the hash holds the route. */}
            <button
              type="button"
              aria-current={isCurrent ? "location" : undefined}
              onClick={() => {
                activate(target);
              }}
              className={`${LINE_CLASS} ${isCurrent ? "border-graphic font-medium text-text" : "border-transparent text-muted"}`}
            >
              {label}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function TaskOutline({ headings, comments, sidebarRef, pageScrollPadding }: TaskOutlineProps): ReactNode {
  const labelId = useId();
  const navRef = useRef<HTMLElement>(null);
  const current = useCurrentTarget([...headings, ...comments].map(({ sentinel }) => sentinel), pageScrollPadding);

  // The sidebar scrolls by itself only: a scrollIntoView would also scroll the window.
  useEffect(() => {
    const sidebar = sidebarRef.current;
    const line = navRef.current?.querySelector("[aria-current]") ?? null;
    if (sidebar === null || line === null) {
      return;
    }

    const box = sidebar.getBoundingClientRect();
    const padding = scrollPadding(sidebar);
    const visibleTop = box.top + padding.top;
    const visibleBottom = box.bottom - padding.bottom;
    const { top, bottom } = line.getBoundingClientRect();
    if (top < visibleTop) {
      sidebar.scrollTop -= visibleTop - top;
    } else if (bottom > visibleBottom) {
      sidebar.scrollTop += bottom - visibleBottom;
    }
  }, [sidebarRef, current]);

  if (headings.length === 0 && comments.length === 0) {
    return null;
  }

  // Under lg the sidebar sits under the comments, so the outline is hidden there.
  return (
    <nav ref={navRef} aria-labelledby={labelId} className="mt-4 hidden border-t border-line pt-4 lg:block">
      <p id={labelId} className="text-sm text-dim">Contents</p>
      {headings.length > 0 && <Lines entries={headings} first={0} current={current} />}
      {comments.length > 0 && (
        <>
          {/* The space separates the words in speech; flex drops it from the layout. */}
          <p className="mt-3 flex items-baseline gap-1.5 text-sm text-dim">
            Comments
            {" "}
            <span className="text-xs">{comments.length}</span>
          </p>
          <Lines entries={comments} first={headings.length} current={current} />
        </>
      )}
    </nav>
  );
}
