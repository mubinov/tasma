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
