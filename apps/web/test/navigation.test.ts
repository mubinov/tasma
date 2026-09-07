import { createMemoryHistory } from "@tanstack/react-router";
import { expect, it } from "vitest";
import { FOOTER_NAVIGATION, NAVIGATION_BY_PATH, PRIMARY_NAVIGATION } from "../src/navigation";
import { createAppRouter } from "../src/routes";
import { testContext } from "./helpers";

const LINKED = [...PRIMARY_NAVIGATION, ...FOOTER_NAVIGATION];

function appRouter() {
  return createAppRouter(createMemoryHistory({ initialEntries: ["/"] }), testContext());
}

/*
 * The sidebar is built from the two navigation arrays and the routes are
 * declared one by one, so nothing but this binds them. It is asked of the
 * matched route rather than of the tree's shape, because a destination can be
 * served by a child: /projects is the parent that renders whichever child
 * matched, and only the child carries the screen.
 */
it("serves a screen at every path the sidebar offers", () => {
  const router = appRouter();

  for (const { path } of LINKED) {
    const matched = router.matchRoutes(path).at(-1);

    // A path no route serves still matches the root, whose component is the
    // shell, so the shell has to be ruled out for the component to mean a screen.
    expect(matched!.routeId, path).not.toBe(router.routeTree.id);
    expect(router.routesById[matched!.routeId]?.options.component, path).toBeDefined();
  }
});

// The other direction: a top-level route with no entry beside it is a screen
// nothing in the sidebar reaches.
it("offers every top-level route from the sidebar", () => {
  const served = (appRouter().routeTree.children ?? []).map((route) => route.fullPath);

  expect(LINKED.map((entry) => entry.path).sort()).toEqual([...served].sort());
});

// Each route reads its own entry through this, so a missing key would leave a
// screen rendering another one's copy.
it("keys every destination by its own path", () => {
  expect(Object.keys(NAVIGATION_BY_PATH).sort()).toEqual(LINKED.map((entry) => entry.path).sort());
  for (const entry of LINKED) {
    expect(NAVIGATION_BY_PATH[entry.path]).toBe(entry);
  }
});
