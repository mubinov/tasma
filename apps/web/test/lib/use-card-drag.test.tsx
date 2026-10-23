import type { TaskEntry } from "@tasma/protocol";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildColumns, type BoardProject } from "../../src/lib/board";
import { DRAG_ATTRIBUTE, type DropPlace } from "../../src/lib/drag-place";
import { useCardDrag, type BoardSnapshot, type DragState } from "../../src/lib/use-card-drag";

const PROJECTS: BoardProject[] = [
  { tag: "ALPHA", config: { statuses: ["To Do", "Done"], final_statuses: [] } },
  { tag: "BETA", config: { statuses: ["TO DO", "Review", "Done"], final_statuses: [] } },
];

function entry(id: string, status: string): TaskEntry {
  return {
    id,
    path: `/tasks/${id}.md`,
    blocked: false,
    frontmatter: {
      id,
      title: `Task ${id}`,
      status,
      created: "2026-09-01T10:00:00Z",
      updated: "2026-09-01T10:00:00Z",
      next_comment_id: 1,
    },
  };
}

const ENTRIES = [entry("ALPHA-1", "To Do"), entry("BETA-2", "TO DO")];

/** The columns To Do (0), Review (1) and Done (2), with both cards in To Do. */
const BOARD: BoardSnapshot = {
  projects: PROJECTS,
  entries: ENTRIES,
  columns: buildColumns(PROJECTS, ENTRIES, []),
  pendingIds: new Set(),
  movedIds: new Set(),
};

type Drop = (taskId: string, place: DropPlace, board: BoardSnapshot) => void;

function placeWords(drag: DragState | null): string {
  if (drag === null) {
    return "no drag";
  }
  if (drag.place === null) {
    return "no place";
  }

  return `${String(drag.place.column)}:${String(drag.place.index)}`;
}

function Board({ onDrop }: { onDrop: Drop }): ReactNode {
  const { drag, board, press } = useCardDrag({ board: BOARD, onDrop });

  return (
    <>
      {board.columns.map((column, index) => (
        <section key={column.status} {...{ [DRAG_ATTRIBUTE.column]: index }}>
          <ul>
            {column.matching.map(({ id }) => (
              <li key={id}>
                <div
                  {...{ [DRAG_ATTRIBUTE.card]: id }}
                  onPointerDown={(event) => {
                    press(event, id);
                  }}
                >
                  {id}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <output>{placeWords(drag)}</output>
    </>
  );
}

describe("a drag over the columns of two projects", () => {
  const COLUMN_WIDTH = 300;
  const COLUMN_GAP = 24;
  const HEADER = 40;
  const CARD_HEIGHT = 96;
  const CARD_GAP = 8;
  const ROW = CARD_HEIGHT + CARD_GAP;
  /** The top of every column's first row. */
  const FIRST_ROW = 100;

  let frames: FrameRequestCallback[] = [];

  function columnLeft(index: number): number {
    return index * (COLUMN_WIDTH + COLUMN_GAP);
  }

  /** The middle of the row at `at` of a column. */
  function atRow(index: number, at: number): { x: number; y: number } {
    return { x: columnLeft(index) + 20, y: FIRST_ROW + at * ROW + CARD_HEIGHT / 2 };
  }

  function rect(left: number, top: number, height: number, width = COLUMN_WIDTH): DOMRect {
    const box = { x: left, y: top, left, top, right: left + width, bottom: top + height, width, height };

    return { ...box, toJSON: () => box };
  }

  /**
   * jsdom lays nothing out. A column stands beside the one before it and has no
   * bottom; its rows stand one under the other.
   */
  function box(element: HTMLElement): DOMRect {
    const section = element.closest<HTMLElement>(`[${DRAG_ATTRIBUTE.column}]`);
    const left = columnLeft(Number(section?.getAttribute(DRAG_ATTRIBUTE.column) ?? 0));

    if (element === section) {
      return rect(left, FIRST_ROW - HEADER, 0);
    }

    const rows = [...(section?.querySelector("ul")?.children ?? [])];

    return rect(left, FIRST_ROW + rows.findIndex((row) => row.contains(element)) * ROW, CARD_HEIGHT);
  }

  function send(target: Element | Window, type: string, at: { x: number; y: number }): void {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: at.x, clientY: at.y });
    Object.assign(event, { pointerType: "mouse" });

    fireEvent(target, event);
  }

  /** Runs the frames a drag has asked for, and the frames they ask for in turn. */
  function runFrames(count = 2): void {
    for (let round = 0; round < count; round += 1) {
      const pending = frames;
      frames = [];
      act(() => {
        for (const frame of pending) {
          frame(0);
        }
      });
    }
  }

  function press(id: string): void {
    const card = document.querySelector<HTMLElement>(`[${DRAG_ATTRIBUTE.card}="${id}"]`)!;
    const { left, top } = card.getBoundingClientRect();

    send(card, "pointerdown", { x: left + 20, y: top + 20 });
  }

  function movePointer(to: { x: number; y: number }): void {
    send(window, "pointermove", to);
    runFrames();
  }

  async function release(at: { x: number; y: number }) {
    await act(async () => {
      send(window, "pointerup", at);
    });
  }

  function shown(): string | null {
    return document.querySelector("output")!.textContent;
  }

  function renderBoard() {
    const onDrop = vi.fn<Drop>();
    render(<Board onDrop={onDrop} />);

    return onDrop;
  }

  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => frames.push(frame));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("innerWidth", 1_400);
    vi.stubGlobal("innerHeight", 3_000);
    vi.stubGlobal("scrollBy", () => {});
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return box(this);
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("gives no place over a column whose status the card's project does not have, and drops nothing there", async () => {
    const onDrop = renderBoard();

    press("ALPHA-1");
    movePointer(atRow(1, 0));

    expect(shown()).toBe("no place");

    await release(atRow(1, 0));

    expect(onDrop).not.toHaveBeenCalled();
  });

  it("gives the place in an empty column of the card's project, and drops the card there", async () => {
    const onDrop = renderBoard();

    press("ALPHA-1");
    movePointer(atRow(2, 0));

    expect(shown()).toBe("2:0");

    await release(atRow(2, 0));

    expect(onDrop).toHaveBeenCalledExactlyOnceWith("ALPHA-1", { column: 2, index: 0 }, BOARD);
  });

  it("gives a place over a column that only the card's own project has, to a card of that project", () => {
    renderBoard();

    press("BETA-2");
    movePointer(atRow(1, 0));

    expect(shown()).toBe("1:0");
  });

  it("gives a place again once the pointer leaves the column that refuses the card for one that takes it", () => {
    renderBoard();

    press("ALPHA-1");
    movePointer(atRow(1, 0));
    movePointer(atRow(2, 0));

    expect(shown()).toBe("2:0");
  });
});
