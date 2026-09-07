import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { createClient, type Diagnostic, type Failure, type Transport, type TransportReply } from "@tasma/protocol";
import { act, render } from "@testing-library/react";
import { vi } from "vitest";
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

/**
 * A transport that answers from a map instead of reaching the network. It sits
 * at the seam the client is built on, so the real client, the envelope read and
 * the query all run; only the host is faked.
 *
 * The default map answers `/health` and an empty `/projects`, which is what
 * every test that only mounts the tree needs. A caller's entries extend it, and
 * override by key.
 */
export function stubTransport(replies: Record<string, TransportReply> = {}) {
  const paths: string[] = [];
  const map: Record<string, TransportReply> = {
    "/health": successReply({ name: "tasma-daemon", version: "0.0.0" }),
    "/projects": successReply([]),
    ...replies,
  };

  const transport: Transport = ({ path }) => {
    paths.push(path);

    return Promise.resolve(
      map[path] ?? refusalReply(404, { kind: "daemon", code: "route-not-found", message: `no route serves ${path}` }),
    );
  };

  return { transport, paths };
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
  // The router scrolls on mount, which jsdom does not implement.
  vi.stubGlobal("scrollTo", () => {});

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
