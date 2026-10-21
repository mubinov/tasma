import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  createClient,
  type Diagnostic,
  type Failure,
  type Transport,
  type TransportReply,
  type TransportRequest,
} from "@tasma/protocol";
import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { onTestFinished, vi } from "vitest";
import { createAppQueryClient } from "../src/api/client";
import { createAppRouter, type RouterContext } from "../src/routes";

/**
 * Replaces matchMedia with one whose answer can be changed mid-test. jsdom's
 * own evaluates no media query, so it never reports dark.
 */
const DARK_QUERY = "(prefers-color-scheme: dark)";

export function stubSystemTheme(initial: "light" | "dark") {
  let current = initial;
  // Keyed by query, so a test touching prefers-reduced-motion or
  // prefers-contrast gets that feature's answer rather than the theme's, and a
  // theme change notifies only the listeners that asked about the theme.
  const listeners = new Map<string, Set<() => void>>();

  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    get matches() {
      return media === DARK_QUERY && current === "dark";
    },
    addEventListener(_type: string, listener: () => void) {
      const forQuery = listeners.get(media) ?? new Set<() => void>();
      forQuery.add(listener);
      listeners.set(media, forQuery);
    },
    removeEventListener: (_type: string, listener: () => void) => void listeners.get(media)?.delete(listener),
  }));

  return {
    set(next: "light" | "dark") {
      current = next;
      for (const listener of listeners.get(DARK_QUERY) ?? []) {
        listener();
      }
    },
  };
}

/** Replaces matchMedia with one that answers the reduced-motion query alone. */
export function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: reduce && media === "(prefers-reduced-motion: reduce)",
  }));
}

/**
 * Gives elements the `getAnimations` jsdom lacks, for the rest of the test.
 * Without it Base UI unmounts a closed popup at once; with it, as in a browser,
 * only after an animation frame.
 */
export function stubAnimations() {
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
  onTestFinished(() => {
    Reflect.deleteProperty(Element.prototype, "getAnimations");
  });
}

/** What a stub observer reports for a target: its box, and whether it meets the root. */
export type ObserverReport = { target: Element; top: number; bottom?: number; isIntersecting?: boolean };

/**
 * Replaces IntersectionObserver, which jsdom does not implement, with one that
 * records every observer and reports only the entries a test hands it.
 */
export function stubIntersectionObserver() {
  const observers: StubIntersectionObserver[] = [];

  class StubIntersectionObserver {
    readonly callback: IntersectionObserverCallback;
    readonly options: IntersectionObserverInit;
    readonly targets = new Set<Element>();

    constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit = {}) {
      this.callback = callback;
      this.options = options;
      observers.push(this);
    }

    observe(target: Element) {
      this.targets.add(target);
    }

    unobserve(target: Element) {
      this.targets.delete(target);
    }

    disconnect() {
      this.targets.clear();
    }

    takeRecords() {
      return [];
    }
  }

  vi.stubGlobal("IntersectionObserver", StubIntersectionObserver);

  return {
    observers,
    /** Hands each observer the reports about the targets it observes. */
    report(...reports: ObserverReport[]) {
      act(() => {
        for (const observer of observers) {
          const entries = reports
            .filter(({ target }) => observer.targets.has(target))
            .map(({ target, top, bottom = top, isIntersecting = false }) => ({
              target,
              isIntersecting,
              boundingClientRect: { top, bottom },
            }) as unknown as IntersectionObserverEntry);
          if (entries.length > 0) {
            observer.callback(entries, observer as unknown as IntersectionObserver);
          }
        }
      });
    },
  };
}

/**
 * A transport that answers from a map instead of reaching the network. It sits
 * at the seam the client is built on, so the real client, the envelope read and
 * the query all run; only the host is faked.
 *
 * A key is a path, which answers a GET, or a method and a path, such as
 * `PATCH /projects/P/tasks/P-1`. A reply can be a promise, for an answer a test
 * holds back.
 *
 * The default map answers `/health`, an empty `/projects` and an empty
 * `/workflows`, which is what every test that only mounts the tree needs. A
 * caller's entries extend it, and override by key. The map is returned too: an
 * entry set later answers the next request.
 */
export function stubTransport(replies: Record<string, TransportReply | Promise<TransportReply>> = {}) {
  const paths: string[] = [];
  const requests: TransportRequest[] = [];
  const map: Record<string, TransportReply | Promise<TransportReply>> = {
    "/health": successReply({ name: "tasma-daemon", version: "0.0.0" }),
    "/projects": successReply([]),
    "/workflows": successReply([]),
    ...replies,
  };

  const transport: Transport = (request) => {
    const { method, path } = request;
    const key = method === "GET" ? path : `${method} ${path}`;
    paths.push(path);
    requests.push(request);

    return Promise.resolve(
      map[key] ?? refusalReply(404, { kind: "daemon", code: "route-not-found", message: `no route serves ${key}` }),
    );
  };

  return { transport, paths, requests, replies: map };
}

/** A reply for a stub map that the test sends when it chooses. */
export function heldBack() {
  let answer: (reply: TransportReply) => void = () => {};
  const reply = new Promise<TransportReply>((resolve) => {
    answer = resolve;
  });

  return { reply, answer };
}

/** A success envelope, the shape every reply in a stub map starts from. */
export function successReply(data: unknown, diagnostics: readonly Diagnostic[] = []): TransportReply {
  return { status: 200, body: { ok: true, data, diagnostics } };
}

/** A refusal the daemon spelled out, which no query retries. */
export function refusalReply(status: number, failure: Failure): TransportReply {
  return { status, body: { ok: false, error: failure } };
}

/** The context every loader and every screen is handed, over a stub daemon. */
export function testContext(transport?: Transport): RouterContext {
  return {
    queryClient: createAppQueryClient(),
    client: createClient(transport ?? stubTransport().transport),
  };
}

/**
 * Mounts one component at `/` of a router that also knows the task page's
 * address, for a component that renders a Link or navigates. The task page
 * renders nothing, so a test reads where a click went from the router.
 */
export async function renderBesideTaskRoute(ui: ReactNode) {
  const rootRoute = createRootRoute({ component: Outlet });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => ui }),
      createRoute({ getParentRoute: () => rootRoute, path: "/tasks/$project/$task", component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  await router.load();
  const result = render(<RouterProvider router={router} />);

  return { ...result, router };
}

/**
 * Mounts the real route tree at a path. The shell is the root route's component
 * and the sidebar renders Link, so neither renders outside a router; a memory
 * history keeps a test off the document's own address.
 *
 * The router comes from the application's own factory, so a test cannot run a
 * differently configured router than the application does — the error and
 * not-found components included.
 *
 * The tree is mounted before the loaders have answered, the order main.tsx
 * runs: a test that awaited the load first would never render what the
 * application shows while a loader is still on its way.
 */
export async function renderWithRouter(initialPath = "/", transport?: Transport) {
  // The router scrolls on mount, which jsdom does not implement. A test that
  // watches the scrolls stubs it beforehand, and that stub stands.
  // eslint-disable-next-line @typescript-eslint/unbound-method -- the value is read, never called
  if (!vi.isMockFunction(window.scrollTo)) {
    vi.stubGlobal("scrollTo", () => {});
  }

  const context = testContext(transport);
  const router = createAppRouter(createMemoryHistory({ initialEntries: [initialPath] }), context);

  await act(async () => {
    render(
      <QueryClientProvider client={context.queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  });

  await act(async () => {
    await router.load();
  });

  return router;
}

/** Replaces ResizeObserver with one that reports a target only when a test asks. */
export function stubResizeObservers() {
  const callbacks = new Map<Element, () => void>();

  vi.stubGlobal(
    "ResizeObserver",
    class {
      readonly callback: () => void;
      readonly targets: Element[] = [];

      constructor(callback: () => void) {
        this.callback = callback;
      }

      observe(target: Element) {
        this.targets.push(target);
        callbacks.set(target, this.callback);
      }

      unobserve() {}

      disconnect() {
        for (const target of this.targets) {
          callbacks.delete(target);
        }
      }
    },
  );

  return {
    observed: (target: Element) => callbacks.has(target),
    report(target: Element) {
      act(() => {
        callbacks.get(target)?.();
      });
    },
  };
}

/**
 * Gives jsdom what the chat panel and its kit thread use, for the rest of the
 * test: a ResizeObserver, `scrollTo` on the window and on an element, and a
 * hit test that finds no element.
 */
export function stubThreadDom(): void {
  stubResizeObservers();
  stubHitTest(() => null);
  vi.stubGlobal("scrollTo", () => {});
  Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, value: () => {} });
  onTestFinished(() => {
    Reflect.deleteProperty(Element.prototype, "scrollTo");
  });
}

/**
 * Gives jsdom `document.elementFromPoint`, which it does not have, for the
 * rest of the test. A later call replaces the hit test of an earlier one.
 */
export function stubHitTest(hit: (x: number, y: number) => Element | null): void {
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: hit });
  onTestFinished(() => {
    Reflect.deleteProperty(document, "elementFromPoint");
  });
}

/**
 * Gives jsdom the CSS Custom Highlight API it lacks: `CSS.highlights` as a map,
 * and a `Highlight` that keeps its ranges, so a test reads what is highlighted.
 */
export function stubHighlights() {
  const highlights = new Map<string, { ranges: Range[] }>();

  vi.stubGlobal("CSS", { highlights });
  vi.stubGlobal(
    "Highlight",
    class {
      readonly ranges: Range[];

      constructor(...ranges: Range[]) {
        this.ranges = ranges;
      }
    },
  );

  return {
    /** The text of each range the highlight holds, or undefined while there is no such highlight. */
    texts: (name: string) => highlights.get(name)?.ranges.map((range) => range.toString()),
    ranges: (name: string) => highlights.get(name)?.ranges ?? [],
  };
}

/**
 * Gives Range the box jsdom does not compute. The default box is 20px tall at
 * 100px from the top; `box` changes it for the ranges it names.
 */
export function stubRangeBoxes(box: (range: Range) => Partial<DOMRect> = () => ({})) {
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: Range) {
      return { top: 100, bottom: 120, height: 20, left: 0, right: 40, width: 40, ...box(this) } as DOMRect;
    },
  });
  onTestFinished(() => {
    Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  });
}
