import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ChatUserText } from "../../src/components/chat-user-text";

afterEach(cleanup);

/** The children of the one paragraph: a text node as its text, a `<br>` as `BR`. */
function lines(text: string): string[] {
  const { container } = render(<ChatUserText type="text" text={text} status={{ type: "complete" }} />);
  const paragraphs = container.querySelectorAll("p");
  expect(paragraphs).toHaveLength(1);
  return [...paragraphs[0]!.childNodes].map((node) => (node instanceof Text ? node.data : node.nodeName));
}

it("shows one line with no line break", () => {
  expect(lines("Rename the parser module.")).toEqual(["Rename the parser module."]);
});

it("puts a line break between each two lines", () => {
  expect(lines("Rename the module.\nUpdate the imports.\nRun the tests.")).toEqual([
    "Rename the module.",
    "BR",
    "Update the imports.",
    "BR",
    "Run the tests.",
  ]);
});

it("shows an empty line as two line breaks in a row", () => {
  expect(lines("Rename the module.\n\nRun the tests.")).toEqual(["Rename the module.", "BR", "BR", "Run the tests."]);
});

it("ends with a line break when the text ends with a line end", () => {
  expect(lines("Rename the module.\n")).toEqual(["Rename the module.", "BR"]);
});
