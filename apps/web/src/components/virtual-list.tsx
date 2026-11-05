import {
  defaultRangeExtractor,
  useVirtualizer,
  useWindowVirtualizer,
  type Range,
  type VirtualItem,
  type Virtualizer,
} from "@tanstack/react-virtual";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { scrollBehavior } from "../lib/scroll-behavior";
import { useFocusLost } from "../lib/use-focus-lost";

type RowKey = string | number;

type Key = VirtualItem["key"];

type RovingOptions = {
  /**
   * The row of the tab stop before the user moves in the list, and after the
   * row of the tab stop leaves the list. The first row when it is absent or
   * not in the list.
   */
  preferredKey?: RowKey;
  /** At mount, focus the row of the tab stop. A later change does nothing. */
  focusOnMount?: boolean;
};

/** The list has exactly one name. */
type ListName
  /** The list is one tab stop on its rows, and the scroll region has no name. */
  = | { roving: RovingOptions; labelledBy: string; label?: never }
  /** The scroll region is a tab stop, named by the element with this id. */
    | { roving?: never; labelledBy: string; label?: never }
  /** The scroll region is a tab stop with this name. */
    | { roving?: never; labelledBy?: never; label: string };

/** `goToTop` focuses the first row, and only a list with `roving` has a row element that takes the focus. */
type ToTop
  = | {
    roving: RovingOptions;
    /**
     * Rendered at the top of the part in view while the list is not at its top, and before the rows in the tab
     * order. `goToTop` scrolls the list to its top and focuses the first row.
     */
    renderToTop?: (goToTop: () => void) => ReactNode;
  }
  | { roving?: never; renderToTop?: never };

type VirtualListProps<T> = ListName & ToTop & {
  items: readonly T[];
  /**
   * A row's height in pixels before measurement; measured rows override it. A row that first renders above the view
   * at another height moves the scroll inside the commit, where React refuses the `flushSync` that the virtualizer
   * calls.
   */
  estimateSize: (item: T, index: number) => number;
  /** Row identity across reorders. Keying by index reuses DOM and state silently. */
  getKey: (item: T, index: number) => RowKey;
  /**
   * With `roving`, the element of the row that takes `tabIndex` is the one the
   * list focuses. Without it, `tabIndex` is undefined.
   */
  renderItem: (item: T, index: number, tabIndex: number | undefined) => ReactNode;
  /**
   * The scroll region's height: a number is pixels, a string any CSS length.
   * Required, and it has to resolve to a definite length — an `auto` height
   * grows to the content, which makes the window the whole list and renders
   * every row. A percentage is definite only under a parent that is.
   */
  height: number | string;
  /** Classes for the scroll container. The height is a prop, not a class. */
  className?: string;
  /** The size each row states. The count of the items by default. */
  total?: number;
  /**
   * Shown after the rows, inside the scroll region, and not counted as a row.
   * When it grows while the end of the rows is in view, the region scrolls to
   * its end, so the footer shows in full.
   */
  footer?: ReactNode;
  /**
   * Called after a render while the end of the rows is one list height or less
   * below the part in view, and on Down on the last row.
   */
  onEnd?: () => void;
  /**
   * Rows that come before the rows in view do not move them while the pointer is in the region, or while the region
   * holds a focus that no press in it gave. Otherwise a list at its top stays at its top and shows the rows, unless
   * the row of `selectedKey` is whole in view and would not be whole at the top. A scrolled list keeps the rows in view
   * in place, unless a new row comes first and the row of `selectedKey` is whole in view, now and at the top: then the
   * list goes to its top. While the scroll of `goToTop` runs, an update keeps the offset.
   */
  anchorTop?: boolean;
  /** The row that `anchorTop` keeps whole in view. */
  selectedKey?: RowKey;
  /** The indexes of rows that render also when they are far from the view, as the row of the tab stop does. */
  keepRendered?: readonly number[];
};

type FocusTarget = {
  key: RowKey;
  /** The focus counts as one that a press gave. */
  pointer: boolean;
  preventScroll: boolean;
};

/** A focus that counts as no press, and scrolls the row into view. */
const NO_PRESS_FOCUS: Omit<FocusTarget, "key"> = { pointer: false, preventScroll: false };

/** The length of the longest series of `keys` whose indexes in `indexes` increase. A key with no index is skipped. */
function orderedLength(keys: readonly Key[], indexes: ReadonlyMap<Key, number>): number {
  // At each length, the lowest last index of a series of that length.
  const ends: number[] = [];
  for (const key of keys) {
    const index = indexes.get(key);
    if (index === undefined) {
      continue;
    }

    let low = 0;
    let high = ends.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (ends[middle]! < index) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    ends[low] = index;
  }
  return ends.length;
}

/**
 * Whether the row of `key` moved from `last` to the list of `indexes`: some longest series of the rows of both lists
 * that keep their order leaves it out. A row that other rows move past keeps its place. Of two rows that change
 * places, both moved: the order cannot tell which of them did.
 */
function moved(last: readonly Key[], indexes: ReadonlyMap<Key, number>, key: Key): boolean {
  return last.includes(key) && indexes.has(key)
    && orderedLength(last.filter((one) => one !== key), indexes) === orderedLength(last, indexes);
}

/** The keys of the rows of `virtualizer`, which are those of the last render until it gets the rows of this one. */
function keysOf(virtualizer: Virtualizer<HTMLDivElement, Element>): Key[] {
  const { count, getItemKey } = virtualizer.options;
  return Array.from({ length: count }, (_, index) => getItemKey(index));
}

/** Whether the row at the scroll offset of `virtualizer`, before it gets the list of `indexes`, moves in that list. */
function offsetRowMoves(virtualizer: Virtualizer<HTMLDivElement, Element>, indexes: ReadonlyMap<Key, number>): boolean {
  // The offset is set in the first render.
  const row = virtualizer.getVirtualItemForOffset(virtualizer.scrollOffset!);
  return row !== undefined && moved(keysOf(virtualizer), indexes, row.key);
}

/** Whether the row of `key` is whole in the part in view of `virtualizer`, before it gets the rows of this render. */
function wholeInView(virtualizer: Virtualizer<HTMLDivElement, Element>, key: Key): boolean {
  // A row that is whole in view is rendered.
  const row = virtualizer.getVirtualItems().find((item) => item.key === key);
  // The offset is set in the first render, the region in a layout effect.
  const top = virtualizer.scrollOffset!;
  return row !== undefined && row.start >= top && row.end <= top + virtualizer.scrollRect!.height;
}

/** The element of the row at `index` that takes the focus, when the row is rendered. */
function rowTarget(list: HTMLUListElement | null, index: number): HTMLElement | null {
  return list?.querySelector<HTMLElement>(`:scope > li[data-index="${String(index)}"] [tabindex]`) ?? null;
}

type RowProps = {
  index: number;
  start: number;
  setSize: number;
  measure: (element: HTMLLIElement | null) => void;
  onFocusLost: () => void;
  children: ReactNode;
};

function Row({ index, start, setSize, measure, onFocusLost, children }: RowProps): ReactNode {
  const ref = useRef<HTMLLIElement>(null);

  useFocusLost(ref, onFocusLost);

  return (
    <li
      ref={(element) => {
        ref.current = element;
        measure(element);
      }}
      role="listitem"
      aria-setsize={setSize}
      aria-posinset={index + 1}
      data-index={index}
      className="absolute top-0 left-0 w-full"
      style={{ transform: `translateY(${start}px)` }}
    >
      {children}
    </li>
  );
}

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
  labelledBy,
  roving,
  height,
  className,
  total,
  footer,
  onEnd,
  anchorTop = false,
  selectedKey,
  renderToTop,
  keepRendered = [],
}: VirtualListProps<T>): ReactNode {
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const footerHeightRef = useRef<number | null>(null);
  const keys = items.map((item, index) => getKey(item, index));
  const indexes = new Map(keys.map((key, index) => [key, index]));
  const [lastFocusedKey, setLastFocusedKey] = useState<RowKey | null>(null);
  // The row the list moves the focus to.
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);
  const [atTop, setAtTop] = useState(true);
  const [pointerIn, setPointerIn] = useState(false);
  const [focusIn, setFocusIn] = useState(false);
  // The focus that the region holds followed a press in it. It does not read `:focus-visible`: a click on a row in
  // WebKit is a focus by script.
  const [pointerFocus, setPointerFocus] = useState(false);
  // The element in the region that holds the focus got it from the keyboard.
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  // A press in the region that no focus, click or exit of the pointer has ended yet.
  const pressRef = useRef(false);
  // The element in the region that holds the focus, also while the window is in the background.
  const heldRef = useRef<EventTarget | null>(null);
  // The kind of the focus that `takeFocusTarget` gives while it gives it.
  const pointerTargetRef = useRef(false);
  // The first pass of a render decides the automatic move to the top: a second pass of StrictMode reads a virtualizer
  // that already holds the rows of the render.
  const autoTopRef = useRef(false);
  // `goToTop` scrolls the list, until the list is at its top or the reader takes the scroll. An update in that time
  // keeps the offset: the scroll of an anchor stops a smooth scroll.
  const goingTopRef = useRef(false);
  const lostRef = useRef<RowKey | null>(null);
  const lastKeysRef = useRef<readonly RowKey[]>(keys);
  // The virtualizer, to read before the call that gives it the rows of this render.
  const [instance, setInstance] = useState<Virtualizer<HTMLDivElement, Element> | null>(null);

  if (lastFocusedKey !== null && !indexes.has(lastFocusedKey)) {
    setLastFocusedKey(null);
  }

  const preferredKey = roving?.preferredKey;
  const stopKey = lastFocusedKey !== null && indexes.has(lastFocusedKey)
    ? lastFocusedKey
    : preferredKey !== undefined && indexes.has(preferredKey) ? preferredKey : keys[0];
  const stopIndex = roving === undefined || stopKey === undefined ? -1 : indexes.get(stopKey)!;

  // The row at `index` is whole in view in a list at its top. A measured height holds no band that the rows of this
  // render add, so every row up to it counts at its estimate.
  function wholeAtTop(index: number, viewport: number): boolean {
    let end = 0;
    for (let at = 0; at <= index && end <= viewport; at++) {
      end += estimateSize(items[at] as T, at);
    }
    return end <= viewport;
  }

  // "end" keeps the rows in view in place, "start" keeps the offset, and "top" is "start" and then a move to the top.
  function anchorOf(virtualizer: Virtualizer<HTMLDivElement, Element>): "start" | "end" | "top" {
    if (pointerIn || (focusIn && !pointerFocus)) {
      return "end";
    }

    const selected = selectedKey === undefined ? undefined : indexes.get(selectedKey);
    if (selected === undefined || !wholeInView(virtualizer, keys[selected]!)) {
      return atTop ? "start" : "end";
    }

    // The region is measured before `instance` is set.
    const later = wholeAtTop(selected, virtualizer.scrollRect!.height);
    if (atTop) {
      return later ? "start" : "end";
    }
    return later && !keysOf(virtualizer).includes(keys[0]!) ? "top" : "end";
  }

  const anchor = !anchorTop || instance === null
    ? "start"
    : autoTopRef.current ? "top" : goingTopRef.current ? "start" : anchorOf(instance);
  if (anchor === "top") {
    autoTopRef.current = true;
  }

  // eslint-disable-next-line react-hooks/incompatible-library -- the call stays here so the window follows the scroll
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    // The virtualizer counts items.length, so every index it hands back is in range.
    estimateSize: (index) => estimateSize(items[index] as T, index),
    getItemKey: (index) => keys[index]!,
    overscan: 8,
    // The row of the tab stop is the focused row while the focus is in the list,
    // and it stays rendered, so Tab reaches the list from anywhere it scrolls.
    rangeExtractor: (range: Range) => {
      const shown = defaultRangeExtractor(range);
      const kept = new Set([stopIndex, ...keepRendered].filter((index) => index !== -1 && !shown.includes(index)));
      return kept.size === 0 ? shown : [...shown, ...kept].sort((one, other) => one - other);
    },
    // "end" keeps the row at the scroll offset in place when rows come before it, and takes the view along when that
    // row moves.
    anchorTo: anchor === "end" && instance !== null && !offsetRowMoves(instance, indexes) ? "end" : "start",
  });
  const rows = virtualizer.getVirtualItems();

  // A scroll of the virtualizer sets the offset of the region at once, clamped to its content, and the virtualizer
  // keeps its own offset unclamped. The `scroll` event comes only at the next rendering update, which a window in the
  // background does not run.
  const followOffset = useEffectEvent(() => {
    setAtTop(scrollRef.current!.scrollTop <= 0);
  });

  // After the effects of `useVirtualizer`, which write the offset of the render. Instant, as the arrival of a row at
  // the top is: the reader did not ask for this scroll.
  useLayoutEffect(() => {
    if (autoTopRef.current) {
      autoTopRef.current = false;
      virtualizer.scrollToOffset(0);
      // `scrollToOffset` sets the offset of the region, and not its own.
      virtualizer.scrollOffset = 0;
    }
    followOffset();
  });

  const keepInstance = useEffectEvent(() => {
    setInstance(virtualizer);
  });

  useLayoutEffect(() => {
    keepInstance();
  }, []);

  function rowIndexOf(target: EventTarget): number | null {
    const list = listRef.current;
    const row = (target as Element).closest("li[data-index]");
    return list !== null && row?.parentElement === list ? Number(row.getAttribute("data-index")) : null;
  }

  function focusRow(key: RowKey, how: Omit<FocusTarget, "key"> = NO_PRESS_FOCUS): void {
    setLastFocusedKey(key);
    setFocusTarget({ key, ...how });
  }

  // The button takes no focus on a press in WebKit, and in other engines it takes a focus that ends the press.
  function goToTop(): void {
    // A list that unmounts detaches the region before the layout cleanups of the button.
    const region = scrollRef.current;
    if (region === null) {
      return;
    }

    // At the top, the scroll fires no `scroll` event to end it.
    goingTopRef.current = region.scrollTop > 0;
    virtualizer.scrollToOffset(0, { behavior: scrollBehavior() });
    focusRow(keys[0]!, { pointer: pressRef.current || (focusIn && pointerFocus), preventScroll: true });
  }

  function tabIndexOf(index: number): number | undefined {
    if (roving === undefined) {
      return undefined;
    }
    return index === stopIndex ? 0 : -1;
  }

  const reachEnd = useEffectEvent(() => {
    // Both are set before this effect: the region in a layout effect, the offset in the first render.
    const viewport = virtualizer.scrollRect!.height;
    const below = virtualizer.getTotalSize() - virtualizer.scrollOffset! - viewport;
    if (below <= viewport) {
      onEnd?.();
    }
  });

  useEffect(() => {
    reachEnd();
  });

  const focusOnMount = useEffectEvent(() => {
    if (roving?.focusOnMount === true && stopKey !== undefined) {
      setFocusTarget({ key: stopKey, ...NO_PRESS_FOCUS });
    }
  });

  useLayoutEffect(() => {
    focusOnMount();
  }, []);

  // A list that mounts under a pointer that does not move gets no `pointerenter`.
  const readPointer = useEffectEvent(() => {
    setPointerIn(scrollRef.current!.matches(":hover"));
  });

  useLayoutEffect(() => {
    readPointer();
  }, []);

  // React gives the focus back to a focused row that a commit moves in the document, and keeps the scroll offsets.
  // A row with a keyboard focus that moves then scrolls into view, so that its focus ring stays in view. Runs before
  // the effect that updates `lastKeysRef`.
  useLayoutEffect(() => {
    const active = document.activeElement;
    const index = active === null ? null : rowIndexOf(active);
    if (keyboardFocus && active !== null && index !== null && moved(lastKeysRef.current, indexes, keys[index]!)) {
      active.scrollIntoView({ block: "nearest" });
    }
  });

  // A focused row that leaves the list hands the focus to the row after it, else the row before it.
  useLayoutEffect(() => {
    const last = lastKeysRef.current;
    const lost = lostRef.current;
    lastKeysRef.current = keys;
    lostRef.current = null;
    if (roving === undefined || lost === null || indexes.has(lost)) {
      return;
    }

    const at = last.indexOf(lost);
    const remains = (key: RowKey) => indexes.has(key);
    const next = last.slice(at + 1).find(remains) ?? last.slice(0, at).findLast(remains);
    if (next !== undefined) {
      focusRow(next);
    }
  });

  // The target is the row of the tab stop, which renders once the virtualizer has measured the scroll region. The
  // focus then scrolls the row into view, clear of the scroll padding, unless the target prevents the scroll.
  const takeFocusTarget = useEffectEvent(() => {
    if (focusTarget === null) {
      return;
    }

    const index = indexes.get(focusTarget.key);
    const element = index === undefined ? null : rowTarget(listRef.current, index);
    if (index !== undefined && element === null) {
      return;
    }
    setFocusTarget(null);
    pointerTargetRef.current = focusTarget.pointer;
    element?.focus({ preventScroll: focusTarget.preventScroll });
    pointerTargetRef.current = false;
  });

  useLayoutEffect(() => {
    takeFocusTarget();
  });

  useLayoutEffect(() => {
    const region = scrollRef.current!;
    const height = footerRef.current?.offsetHeight ?? null;
    const before = footerHeightRef.current;
    footerHeightRef.current = height;
    if (height === null || before === null || height <= before) {
      return;
    }

    // 1px for a scroll offset that rounds to a device pixel.
    if (virtualizer.getTotalSize() <= region.scrollTop + virtualizer.scrollRect!.height + 1) {
      region.scrollTop = region.scrollHeight;
    }
  });

  function onRowKeyDown(event: KeyboardEvent<HTMLUListElement>): void {
    const index = rowIndexOf(event.target);
    if (index === null || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }

    const last = items.length - 1;
    let to: number;
    switch (event.key) {
      case "ArrowUp":
        to = Math.max(index - 1, 0);
        break;
      case "ArrowDown":
        if (index === last) {
          onEnd?.();
        }
        to = Math.min(index + 1, last);
        break;
      case "Home":
        to = 0;
        break;
      case "End":
        to = last;
        break;
      default:
        return;
    }

    event.preventDefault();
    if (to !== index) {
      focusRow(keys[to]!);
    }
  }

  // WebKit does not focus a link on a click.
  function onRowClick(event: MouseEvent<HTMLUListElement>): void {
    const index = rowIndexOf(event.target);
    const target = index === null ? null : rowTarget(listRef.current, index);
    if (target !== null && target.contains(event.target as Node) && document.activeElement !== target) {
      target.focus({ preventScroll: true });
    }
  }

  function onRowFocus(event: FocusEvent<HTMLUListElement>): void {
    const index = rowIndexOf(event.target);
    if (index !== null) {
      setLastFocusedKey(keys[index]!);
    }
  }

  const named = roving === undefined
    ? {
        // A scroll container whose rows hold nothing focusable is unreachable by
        // keyboard unless it is a tab stop itself, and only some engines add one.
        tabIndex: 0,
        role: "group",
        ...(labelledBy === undefined ? { "aria-label": label } : { "aria-labelledby": labelledBy }),
      }
    : {};

  return (
    <div
      ref={scrollRef}
      {...named}
      className={className}
      style={{ overflow: "auto", height }}
      onScroll={(event) => {
        const reachedTop = event.currentTarget.scrollTop <= 0;
        setAtTop(reachedTop);
        if (reachedTop) {
          goingTopRef.current = false;
        }
      }}
      onWheel={() => {
        goingTopRef.current = false;
      }}
      onKeyDown={() => {
        goingTopRef.current = false;
      }}
      onPointerEnter={() => {
        setPointerIn(true);
      }}
      onPointerLeave={() => {
        setPointerIn(false);
        pressRef.current = false;
      }}
      onPointerDown={() => {
        pressRef.current = true;
        goingTopRef.current = false;
      }}
      // After the click handlers of a row and of the button, which read the press.
      onClick={() => {
        pressRef.current = false;
      }}
      onFocus={(event) => {
        // A focus on the element that the region holds, as when the window comes back from the background, keeps its
        // kind.
        if (event.target !== heldRef.current) {
          heldRef.current = event.target;
          setPointerFocus(pressRef.current || pointerTargetRef.current);
        }
        pressRef.current = false;
        setFocusIn(true);
        setKeyboardFocus(event.target.matches(":focus-visible"));
      }}
      onBlur={(event) => {
        // A window that goes to the background blurs the element and keeps it active.
        const kept = event.currentTarget.contains(event.relatedTarget) || document.activeElement === event.target;
        setFocusIn(kept);
        if (!kept) {
          heldRef.current = null;
        }
      }}
    >
      {renderToTop !== undefined && !atTop && (
        // No height, so the rows keep their place when the button comes or goes.
        <div className="sticky top-2 z-(--layer-scroll-to-top) flex h-0 items-start justify-center">
          {renderToTop(goToTop)}
        </div>
      )}
      {/*
       * Both roles are stated rather than inherited: list-style: none drops the
       * list role in WebKit, and only a window of rows is in the DOM, so the
       * real size and position have to be declared on each one.
       */}
      <ul
        ref={listRef}
        role="list"
        aria-labelledby={roving === undefined ? undefined : labelledBy}
        className="relative m-0 list-none p-0"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
        {...(roving === undefined ? {} : { onKeyDown: onRowKeyDown, onClick: onRowClick, onFocus: onRowFocus })}
      >
        {rows.map((row) => (
          <Row
            key={row.key}
            index={row.index}
            start={row.start}
            setSize={total ?? items.length}
            measure={virtualizer.measureElement}
            onFocusLost={() => {
              lostRef.current = keys[row.index]!;
            }}
          >
            {renderItem(items[row.index] as T, row.index, tabIndexOf(row.index))}
          </Row>
        ))}
      </ul>
      {footer !== undefined && <div ref={footerRef}>{footer}</div>}
    </div>
  );
}

type PageVirtualListProps<T> = {
  rows: readonly T[];
  /**
   * A row's height in pixels before measurement; measured rows override it. The
   * height a row already has on the page keeps the rows in view in place when
   * this list replaces a list of the same rows.
   */
  estimateSize: (row: T, index: number) => number;
  /** Row identity across reorders. Keying by index reuses DOM and state silently. */
  getKey: (row: T, index: number) => string | number;
  renderRow: (row: T, index: number) => ReactNode;
  /** The id of the visible heading that names the list. */
  labelledBy: string;
  /** Pixels between two rows. */
  gap?: number;
  /**
   * A row's place among the items of the list, `null` for a row that draws
   * something and holds no item. Every row is an item of its own by default.
   */
  itemIndex?: (row: T, index: number) => number | null;
  /** How many of the rows hold an item. As many as there are rows by default. */
  itemCount?: number;
  /** The row the page scrolls to, when it changes. */
  scrollToIndex?: number;
};

/**
 * The row index the virtualizer reads back off a measured element. It is an
 * attribute of its own because `data-index` carries the item index, which a row
 * holding no item shifts away from the row index.
 */
const ROW_INDEX_ATTRIBUTE = "data-row-index";

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
  rows,
  estimateSize,
  getKey,
  renderRow,
  labelledBy,
  gap,
  itemIndex,
  itemCount,
  scrollToIndex,
}: PageVirtualListProps<T>): ReactNode {
  "use no memo";
  const listRef = useRef<HTMLUListElement>(null);
  // The list's top in page coordinates. Content above the list can change height
  // with no render of the list, so a resize of the body measures it again.
  const [scrollMargin, setScrollMargin] = useState(0);
  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    // The virtualizer counts rows.length, so every index it hands back is in range.
    estimateSize: (index) => estimateSize(rows[index] as T, index),
    getItemKey: (index) => getKey(rows[index] as T, index),
    overscan: 8,
    gap,
    scrollMargin,
    indexAttribute: ROW_INDEX_ATTRIBUTE,
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
      {virtualizer.getVirtualItems().map((virtual) => {
        // The virtualizer counts rows.length, so every index it hands back is in range.
        const row = rows[virtual.index] as T;
        const at = itemIndex === undefined ? virtual.index : itemIndex(row, virtual.index);

        return (
          <li
            key={virtual.key}
            role="listitem"
            aria-hidden={at === null || undefined}
            aria-setsize={itemCount ?? rows.length}
            aria-posinset={at === null ? undefined : at + 1}
            data-index={at ?? undefined}
            {...{ [ROW_INDEX_ATTRIBUTE]: virtual.index }}
            // A focus target for a script, never a tab stop.
            tabIndex={-1}
            ref={virtualizer.measureElement}
            className="absolute top-0 left-0 w-full"
            style={{ transform: `translateY(${virtual.start - scrollMargin}px)` }}
          >
            {renderRow(row, virtual.index)}
          </li>
        );
      })}
    </ul>
  );
}
