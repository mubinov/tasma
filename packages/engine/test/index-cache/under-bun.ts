// Run by `bun`, not by vitest: an index over the project the arguments name,
// which prints each change it reports as one line of JSON, with the title the
// index holds for that task at that moment. It ends when standard input ends.
import { type IndexedProject, openIndexedProject, openProject } from "@tasma/engine";

const [root = "", project = ""] = process.argv.slice(2);
let indexed: IndexedProject | undefined = undefined;

indexed = await openIndexedProject(openProject({ project, root }), {
  onChange: (change) => {
    const title = indexed?.query().entries.find((entry) => entry.id === change.id)?.frontmatter.title;
    process.stdout.write(`${JSON.stringify({ ...change, title })}\n`);
  },
});
process.stdout.write("ready\n");
process.stdin.on("end", () => void indexed.close());
process.stdin.resume();
