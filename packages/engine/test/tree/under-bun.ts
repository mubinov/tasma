// Run by `bun`, not by vitest: a tree watch over the root the arguments name,
// which prints each change as one line of JSON, and, with a tag, an index over
// that project, which prints its changes the same way. A line `reopen` on
// standard input closes the tree watch and opens it again. It ends when
// standard input ends.
import { createInterface } from "node:readline";
import { type IndexedProject, openIndexedProject, openProject, type TreeChange, type TreeWatch, watchTree } from "@tasma/engine";

const [root = "", tag] = process.argv.slice(2);
const print = (line: unknown): void => void process.stdout.write(`${JSON.stringify(line)}\n`);
const onChange = (change: TreeChange): void => print({ tree: change });

let tree: TreeWatch = await watchTree({ root, onChange });
const index: IndexedProject | undefined = tag === undefined
  ? undefined
  : await openIndexedProject(openProject({ project: tag, root }), { onChange: (change) => print({ index: change }) });
process.stdout.write("ready\n");

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (line !== "reopen") return;
  void tree.close().then(async () => {
    tree = await watchTree({ root, onChange });
    process.stdout.write("reopened\n");
  });
});
input.on("close", () => {
  void tree.close();
  void index?.close();
});
