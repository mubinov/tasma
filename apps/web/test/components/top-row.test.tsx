import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { TopRow, TopRowTitle } from "../../src/components/top-row";

afterEach(() => {
  cleanup();
});

const LINE = [
  "flex",
  "min-h-top-bar",
  "flex-wrap",
  "items-center",
  "gap-x-5",
  "gap-y-2",
  "px-6",
  "py-2.5",
  "sm:px-10",
  "[&_*]:scroll-mt-top-bar",
];

const MAIN_PADDING = ["-mx-6", "-mt-6", "sm:-mx-10", "sm:-mt-10"];

const SIDEWAYS = ["sticky", "left-(--sidebar-width)", "w-[min(100%,calc(100vw-var(--sidebar-width)))]"];

function rowOf(control: HTMLElement): { outer: Element; inner: Element } {
  const inner = control.parentElement!;

  return { outer: inner.parentElement!, inner };
}

it("draws the line below the row, cancels the padding of main, holds the height of the task page's row and takes a focus scroll to a control to the top of the page", () => {
  render(<TopRow><button type="button">Act</button></TopRow>);

  const { outer, inner } = rowOf(screen.getByRole("button", { name: "Act" }));

  expect([...outer.classList]).toEqual(["border-b", "border-line", ...MAIN_PADDING]);
  expect([...inner.classList]).toEqual(LINE);
});

it("sticks a wide row to the left of the page only, inside a box that sets its own width", () => {
  render(<TopRow wide><button type="button">Act</button></TopRow>);

  const { outer, inner } = rowOf(screen.getByRole("button", { name: "Act" }));

  expect([...outer.classList]).toEqual(["border-b", "border-line", "[contain:inline-size]"]);
  expect([...inner.classList]).toEqual([...LINE, ...SIDEWAYS]);
});

it("heads the page with an h1 of 18 px in the row", () => {
  render(<TopRow><TopRowTitle id="list-title">Lists</TopRowTitle></TopRow>);

  const heading = screen.getByRole("heading", { level: 1, name: "Lists" });

  expect(heading.id).toBe("list-title");
  expect([...heading.classList]).toEqual(["font-chrome", "text-lg", "font-semibold"]);
});

it("sets no id on a title without an id", () => {
  render(<TopRowTitle>Lists</TopRowTitle>);

  expect(screen.getByRole("heading", { level: 1 }).hasAttribute("id")).toBe(false);
});
