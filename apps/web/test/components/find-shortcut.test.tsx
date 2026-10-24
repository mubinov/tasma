import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FindShortcut } from "../../src/components/find-shortcut";
import { useUiStore } from "../../src/store/ui";
import { renderWithRouter } from "../helpers";
import { daemon } from "../task-screen-fixtures";

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({
    boardReturn: null, boardRestorePending: false, modalDialogs: 0, findRequest: 0, findTargets: 0,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mount(path: string) {
  const router = await renderWithRouter(path, daemon().transport);
  return render(<FindShortcut router={router} />);
}

/** Presses the key on the page, and tells whether the page took it from the browser. */
function press(init: KeyboardEventInit): boolean {
  return !fireEvent.keyDown(window, init);
}

describe("Cmd+F", () => {
  it.each([
    ["the board", "/tasks?projects=SAGA"],
    ["the task page", "/tasks/SAGA/SAGA-3"],
  ])("asks %s for its find and keeps the key from the browser", async (_screen, path) => {
    await mount(path);

    expect(press({ key: "f", code: "KeyF", metaKey: true })).toBe(true);
    expect(press({ key: "F", code: "KeyF", metaKey: true })).toBe(true);

    expect(useUiStore.getState().findRequest).toBe(2);
  });

  it("reads the place of the key on a layout that types no Latin letter", async () => {
    await mount("/tasks/SAGA/SAGA-3");

    expect(press({ key: "а", code: "KeyF", metaKey: true })).toBe(true);

    expect(useUiStore.getState().findRequest).toBe(1);
  });

  it("takes the letter a Latin layout types on the key, not its place", async () => {
    await mount("/tasks/SAGA/SAGA-3");

    expect(press({ key: "u", code: "KeyF", metaKey: true })).toBe(false);

    expect(useUiStore.getState().findRequest).toBe(0);
  });

  it.each([
    ["Shift", { shiftKey: true }],
    ["Option", { altKey: true }],
    ["Ctrl", { ctrlKey: true }],
    ["no Cmd", { metaKey: false }],
  ])("does nothing with %s", async (_name, modifiers) => {
    await mount("/tasks/SAGA/SAGA-3");

    expect(press({ key: "f", code: "KeyF", metaKey: true, ...modifiers })).toBe(false);

    expect(useUiStore.getState().findRequest).toBe(0);
  });

  it.each(["/settings", "/projects", "/workflows"])("leaves the key to the browser on %s", async (path) => {
    await mount(path);

    expect(press({ key: "f", code: "KeyF", metaKey: true })).toBe(false);

    expect(useUiStore.getState().findRequest).toBe(0);
  });

  it("asks the dashboard for its find only while a find target is mounted, and else leaves the key to the browser", async () => {
    await mount("/");
    await screen.findByRole("searchbox", { name: "Search chats" });
    useUiStore.setState({ findTargets: 0 });

    expect(press({ key: "f", code: "KeyF", metaKey: true })).toBe(false);
    expect(useUiStore.getState().findRequest).toBe(0);

    useUiStore.setState({ findTargets: 1 });

    expect(press({ key: "f", code: "KeyF", metaKey: true })).toBe(true);
    expect(useUiStore.getState().findRequest).toBe(1);
  });

  it("asks the board for its find with no find target mounted", async () => {
    await mount("/tasks?projects=SAGA");
    useUiStore.setState({ findTargets: 0 });

    expect(press({ key: "f", code: "KeyF", metaKey: true })).toBe(true);
    expect(useUiStore.getState().findRequest).toBe(1);
  });

  it("does nothing while a modal dialog is open", async () => {
    await mount("/tasks/SAGA/SAGA-3");
    useUiStore.setState({ modalDialogs: 1 });

    expect(press({ key: "f", code: "KeyF", metaKey: true })).toBe(false);

    expect(useUiStore.getState().findRequest).toBe(0);
  });

  it("stops listening when it unmounts", async () => {
    const view = await mount("/tasks/SAGA/SAGA-3");

    view.unmount();

    expect(press({ key: "f", code: "KeyF", metaKey: true })).toBe(false);
    expect(useUiStore.getState().findRequest).toBe(0);
  });
});
