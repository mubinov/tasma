# Layout

- `apps/macos` — the macOS application: a Tauri shell that serves the
  `apps/web` bundle and forwards to the daemon. The only Rust in the repository.
- `apps/web` — the board, a React application. The browser is for development
  only; what ships is the macOS app, which serves this same bundle.
- `apps/daemon` — the HTTP daemon over the engine. Every read and write of a
  tree goes through it.
- `apps/cli` — the `tasma` command. It reaches the daemon, never a tree.
- `packages/engine` — the disk layer: the task and workflow file format, the
  store, the index cache and the watcher.
- `packages/protocol` — the wire contract and its client, shared by the daemon,
  the CLI and the board.
- `docs/` — documentation for people outside the repository. `README.md` is the
  GitHub front page, not a documentation page.

`packages/engine` and `packages/protocol` depend on nothing of ours, and
`apps/cli` never depends on `packages/engine`. Keep it that way.

# Rules

- `~/.tasma` holds real data: live projects, tasks and workflows, with no backup.
  Never write to it, never delete it, and never delete anything under it. A test
  suite that looks polluted is never caused by this tree.
- Every command that resolves a daemon from `HOME` runs under
  `scripts/dev-home.sh`, which puts `HOME` under `/tmp`: `pnpm dev:cli` and
  `pnpm app:start` do. A temporary `HOME` of your own is equally fine; the real
  home directory is forbidden. The web application reads no tree — run it with
  `pnpm dev`.
- Under a development `HOME`, give the tree a daemon record of its own before
  running the app: start a daemon there, or set `TASMA_DAEMON_PORT` and write
  the record naming that port. A tree with no record falls back to the default
  port, where the daemon on the real home answers, and the app stands down to
  it and serves the real tree.
- Tests, fixtures, examples, docs and comments hold invented data only. Never
  use the tag, a task id, the name or the path of a real project, or the name
  of a real person. This project is no exception: no `TASM` or `TASM-<n>`, and
  no `tasma` as a sample name, title or path. `tasma` appears only where it
  names the product itself, for example the CLI name, the `tasma:` prefix,
  `~/.tasma`, `@tasma/*`, `TASMA_*`.

# apps/macos

Rules in this chapter are for the `apps/macos` shell alone.

- The crate is deliberately not a pnpm workspace package. When
  `test/workspace.test.ts` fails naming `apps/macos`, delete the `package.json`
  someone added — never add the scripts the failure asks for.
- **bun is a build requirement of the crate, as Rust is.** `tauri_build` refuses
  a declared external binary that is absent, so with no compiled daemon the
  crate does not compile at all — `cargo test` included. `app:dev`, `app:start`
  and `app:test` each run `scripts/daemon-binary.sh` first; a bare `cargo`
  command does not.
- Never run `scripts/daemon-binary.sh` through `scripts/dev-home.sh`. Its header
  holds why.
- The script's scratch file differs from the output by directory alone. Never
  give it a name of its own; `test/macos.test.ts` pins this and the script's
  header holds why.
- `pnpm app:dev` runs under the real home and starts a daemon on the real tree.
  Use `pnpm app:start`, which is wrapped.
- Every run that serves the built bundle passes `--features custom-protocol`,
  and `app:test` never does: the feature embeds `apps/web/dist`, which no clone
  carries.
- `app:start` uses `cargo run`, never the Tauri CLI. `tauri dev` always runs
  `beforeDevCommand` and then probes `devUrl`, which collides with the dev
  server's `strictPort`.
- The window is built in Rust. `app.windows` in `tauri.conf.json` is empty, and
  a window property written there is read by nothing.
- Never set a menu of our own and never call `enable_macos_default_menu(false)`.
  Copy, paste and select-all reach the webview only through the default menu.
- The first zoom keypress of a session logs one policy violation and one console
  warning. Never widen `apps/web`'s `connect-src` to silence it.

# apps/web

Rules in this chapter are for the `apps/web` application alone.

- Desktop only. Never design or test a mobile layout.
- Use Base UI for interactive components.
- Import icons from `src/lib/icons.ts`, never from `@phosphor-icons/react`.
- No runtime CSS-in-JS.
- Style from theme tokens. Never hardcode a colour.
- No colour below `--color-dim`. Hierarchy comes from size, weight, position.
- `--color-signal` means "needs a human". `--color-running` means "an agent is working now".
- Tell control states apart by a mark that keeps 3:1, never by two surfaces alone. Pointer hover may use a surface alone.
- The page's one `<h1>` opens the main content. Nothing before `<main>` is a heading.
- Call `useDocumentTitle` in every screen.
- A group of controls carries a visible label, never `aria-label` alone.
- The theme class lives on `<html>`. Moving it breaks tokens inside portals.
- Text sizes in `rem`. Smallest text is `0.6875rem`.
- Text holding one unbroken token — a path, a URL, an id — takes `wrap-anywhere`, and its panel pairs `w-full` with `max-w-*`. Without both, a narrow window clips it off the left edge.
- Animate `transform` and `opacity` only.
- Routing uses hash history, coupled to `base: "./"`. Changing either alone 404s assets on nested routes.
- Share state through `src/store/`, never through React Context.
- Selectors return primitives, or use `useShallow`.
- Server data belongs in the query cache, never in the store.
- A route's data: `query({ ...options, staleTime: "static" })` in the loader, `useSuspenseQuery` on the same `queryOptions`. Both clients arrive through router context.
- A write goes through a factory in `src/api/mutations/`, one module per write domain, reaching the outside through `index.ts`. `notices.ts` holds what a second write domain would reuse unchanged, machinery and reader-facing text alike; what a second domain would write its own version of stays in the domain module.
- The board shows a write from the pending mutation variables; never edit the query cache by hand.
- State that outlives a restart goes through the store's storage adapter and is hydrated in `main.tsx`.
- Filtering or searching a long list uses `useDeferredValue`.
- Do not hand-write `useMemo` or `useCallback`. The compiler does it.
- `VirtualList` and `PageVirtualList` are the components the compiler skips: the compiler knows `useVirtualizer`, and `PageVirtualList` opts out with `"use no memo"`. Leave their virtualizer calls in the components.
- A failure screen for a route goes through `RouteFailure`: the router's default, or a route's `errorComponent` that renders it, never a boundary of its own. Use `ErrorScreen` where no shell renders around it.
- Recovering from a route failure is `router.invalidate()`, never the `reset` an error component is handed.
- Build a browser history only in `src/router.tsx`.
- Mount a document-wide subscription above the router and outside the error boundary.
- No Node APIs in renderer code.
- The proxy in `vite.config.ts` owns the daemon address. Renderer code builds no absolute URL, so `connect-src` stays `'self'`.
