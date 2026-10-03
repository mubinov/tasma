import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ArrowCircleUpIcon, ArrowClockwiseIcon, CircleNotchIcon, WarningIcon } from "../../src/lib/icons";
import { useUiStore } from "../../src/store/ui";
import { AVAILABLE, renderApp, resetUpdateUi, stubApp, type Answer } from "../update-fixtures";

/** The markup of an icon, which tells the icons apart where nothing else does. */
function iconMarkup(Icon: ComponentType<{ size: number }>): string {
  const { container, unmount } = render(<Icon size={20} />);
  const markup = container.querySelector("svg")!.innerHTML;
  unmount();

  return markup;
}

beforeEach(resetUpdateUi);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each([
  ["no app answers", "unreachable" as const],
  ["the answer is a page", "page" as const],
  ["no update is found", { state: "none", current: "0.1.0" } satisfies Answer],
])("shows no item when %s", async (_name, answer) => {
  stubApp(answer);
  await renderApp();

  expect(screen.queryByRole("button", { name: /update|install|restart/i })).toBeNull();
  expect(screen.getAllByRole("listitem")).toHaveLength(5);
});

it.each([
  ["available", AVAILABLE, "Update to 0.2.0", ArrowCircleUpIcon, "text-signal"],
  ["installing", { ...AVAILABLE, state: "installing", progress: 42 }, "Installing 0.2.0", CircleNotchIcon, "text-dim"],
  ["ready", { ...AVAILABLE, state: "ready" }, "Restart to update", ArrowClockwiseIcon, "text-signal"],
  ["failed", { ...AVAILABLE, state: "failed", error: "The download failed." }, "Update failed", WarningIcon, "text-signal"],
] satisfies [string, Answer, string, ComponentType<{ size: number }>, string][])(
  "shows the %s state with its own icon, text and colour",
  async (_state, update, name, Icon, tone) => {
    stubApp(update);
    await renderApp();

    const item = await screen.findByRole("button", { name });
    expect(item.querySelector("svg")!.innerHTML).toBe(iconMarkup(Icon));
    expect(item.classList.contains(tone)).toBe(true);
    // Above Settings, in the sidebar's bottom list.
    const items = within(screen.getByRole("navigation")).getAllByRole("listitem");
    expect(items.at(-2)!.contains(item)).toBe(true);
  },
);

it("shows the percent of an install beside the item, out of its name, and keeps the item inert", async () => {
  stubApp({ ...AVAILABLE, state: "installing", progress: 42 });
  const user = userEvent.setup();
  await renderApp();

  const item = await screen.findByRole("button", { name: "Installing 0.2.0" });
  expect(item.textContent).toBe("Installing 0.2.0");
  const percent = screen.getByText("42%");
  expect(item.contains(percent)).toBe(false);
  expect(item.closest("li")!.contains(percent)).toBe(true);
  expect(percent.closest("[aria-hidden='true']")).not.toBeNull();
  expect(item.getAttribute("aria-disabled")).toBe("true");
  expect(item.classList.contains("hover:bg-surface")).toBe(false);

  await user.click(item);
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("keeps the item named once the sidebar collapses, and hides the percent with the label", async () => {
  stubApp({ ...AVAILABLE, state: "installing", progress: 42 });
  useUiStore.setState({ sidebarCollapsed: true });
  await renderApp();

  expect(await screen.findByRole("button", { name: "Installing 0.2.0" })).toBeTruthy();
  expect(screen.getByText("42%").classList.contains("sm:opacity-100")).toBe(false);
});

it("opens the update dialog from the item and returns focus to the item", async () => {
  stubApp(AVAILABLE);
  const user = userEvent.setup();
  await renderApp();

  const item = await screen.findByRole("button", { name: "Update to 0.2.0" });
  await user.click(item);

  const dialog = screen.getByRole("alertdialog", { name: "Tasma 0.2.0 is available" });
  await waitFor(() => {
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Later" }));
  });

  await user.click(within(dialog).getByRole("button", { name: "Later" }));

  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(document.activeElement).toBe(item);
});

it("returns focus to the item when the press that opened the dialog left focus elsewhere", async () => {
  stubApp(AVAILABLE);
  const user = userEvent.setup();
  await renderApp();

  const item = await screen.findByRole("button", { name: "Update to 0.2.0" });
  expect(document.activeElement).toBe(document.body);
  fireEvent.click(item);

  const dialog = screen.getByRole("alertdialog", { name: "Tasma 0.2.0 is available" });
  await user.click(within(dialog).getByRole("button", { name: "Later" }));

  expect(document.activeElement).toBe(item);
});

it("opens the failure dialog from the item and returns focus to the item", async () => {
  stubApp({ ...AVAILABLE, state: "failed", error: "The download failed." });
  const user = userEvent.setup();
  await renderApp();

  const item = await screen.findByRole("button", { name: "Update failed" });
  await user.click(item);
  const dialog = screen.getByRole("alertdialog", { name: "The update to 0.2.0 failed" });
  await user.click(within(dialog).getByRole("button", { name: "Close" }));

  expect(document.activeElement).toBe(item);
});
