import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { Tooltip } from "../../src/components/tooltip";

// Above the 600 ms open delay of a hover.
const PAST_HOVER_DELAY = { timeout: 1500 };

const AT_ONCE = { timeout: 100 };

const SETTLE_MS = 200;

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
}

function Example() {
  return (
    <>
      <Tooltip content="Full destination">
        <a href="https://example.com/a" className="link">Example</a>
      </Tooltip>
      <button type="button">After</button>
    </>
  );
}

afterEach(() => {
  cleanup();
});

it("opens on pointer hover after the delay", async () => {
  const user = userEvent.setup();
  render(<Example />);

  await user.hover(screen.getByRole("link", { name: "Example" }));

  expect(await screen.findByText("Full destination", undefined, PAST_HOVER_DELAY)).toBeDefined();
});

// user-event gives a leave event no relatedTarget, and the hover logic reads it to tell a move onto the popup apart.
function movePointer(from: Element, to: Element): void {
  fireEvent.pointerLeave(from, { relatedTarget: to });
  fireEvent.mouseLeave(from, { relatedTarget: to });
  fireEvent.pointerEnter(to);
  fireEvent.mouseEnter(to);
  fireEvent.mouseMove(to);
}

it("stays open while the pointer moves from the trigger onto the popup", async () => {
  const user = userEvent.setup();
  render(<Example />);
  const link = screen.getByRole("link", { name: "Example" });

  await user.hover(link);
  const popup = await screen.findByText("Full destination", undefined, PAST_HOVER_DELAY);
  movePointer(link, popup);

  await settle();
  expect(popup.isConnected).toBe(true);
});

it("closes when the pointer leaves the trigger for the page", async () => {
  const user = userEvent.setup();
  render(<Example />);
  const link = screen.getByRole("link", { name: "Example" });

  await user.hover(link);
  await screen.findByText("Full destination", undefined, PAST_HOVER_DELAY);
  movePointer(link, document.body);

  await waitFor(() => {
    expect(screen.queryByText("Full destination")).toBeNull();
  });
});

it("opens at once on keyboard focus and stays open while the focus stays", async () => {
  const user = userEvent.setup();
  render(<Example />);

  await user.tab();

  expect(document.activeElement).toBe(screen.getByRole("link", { name: "Example" }));
  expect(await screen.findByText("Full destination", undefined, AT_ONCE)).toBeDefined();
  await settle();
  expect(screen.getByText("Full destination")).toBeDefined();
});

it("closes on Escape", async () => {
  const user = userEvent.setup();
  render(<Example />);

  await user.tab();
  await screen.findByText("Full destination");
  await user.keyboard("{Escape}");

  await waitFor(() => {
    expect(screen.queryByText("Full destination")).toBeNull();
  });
});

it("closes when the focus leaves", async () => {
  const user = userEvent.setup();
  render(<Example />);

  await user.tab();
  await screen.findByText("Full destination");
  await user.tab();

  expect(document.activeElement).toBe(screen.getByRole("button", { name: "After" }));
  await waitFor(() => {
    expect(screen.queryByText("Full destination")).toBeNull();
  });
});

it("keeps the element and the attributes of its trigger", () => {
  render(<Example />);

  const link = screen.getByRole("link", { name: "Example" });
  expect(link.tagName).toBe("A");
  expect(link.getAttribute("href")).toBe("https://example.com/a");
  expect(link.classList.contains("link")).toBe(true);
});

it("renders the popup in a portal under the body, outside the render container", async () => {
  const user = userEvent.setup();
  const { container } = render(<Example />);

  await user.tab();
  const popup = await screen.findByText("Full destination");

  expect(container.contains(popup)).toBe(false);
  expect(document.body.contains(popup)).toBe(true);
});
