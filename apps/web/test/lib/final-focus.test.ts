import { afterEach, expect, it } from "vitest";
import { focusFirst } from "../../src/lib/final-focus";

function button(): HTMLButtonElement {
  const control = document.createElement("button");
  document.body.append(control);

  return control;
}

/** Present and unfocusable: a heading given no `tabIndex` is the case this guards. */
function plain(): HTMLElement {
  const heading = document.createElement("h2");
  document.body.append(heading);

  return heading;
}

afterEach(() => {
  document.body.innerHTML = "";
});

it("focuses the first candidate that is in the document", () => {
  const first = button();
  const second = button();

  focusFirst([first, second]);

  expect(document.activeElement).toBe(first);
});

it("skips a candidate that has left the document", () => {
  const gone = button();
  const standing = button();
  gone.remove();

  focusFirst([gone, standing]);

  expect(document.activeElement).toBe(standing);
});

it("skips a missing candidate", () => {
  const standing = button();

  focusFirst([null, undefined, standing]);

  expect(document.activeElement).toBe(standing);
});

it("skips a candidate that is there but refuses the caret", () => {
  const unfocusable = plain();
  const standing = button();

  focusFirst([unfocusable, standing]);

  expect(document.activeElement).toBe(standing);
});

it("leaves the caret where it was when every candidate is gone", () => {
  const held = button();
  held.focus();

  focusFirst([null]);

  expect(document.activeElement).toBe(held);
});
