import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { InputModeSync } from "../../src/components/input-mode-sync";

function inputMode(): string | null {
  return document.documentElement.getAttribute("data-input");
}

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-input");
});

describe("the input mode record", () => {
  it("sets no mode before the first press", () => {
    render(<InputModeSync />);

    expect(inputMode()).toBeNull();
  });

  it.each(["Tab", "Enter", "ArrowDown"])("records the keyboard on a press of %s", (key) => {
    render(<InputModeSync />);

    fireEvent.keyDown(window, { key });

    expect(inputMode()).toBe("keyboard");
  });

  it.each([
    ["Option+Down Arrow", { key: "ArrowDown", altKey: true }],
    ["Cmd+V", { key: "v", metaKey: true }],
  ])("records the keyboard on %s", (_name, init) => {
    render(<InputModeSync />);

    fireEvent.keyDown(window, init);

    expect(inputMode()).toBe("keyboard");
  });

  it.each([
    ["Shift", { key: "Shift", shiftKey: true }],
    ["Control", { key: "Control", ctrlKey: true }],
    ["Alt", { key: "Alt", altKey: true }],
    ["Meta", { key: "Meta", metaKey: true }],
  ])("does not change the mode on %s alone", (_name, init) => {
    render(<InputModeSync />);
    fireEvent.pointerDown(window);

    fireEvent.keyDown(window, init);

    expect(inputMode()).toBe("pointer");
  });

  it("records the pointer on a pointer press, also after a key press", () => {
    render(<InputModeSync />);
    fireEvent.keyDown(window, { key: "Tab" });

    fireEvent.pointerDown(window);

    expect(inputMode()).toBe("pointer");
  });

  it("records the keyboard again on a key press after a pointer press", () => {
    render(<InputModeSync />);
    fireEvent.pointerDown(window);

    fireEvent.keyDown(window, { key: "ArrowDown" });

    expect(inputMode()).toBe("keyboard");
  });

  it("records a press that a handler of the page stops", () => {
    render(<InputModeSync />);
    const button = document.body.appendChild(document.createElement("button"));
    for (const type of ["keydown", "pointerdown"]) {
      button.addEventListener(type, (event) => {
        event.stopPropagation();
      });
    }

    fireEvent.keyDown(button, { key: "Enter" });
    expect(inputMode()).toBe("keyboard");
    fireEvent.pointerDown(button);
    expect(inputMode()).toBe("pointer");
    button.remove();
  });

  it("writes the attribute only when the mode changes", () => {
    render(<InputModeSync />);
    const writes = new MutationObserver(() => {});
    writes.observe(document.documentElement, { attributeFilter: ["data-input"] });

    fireEvent.keyDown(window, { key: "Tab" });
    fireEvent.keyDown(window, { key: "Tab" });
    fireEvent.pointerDown(window);
    fireEvent.pointerDown(window);

    expect(writes.takeRecords()).toHaveLength(2);
    writes.disconnect();
  });

  it("removes the mode and stops listening when it unmounts", () => {
    const view = render(<InputModeSync />);
    fireEvent.keyDown(window, { key: "Tab" });

    view.unmount();

    expect(inputMode()).toBeNull();
    fireEvent.keyDown(window, { key: "Tab" });
    fireEvent.pointerDown(window);
    expect(inputMode()).toBeNull();
  });
});
