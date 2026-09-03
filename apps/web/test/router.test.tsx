import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { ProtocolError, TransportError } from "@tasma/protocol";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../src/components/app-shell";
import { ErrorScreen, RouteFailure } from "../src/components/error-boundary";
import { router } from "../src/router";
import { createAppRouter } from "../src/routes";
import config from "../vite.config";

/*
 * Which component throws is chosen per test. Both failures are caught by the
 * router rather than by the boundary main.tsx puts around the provider, but
 * they are caught at different depths: the root match has no shell around it,
 * while a child match sits inside the shell's <main>.
 */
const failing = vi.hoisted(() => ({ shell: false, screen: false }));

vi.mock("../src/components/app-shell", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/components/app-shell")>();

  return {
    AppShell: () => {
      if (failing.shell) {
        throw new Error("the shell could not render");
      }

      return <actual.AppShell />;
    },
  };
});

vi.mock("../src/components/placeholder-screen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/components/placeholder-screen")>();

  return {
    PlaceholderScreen: (props: { title: string; summary: string }) => {
      if (failing.screen) {
        throw new Error("the screen could not render");
      }

      return <actual.PlaceholderScreen {...props} />;
    },
  };
});

// React and the router both report a caught render error on the console; these
// tests assert what is painted, not the noise. The router also scrolls on
// mount, which jsdom does not implement.
function silenceFailureNoise() {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("scrollTo", () => {});
}

afterEach(() => {
  cleanup();
  failing.shell = false;
  failing.screen = false;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/*
 * base: "./" and hash history are one decision, and this is the only place
 * that binds them. Relative asset paths resolve against the document's own
 * directory, so they hold only while the document sits at the root; hash
 * history is what keeps it there once a nested route exists. Changing either
 * alone 404s every asset inside a packaged shell, where there are no devtools
 * to see it happen.
 */
it("couples relative asset paths to hash history", () => {
  expect(config.base).toBe("./");
  expect(router.history.createHref("/settings/general")).toContain("#/settings/general");
});

it("answers a throw from the root route with the app's own panel, not the library's", async () => {
  silenceFailureNoise();
  failing.shell = true;

  await act(async () => {
    render(<RouterProvider router={router} />);
  });

  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("tasma stopped rendering");
  expect(screen.getByText("the shell could not render")).toBeTruthy();
  expect(document.activeElement).toBe(alert);
  // Nothing renders a landmark once the shell is gone, so the panel supplies
  // the one <main> the page has.
  expect(screen.getByRole("main").contains(alert)).toBe(true);
  // The library's own fallback, which paints instead when the router is left
  // to its default.
  expect(screen.queryByText("Something went wrong!")).toBeNull();
});

/*
 * A child's failure is caught in the child's own slot, so the shell stays and
 * the panel lands inside its <main>. A panel carrying a <main> of its own would
 * nest one landmark in another, which the content model forbids and which
 * leaves a screen-reader user two main regions to choose between.
 */
it("keeps a throw from a child screen inside the shell's one main landmark", async () => {
  silenceFailureNoise();
  failing.screen = true;

  await act(async () => {
    render(<RouterProvider router={router} />);
  });

  const alert = screen.getByRole("alert");
  expect(screen.getByText("the screen could not render")).toBeTruthy();
  expect(screen.getAllByRole("main")).toHaveLength(1);
  expect(screen.getByRole("main").contains(alert)).toBe(true);
  expect(screen.getByRole("navigation")).toBeTruthy();
});

/*
 * Retry is the one recovery the panel offers, and the router is the only place
 * it can be wired — so this is the only place it can be proved. A panel test
 * driving a `vi.fn()` reset would pass against a Retry that recovers nothing.
 */
describe("recovering from a loader that failed", () => {
  const NO_DAEMON = new TransportError("GET /health reached no daemon");

  /** A promise a test resolves when it chooses, and the resolver. */
  function held(): [Promise<unknown>, () => void] {
    let answer = () => {};
    const promise = new Promise<unknown>((resolve) => {
      answer = () => {
        resolve({});
      };
    });

    return [promise, answer];
  }

  /**
   * The shell and the failure surface the app uses, over loaders a test drives.
   * The second route is the navigation the panel did not ask for.
   */
  function routerOver(loader: () => Promise<unknown>, elsewhere: () => Promise<unknown> = () => Promise.resolve({})) {
    const rootRoute = createRootRoute({ component: AppShell, errorComponent: ErrorScreen });
    const screenRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      loader,
      component: () => <h1>Dashboard</h1>,
    });
    // A path the app's own tree carries: `navigate` is typed against the
    // registered router, whatever tree the test builds under it.
    const elsewhereRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/tasks",
      loader: elsewhere,
      component: () => <h1>Elsewhere</h1>,
    });

    return createRouter({
      routeTree: rootRoute.addChildren([screenRoute, elsewhereRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
      defaultErrorComponent: RouteFailure,
    });
  }

  /** Fails the first load, presses Retry, and answers the repeat with `second`. */
  async function pressRetryAfterAFailedLoad(second: () => Promise<unknown>) {
    silenceFailureNoise();
    const loader = vi.fn<() => Promise<unknown>>().mockRejectedValueOnce(NO_DAEMON).mockImplementation(second);

    await act(async () => {
      render(<RouterProvider router={routerOver(loader)} />);
    });

    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    });

    return loader;
  }

  // The route tree below is the test's own; this is what ties it to the app's.
  it("hands every route the same failure surface the app's own router does", () => {
    expect(createAppRouter(createMemoryHistory({ initialEntries: ["/"] })).options.defaultErrorComponent).toBe(
      RouteFailure,
    );
  });

  it("re-runs the loader and shows the screen it then serves", async () => {
    const loader = await pressRetryAfterAFailedLoad(() => Promise.resolve({}));

    expect(loader).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Dashboard");
  });

  // The button the reader activated leaves the DOM, so focus would otherwise
  // fall back to <body> and the next tab start at the top of the document.
  it("puts focus on the content region the screen replaced the panel in", async () => {
    await pressRetryAfterAFailedLoad(() => Promise.resolve({}));

    expect(document.activeElement).toBe(screen.getByRole("main"));
  });

  /*
   * The router reports a load for any pending navigation, the very one that
   * commits this failure included — so a panel reading that instead of its own
   * match is inserted as a wait and only then swaps to an alert, on a node
   * already in the document, where the role change announces nothing.
   */
  it("alerts on the first failure rather than reporting a repeat nobody asked for", async () => {
    silenceFailureNoise();

    await act(async () => {
      render(<RouterProvider router={routerOver(() => Promise.reject(NO_DAEMON))} />);
    });

    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("aria-busy")).toBe("false");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(alert.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Retry" }));
  });

  // Somewhere else being slow says nothing about this failure, which is still
  // just as final: reported as a repeat it relabels the control the reader is
  // reaching for and reads a wait over words that are not waiting on anything.
  it("stays an alert while a navigation it did not ask for is pending", async () => {
    silenceFailureNoise();
    const [journey, arrive] = held();
    const router = routerOver(() => Promise.reject(NO_DAEMON), () => journey);

    await act(async () => {
      render(<RouterProvider router={router} />);
    });

    await act(async () => {
      void router.navigate({ to: "/tasks" });
    });

    expect(screen.getByRole("alert").getAttribute("aria-busy")).toBe("false");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();

    await act(async () => {
      arrive();
    });

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Elsewhere");
  });

  /*
   * Invalidating rebuilds the errored match, so an identical panel is mounted
   * for as long as the load runs. Left to what every other failure wants on
   * mount, that takes the reader off the button they just pressed and reads the
   * failure they are waiting out back to them as the answer.
   */
  it("holds the reader on the control while the repeat runs, and says it is running", async () => {
    const [repeat, answer] = held();

    const loader = await pressRetryAfterAFailedLoad(() => repeat);

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Retrying…" }));
    expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByRole("alert")).toBeNull();

    await act(async () => {
      answer();
    });

    expect(loader).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Dashboard");
  });

  // A refusal offers no retry, so the button is removed while the panel stays.
  it("keeps focus in the content region when the retry is refused instead", async () => {
    await pressRetryAfterAFailedLoad(() =>
      Promise.reject(new ProtocolError({ kind: "store", code: "config-invalid", message: "config.yml is not a mapping" }, 422)),
    );

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("the daemon refused this request");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByRole("main").contains(document.activeElement)).toBe(true);
  });
});
