import { Popover } from "@base-ui/react/popover";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it } from "vitest";

function Example() {
  return (
    <Popover.Root>
      <Popover.Trigger>Open</Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner>
          <Popover.Popup>Popover content</Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

beforeEach(() => {
  document.documentElement.className = "dark";
});

afterEach(() => {
  cleanup();
  document.documentElement.className = "";
});

/*
 * jsdom neither lays out nor resolves custom properties from a stylesheet, so
 * this asserts the invariant that actually protects the design: the theme
 * class sits on <html>, above every portal. Moving it to a wrapper inside the
 * app would silently strip the tokens from every popup in the app.
 */
it("renders the popup outside the app, under the themed root", async () => {
  const user = userEvent.setup();
  const { container } = render(<Example />);

  await user.click(screen.getByRole("button", { name: "Open" }));

  const popup = await screen.findByText("Popover content");
  expect(container.contains(popup)).toBe(false);
  expect(document.body.contains(popup)).toBe(true);
  expect(document.documentElement.contains(popup)).toBe(true);
  expect(document.querySelector(".dark")).toBe(document.documentElement);
});

it("returns focus to the trigger when the popup closes", async () => {
  const user = userEvent.setup();
  render(<Example />);
  const trigger = screen.getByRole("button", { name: "Open" });

  await user.click(trigger);
  await screen.findByText("Popover content");
  await user.keyboard("{Escape}");

  await waitFor(() => {
    expect(screen.queryByText("Popover content")).toBeNull();
  });
  expect(document.activeElement).toBe(trigger);
});
