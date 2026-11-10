import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyWatch } from "../../src/components/key-watch";
import { useUiStore } from "../../src/store/ui";

beforeEach(() => {
  useUiStore.setState({ keyPressed: false });
});

afterEach(() => {
  cleanup();
});

describe("the key watch", () => {
  it.each(["Tab", "Enter", "Shift"])("notes a press of %s", (key) => {
    render(<KeyWatch />);

    fireEvent.keyDown(window, { key });

    expect(useUiStore.getState().keyPressed).toBe(true);
  });

  it.each([
    ["Cmd", { key: "Meta", metaKey: true }],
    ["Cmd+Tab", { key: "Tab", metaKey: true }],
    ["Option", { key: "Alt", altKey: true }],
    ["Ctrl", { key: "Control", ctrlKey: true }],
  ])("does not note %s", (_name, init) => {
    render(<KeyWatch />);

    fireEvent.keyDown(window, init);

    expect(useUiStore.getState().keyPressed).toBe(false);
  });

  it("does not note a pointer press", () => {
    render(<KeyWatch />);

    fireEvent.pointerDown(window);

    expect(useUiStore.getState().keyPressed).toBe(false);
  });

  it("notes a press that a handler of the page stops", () => {
    render(<KeyWatch />);
    const button = document.body.appendChild(document.createElement("button"));
    button.addEventListener("keydown", (event) => {
      event.stopPropagation();
    });

    fireEvent.keyDown(button, { key: "Enter" });
    button.remove();

    expect(useUiStore.getState().keyPressed).toBe(true);
  });

  it("stops listening after the first press it notes", () => {
    render(<KeyWatch />);

    fireEvent.keyDown(window, { key: "Tab" });
    useUiStore.setState({ keyPressed: false });
    fireEvent.keyDown(window, { key: "Tab" });

    expect(useUiStore.getState().keyPressed).toBe(false);
  });

  it("stops listening when it unmounts", () => {
    const view = render(<KeyWatch />);

    view.unmount();
    fireEvent.keyDown(window, { key: "Tab" });

    expect(useUiStore.getState().keyPressed).toBe(false);
  });
});
