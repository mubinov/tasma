import { describe, expect, it } from "vitest";
import { compareKit, kitBlocks, lostBlocks, markedBlocks, noteBlocks } from "../../scripts/kit/blocks.ts";

describe("markedBlocks", () => {
  it("finds the blocks of each comment form, with their reasons and lines", () => {
    const text = [
      "a",
      "// tasma-edit: line comment",
      "b",
      "// tasma-edit end",
      "  {/* tasma-edit: jsx comment */}",
      "  {/* tasma-edit end */}",
      "/* tasma-edit: css comment */",
      "c",
      "/* tasma-edit end */",
    ].join("\n");

    expect(markedBlocks(text)).toEqual([
      { reason: "line comment", start: 1, end: 3 },
      { reason: "jsx comment", start: 4, end: 5 },
      { reason: "css comment", start: 6, end: 8 },
    ]);
  });

  it("refuses an end marker with no block open", () => {
    expect(() => markedBlocks("a\n// tasma-edit end\n")).toThrow("line 2: tasma-edit end with no open block");
  });

  it("refuses a block inside a block", () => {
    expect(() => markedBlocks("// tasma-edit: one\n// tasma-edit: two\n")).toThrow("line 2: tasma-edit block inside");
  });

  it("refuses a block that is not closed", () => {
    expect(() => markedBlocks("a\n// tasma-edit: open\nb\n")).toThrow("line 2: tasma-edit block with no end");
  });
});

describe("the blocks that an update removed", () => {
  const before = new Map([
    ["components/ui/button.tsx", "x\n{/* tasma-edit: keep the ring */}\ny\n{/* tasma-edit end */}\n"],
    ["kit.css", "/* tasma-edit: drop the shimmer */\n/* tasma-edit end */\n"],
    ["hooks/use-thing.ts", "// tasma-edit: guard\nz\n// tasma-edit end\n"],
  ]);

  it("are the noted blocks whose start marker is no longer in their file", () => {
    const after = new Map([
      ["components/ui/button.tsx", "x\n  {/* tasma-edit: keep the ring */}\ny\n{/* tasma-edit end */}\n"],
      ["kit.css", "@import \"tw-shimmer\";\n"],
    ]);

    expect(lostBlocks(noteBlocks(before), after)).toEqual([
      { file: "kit.css", reason: "drop the shimmer", text: "/* tasma-edit: drop the shimmer */\n/* tasma-edit end */" },
      { file: "hooks/use-thing.ts", reason: "guard", text: "// tasma-edit: guard\nz\n// tasma-edit end" },
    ]);
  });

  it("are none when no file has a block", () => {
    expect(noteBlocks(new Map([["kit.css", ""]]))).toEqual([]);
  });

  it("names the file of a malformed block", () => {
    expect(() => noteBlocks(new Map([["kit.css", "/* tasma-edit: open */\n"]]))).toThrow("kit.css: line 1");
  });
});

describe("kitBlocks", () => {
  it("lists each block with its file, reason and 1-based marker lines", () => {
    const kit = new Map([
      ["components/ui/button.tsx", "x\n{/* tasma-edit: keep the ring */}\ny\n{/* tasma-edit end */}\n"],
      ["kit.css", "/* tasma-edit: drop the shimmer */\n/* tasma-edit end */\n"],
      ["hooks/use-thing.ts", "z\n"],
    ]);

    expect(kitBlocks(kit)).toEqual([
      { file: "components/ui/button.tsx", reason: "keep the ring", first: 2, last: 4 },
      { file: "kit.css", reason: "drop the shimmer", first: 1, last: 2 },
    ]);
  });

  it("skips lib/utils.ts and a file whose blocks are malformed", () => {
    const kit = new Map([
      ["lib/utils.ts", "// tasma-edit: own file\n// tasma-edit end\n"],
      ["kit.css", "/* tasma-edit: open */\n"],
    ]);

    expect(kitBlocks(kit)).toEqual([]);
  });
});

describe("compareKit", () => {
  const generated = (text: string) => new Map([["thread.tsx", text]]);
  const differences = (generatedText: string, actualText: string) =>
    compareKit(generated(generatedText), new Map([["thread.tsx", actualText]]));

  it("passes identical files", () => {
    expect(differences("a\nb\n", "a\nb\n")).toEqual([]);
  });

  it("passes a difference inside a marked block", () => {
    expect(differences("a\nb\nc\n", "a\n// tasma-edit: reason\nB\n// tasma-edit end\nc\n")).toEqual([]);
    expect(differences("a\nb\nc\n", "a\n{/* tasma-edit: reason */}\nB\n{/* tasma-edit end */}\nc\n")).toEqual([]);
    expect(differences("a\nb\n", "a\nb\n/* tasma-edit: reason */\nc\n/* tasma-edit end */\n")).toEqual([]);
  });

  it("passes a block that keeps a generated line and adds one after it", () => {
    expect(differences("a\nb\nc\n", "a\n// tasma-edit: reason\nb\nB\n// tasma-edit end\nc\n")).toEqual([]);
  });

  it("passes a deletion block", () => {
    expect(differences("a\nb\nc\n", "a\n// tasma-edit: drop b\n// tasma-edit end\nc\n")).toEqual([]);
    expect(differences("a\nb\nc\n", "a\n// tasma-edit: drop c\n// tasma-edit end\n")).toEqual([]);
  });

  it("passes lines removed directly at a block that keeps generated lines", () => {
    expect(differences("a\nb\nc\nd\n", "a\n// tasma-edit: reason\nc\n// tasma-edit end\nd\n")).toEqual([]);
  });

  it("fails a difference outside a marked block, at the line where it is", () => {
    expect(differences("a\nb\nc\n", "a\nB\nc\n")).toEqual([{ file: "thread.tsx", line: 2 }]);
  });

  it("fails an added line outside a block, also when a block is next to it", () => {
    expect(differences("a\nb\n", "a\n// tasma-edit: reason\nB\n// tasma-edit end\nextra\nb\n"))
      .toEqual([{ file: "thread.tsx", line: 5 }]);
  });

  it("fails lines removed away from any block", () => {
    expect(differences("a\nb\nc\nd\n", "a\n// tasma-edit: reason\n// tasma-edit end\nb\nd\n"))
      .toEqual([{ file: "thread.tsx", line: 5 }]);
    expect(differences("a\nb\n", "a\n")).toEqual([{ file: "thread.tsx", line: 2 }]);
  });

  it("passes a leading \"use client\" directive that one side has and the other does not", () => {
    expect(differences('"use client"\n\nimport a\n', "import a\n")).toEqual([]);
    expect(differences("import a\n", '"use client"\n\nimport a\n')).toEqual([]);
    expect(differences("import a\n", "'use client';\nimport a\n")).toEqual([]);
  });

  it("fails a \"use client\" directive that is not on the first line", () => {
    expect(differences("import a\n", 'import a\n"use client"\n')).toEqual([{ file: "thread.tsx", line: 2 }]);
    expect(differences('import a\n"use client"\n', "import a\n")).toEqual([{ file: "thread.tsx", line: 2 }]);
  });

  it("fails a file with a malformed block", () => {
    expect(differences("a\n", "a\n// tasma-edit: open\n")).toEqual([{ file: "thread.tsx", line: 2 }]);
    expect(differences("a\n", "a\n// tasma-edit end\n")).toEqual([{ file: "thread.tsx", line: 2 }]);
  });

  it("fails a file that is on one side only", () => {
    expect(compareKit(new Map([["extra.tsx", "a\n"]]), new Map())).toEqual([{ file: "extra.tsx", line: 1 }]);
    expect(compareKit(new Map(), new Map([["stale.tsx", "a\n"]]))).toEqual([{ file: "stale.tsx", line: 1 }]);
  });

  it("skips lib/utils.ts", () => {
    expect(compareKit(new Map([["lib/utils.ts", "a\n"]]), new Map([["lib/utils.ts", "b\n"]]))).toEqual([]);
    expect(compareKit(new Map(), new Map([["lib/utils.ts", "b\n"]]))).toEqual([]);
  });
});
