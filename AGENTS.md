# apps/web

Rules in this chapter are for the `apps/web` application alone.

- Use Base UI for interactive components.
- Import icons from `src/lib/icons.ts`, never from `@phosphor-icons/react`.
- No runtime CSS-in-JS.
- Style from theme tokens. Never hardcode a colour.
- No colour below `--color-dim`. Hierarchy comes from size, weight, position.
- `--color-signal` means "needs a human". `--color-running` means "an agent is working now".
- Tell control states apart by a mark that keeps 3:1, never by two surfaces alone.
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
- A route's data: `ensureQueryData` in the loader, `useSuspenseQuery` on the same `queryOptions`. Both clients arrive through router context.
- State that outlives a restart goes through the store's storage adapter and is hydrated in `main.tsx`.
- Lists that can exceed 50 rows use `VirtualList`.
- Filtering or searching a long list uses `useDeferredValue`.
- Do not hand-write `useMemo` or `useCallback`. The compiler does it.
- `VirtualList` is the one component the compiler skips. Leave its `useVirtualizer` call in the component.
- A failure screen for a route goes through `RouteFailure`, wired on the router, never a boundary of its own. Use `ErrorScreen` where no shell renders around it.
- Recovering from a route failure is `router.invalidate()`, never the `reset` an error component is handed.
- Build a browser history only in `src/router.tsx`.
- Mount a document-wide subscription above the router and outside the error boundary.
- No Node APIs in renderer code.
- The proxy in `vite.config.ts` owns the daemon address. Renderer code builds no absolute URL, so `connect-src` stays `'self'`.
