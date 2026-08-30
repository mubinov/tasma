import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../../src/components/error-boundary";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("renders its children while nothing throws", () => {
  render(
    <ErrorBoundary>
      <p>the app</p>
    </ErrorBoundary>,
  );

  expect(screen.getByText("the app")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("replaces a render error with a message inside a landmark, not a blank window", () => {
  // React reports every caught render error on the console; the test asserts
  // the boundary, not the noise.
  vi.spyOn(console, "error").mockImplementation(() => {});

  function Broken(): never {
    throw new Error("the shell could not render");
  }

  render(
    <ErrorBoundary>
      <Broken />
    </ErrorBoundary>,
  );

  const alert = screen.getByRole("alert");
  expect(alert).toBeTruthy();
  expect(screen.getByText("the shell could not render")).toBeTruthy();
  expect(screen.getByRole("main").contains(alert)).toBe(true);
});

// The tree holding the focused element is gone, so focus would fall to <body>,
// and a live region inserted already populated may never be announced.
it("moves focus onto the message rather than letting it fall to the body", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});

  function Broken(): never {
    throw new Error("the shell could not render");
  }

  render(
    <ErrorBoundary>
      <Broken />
    </ErrorBoundary>,
  );

  const alert = screen.getByRole("alert");
  expect(alert.tabIndex).toBe(-1);
  expect(document.activeElement).toBe(alert);
});

// jsdom lays nothing out, so the class contract is the honest assertion. The
// commonest real message is a module URL — one unbroken token whose min-content
// width would size the panel past a narrow window, and a centred flex child
// wider than its container overflows on both sides, putting the heading off the
// left edge where no scrolling reaches it.
it("keeps a long unbroken message inside a narrow window", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});

  const message
    = "Failed to fetch dynamically imported module: http://localhost:5173/src/features/workspace/board/columns/column-header-menu.tsx?t=1788100727450";

  function Broken(): never {
    throw new Error(message);
  }

  render(
    <ErrorBoundary>
      <Broken />
    </ErrorBoundary>,
  );

  const panel = screen.getByRole("alert");
  expect(screen.getByText(message).classList.contains("wrap-anywhere")).toBe(true);
  expect(panel.classList.contains("w-full")).toBe(true);
  expect(panel.classList.contains("max-w-lg")).toBe(true);
});

// React hands the boundary whatever was thrown. A string leaves `message`
// undefined, so the panel would show an empty code block; `null` would read as
// the "nothing failed" state and re-render the children that just threw.
it.each([
  { thrown: "the shell could not render", shown: "the shell could not render" },
  { thrown: null, shown: "null" },
])("reports a throw that is not an Error: $thrown", ({ thrown, shown }) => {
  vi.spyOn(console, "error").mockImplementation(() => {});

  function Broken(): never {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- throwing a non-Error is the case under test
    throw thrown;
  }

  render(
    <ErrorBoundary>
      <Broken />
    </ErrorBoundary>,
  );

  expect(screen.getByRole("alert").textContent).toContain(shown);
});
