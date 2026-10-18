import { UTILS } from "./files.ts";

const BLOCK_START = /^\s*(?:\/\/|\{\/\*|\/\*)\s*tasma-edit:\s*(.+?)\s*(?:\*\/\}?)?\s*$/;
const BLOCK_END = /^\s*(?:\/\/|\{\/\*|\/\*)\s*tasma-edit end\s*(?:\*\/\}?)?\s*$/;

class BlockError extends Error {
  readonly line: number;

  constructor(line: number, message: string) {
    super(`line ${line}: ${message}`);
    this.line = line;
  }
}

/** A block between `tasma-edit: <reason>` and `tasma-edit end`. `start` and `end` are 0-based marker lines. */
export type MarkedBlock = { reason: string; start: number; end: number };

export function markedBlocks(text: string): MarkedBlock[] {
  const blocks: MarkedBlock[] = [];
  let open: { reason: string; start: number } | undefined;

  text.split("\n").forEach((line, index) => {
    const reason = BLOCK_START.exec(line)?.[1];
    if (reason !== undefined) {
      if (open !== undefined) {
        throw new BlockError(index + 1, `tasma-edit block inside the block of line ${open.start + 1}`);
      }
      open = { reason, start: index };
    } else if (BLOCK_END.test(line)) {
      if (open === undefined) throw new BlockError(index + 1, "tasma-edit end with no open block");
      blocks.push({ ...open, end: index });
      open = undefined;
    }
  });

  if (open !== undefined) throw new BlockError(open.start + 1, "tasma-edit block with no end");
  return blocks;
}

export type NotedBlock = { file: string; reason: string; text: string };

export function noteBlocks(tree: ReadonlyMap<string, string>): NotedBlock[] {
  return [...tree].flatMap(([file, text]) => {
    const lines = text.split("\n");
    try {
      return markedBlocks(text).map(({ reason, start, end }) => ({
        file,
        reason,
        text: lines.slice(start, end + 1).join("\n"),
      }));
    } catch (error) {
      throw new Error(`${file}: ${(error as Error).message}`, { cause: error });
    }
  });
}

/** The noted blocks whose start marker is no longer in their file. */
export function lostBlocks(noted: readonly NotedBlock[], tree: ReadonlyMap<string, string>): NotedBlock[] {
  return noted.filter(({ file, text }) => {
    const marker = text.split("\n")[0]!.trim();
    return !(tree.get(file) ?? "").split("\n").some((line) => line.trim() === marker);
  });
}

/** A marked block of the kit folder, with its 1-based marker lines. */
export type KitBlock = { file: string; reason: string; first: number; last: number };

/** The marked blocks of the kit folder, except in lib/utils.ts and in a file whose blocks are malformed. */
export function kitBlocks(tree: ReadonlyMap<string, string>): KitBlock[] {
  return [...tree].flatMap(([file, text]) => {
    if (file === UTILS) return [];
    try {
      return markedBlocks(text).map(({ reason, start, end }) => ({ file, reason, first: start + 1, last: end + 1 }));
    } catch {
      return [];
    }
  });
}

type DiffOp = { kind: "same" | "removed" | "added"; generatedIndex: number; actualIndex: number };

/**
 * The line-by-line edit script from `generated` to `actual` along their
 * longest common subsequence. `generatedIndex` and `actualIndex` are the
 * indexes of the next line of each file at the point of each operation.
 */
function diffLines(generated: readonly string[], actual: readonly string[]): DiffOp[] {
  const rows = generated.length;
  const columns = actual.length;
  const width = columns + 1;
  const common = new Uint32Array((rows + 1) * width);

  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      common[row * width + column] = generated[row] === actual[column]
        ? common[(row + 1) * width + column + 1]! + 1
        : Math.max(common[(row + 1) * width + column]!, common[row * width + column + 1]!);
    }
  }

  const skipGenerated = (row: number, column: number) =>
    common[(row + 1) * width + column]! >= common[row * width + column + 1]!;
  const ops: DiffOp[] = [];
  let row = 0;
  let column = 0;
  while (row < rows || column < columns) {
    if (row < rows && column < columns && generated[row] === actual[column]) {
      ops.push({ kind: "same", generatedIndex: row, actualIndex: column });
      row += 1;
      column += 1;
    } else if (column === columns || (row < rows && skipGenerated(row, column))) {
      ops.push({ kind: "removed", generatedIndex: row, actualIndex: column });
      row += 1;
    } else {
      ops.push({ kind: "added", generatedIndex: row, actualIndex: column });
      column += 1;
    }
  }
  return ops;
}

/*
 * The CLI removes a leading "use client" from some files and keeps it in
 * others, by the order in which it writes them: its rsc transform tests a
 * global regex, whose lastIndex carries over from one file to the next. With
 * rsc false the directive does nothing, so the comparison skips it.
 */
const USE_CLIENT = /^["']use client["'];?$/;

/** The number of leading lines that a "use client" directive and the blank line after it take. */
function directiveLength(lines: readonly string[]): number {
  if (!USE_CLIENT.test(lines[0]!)) return 0;
  return lines[1] === "" ? 2 : 1;
}

/**
 * The 1-based lines at which `actual` differs from `generated` outside its
 * marked blocks. A run of changes passes when each line it adds is inside a
 * block and, when it removes generated lines, a block is at the run.
 */
function fileDifferences(generated: string, actual: string): number[] {
  if (generated === actual) return [];

  let blocks: MarkedBlock[];
  try {
    blocks = markedBlocks(actual);
  } catch (error) {
    return [(error as BlockError).line];
  }

  const generatedLines = generated.split("\n");
  const actualLines = actual.split("\n");
  const generatedDirective = directiveLength(generatedLines);
  const actualDirective = directiveLength(actualLines);
  const inBlock = actualLines.map((_line, index) => blocks.some(({ start, end }) => index >= start && index <= end));
  const ops = diffLines(generatedLines, actualLines);
  const differingLines: number[] = [];

  for (let index = 0; index < ops.length;) {
    if (ops[index]!.kind === "same") {
      index += 1;
      continue;
    }

    const region: DiffOp[] = [];
    while (index < ops.length && ops[index]!.kind !== "same") {
      region.push(ops[index]!);
      index += 1;
    }

    const added = region
      .filter((op) => op.kind === "added" && op.actualIndex >= actualDirective)
      .map((op) => op.actualIndex);
    const removes = region.some((op) => op.kind === "removed" && op.generatedIndex >= generatedDirective);
    const outside = added.find((line) => !inBlock[line]);
    const first = region[0]!.actualIndex;
    const next = region.at(-1)!.actualIndex + (region.at(-1)!.kind === "added" ? 1 : 0);
    const atBlock = added.length > 0 || inBlock[first - 1] === true || inBlock[next] === true;

    if (outside !== undefined) {
      differingLines.push(outside + 1);
    } else if (removes && !atBlock) {
      differingLines.push(first + 1);
    }
  }
  return differingLines;
}

export type Difference = { file: string; line: number };

/** Where the kit folder differs from the CLI output, apart from marked blocks and lib/utils.ts. */
export function compareKit(generated: ReadonlyMap<string, string>, actual: ReadonlyMap<string, string>): Difference[] {
  const files = [...new Set([...generated.keys(), ...actual.keys()])].filter((file) => file !== UTILS).sort();

  return files.flatMap((file) => {
    const generatedText = generated.get(file);
    const actualText = actual.get(file);
    if (generatedText === undefined || actualText === undefined) return [{ file, line: 1 }];
    return fileDifferences(generatedText, actualText).map((line) => ({ file, line }));
  });
}
