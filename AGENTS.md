# Rules

- `~/.tasma` holds real data: live projects, tasks and workflows, with no backup.
  Never write to it, never delete it, and never delete anything under it. A test
  suite that looks polluted is never caused by this tree.
- Run the CLI through `pnpm dev:cli`, which sets `HOME` to a directory under
  `/tmp`. A temporary `HOME` of your own is equally fine; the real home
  directory is forbidden. The web application reads no tree — run it with
  `pnpm dev`.
- Tests, fixtures, examples, docs and comments hold invented data only. Never
  use the tag, a task id, the name or the path of a real project, or the name
  of a real person. This project is no exception: no `TASM` or `TASM-<n>`, and
  no `tasma` as a sample name, title or path. `tasma` appears only where it
  names the product itself, for example the CLI name, the `tasma:` prefix,
  `~/.tasma`, `@tasma/*`, `TASMA_*`.

# apps/web

Rules in this chapter are for the `apps/web` application alone.

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
- State that outlives a restart goes through the store's storage adapter and is hydrated in `main.tsx`.
- A list that can exceed 50 rows renders through `VirtualList`, or `PageVirtualList` where the page scrolls, once it holds more than 50.
- Filtering or searching a long list uses `useDeferredValue`.
- Do not hand-write `useMemo` or `useCallback`. The compiler does it.
- `VirtualList` and `PageVirtualList` are the components the compiler skips: the compiler knows `useVirtualizer`, and `PageVirtualList` opts out with `"use no memo"`. Leave their virtualizer calls in the components.
- A failure screen for a route goes through `RouteFailure`: the router's default, or a route's `errorComponent` that renders it, never a boundary of its own. Use `ErrorScreen` where no shell renders around it.
- Recovering from a route failure is `router.invalidate()`, never the `reset` an error component is handed.
- Build a browser history only in `src/router.tsx`.
- Mount a document-wide subscription above the router and outside the error boundary.
- No Node APIs in renderer code.
- The proxy in `vite.config.ts` owns the daemon address. Renderer code builds no absolute URL, so `connect-src` stays `'self'`.
