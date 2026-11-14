import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WindowThemeSync } from "../../src/components/window-theme-sync";
import { useUiStore } from "../../src/store/ui";
import { stubShell, stubSystemTheme } from "../helpers";

/** The send runs after the previous one settles, so a post that would come is in by the next task. */
async function settled() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  useUiStore.setState({ themePreference: "dark", sidebarCollapsed: false });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("sends the stored setting at mount", async () => {
  const shell = stubShell();

  render(<WindowThemeSync />);

  await waitFor(() => {
    expect(shell.posted()).toEqual(["POST /app/theme/dark"]);
  });
});

it("sends the system setting, not the theme it resolves to", async () => {
  stubSystemTheme("dark");
  useUiStore.setState({ themePreference: "system" });
  const shell = stubShell();

  render(<WindowThemeSync />);

  await waitFor(() => {
    expect(shell.posted()).toEqual(["POST /app/theme/system"]);
  });
});

it("sends a changed setting", async () => {
  const shell = stubShell();
  render(<WindowThemeSync />);
  await waitFor(() => {
    expect(shell.posted()).toEqual(["POST /app/theme/dark"]);
  });

  act(() => {
    useUiStore.getState().setThemePreference("light");
  });

  await waitFor(() => {
    expect(shell.posted()).toEqual(["POST /app/theme/dark", "POST /app/theme/light"]);
  });
});

it("sends nothing more while the setting stays the same", async () => {
  const shell = stubShell();
  render(<WindowThemeSync />);
  await waitFor(() => {
    expect(shell.posted()).toEqual(["POST /app/theme/dark"]);
  });

  act(() => {
    useUiStore.setState({ themePreference: "dark", sidebarCollapsed: true });
  });
  await settled();

  expect(shell.posted()).toEqual(["POST /app/theme/dark"]);
});
