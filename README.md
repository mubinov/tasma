# tasma
Local task engine that runs your dev and design workflows with agents

## Development

The repository is a pnpm workspace. Applications live in `apps/*` and libraries in `packages/*`. All packages share [tsconfig.base.json](tsconfig.base.json) and use [vitest](https://vitest.dev) as the test runner.

Requirements: Node 24 (see [.nvmrc](.nvmrc)) and pnpm.

```sh
pnpm install
pnpm test        # run all package tests
pnpm coverage    # run all package tests with coverage
pnpm typecheck   # type-check all packages
```

One package on its own: `pnpm --filter @tasma/engine test` (from anywhere), or `pnpm vitest --project @tasma/engine` to run it inside the root projects setup. The project name is the package `name` field.

Packages:

- `packages/engine` — the task engine library.

## The task file format

A task is one markdown file: YAML frontmatter, a body, and zero or more comments
carried by HTML comment markers. [docs/task-file-format.md](docs/task-file-format.md)
is the contract, written so that the format can be reimplemented without this code.

`packages/engine` reads and writes it with two pure functions:

```ts
import { parseTask, serializeTask } from "@tasma/engine";

const { task, diagnostics } = parseTask(text, { filename: "proj-42.md" });
const written = serializeTask({ ...task, frontmatter: { ...task.frontmatter, status: "Done" } });
```

`parseTask` throws `TaskParseError` on a file it cannot read and returns a
`Diagnostic` for a file that is legal but questionable. `serializeTask` throws
`TaskSerializeError` on a task it cannot write, or that would not read back the
same way. Both
extend `TaskFormatError` and carry a `code` to match on, the line they point at,
and the filename when one was passed.

A region that was not changed is written back from the text it was read from, so
parsing and serializing a file that was not edited reproduces it byte for byte.
A field set to `undefined` is a cleared field at every level of a mapping: the
writer drops the key, and clearing a key the file does not carry is no change.
The source is stored under the `SNAPSHOT` symbol key. A spread
copy keeps it; a copy that drops symbol keys, such as `structuredClone` or a JSON
round trip, does not, and every region is then generated instead. `hasSource`
reports which of the two a value is.
