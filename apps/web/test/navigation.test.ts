import { createMemoryHistory } from "@tanstack/react-router";
import { expect, it } from "vitest";
import { FOOTER_NAVIGATION, NAVIGATION_BY_PATH, PRIMARY_NAVIGATION } from "../src/navigation";
import { createAppRouter } from "../src/routes";

const LINKED = [...PRIMARY_NAVIGATION, ...FOOTER_NAVIGATION];

/*
 * The sidebar is built from the two navigation arrays and the routes are
 * declared one by one, so nothing but this binds them. Without it a renamed
 * path leaves either a link to a route that does not exist, or a screen with no
 * way to reach it.
 */
it("offers exactly the paths the router serves", () => {
  const router = createAppRouter(createMemoryHistory({ initialEntries: ["/"] }));
  const served = (router.routeTree.children ?? []).map((route) => route.fullPath);

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
