import { useVirtualizer, useWindowVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

type VirtualListProps<T> = {
  items: readonly T[];
  /** Row height in pixels before measurement; measured rows override it. */
  estimateSize: number;
  /** Row identity across reorders. Keying by index reuses DOM and state silently. */
  getKey: (item: T, index: number) => string | number;
  renderItem: (item: T, index: number) => ReactNode;
  /** Names the scroll region, which is a tab stop of its own. */
  label: string;
  /**
   * The scroll region's height: a number is pixels, a string any CSS length.
   * Required, and it has to resolve to a definite length — an `auto` height
   * grows to the content, which makes the window the whole list and renders
   * every row. A percentage is definite only under a parent that is.
   */
  height: number | string;
  /** Classes for the scroll container. The height is a prop, not a class. */
  className?: string;
};

/**
 * Renders only the rows in view.
 *
 * React Compiler skips this component and reports the skip as a warning, which
 * `vite.config.ts` filters because the skip is expected. `useVirtualizer`
 * returns functions whose answers change while their identity does not, so
 * memoizing around them serves a window that stops following the scroll. Hiding
 * the call behind a hook makes the component compile again and reintroduces
 * exactly that staleness, so the call stays here and the skip stands.
 */
export function VirtualList<T>({
  items,
  estimateSize,
  getKey,
  renderItem,
  label,
  height,
  className,
}: VirtualListProps<T>): ReactNode {
  const scrollRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library -- the call stays here so the window follows the scroll
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    // The virtualizer counts items.length, so every index it hands back is in range.
    getItemKey: (index) => getKey(items[index] as T, index),
    overscan: 8,
  });

  return (
    // A scroll container whose rows hold nothing focusable is unreachable by
    // keyboard unless it is a tab stop itself, and only some engines add one.
    <div
      ref={scrollRef}
      tabIndex={0}
      role="group"
      aria-label={label}
      className={className}
      style={{ overflow: "auto", height }}
    >
      {/*
       * Both roles are stated rather than inherited: list-style: none drops the
       * list role in WebKit, and only a window of rows is in the DOM, so the
       * real size and position have to be declared on each one.
       */}
      <ul role="list" className="relative m-0 list-none p-0" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualizer.getVirtualItems().map((row) => (
          <li
            key={row.key}
            role="listitem"
            aria-setsize={items.length}
            aria-posinset={row.index + 1}
            data-index={row.index}
            ref={virtualizer.measureElement}
            className="absolute top-0 left-0 w-full"
            style={{ transform: `translateY(${row.start}px)` }}
          >
            {renderItem(items[row.index] as T, row.index)}
          </li>
        ))}
      </ul>
    </div>
  );
}

type PageVirtualListProps<T> = {
  items: readonly T[];
  /**
   * An item's row height in pixels before measurement; measured rows override
   * it. The height a row already has on the page keeps the rows in view in
   * place when this list replaces a list of the same rows.
   */
  estimateSize: (item: T, index: number) => number;
  /** Row identity across reorders. Keying by index reuses DOM and state silently. */
  getKey: (item: T, index: number) => string | number;
  renderItem: (item: T, index: number) => ReactNode;
  /** The id of the visible heading that names the list. */
  labelledBy: string;
  /** Pixels between two rows. */
  gap?: number;
  /** The row the page scrolls to, when it changes. */
  scrollToIndex?: number;
};

/**
 * Renders only the rows in view of a list that scrolls with the page rather than
 * inside a region of its own.
 *
 * It is a component apart from `VirtualList` because TanStack types a window
 * virtualizer apart from an element virtualizer, so one component cannot hold
 * both calls. The compiler does not know `useWindowVirtualizer` as a library it
 * must skip, so `"use no memo"` opts the component out: memoized, the rows stop
 * following the page scroll.
 */
export function PageVirtualList<T>({
  items,
  estimateSize,
  getKey,
  renderItem,
  labelledBy,
  gap,
  scrollToIndex,
}: PageVirtualListProps<T>): ReactNode {
  "use no memo";
  const listRef = useRef<HTMLUListElement>(null);
  // The list's top in page coordinates. Content above the list can change height
  // with no render of the list, so a resize of the body measures it again.
  const [scrollMargin, setScrollMargin] = useState(0);
  const virtualizer = useWindowVirtualizer({
    count: items.length,
    // The virtualizer counts items.length, so every index it hands back is in range.
    estimateSize: (index) => estimateSize(items[index] as T, index),
    getItemKey: (index) => getKey(items[index] as T, index),
    overscan: 8,
    gap,
    scrollMargin,
  });

  function measure(): void {
    const list = listRef.current;

    if (list !== null) {
      const top = list.getBoundingClientRect().top + window.scrollY;
      setScrollMargin((current) => (current === top ? current : top));
    }
  }

  useLayoutEffect(measure);

  useEffect(() => {
    if (scrollToIndex !== undefined) {
      virtualizer.scrollToIndex(scrollToIndex);
    }
  }, [scrollToIndex, virtualizer]);

  useEffect(() => {
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(document.body);

    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, []);

  return (
    <ul
      ref={listRef}
      role="list"
      aria-labelledby={labelledBy}
      className="relative m-0 list-none p-0"
      style={{ height: `${virtualizer.getTotalSize()}px` }}
    >
      {virtualizer.getVirtualItems().map((row) => (
        <li
          key={row.key}
          role="listitem"
          aria-setsize={items.length}
          aria-posinset={row.index + 1}
          data-index={row.index}
          // A focus target for a script, never a tab stop.
          tabIndex={-1}
          ref={virtualizer.measureElement}
          className="absolute top-0 left-0 w-full"
          style={{ transform: `translateY(${row.start - scrollMargin}px)` }}
        >
          {renderItem(items[row.index] as T, row.index)}
        </li>
      ))}
    </ul>
  );
}
