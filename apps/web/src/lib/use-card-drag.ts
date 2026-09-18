import type { TaskEntry } from "@tasma/protocol";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import { cardPlace, type ColumnData } from "./board";
import {
  CARD_GAP,
  DRAG_ATTRIBUTE,
  dropPlace,
  samePlace,
  scrollStep,
  type DragGeometry,
  type DropPlace,
  type Point,
} from "./drag-place";

/** The board as one render of it shows it. A drag holds the one it started on. */
export type BoardSnapshot = {
  entries: readonly TaskEntry[];
  columns: readonly ColumnData[];
  /** The ids of the tasks a write the daemon has not answered yet changes. */
  pendingIds: ReadonlySet<string>;
  /** Of those, the ids of the tasks such a write moves rather than renumbers. */
  movedIds: ReadonlySet<string>;
};

/** The origin card's box when the drag started, in viewport coordinates. */
type OriginBox = { left: number; top: number; width: number; height: number };

export type DragState = {
  taskId: string;
  /** Where a drop lands the card, `null` where a drop writes nothing. */
  place: DropPlace | null;
  box: OriginBox;
};

type Lift = {
  board: BoardSnapshot;
  /** By task: its index in its column's visible list without the dragged card. */
  indexes: ReadonlyMap<string, number>;
  /** The place the card already holds, which a drop would not change. */
  origin: DropPlace;
  /** The pointer's offset inside the card when it was pressed. */
  grab: Point;
  box: OriginBox;
  place: DropPlace | null;
  frame: number;
};

/** A pressed card. It becomes a drag once the pointer passes the threshold. */
type Session = {
  taskId: string;
  card: HTMLElement;
  down: Point;
  at: Point;
  lift: Lift | null;
  /** A drag Escape ended while the pointer was still down. */
  cancelled: boolean;
  release: () => void;
};

/** How far the pointer moves before a press becomes a drag. */
const THRESHOLD = 4;

const SCALE = 1.02;

/** The classes `<html>` carries while a card is dragged. */
const DRAGGING_CLASSES = ["cursor-grabbing", "select-none"];

const COLUMN_SELECTOR = `[${DRAG_ATTRIBUTE.column}]`;

const CARD_SELECTOR = `[${DRAG_ATTRIBUTE.card}]`;

const SLOT_SELECTOR = `[${DRAG_ATTRIBUTE.slot}]`;

function transform({ x, y }: Point, grab: Point): string {
  return `translate(${String(x - grab.x)}px, ${String(y - grab.y)}px) scale(${String(SCALE)})`;
}

/** Every card of the board by its index in its column's visible list without the dragged card. */
function cardIndexes(columns: readonly ColumnData[], movedId: string): Map<string, number> {
  const indexes = new Map<string, number>();

  for (const { matching } of columns) {
    let index = 0;

    for (const { id } of matching) {
      if (id !== movedId) {
        indexes.set(id, index);
        index += 1;
      }
    }
  }

  return indexes;
}

/** The board as it stands on the page. */
function readGeometry(indexes: ReadonlyMap<string, number>): DragGeometry {
  const columns = [...document.querySelectorAll(COLUMN_SELECTOR)].map((section) => {
    const { left, right, top } = section.getBoundingClientRect();
    const cards = [...section.querySelectorAll(CARD_SELECTOR)].map((row) => {
      const box = row.getBoundingClientRect();
      const id = row.getAttribute(DRAG_ATTRIBUTE.card)!;

      return { top: box.top, height: box.height, index: indexes.get(id) ?? null };
    });
    const box = section.querySelector(SLOT_SELECTOR)?.getBoundingClientRect();

    return {
      index: Number(section.getAttribute(DRAG_ATTRIBUTE.column)),
      left,
      right,
      top,
      cards,
      slot: box === undefined ? null : { top: box.top, height: box.height },
    };
  });

  return { columns, gap: CARD_GAP };
}

/**
 * One frame of a drag: the lifted card follows the pointer, the page scrolls
 * near an edge, and the place under the pointer is read again.
 */
function runFrame(
  sessionRef: RefObject<Session | null>,
  lifted: RefObject<HTMLDivElement | null>,
  setDrag: Dispatch<SetStateAction<DragState | null>>,
): void {
  const current = sessionRef.current;
  // A frame of a drag that has ended, which the cancel did not catch.
  if (current?.lift == null) {
    return;
  }

  const lift = current.lift;
  const { at } = current;
  // The card can still be off the page: the frame was asked for before React
  // put it there.
  if (lifted.current !== null) {
    lifted.current.style.transform = transform(at, lift.grab);
  }

  const scroll = scrollStep(at, { width: window.innerWidth, height: window.innerHeight });
  if (scroll.x !== 0 || scroll.y !== 0) {
    window.scrollBy(scroll.x, scroll.y);
  }

  const found = dropPlace(at, readGeometry(lift.indexes));
  const place = samePlace(found, lift.origin) ? null : found;
  if (!samePlace(place, lift.place)) {
    lift.place = place;
    setDrag({ taskId: current.taskId, place, box: lift.box });
  }

  lift.frame = requestAnimationFrame(() => {
    runFrame(sessionRef, lifted, setDrag);
  });
}

/** Whether a press on a card can open a drag at all. */
function startsDrag(event: ReactPointerEvent<HTMLElement>): boolean {
  const target = event.target as Element;

  if (event.button !== 0 || (event.pointerType !== "mouse" && event.pointerType !== "pen")) {
    return false;
  }

  // The menu popups render in portals, and their events bubble through the
  // card's React tree.
  return event.currentTarget.contains(target) && target.closest("button") === null;
}

type CardDragOptions = {
  /** The board as it renders now. A drag freezes it until it ends. */
  board: BoardSnapshot;
  onDrop: (taskId: string, place: DropPlace, board: BoardSnapshot) => void;
};

type CardDrag = {
  drag: DragState | null;
  /** The board to render: the frozen one during a drag, the live one otherwise. */
  board: BoardSnapshot;
  /** The card that follows the pointer. */
  liftedRef: RefObject<HTMLDivElement | null>;
  press: (event: ReactPointerEvent<HTMLElement>, taskId: string) => void;
};

/**
 * Dragging a card to a place with the mouse or a pen.
 *
 * The pointer position does not go through React state: a frame writes it to
 * the lifted card's transform. State changes when the drag starts, when the
 * place changes, and when the drag ends.
 *
 * The listeners sit on the window rather than on the card: a virtualised column
 * can unmount the card's element mid-drag.
 */
export function useCardDrag({ board, onDrop }: CardDragOptions): CardDrag {
  const [drag, setDrag] = useState<DragState | null>(null);
  const [frozen, setFrozen] = useState<BoardSnapshot | null>(null);
  const liftedRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<Session | null>(null);
  const suppressClickRef = useRef(false);
  // A press reads the board and the handler of the render that committed last,
  // not of the render its listeners were built in.
  const latestRef = useRef({ board, onDrop });

  useEffect(() => {
    latestRef.current = { board, onDrop };
  });

  /** Takes the card off the pointer. The press it belongs to can stay open. */
  function unlift(current: Session): void {
    if (current.lift !== null) {
      cancelAnimationFrame(current.lift.frame);
      document.documentElement.classList.remove(...DRAGGING_CLASSES);
      current.lift = null;
      setDrag(null);
      setFrozen(null);
    }
  }

  /** Ends the press, the card it lifted included. */
  function end(current: Session): void {
    sessionRef.current = null;
    current.release();
    unlift(current);
  }

  function drop(current: Session): void {
    const lift = current.lift;
    const dragged = lift !== null || current.cancelled;

    end(current);
    if (dragged) {
      // Only this release fires a click, and that click would open the task.
      // A pointer the window lost or the browser cancelled fires none, so
      // arming there would swallow an unrelated click later on.
      suppressClickRef.current = true;
    }
    if (lift?.place != null) {
      latestRef.current.onDrop(current.taskId, lift.place, lift.board);
    }
  }

  /** Escape: the card goes back, and the press stays open until the release. */
  function cancel(current: Session): void {
    // A press that never lifted has no click to swallow, so it can end here. A
    // cancelled one has to reach the release, the only path that arms the flag.
    if (current.lift === null && !current.cancelled) {
      end(current);
      return;
    }

    unlift(current);
    current.cancelled = true;
  }

  function liftCard(current: Session): void {
    const snapshot = latestRef.current.board;
    const found = cardPlace(snapshot.columns, current.taskId);
    // A poll since the press can have replaced the card's element, and the box
    // of an element off the page is all zeros. The id comes off the wire, so it
    // is escaped before it stands in a selector.
    const selector = `[${DRAG_ATTRIBUTE.card}="${CSS.escape(current.taskId)}"]`;
    const card = document.querySelector<HTMLElement>(selector) ?? current.card;

    // A poll can also have taken the card off the board, or off the page while
    // it stands on the board: a virtualised column renders a window of its cards.
    if (found === null || !card.isConnected) {
      end(current);
      return;
    }

    const { left, top, width, height } = card.getBoundingClientRect();
    const box = { left, top, width, height };

    current.lift = {
      board: snapshot,
      indexes: cardIndexes(snapshot.columns, current.taskId),
      origin: { column: found.column, index: found.index },
      grab: { x: current.down.x - left, y: current.down.y - top },
      box,
      place: null,
      frame: requestAnimationFrame(() => {
        runFrame(sessionRef, liftedRef, setDrag);
      }),
    };
    document.documentElement.classList.add(...DRAGGING_CLASSES);
    setFrozen(snapshot);
    setDrag({ taskId: current.taskId, place: null, box });
  }

  function press(event: ReactPointerEvent<HTMLElement>, taskId: string): void {
    if (sessionRef.current !== null || !startsDrag(event)) {
      return;
    }

    const card = event.currentTarget;
    const down = { x: event.clientX, y: event.clientY };
    const listeners: [string, EventListener][] = [];
    const session: Session = {
      taskId,
      card,
      down,
      at: down,
      lift: null,
      cancelled: false,
      release: () => {
        for (const [type, listener] of listeners) {
          window.removeEventListener(type, listener);
        }
      },
    };

    function listen(type: string, listener: EventListener): void {
      listeners.push([type, listener]);
      window.addEventListener(type, listener);
    }

    // On the window from the press on, so a movement that leaves the card
    // before the threshold still starts the drag.
    listen("pointermove", (moved) => {
      const { clientX, clientY } = moved as PointerEvent;

      session.at = { x: clientX, y: clientY };
      if (session.lift === null && !session.cancelled && Math.hypot(clientX - down.x, clientY - down.y) >= THRESHOLD) {
        liftCard(session);
      }
    });
    listen("pointerup", () => {
      drop(session);
    });
    listen("pointercancel", () => {
      end(session);
    });
    listen("blur", () => {
      end(session);
    });
    listen("keydown", (pressed) => {
      if ((pressed as KeyboardEvent).key === "Escape") {
        cancel(session);
      }
    });

    sessionRef.current = session;
  }

  /** An unmount mid-press: the listeners are the session's, and go with it. */
  const endOpenPress = useEffectEvent(() => {
    if (sessionRef.current !== null) {
      end(sessionRef.current);
    }
  });

  // The lifted card stands where the origin card stands until the first frame
  // moves it.
  useLayoutEffect(() => {
    const current = sessionRef.current;
    if (liftedRef.current !== null && current?.lift != null) {
      liftedRef.current.style.transform = transform(current.at, current.lift.grab);
    }
  }, [drag?.taskId]);

  useEffect(() => {
    function swallow(event: MouseEvent): void {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
      }
    }
    // A press starts an interaction of its own, so the click it leads to is not
    // the one a drag has to swallow.
    function pressed(): void {
      suppressClickRef.current = false;
    }

    window.addEventListener("click", swallow, true);
    window.addEventListener("pointerdown", pressed, true);

    return () => {
      window.removeEventListener("click", swallow, true);
      window.removeEventListener("pointerdown", pressed, true);
      endOpenPress();
    };
  }, []);

  return { drag, board: frozen ?? board, liftedRef, press };
}
