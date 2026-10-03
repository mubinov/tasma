import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTheme, readSystemTheme, resolveTheme, useResolvedTheme, useTheme } from "../../src/lib/theme";
import { useUiStore } from "../../src/store/ui";
import { stubSystemTheme } from "../helpers";

function Probe() {
  const { preference, theme, setPreference } = useTheme();
  return (
    <>
      <output>{`${preference}/${theme}`}</output>
      <button type="button" onClick={() => setPreference("light")}>
        Light
      </button>
    </>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({ themePreference: "system" });
  document.documentElement.className = "";
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("resolveTheme", () => {
  it("reads the system appearance for the system preference", () => {
    stubSystemTheme("dark");
    expect(readSystemTheme()).toBe("dark");
    expect(resolveTheme("system")).toBe("dark");
  });

  it("takes an explicit preference as the theme", () => {
    stubSystemTheme("dark");
    expect(resolveTheme("light")).toBe("light");
  });
});

describe("applyTheme", () => {
  it("replaces the theme class on <html> rather than stacking one", () => {
    applyTheme("dark");
    expect(document.documentElement.className).toBe("dark");

    applyTheme("light");
    expect(document.documentElement.className).toBe("light");
  });
});

describe("useResolvedTheme", () => {
  function ResolvedProbe() {
    return <output>{useResolvedTheme()}</output>;
  }

  it("follows the preference and the system appearance and writes nothing on <html>", async () => {
    const system = stubSystemTheme("dark");
    render(<ResolvedProbe />);

    expect(screen.getByText("dark")).toBeTruthy();
    system.set("light");
    expect(await screen.findByText("light")).toBeTruthy();
    act(() => {
      useUiStore.setState({ themePreference: "dark" });
    });
    expect(screen.getByText("dark")).toBeTruthy();
    expect(document.documentElement.className).toBe("");
  });
});

describe("useTheme", () => {
  it("follows the system appearance and writes the class on <html>", () => {
    stubSystemTheme("dark");
    render(<Probe />);

    expect(screen.getByText("system/dark")).toBeTruthy();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("follows the system appearance when it changes", async () => {
    const system = stubSystemTheme("dark");
    render(<Probe />);

    system.set("light");

    expect(await screen.findByText("system/light")).toBeTruthy();
    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("lets an explicit preference override the system appearance", async () => {
    stubSystemTheme("dark");
    render(<Probe />);

    await userEvent.click(screen.getByRole("button", { name: "Light" }));

    expect(screen.getByText("light/light")).toBeTruthy();
    expect(document.documentElement.classList.contains("light")).toBe(true);
  });
});
