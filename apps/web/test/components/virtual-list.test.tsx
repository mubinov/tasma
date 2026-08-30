import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VirtualList } from "../../src/components/virtual-list";

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
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
