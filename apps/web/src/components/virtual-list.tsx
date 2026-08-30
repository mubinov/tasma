import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef, type ReactNode } from "react";

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
 * Renders only the rows in view. Any list that can exceed 50 rows goes through
 * this rather than mapping the whole collection.
 *
 * React Compiler skips this component, and the build prints why: `useVirtualizer`
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
