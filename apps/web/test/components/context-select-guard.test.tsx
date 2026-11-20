import { cleanup, createEvent, fireEvent, render, type RenderResult } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ContextSelectGuard } from "../../src/components/context-select-guard";
import { NO_CONTEXT_SELECT_MARK } from "../../src/lib/context-select";

afterEach(cleanup);

/** The guard, then a marked card and a plain paragraph in a render of their own. */
function renderPage(): { guard: RenderResult; marked: HTMLElement; plain: HTMLElement } {
  const guard = render(<ContextSelectGuard />);
  const page = render(
    <>
      <div {...NO_CONTEXT_SELECT_MARK}>
        <span>Draft the schema</span>
      </div>
      <p>Plain text</p>
    </>,
  );
  return { guard, marked: page.getByText("Draft the schema"), plain: page.getByText("Plain text") };
}

/** Whether a handler canceled the `selectstart` of a selection in the text of `element`. */
function selectionPrevented(element: HTMLElement): boolean {
  const text = element.firstChild!;
  const event = createEvent("selectstart", text, { bubbles: true, cancelable: true });
  fireEvent(text, event);
  return event.defaultPrevented;
}

const RIGHT = { button: 2 };
const CONTROL = { button: 0, ctrlKey: true };

describe("the right-click selection guard", () => {
  it("marks an element with one attribute", () => {
    expect(NO_CONTEXT_SELECT_MARK).toEqual({ "data-no-context-select": "" });
  });

  it.each([
    ["a right-button pointer press", "pointerDown", RIGHT],
    ["a right-button mouse press alone", "mouseDown", RIGHT],
    ["a Control + left-button pointer press", "pointerDown", CONTROL],
    ["a Control + left-button mouse press alone", "mouseDown", CONTROL],
  ] as const)("stops the selection after %s on a marked element", (_name, press, init) => {
    const { marked } = renderPage();

    fireEvent[press](marked, init);

    expect(selectionPrevented(marked)).toBe(true);
  });

  it("stops the selection after both presses of one right click", () => {
    const { marked } = renderPage();

    fireEvent.pointerDown(marked, RIGHT);
    fireEvent.mouseDown(marked, RIGHT);

    expect(selectionPrevented(marked)).toBe(true);
  });

  it("stops the selection when a handler of the page stops the press", () => {
    const { marked } = renderPage();
    marked.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });

    fireEvent.pointerDown(marked, RIGHT);

    expect(selectionPrevented(marked)).toBe(true);
  });

  it("leaves the selection of a left-button press on a marked element alone", () => {
    const { marked } = renderPage();

    fireEvent.pointerDown(marked, { button: 0 });
    fireEvent.mouseDown(marked, { button: 0 });

    expect(selectionPrevented(marked)).toBe(false);
  });

  it("leaves the selection of a right-button press on an element with no mark alone", () => {
    const { plain } = renderPage();

    fireEvent.pointerDown(plain, RIGHT);
    fireEvent.mouseDown(plain, RIGHT);

    expect(selectionPrevented(plain)).toBe(false);
  });

  it("leaves the selection of a right-button press on the document alone", () => {
    const { plain } = renderPage();

    fireEvent.pointerDown(document, RIGHT);

    expect(selectionPrevented(plain)).toBe(false);
  });

  it.each([
    ["contextmenu", "contextMenu"],
    ["pointerup", "pointerUp"],
    ["keydown", "keyDown"],
  ] as const)("lets a selection through after %s", (_name, end) => {
    const { marked } = renderPage();
    fireEvent.pointerDown(marked, RIGHT);

    fireEvent[end](marked);

    expect(selectionPrevented(marked)).toBe(false);
  });

  it("stops nothing after it unmounts", () => {
    const { guard, marked } = renderPage();

    guard.unmount();
    fireEvent.pointerDown(marked, RIGHT);

    expect(selectionPrevented(marked)).toBe(false);
  });
});
