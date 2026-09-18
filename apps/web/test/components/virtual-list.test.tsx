import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageVirtualList, VirtualList } from "../../src/components/virtual-list";

const ROW_HEIGHT = 32;
const rows = Array.from({ length: 500 }, (_, index) => `row ${index}`);

/*
 * jsdom runs no layout, so every element measures zero and the virtualizer
 * decides nothing is on screen. It reads offsetHeight for both the viewport and
 * a row, so the stub answers a row with its real height and everything else
 * with the height its own style declares — which is what makes the window a
 * consequence of the height prop rather than of a constant in this file.
 */
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.tagName === "LI" ? ROW_HEIGHT : Number.parseFloat(this.style.height);
  });
  vi.stubGlobal("scrollTo", () => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderRows(height: number, getKey: (row: string) => string = (row) => row) {
  return render(
    <VirtualList
      items={rows}
      estimateSize={ROW_HEIGHT}
      label="Rows"
      height={height}
      getKey={getKey}
      renderItem={(row) => row}
    />,
  );
}

it("renders a window of rows rather than the whole collection", () => {
  renderRows(320);

  const rendered = screen.getAllByRole("listitem");
  expect(rendered.length).toBeGreaterThan(0);
  expect(rendered.length).toBeLessThan(rows.length);
  expect(screen.getByText("row 0")).toBeTruthy();
  expect(screen.getByRole("list")).toBeTruthy();
});

// The height is what bounds the scroll region: without a definite one the
// container grows to its content and every row renders.
it("sizes the window from the height it is given", () => {
  const short = renderRows(320).container.querySelectorAll("li").length;
  cleanup();
  const tall = renderRows(1600).container.querySelectorAll("li").length;

  expect(tall).toBeGreaterThan(short);
  expect(tall).toBeLessThan(rows.length);
});

it("puts the scroll region on the tab order under its own name", () => {
  renderRows(320);

  expect(screen.getByRole("group", { name: "Rows" }).tabIndex).toBe(0);
});

it("states the whole collection's size on a row the window happens to hold", () => {
  renderRows(320);

  const first = screen.getAllByRole("listitem")[0];
  expect(first?.getAttribute("aria-setsize")).toBe("500");
  expect(first?.getAttribute("aria-posinset")).toBe("1");
});

it("keys every row by its item rather than its position", () => {
  const getKey = vi.fn((row: string) => row);

  renderRows(320, getKey);

  expect(getKey).toHaveBeenCalledWith("row 0", 0);
  expect(screen.getByText("row 0")).toBeTruthy();
});

describe("PageVirtualList", () => {
  const LIST_TOP = 200;

  /*
   * The window virtualizer reads the viewport from the window and the list's top
   * from its box. jsdom has no layout, so the box is stubbed as a list 200px down
   * the page that moves up as the page scrolls.
   */
  beforeEach(() => {
    vi.stubGlobal("innerHeight", 320);
    vi.stubGlobal("scrollY", 0);
    placeListAt(LIST_TOP);
  });

  /** Puts the list's top `top` pixels down the page. */
  function placeListAt(top: number) {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ top: top - window.scrollY }) as DOMRect,
    );
  }

  function scrollPageTo(y: number) {
    act(() => {
      vi.stubGlobal("scrollY", y);
      window.dispatchEvent(new Event("scroll"));
    });
  }

  /** A list whose row at `at` draws something and holds no item of its own. */
  function decorationAt(at: number) {
    return {
      itemIndex: (_row: string, index: number): number | null => {
        if (index === at) {
          return null;
        }

        return index > at ? index - 1 : index;
      },
      itemCount: rows.length - 1,
    };
  }

  function renderPageRows(
    estimateSize: (row: string, index: number) => number = () => ROW_HEIGHT,
    decoration: ReturnType<typeof decorationAt> | undefined = undefined,
  ) {
    return render(
      <>
        <h2 id="rows-heading">Rows</h2>
        <PageVirtualList
          rows={rows}
          estimateSize={estimateSize}
          getKey={(row) => row}
          renderRow={(row) => row}
          labelledBy="rows-heading"
          gap={8}
          {...decoration}
        />
      </>,
    );
  }

  function positions(): number[] {
    return screen.getAllByRole("listitem").map((row) => Number(row.getAttribute("aria-posinset")));
  }

  it("renders a window of rows, named by the heading, each with its size and position", () => {
    renderPageRows();

    const rendered = within(screen.getByRole("list", { name: "Rows" })).getAllByRole("listitem");
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(rows.length);
    expect(rendered[0]?.getAttribute("aria-setsize")).toBe("500");
    expect(positions()[0]).toBe(1);
    expect(screen.getByText("row 0")).toBeTruthy();
  });

  it("hides a row that holds no item, and counts and numbers the list without it", () => {
    renderPageRows(() => ROW_HEIGHT, decorationAt(2));

    const rendered = [...screen.getByRole("list", { name: "Rows" }).querySelectorAll("li")];
    expect(rendered[2]?.getAttribute("aria-hidden")).toBe("true");
    expect(rendered[2]?.getAttribute("aria-posinset")).toBeNull();
    expect(rendered[0]?.getAttribute("aria-setsize")).toBe("499");
    expect(rendered.slice(0, 5).map((row) => row.getAttribute("data-index"))).toEqual(["0", "1", null, "2", "3"]);
    expect(rendered.slice(0, 5).map((row) => row.getAttribute("aria-posinset"))).toEqual(["1", "2", null, "3", "4"]);
  });

  // The virtualizer reads a measured row back by this attribute, so a row that
  // holds no item has to carry its own index as well as no item index.
  it("numbers every row for the virtualizer, the row that holds no item included", () => {
    renderPageRows(() => ROW_HEIGHT, decorationAt(2));

    const rendered = [...screen.getByRole("list", { name: "Rows" }).querySelectorAll("li")];
    expect(rendered.slice(0, 5).map((row) => row.getAttribute("data-row-index"))).toEqual(["0", "1", "2", "3", "4"]);
  });

  it("hands the virtualizer a row index it can read back off every row it measures", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    renderPageRows(() => ROW_HEIGHT, decorationAt(2));

    expect(warn).not.toHaveBeenCalled();
  });

  it("places each row below the list's top, one gap apart", () => {
    renderPageRows();

    const [first, second] = screen.getAllByRole("listitem");
    expect(first?.style.transform).toBe("translateY(0px)");
    expect(second?.style.transform).toBe(`translateY(${String(ROW_HEIGHT + 8)}px)`);
  });

  // Memoized by the compiler, the component keeps the first window after a scroll.
  it("follows the page scroll", () => {
    renderPageRows();

    scrollPageTo(8000);

    expect(Math.min(...positions())).toBeGreaterThan(100);
    expect(screen.queryByText("row 0")).toBeNull();
  });

  it("sizes a row it has not measured by the estimate for its item", () => {
    const estimateSize = vi.fn((row: string) => (row === "row 499" ? 100 : ROW_HEIGHT));

    renderPageRows(estimateSize);

    expect(estimateSize).toHaveBeenCalledWith("row 499", 499);
    expect(screen.getByRole("list").style.height).toBe(`${String(499 * ROW_HEIGHT + 100 + 499 * 8)}px`);
  });

  it("scrolls the page to the row it is asked to, which then renders", async () => {
    // The page is as tall as the list below its top.
    vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(LIST_TOP + rows.length * (ROW_HEIGHT + 8));
    vi.stubGlobal("scrollTo", ({ top }: ScrollToOptions) => {
      vi.stubGlobal("scrollY", top);
      window.dispatchEvent(new Event("scroll"));
    });
    const list = (scrollToIndex?: number) => (
      <>
        <h2 id="rows-heading">Rows</h2>
        <PageVirtualList
          rows={rows}
          estimateSize={() => ROW_HEIGHT}
          getKey={(row) => row}
          renderRow={(row) => row}
          labelledBy="rows-heading"
          gap={8}
          scrollToIndex={scrollToIndex}
        />
      </>
    );
    const { rerender } = render(list());
    expect(screen.queryByText("row 300")).toBeNull();

    rerender(list(300));

    await vi.waitFor(() => {
      expect(screen.getByText("row 300")).toBeTruthy();
    });
    expect(window.scrollY).toBeGreaterThan(LIST_TOP + 290 * (ROW_HEIGHT + 8));
  });

  it("makes each row a focus target that is not a tab stop", () => {
    renderPageRows();

    expect(screen.getAllByRole("listitem").every((row) => row.tabIndex === -1)).toBe(true);
  });

  it("measures the list's top again when the window is resized", () => {
    renderPageRows();

    // The list moves 8000px further down the page with no render of the list.
    placeListAt(LIST_TOP + 8000);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    scrollPageTo(8000);

    expect(positions()[0]).toBe(1);
  });

  it("measures the list's top again when the body changes size, and stops when unmounted", () => {
    // The virtualizer observes its rows too; only the observer of the body is kept.
    let report = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        callback: () => void;
        body = false;

        constructor(callback: () => void) {
          this.callback = callback;
        }

        observe(target: Element) {
          if (target === document.body) {
            this.body = true;
            report = this.callback;
          }
        }

        unobserve() {}

        disconnect() {
          if (this.body) {
            disconnect();
          }
        }
      },
    );
    const { unmount } = renderPageRows();

    placeListAt(LIST_TOP + 8000);
    act(() => {
      report();
    });
    scrollPageTo(8000);

    expect(positions()[0]).toBe(1);

    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(() => {
      report();
    }).not.toThrow();
  });
});
