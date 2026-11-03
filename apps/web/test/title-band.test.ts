// @vitest-environment node
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
import { utilityOf } from "./kit/class-words";
import { SRC, tasmaSourceFiles } from "./source-files";

const REACHES_THE_TOP = /^sticky$|^(?:max-)?h-(?:screen|[dsl]vh|\[.*100[dsl]?vh.*\])$/;

/** The outermost string and template literals of `source`. Comments and JSX text are not among them. */
function literals(source: string, fileName: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) found.push(node.getText(file));
    else ts.forEachChild(node, visit);
  };
  visit(file);

  return found;
}

/**
 * The literals of `source` with a class that reaches the top of the window, and
 * no word about the band. The extension of `fileName` selects how to parse it.
 */
function withoutBand(source: string, fileName = "source.tsx"): string[] {
  return literals(source, fileName).filter((literal) =>
    !literal.includes("--title-band")
    && literal.split(/[\s"'`${}]+/).some((word) => REACHES_THE_TOP.test(utilityOf(word))));
}

it("finds each class that reaches the top of the window, with its variants", () => {
  for (const name of ["sticky", "lg:sticky", "h-screen", "xl:h-screen", "h-dvh", "max-h-screen", "h-[calc(100vh-1rem)]"]) {
    expect(withoutBand(`const a = "flex ${name}";`), name).toEqual([`"flex ${name}"`]);
  }
});

it("finds such a class in a JSX attribute and in an expression of a template literal", () => {
  expect(withoutBand("<div className=\"sticky top-0\" />")).toEqual(["\"sticky top-0\""]);
  expect(withoutBand("const a = `p-2 ${open ? \"sticky\" : \"\"}`;")).toEqual(["`p-2 ${open ? \"sticky\" : \"\"}`"]);
});

it("accepts a literal that names the band", () => {
  expect(withoutBand("const a = \"sticky top-(--title-band)\";")).toEqual([]);
  expect(withoutBand("const a = `h-screen ${open ? \"sticky\" : \"\"} pt-(--title-band)`;")).toEqual([]);
});

it("leaves a minimum height, comments and text alone", () => {
  expect(withoutBand("const a = \"flex min-h-screen\";")).toEqual([]);
  expect(withoutBand("// \"sticky\"\n/* \"h-screen\" */\nconst a = <p>sticky {/* \"sticky\" */}</p>;")).toEqual([]);
});

it("reads a .ts file as TypeScript, where angle brackets open no JSX", () => {
  for (const head of ["const pick = <T>(value: T): T => value;", "const size = <number>sample;"]) {
    expect(withoutBand(`${head}\nexport const BOX = "sticky top-0";`, "source.ts"), head).toEqual(["\"sticky top-0\""]);
  }
});

it("names the band in each class string that reaches the top of the window", () => {
  const files = tasmaSourceFiles();
  const offenders = files.flatMap((file) =>
    withoutBand(readFileSync(file, "utf8"), file).map((literal) => `${relative(SRC, file)}: ${literal}`));

  expect(files.length).toBeGreaterThan(0);
  expect(offenders).toEqual([]);
});
