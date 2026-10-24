import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageVirtualList, VirtualList } from "../../src/components/virtual-list";
import { stubResizeObservers } from "../helpers";

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

it("names the scroll region by the element that labelledBy names, in place of a label", () => {
  render(
    <>
      <h2 id="rows-heading">Rows</h2>
      <VirtualList items={rows} estimateSize={ROW_HEIGHT} labelledBy="rows-heading" height={320} getKey={(row) => row} renderItem={(row) => row} />
    </>,
  );

  const region = screen.getByRole("group", { name: "Rows" });
  expect(region.tabIndex).toBe(0);
  expect(region.getAttribute("aria-label")).toBeNull();
  expect(screen.getByRole("list").getAttribute("aria-labelledby")).toBeNull();
});

it("states the total it is given as the size of the list", () => {
  render(<VirtualList items={rows} estimateSize={ROW_HEIGHT} label="Rows" height={320} getKey={(row) => row} renderItem={(row) => row} total={1200} />);

  expect(screen.getAllByRole("listitem")[0]?.getAttribute("aria-setsize")).toBe("1200");
});

it("shows the footer after the rows, inside the scroll region, as no row", () => {
  render(
    <VirtualList
      items={rows}
      estimateSize={ROW_HEIGHT}
      label="Rows"
      height={320}
      getKey={(row) => row}
      renderItem={(row) => row}
      footer={<p>The end</p>}
    />,
  );

  const footer = screen.getByText("The end");
  expect(footer.parentElement!.parentElement).toBe(screen.getByRole("group", { name: "Rows" }));
  expect(footer.parentElement!.previousElementSibling).toBe(screen.getByRole("list"));
  expect(footer.closest("li")).toBeNull();
});

/** Gives the element a scroll offset, which jsdom keeps at 0, and a `scrollTo` that moves it. */
function scrollable(element: HTMLElement) {
  let top = 0;
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value;
    },
  });
  element.scrollTo = ((options: ScrollToOptions) => {
    top = options.top!;
    element.dispatchEvent(new Event("scroll"));
  }) as typeof element.scrollTo;

  return {
    top: () => top,
    scrollTo(y: number) {
      act(() => {
        top = y;
        element.dispatchEvent(new Event("scroll"));
      });
    },
  };
}

describe("onEnd", () => {
  it("is called when the end of the rows is one list height or less below the part in view", () => {
    const onEnd = vi.fn();
    const { container } = render(
      <VirtualList items={rows} estimateSize={ROW_HEIGHT} label="Rows" height={320} getKey={(row) => row} renderItem={(row) => row} onEnd={onEnd} />,
    );
    const region = scrollable(container.firstElementChild as HTMLElement);
    expect(onEnd).not.toHaveBeenCalled();

    // 500 rows of 32px: the end is 16000px down, and the part in view ends at the offset and 320px.
    region.scrollTo(16000 - 320 - 321);
    expect(onEnd).not.toHaveBeenCalled();

    region.scrollTo(16000 - 320 - 320);
    expect(onEnd).toHaveBeenCalled();
  });

  it("is called after the first render of a list that ends in view", () => {
    const onEnd = vi.fn();

    render(
      <VirtualList items={rows.slice(0, 3)} estimateSize={ROW_HEIGHT} label="Rows" height={320} getKey={(row) => row} renderItem={(row) => row} onEnd={onEnd} />,
    );

    expect(onEnd).toHaveBeenCalled();
  });
});

type RovingProps = {
  items?: readonly string[];
  preferredKey?: string;
  focusOnMount?: boolean;
  onEnd?: () => void;
  anchorTop?: boolean;
  footer?: ReactNode;
  height?: number;
};

function rovingList(
  { items = rows, preferredKey, focusOnMount, onEnd, anchorTop, footer, height = 320 }: RovingProps = {},
) {
  return (
    <>
      <button type="button">Before</button>
      <h2 id="rows-heading">Rows</h2>
      <VirtualList
        items={items}
        estimateSize={ROW_HEIGHT}
        labelledBy="rows-heading"
        roving={{ preferredKey, focusOnMount }}
        height={height}
        getKey={(row) => row}
        renderItem={(row, _index, tabIndex) => <a href={`#${row}`} tabIndex={tabIndex}>{row}</a>}
        onEnd={onEnd}
        anchorTop={anchorTop}
        footer={footer}
      />
    </>
  );
}

function link(name: string): HTMLElement {
  return screen.getByRole("link", { name });
}

function tabStops(): string[] {
  return screen.getAllByRole("link").filter((element) => element.tabIndex === 0).map((element) => element.textContent);
}

describe("roving", () => {
  it("names the list by labelledBy, and gives the scroll region no tab stop, role or name", () => {
    const { container } = render(rovingList());
    const region = container.querySelector<HTMLElement>("ul")!.parentElement!;

    expect(screen.getByRole("list", { name: "Rows" })).toBeTruthy();
    expect(region.hasAttribute("tabindex")).toBe(false);
    expect(region.hasAttribute("role")).toBe(false);
    expect(region.hasAttribute("aria-label")).toBe(false);
    expect(region.hasAttribute("aria-labelledby")).toBe(false);
  });

  it("makes the first row the one tab stop, and hands every other row -1", () => {
    render(rovingList());

    expect(tabStops()).toEqual(["row 0"]);
    expect(link("row 1").tabIndex).toBe(-1);
  });

  it("makes the row of preferredKey the tab stop, and the first row when the key is not in the list", () => {
    const { rerender } = render(rovingList({ preferredKey: "row 3" }));
    expect(tabStops()).toEqual(["row 3"]);

    rerender(rovingList({ preferredKey: "gone" }));
    expect(tabStops()).toEqual(["row 0"]);
  });

  it("moves the focus with Down, Up, Home and End, and makes the focused row the tab stop", async () => {
    const user = userEvent.setup();
    render(rovingList());
    link("row 0").focus();

    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(document.activeElement).toBe(link("row 2"));
    expect(tabStops()).toEqual(["row 2"]);

    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(link("row 1"));

    await user.keyboard("{End}");
    expect(document.activeElement).toBe(link("row 499"));

    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(link("row 0"));
  });

  it("keeps the focus on the first row on Up, and on the last row on Down", async () => {
    const user = userEvent.setup();
    render(rovingList({ items: rows.slice(0, 3) }));
    link("row 0").focus();

    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(link("row 0"));

    link("row 2").focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(link("row 2"));
  });

  it("calls onEnd on Down on the last row", async () => {
    const user = userEvent.setup();
    const onEnd = vi.fn();
    render(rovingList({ onEnd }));
    link("row 0").focus();
    await user.keyboard("{End}");
    onEnd.mockClear();

    await user.keyboard("{ArrowDown}");

    expect(onEnd).toHaveBeenCalledOnce();
  });

  it("leaves a key with a modifier, and any other key, to the page", () => {
    render(rovingList());
    link("row 0").focus();

    for (const init of [{ key: "ArrowDown", shiftKey: true }, { key: "ArrowDown", altKey: true }, { key: "End", ctrlKey: true }, { key: "Home", metaKey: true }, { key: "a" }]) {
      expect(fireEvent.keyDown(link("row 0"), init)).toBe(true);
    }
    expect(document.activeElement).toBe(link("row 0"));
  });

  it("does nothing for a key or a focus that reaches the list outside a row", () => {
    render(rovingList());

    expect(fireEvent.keyDown(screen.getByRole("list"), { key: "ArrowDown" })).toBe(true);
    fireEvent.focus(screen.getByRole("list"));
    expect(tabStops()).toEqual(["row 0"]);
  });

  it("tabs into the list on its tab stop and out of it in one step", async () => {
    const user = userEvent.setup();
    render(rovingList({ preferredKey: "row 2", footer: <button type="button">After</button> }));
    screen.getByRole("button", { name: "Before" }).focus();

    await user.tab();
    expect(document.activeElement).toBe(link("row 2"));

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "After" }));
  });

  it("focuses a clicked row that the click does not focus, and makes it the tab stop", () => {
    render(rovingList());

    fireEvent.click(link("row 4"));

    expect(document.activeElement).toBe(link("row 4"));
    expect(tabStops()).toEqual(["row 4"]);
  });

  it("leaves the focus on a clicked row that has it", () => {
    render(rovingList());
    const row = link("row 4");
    row.focus();
    const focus = vi.spyOn(row, "focus");

    fireEvent.click(row);

    expect(focus).not.toHaveBeenCalled();
  });

  it("does nothing for a click outside a row", () => {
    render(rovingList());

    fireEvent.click(screen.getByRole("list"));

    expect(document.activeElement).toBe(document.body);
  });

  it("focuses the row of the tab stop at mount with focusOnMount, and not after a later change of it", () => {
    const { unmount } = render(rovingList({ preferredKey: "row 300", focusOnMount: true }));
    expect(document.activeElement).toBe(link("row 300"));
    unmount();

    const { rerender } = render(rovingList({ preferredKey: "row 3" }));
    rerender(rovingList({ preferredKey: "row 3", focusOnMount: true }));
    expect(document.activeElement).toBe(document.body);
  });

  it("focuses the row of the tab stop at mount once the scroll region has a height and the row renders", () => {
    const list = (height: number) => rovingList({ preferredKey: "row 300", focusOnMount: true, height });
    const observers = stubResizeObservers();
    const { container, rerender } = render(list(0));
    expect(screen.queryAllByRole("listitem")).toEqual([]);
    expect(document.activeElement).toBe(document.body);

    rerender(list(320));
    observers.report(container.querySelector("ul")!.parentElement!);

    expect(document.activeElement).toBe(link("row 300"));
  });

  it("takes no focus at mount with focusOnMount and no rows", () => {
    render(rovingList({ items: [], focusOnMount: true }));

    expect(document.activeElement).toBe(document.body);
  });

  it("keeps the row of the tab stop rendered when the list scrolls away from it", () => {
    const { container } = render(rovingList({ preferredKey: "row 2" }));
    const region = scrollable(container.querySelector<HTMLElement>("ul")!.parentElement!);

    region.scrollTo(8000);

    expect(screen.queryByText("row 0")).toBeNull();
    expect(link("row 2")).toBeTruthy();
  });

  it("moves the tab stop to preferredKey, else to the first row, when the row of the tab stop leaves the list", () => {
    const { rerender } = render(rovingList({ preferredKey: "row 1" }));
    fireEvent.click(link("row 4"));
    screen.getByRole("button", { name: "Before" }).focus();

    rerender(rovingList({ items: rows.filter((row) => row !== "row 4"), preferredKey: "row 1" }));
    expect(tabStops()).toEqual(["row 1"]);

    fireEvent.click(link("row 5"));
    screen.getByRole("button", { name: "Before" }).focus();
    rerender(rovingList({ items: rows.filter((row) => row !== "row 4" && row !== "row 5") }));
    expect(tabStops()).toEqual(["row 0"]);
  });

  it("moves the focus from a focused row that leaves the list to the row after it", () => {
    const { rerender } = render(rovingList());
    link("row 2").focus();

    rerender(rovingList({ items: rows.filter((row) => row !== "row 2") }));

    expect(document.activeElement).toBe(link("row 3"));
    expect(tabStops()).toEqual(["row 3"]);
  });

  it("moves the focus from a focused last row that leaves the list to the row before it", () => {
    const items = rows.slice(0, 3);
    const { rerender } = render(rovingList({ items }));
    link("row 2").focus();

    rerender(rovingList({ items: items.slice(0, 2) }));

    expect(document.activeElement).toBe(link("row 1"));
  });

  it("moves the focus to no row when the focused row leaves with all others", () => {
    const { rerender } = render(rovingList({ items: rows.slice(0, 2) }));
    link("row 1").focus();

    rerender(rovingList({ items: [] }));

    expect(document.activeElement).toBe(document.body);
  });

  it("drops a focus move to a row that leaves the list in the same update", () => {
    const { rerender } = render(rovingList({ items: rows.slice(0, 3) }));
    link("row 0").focus();

    act(() => {
      fireEvent.keyDown(link("row 0"), { key: "ArrowDown" });
      rerender(rovingList({ items: ["row 0", "row 2"] }));
    });

    expect(document.activeElement).toBe(link("row 0"));
    expect(tabStops()).toEqual(["row 0"]);
  });

  it("moves no focus from a focused row that leaves a list without roving", () => {
    const list = (items: readonly string[]) => (
      <VirtualList items={items} estimateSize={ROW_HEIGHT} label="Rows" height={320} getKey={(row) => row} renderItem={(row) => <button type="button">{row}</button>} />
    );
    const { rerender } = render(list(rows.slice(0, 3)));
    screen.getByRole("button", { name: "row 1" }).focus();

    rerender(list(["row 0", "row 2"]));

    expect(document.activeElement).toBe(document.body);
  });
});

describe("footer", () => {
  const END = rows.length * ROW_HEIGHT;
  let footerHeight = 16;

  // Of the elements the list measures, only the footer has no height in its style. The region ends past the rows by
  // the footer.
  beforeEach(() => {
    footerHeight = 16;
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.tagName === "LI" ? ROW_HEIGHT : this.style.height === "" ? footerHeight : Number.parseFloat(this.style.height);
    });
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(() => END + footerHeight);
  });

  function regionOf(container: HTMLElement): HTMLElement {
    return container.querySelector("ul")!.parentElement!;
  }

  it("scrolls the region to its end when the footer grows while the end of the rows is in view", () => {
    const { container, rerender } = render(rovingList({ footer: <p /> }));
    const region = scrollable(regionOf(container));
    // The last pixel of the rows is below the part in view.
    region.scrollTo(END - 320 - 1);

    footerHeight = 40;
    rerender(rovingList({ footer: <p>Loading</p> }));

    expect(region.top()).toBe(END + 40);
  });

  it("keeps the offset when the footer grows while the end of the rows is below the part in view", () => {
    const { container, rerender } = render(rovingList({ footer: <p /> }));
    const region = scrollable(regionOf(container));
    region.scrollTo(END - 320 - 2);

    footerHeight = 40;
    rerender(rovingList({ footer: <p>Loading</p> }));

    expect(region.top()).toBe(END - 320 - 2);
  });

  it("keeps the offset when the footer shrinks or keeps its height", () => {
    footerHeight = 40;
    const { container, rerender } = render(rovingList({ footer: <p>Loading</p> }));
    const region = scrollable(regionOf(container));
    region.scrollTo(END - 320);

    rerender(rovingList({ footer: <p>Still loading</p> }));
    footerHeight = 16;
    rerender(rovingList({ footer: <p /> }));

    expect(region.top()).toBe(END - 320);
  });

  it("keeps the offset at mount, with a footer and the end of the rows in view", () => {
    const { container } = render(rovingList({ items: rows.slice(0, 3), footer: <p>Loading</p> }));

    expect(regionOf(container).scrollTop).toBe(0);
  });
});

describe("anchorTop", () => {
  const anchored = (items: readonly string[]) => rovingList({ items, anchorTop: true });
  const added = ["new 1", "new 0", ...rows];

  function regionOf(container: HTMLElement) {
    return scrollable(container.querySelector<HTMLElement>("ul")!.parentElement!);
  }

  it("shows rows that come first at the top while the list is at its top, with neither the pointer nor the focus in it", () => {
    const { container, rerender } = render(anchored(rows));
    const region = regionOf(container);

    rerender(anchored(added));

    expect(region.top()).toBe(0);
    expect(screen.getAllByRole("listitem")[0]?.textContent).toBe("new 1");
  });

  it("keeps the rows in view in place when rows come first while the list is scrolled", () => {
    const { container, rerender } = render(anchored(rows));
    const region = regionOf(container);
    region.scrollTo(320);

    rerender(anchored(added));

    expect(region.top()).toBe(320 + 2 * ROW_HEIGHT);
  });

  it("keeps the rows in view in place when rows come first while the pointer is in the list", () => {
    const { container, rerender } = render(anchored(rows));
    const region = regionOf(container);
    fireEvent.pointerEnter(container.querySelector("ul")!.parentElement!);

    rerender(anchored(added));

    expect(region.top()).toBe(2 * ROW_HEIGHT);
  });

  it("keeps the rows in view in place when rows come first while the focus is in the list, and not after the focus leaves", () => {
    const { container, rerender } = render(anchored(rows));
    const region = regionOf(container);
    link("row 0").focus();

    rerender(anchored(added));
    expect(region.top()).toBe(2 * ROW_HEIGHT);

    region.scrollTo(0);
    screen.getByRole("button", { name: "Before" }).focus();
    rerender(anchored(["newer", ...added]));
    expect(region.top()).toBe(0);
  });

  it("shows rows that come first at the top again after the pointer leaves", () => {
    const { container, rerender } = render(anchored(rows));
    const region = regionOf(container);
    const element = container.querySelector("ul")!.parentElement!;
    fireEvent.pointerEnter(element);
    fireEvent.pointerLeave(element);

    rerender(anchored(added));

    expect(region.top()).toBe(0);
  });

  it("does not anchor without anchorTop", () => {
    const { container, rerender } = render(rovingList({ items: rows }));
    const region = regionOf(container);
    region.scrollTo(320);

    rerender(rovingList({ items: added }));

    expect(region.top()).toBe(320);
  });
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
