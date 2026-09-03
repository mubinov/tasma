import { ProtocolError, TransportError } from "@tasma/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { DAEMON_URL } from "../../src/api/transport";
import { ErrorBoundary, ErrorPanel, ErrorScreen } from "../../src/components/error-boundary";

const NO_DAEMON = new TransportError("GET /health reached no daemon");
// A status is present only where an answer arrived — a proxy with nothing
// behind it answers this way.
const NO_ENVELOPE = new TransportError("GET /health answered with no envelope", 502);
const REFUSED = new ProtocolError(
  { kind: "store", code: "config-invalid", message: "config.yml is not a mapping" },
  422,
);
const CRASH = new Error("the shell could not render");

afterEach(() => {
  cleanup();
  document.title = "tasma";
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

/*
 * The screen that named the document is gone with the tree that threw, so
 * without a title of its own the tab, the window list and a bookmark keep on
 * saying which screen the user was reading.
 */
it("names the document after the failure rather than the screen that is gone", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  document.title = "Tasks · tasma";

  function Broken(): never {
    throw new Error("the shell could not render");
  }

  render(
    <ErrorBoundary>
      <Broken />
    </ErrorBoundary>,
  );

  expect(document.title).toBe("Stopped rendering · tasma");
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

/*
 * The panel carries no landmark of its own: the router renders it inside the
 * shell's <main>, and a second one there would nest one landmark in another and
 * leave a screen-reader user two main regions to choose between. ErrorScreen is
 * the wrapper for the one place no shell renders around it.
 */
it("leaves the landmark to the shell and supplies one only where no shell renders", () => {
  const { unmount } = render(<ErrorPanel error={CRASH} />);
  expect(screen.queryByRole("main")).toBeNull();
  unmount();

  render(<ErrorScreen error={CRASH} />);
  expect(screen.getAllByRole("main")).toHaveLength(1);
  expect(screen.getByRole("main").contains(screen.getByRole("alert"))).toBe(true);
});

/*
 * Four failures, four things to say. A refusal presented as "tasma stopped
 * rendering" would be actively wrong about a config.yml the reader can go and
 * fix, and an unreachable daemon is not a fault in the app at all.
 */
it.each([
  { failure: "a daemon that never answered", error: NO_DAEMON, heading: "tasma cannot reach the daemon" },
  { failure: "an answer that is not an envelope", error: NO_ENVELOPE, heading: "tasma cannot read the daemon's answer" },
  { failure: "a request the daemon refused", error: REFUSED, heading: "the daemon refused this request" },
  { failure: "a render crash", error: CRASH, heading: "tasma stopped rendering" },
])("heads $failure with its own words", ({ error, heading }) => {
  render(<ErrorPanel error={error} />);

  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(heading);
});

// The screen that named the document is gone, and every failure names the tab
// after itself rather than after the screen the reader was on.
it.each([
  { error: NO_DAEMON, title: "No daemon · tasma" },
  { error: NO_ENVELOPE, title: "Unreadable answer · tasma" },
  { error: REFUSED, title: "Request refused · tasma" },
  { error: CRASH, title: "Stopped rendering · tasma" },
])("names the document $title", ({ error, title }) => {
  render(<ErrorPanel error={error} />);

  expect(document.title).toBe(title);
});

// The other arm's promise that nothing was read would be false here: whatever
// answered may well have carried the request out.
it("prints the status and the fault when something answered for the daemon", () => {
  render(<ErrorPanel error={NO_ENVELOPE} />);

  expect(screen.getByText(`${DAEMON_URL} · HTTP 502`)).toBeTruthy();
  expect(screen.getByText("GET /health answered with no envelope")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).not.toContain("Nothing on disk");
});

// The address is the one thing the reader acts on, and it is a single unbroken
// token, so it takes the block that wraps anywhere.
it("prints the daemon's address when nothing answered there", () => {
  render(<ErrorPanel error={NO_DAEMON} />);

  expect(screen.getByText(DAEMON_URL).classList.contains("wrap-anywhere")).toBe(true);
});

// The daemon's own code and message, not a paraphrase: the code is what a
// person searches for and the message is what names the file.
it("prints the daemon's own code and message when it refused", () => {
  render(<ErrorPanel error={REFUSED} />);

  expect(screen.getByText("store/config-invalid")).toBeTruthy();
  expect(screen.getByText("config.yml is not a mapping")).toBeTruthy();
});

/*
 * The panel calls what it is handed and knows nothing of what that repeats;
 * test/router.test.tsx proves the recovery itself. Retry is offered only where
 * asking again could answer differently, never for a refusal or a crash.
 */
it.each([
  { failure: "a daemon that never answered", error: NO_DAEMON },
  { failure: "an answer that is not an envelope", error: NO_ENVELOPE },
])("calls the reset it was handed when Retry is clicked for $failure", async ({ error }) => {
  const reset = vi.fn();
  render(<ErrorPanel error={error} reset={reset} />);

  await userEvent.click(screen.getByRole("button", { name: "Retry" }));

  expect(reset).toHaveBeenCalledTimes(1);
});

it.each([
  { failure: "a request the daemon refused", error: REFUSED },
  { failure: "a render crash", error: CRASH },
])("offers no retry for $failure", ({ error }) => {
  render(<ErrorPanel error={error} reset={vi.fn()} />);

  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

// A throw from inside the fallback reaches no boundary, so the window would go
// blank instead of naming the failure.
it("shows a refusal whose message is not a string rather than blanking the window", () => {
  const malformed = new ProtocolError(
    { kind: "store", code: "config-invalid", message: { path: "config.yml" } } as never,
    422,
  );

  render(<ErrorPanel error={malformed} />);

  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("the daemon refused this request");
  expect(screen.getByText("store/config-invalid")).toBeTruthy();
});

// The class boundary has caught a render crash and has no loader to re-run, so
// it passes no reset. Typing reset as required would compile against the router
// and break this path.
it("offers no retry where the caller supplied no reset", () => {
  render(<ErrorPanel error={NO_DAEMON} />);

  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

/*
 * The router re-renders the panel on any state change around it, a pending
 * reset included. Focus moves once, on mount: taking it a second time would
 * pull the reader off the Retry button they had just reached.
 */
it("holds its content and leaves focus where it is when it re-renders", () => {
  const reset = vi.fn();
  const { rerender } = render(<ErrorPanel error={NO_DAEMON} reset={reset} />);
  const retry = screen.getByRole("button", { name: "Retry" });
  retry.focus();

  rerender(<ErrorPanel error={NO_DAEMON} reset={reset} />);

  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("tasma cannot reach the daemon");
  expect(screen.getByText(DAEMON_URL)).toBeTruthy();
  expect(document.activeElement).toBe(retry);
});

/*
 * A panel mounted with the repeat already running replaces the one the reader
 * pressed Retry on, so it lands them back on that control and reports the wait
 * instead of alerting them with the failure they are waiting on.
 */
it("lands on the control and reports the wait while a repeat is running", () => {
  render(<ErrorPanel error={NO_DAEMON} reset={vi.fn()} retrying />);

  const retry = screen.getByRole("button", { name: "Retrying…" });
  expect(document.activeElement).toBe(retry);
  expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");
  expect(screen.queryByRole("alert")).toBeNull();
});

// A failure that offers no repeat can still be waiting on one another part of
// the app asked for, and focus has nowhere else to go but the message.
it("falls back to the message where a repeat is running with no control to land on", () => {
  render(<ErrorPanel error={REFUSED} retrying />);

  const status = screen.getByRole("status");
  expect(screen.queryByRole("button", { name: "Retrying…" })).toBeNull();
  expect(document.activeElement).toBe(status);
});
