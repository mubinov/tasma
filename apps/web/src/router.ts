import { createHashHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { App } from "./app";
import { ErrorPanel } from "./components/error-boundary";

// One route, defined in code: no routes/ directory and no generated tree.
const rootRoute = createRootRoute({ component: App });

// Coupled to Vite's base: "./" and the only history a file:// origin allows;
// the argument lives in test/router.test.tsx, which binds the pair. Built here
// alone, so the decision stays reversible.
const history = createHashHistory();

export const router = createRouter({
  routeTree: rootRoute,
  history,
  // Every match is wrapped in a catch boundary of the router's own, below the
  // one main.tsx puts around the provider, so a throw from a route component
  // never reaches that boundary. Left unset this renders the library's own
  // unthemed panel, which hides the message outside a development build.
  defaultErrorComponent: ErrorPanel,
});

declare module "@tanstack/react-router" {
  // Declaration merging works on an interface only, so a module augmentation
  // cannot use the `type` form this repository otherwise requires.
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Register {
    router: typeof router;
  }
}
