import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stubSystemTheme } from "./helpers";

// The entry keeps no handle on its root. A root that stays mounted keeps its
// feed loop alive, and the loop reads through the fetch stubs of later tests.
const roots = vi.hoisted((): Root[] => []);

vi.mock("react-dom/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom/client")>();

  return {
    ...actual,
    createRoot: (...args: Parameters<typeof actual.createRoot>) => {
      const root = actual.createRoot(...args);
      roots.push(root);
      return root;
    },
  };
});

// The stub is installed once and its handle kept, so a test that changes the
// system appearance mid-run drives the same stub the entry subscribed to.
let system: ReturnType<typeof stubSystemTheme>;

beforeEach(() => {
  vi.resetModules();
  // The entry hydrates from storage, so a preference left by an earlier test
  // would decide this one's starting state.
  window.localStorage.clear();
  // The router scrolls on mount, which jsdom does not implement.
  vi.stubGlobal("scrollTo", () => {});
  // The hash is the app's address bar and hash history reads it when it is
  // created, so every test states where it opens before it imports the entry.
  window.location.hash = "#/";
  // The dashboard at #/ lists the chats before it renders.
  vi.stubGlobal("fetch", (input: string) =>
    input.endsWith("/daemon/chats")
      ? Promise.resolve(Response.json({ ok: true, data: { items: [], total: 0 }, diagnostics: [] }))
      : Promise.reject(new Error(`no stub answers ${input}`)));
  system = stubSystemTheme("dark");
});

afterEach(async () => {
  cleanup();
  act(() => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
  // The history patches window.history until it is destroyed and vi.resetModules()
  // gives every test a new one, so a layer left in place runs its own detached
  // router on the next test's navigation.
  const { router } = await import("../src/router");
  router.history.destroy();
  document.body.innerHTML = "";
  document.documentElement.className = "";
  vi.unstubAllGlobals();
});

it("mounts the shell into #root without throwing", async () => {
  document.body.innerHTML = '<div id="root"></div>';

  await act(async () => {
    await import("../src/main");
  });

  expect(screen.getByRole("navigation")).toBeTruthy();
  expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeTruthy();
  expect(document.documentElement.classList.contains("dark")).toBe(true);
});

// The entry resolves the stored preference and writes the class before it
// renders, so a preference disagreeing with the system never paints wrong.
it("starts on the stored preference rather than the system appearance", async () => {
  window.localStorage.setItem("tasma.theme", "light");
  document.body.innerHTML = '<div id="root"></div>';

  await act(async () => {
    await import("../src/main");
  });

  expect(document.documentElement.classList.contains("light")).toBe(true);
});

/*
 * The toggle's state is the only thing this may assert. The collapsed sidebar
 * leaves no artifact on the document the way the theme does, and by the time a
 * mount settles every effect has flushed, so a store hydrated before the first
 * render and one hydrated from an effect paint the same DOM. That hydration
 * happens synchronously is proved in test/store/ui.test.ts; nothing here may
 * assert a width or a class.
 */
it("starts on the stored sidebar state", async () => {
  window.localStorage.setItem("tasma.sidebar", "collapsed");
  document.body.innerHTML = '<div id="root"></div>';

  await act(async () => {
    await import("../src/main");
  });

  expect(screen.getByRole("button", { name: "Expand sidebar" }).getAttribute("aria-expanded")).toBe("false");
});

/*
 * The theme subscription sits above the router and outside the error boundary,
 * because either one replaces the tree below it when a screen throws. Once the
 * entry writes the first class the document stops following prefers-color-scheme
 * on its own, so without a live subscription the palette freezes until reload.
 */
it("follows the system appearance for as long as it runs", async () => {
  document.body.innerHTML = '<div id="root"></div>';

  await act(async () => {
    await import("../src/main");
  });
  expect(document.documentElement.classList.contains("dark")).toBe(true);

  await act(async () => {
    system.set("light");
  });

  expect(document.documentElement.classList.contains("light")).toBe(true);
  expect(document.documentElement.classList.contains("dark")).toBe(false);
});

/*
 * The control writes only to the store; what puts the class on <html> is the
 * subscription the entry mounts, so only a mount of the entry proves the two
 * are wired to each other.
 */
it("switches the theme through the wired entry path", async () => {
  const user = userEvent.setup();
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = "#/settings";

  await act(async () => {
    await import("../src/main");
  });
  await act(async () => {
    await user.click(screen.getByRole("radio", { name: "Light" }));
  });

  expect(document.documentElement.classList.contains("light")).toBe(true);
  expect(document.documentElement.classList.contains("dark")).toBe(false);
});

/*
 * The one test that proves main.tsx, the provider, the router context, the
 * loader, the transport and the proxy path are wired to each other: everything
 * between the entry module and the daemon runs, and only fetch is stubbed.
 */
it("lists the daemon's projects through the wired entry path", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = "#/projects";
  vi.stubGlobal("fetch", (input: string) =>
    input.endsWith("/daemon/projects")
      ? Promise.resolve(Response.json({ ok: true, data: [{ tag: "SAGA", name: "saga" }], diagnostics: [] }))
      : Promise.reject(new Error(`no stub answers ${input}`)));

  await act(async () => {
    await import("../src/main");
  });

  const row = screen.getByRole("list", { name: "Projects" }).querySelector("a");

  expect(screen.getByRole("heading", { level: 1, name: "Projects" })).toBeTruthy();
  expect(row?.getAttribute("href")).toBe("/#/projects/SAGA");
  expect(row?.textContent).toBe("sagaSAGA");
});

it("reads the change feed through the wired entry path", async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const requested: string[] = [];
  vi.stubGlobal("fetch", (input: string) => {
    requested.push(input);
    if (input.endsWith("/daemon/events")) {
      return Promise.resolve(Response.json({ ok: true, data: { cursor: "smoke-7", events: [] }, diagnostics: [] }));
    }
    // A read with a cursor is held. A stub that answers it at once makes the
    // loop read again with no wait, without end.
    if (input.includes("/daemon/events?after=")) {
      return new Promise(() => {});
    }
    return Promise.reject(new Error(`no stub answers ${input}`));
  });

  await act(async () => {
    await import("../src/main");
  });

  await waitFor(() => {
    expect(requested).toContain("/daemon/events?after=smoke-7");
  });
});

it("fails loudly when the document carries no #root", async () => {
  await expect(import("../src/main")).rejects.toThrow("#root");
});
