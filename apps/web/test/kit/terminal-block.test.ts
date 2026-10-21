import { parseAnsi } from "@kit/components/assistant-ui/elements/terminal-block";
import { expect, it } from "vitest";

it("parses the escape sequences and the C1 controls of a line", () => {
  const line = "a\u001b[31mb\u009b1mc\u001b]0;title\u0007d\u009d8;;x\u001b\\e\u001b(Bf\u009b0mg";

  expect(parseAnsi(line)).toEqual([
    { text: "a", color: undefined, bold: false, dim: false },
    { text: "b", color: 31, bold: false, dim: false },
    { text: "cdef", color: 31, bold: true, dim: false },
    { text: "g", color: undefined, bold: false, dim: false },
  ]);
});

it("skips a control that a sequence before it holds", () => {
  expect(parseAnsi("a\u001b[3\u009b2mb\u001b[0m\u001b[1mc")).toEqual([
    { text: "ab", color: undefined, bold: false, dim: false },
    { text: "c", color: undefined, bold: true, dim: false },
  ]);
});

it.each([
  ["escape sequences", "\u001b!"],
  ["C1 controls", "\u009bm"],
])("parses a line of 50,000 %s in linear time", (_name, control) => {
  const line = `start ${control.repeat(50_000)} end`;
  const before = performance.now();

  expect(parseAnsi(line).map((segment) => segment.text).join("")).toBe("start  end");
  expect(performance.now() - before).toBeLessThan(1_000);
});
