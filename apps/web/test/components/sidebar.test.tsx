import type { AgentState } from "@tasma/protocol";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daemonKeys } from "../../src/api/queries";
import { FOOTER_NAVIGATION, PRIMARY_NAVIGATION } from "../../src/navigation";
import { useNoticeStore } from "../../src/store/notices";
import { useUiStore } from "../../src/store/ui";
import { openWithFeed, refusalReply, renderWithRouter, stubTransport, successReply } from "../helpers";

const LABELS = [...PRIMARY_NAVIGATION, ...FOOTER_NAVIGATION].map((entry) => entry.label);

const NEEDS_YOU_WORDS = "A chat needs you";

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({ sidebarCollapsed: false });
  useNoticeStore.setState({ announced: [] });
});

afterEach(() => {
  cleanup();
  // renderWithRouter stubs scrollTo, which jsdom does not implement.
  vi.unstubAllGlobals();
});

it("offers every destination, and the collapse toggle beside them", async () => {
  await renderWithRouter();

  for (const label of LABELS) {
    expect(screen.getByRole("link", { name: label })).toBeTruthy();
  }
  expect(screen.getAllByRole("link")).toHaveLength(LABELS.length);
  expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy();
});

/*
 * Two navigation landmarks would each need a name to tell them apart, and a
 * Settings link inside no landmark at all would be worse. One unnamed <nav>
 * leaves the landmark list unambiguous.
 */
it("holds the destinations in exactly one navigation landmark", async () => {
  await renderWithRouter();

  const landmarks = screen.getAllByRole("navigation");
  expect(landmarks).toHaveLength(1);
  for (const label of LABELS) {
    expect(landmarks[0]!.contains(screen.getByRole("link", { name: label }))).toBe(true);
  }
});

/*
 * The collapse toggle sits outside the <nav>, so without a landmark around the
 * whole column a user moving by landmark would skip past the one control that
 * changes the sidebar and never reach it.
 */
it("keeps the toggle and the navigation inside the banner landmark, with no name of the app", async () => {
  await renderWithRouter();

  const banner = screen.getByRole("banner");
  expect(banner.contains(screen.getByRole("button", { name: "Collapse sidebar" }))).toBe(true);
  expect(banner.contains(screen.getByRole("navigation"))).toBe(true);
  expect(within(banner).queryByText(/^tasma$/i)).toBeNull();
});

it("starts the navigation directly below the band", async () => {
  await renderWithRouter();

  expect(screen.getByRole("navigation").classList.contains("pt-2")).toBe(true);
});

it("marks the current destination, and only that one", async () => {
  await renderWithRouter();

  const current = screen.getAllByRole("link").filter((link) => link.getAttribute("aria-current") === "page");
  expect(current.map((link) => link.textContent)).toEqual(["Chats"]);
});

// Every path starts with "/", so a prefix match leaves Chats current on
// every screen. Its link is the one that matches exactly.
it("does not leave Chats current on another screen", async () => {
  await renderWithRouter("/tasks");

  const current = screen.getAllByRole("link").filter((link) => link.getAttribute("aria-current") === "page");
  expect(current.map((link) => link.textContent)).toEqual(["Tasks"]);
});

it("keeps Chats current while the address of the page names a chat", async () => {
  await renderWithRouter("/?task=SAGA-3&chat=2");

  const current = screen.getAllByRole("link").filter((link) => link.getAttribute("aria-current") === "page");
  expect(current.map((link) => link.textContent)).toEqual(["Chats"]);
});

it("marks Settings current on its own screen", async () => {
  await renderWithRouter("/settings");

  const current = screen.getAllByRole("link").filter((link) => link.getAttribute("aria-current") === "page");
  expect(current.map((link) => link.textContent)).toEqual(["Settings"]);
});

/*
 * What this can prove in jsdom is the part a developer gets wrong: the label is
 * never removed from the DOM when collapsed. display: none would take the
 * accessible name with it and leave five unnamed links. That the CSS clips and
 * fades it instead of hiding it is checked by eye.
 */
it("keeps every link named once collapsed", async () => {
  useUiStore.setState({ sidebarCollapsed: true });
  await renderWithRouter();

  for (const label of LABELS) {
    expect(screen.getByRole("link", { name: label })).toBeTruthy();
  }
});

/*
 * jsdom computes no styles, so the rendered class is the only artifact of the
 * width there is. It is still worth pinning: without it, deleting the width
 * from the column leaves every other test in this file green.
 *
 * The full width is a breakpoint variant rather than a plain utility because
 * below it the rail is forced — at 320 CSS px a 240px sidebar leaves the
 * content less than one heading's width.
 */
it("carries the rail width always and the full width only above the breakpoint", async () => {
  const user = userEvent.setup();
  await renderWithRouter();

  const sidebar = screen.getByRole("banner");
  expect(sidebar.classList.contains("w-[max(--spacing(16),var(--title-controls))]")).toBe(true);
  expect(sidebar.classList.contains("sm:w-[max(--spacing(60),var(--title-controls))]")).toBe(true);

  await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));

  expect(sidebar.classList.contains("w-[max(--spacing(16),var(--title-controls))]")).toBe(true);
  expect(sidebar.classList.contains("sm:w-[max(--spacing(60),var(--title-controls))]")).toBe(false);
});

/*
 * A sticky sidebar cannot stay in view at the left of a board wider than the
 * shell, so the header only holds the width and one fixed child carries the
 * surface. The layout itself is checked in a real browser.
 */
it("holds the width on the header and the surface on one fixed child", async () => {
  await renderWithRouter();

  const header = screen.getByRole("banner");
  const content = header.firstElementChild!;

  expect(header.children).toHaveLength(1);
  for (const name of ["flex", "border-r", "bg-surface-2"]) {
    expect(header.classList.contains(name), name).toBe(false);
  }
  for (const name of [
    "fixed",
    "inset-y-0",
    "left-0",
    "z-(--layer-sidebar)",
    "w-[inherit]",
    "bg-surface-2",
    "pt-(--title-band)",
  ]) {
    expect(content.classList.contains(name), name).toBe(true);
  }
  expect(content.classList.contains("border-r")).toBe(false);
});

it("draws the frame of the page panel as one rounded border, with no line below the band and no curve when the band is 0", async () => {
  await renderWithRouter();

  const fixed = screen.getByRole("banner").firstElementChild!;

  for (const name of [
    "after:pointer-events-none",
    "after:absolute",
    "after:top-(--title-band)",
    "after:bottom-0",
    "after:left-full",
    "after:w-screen",
    "after:rounded-tl-(--panel-corner)",
    "after:border-l",
    "after:border-line",
    "after:[border-top-width:min(1px,var(--title-band))]",
    "after:shadow-[0_0_0_var(--panel-corner)_var(--color-surface-2)]",
    "after:[clip-path:inset(0)]",
    "after:[--panel-corner:min(var(--radius-panel),var(--title-band))]",
  ]) {
    expect(fixed.classList.contains(name), name).toBe(true);
  }
});

it("scrolls in a box inside the fixed one, below the band", async () => {
  await renderWithRouter();

  const fixed = screen.getByRole("banner").firstElementChild!;
  const scroller = fixed.firstElementChild!;

  expect(fixed.children).toHaveLength(1);
  expect(fixed.classList.contains("overflow-y-auto")).toBe(false);
  for (const name of ["overflow-y-auto", "min-h-0", "flex-1", "pb-2", "sm:pb-0"]) {
    expect(scroller.classList.contains(name), name).toBe(true);
  }
  expect(scroller.classList.contains("pt-(--title-band)")).toBe(false);
  expect(scroller.classList.contains("border-r")).toBe(false);
  expect(scroller.contains(screen.getByRole("navigation"))).toBe(true);
});

// The fixed content covers the left of the page, so the page's scroll padding
// has to follow the width, or a focus scroll can leave its target under it.
it("sets the page's scroll padding to the sidebar width", async () => {
  const user = userEvent.setup();
  await renderWithRouter();

  const header = screen.getByRole("banner");
  expect(header.classList.contains("[html:has(&)]:scroll-pl-[max(--spacing(16),var(--title-controls))]")).toBe(true);
  expect(header.classList.contains("sm:[html:has(&)]:scroll-pl-[max(--spacing(60),var(--title-controls))]")).toBe(true);

  await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));

  expect(header.classList.contains("[html:has(&)]:scroll-pl-[max(--spacing(16),var(--title-controls))]")).toBe(true);
  expect(header.classList.contains("sm:[html:has(&)]:scroll-pl-[max(--spacing(60),var(--title-controls))]")).toBe(false);
});

// A disclosure, not a toggle: it expands and collapses a region. The button
// carries no visible label in either state, so its name has to change with it,
// and aria-controls is what says which region it means.
it("flips the disclosure state and renames the toggle", async () => {
  const user = userEvent.setup();
  await renderWithRouter();

  const collapse = screen.getByRole("button", { name: "Collapse sidebar" });
  expect(collapse.getAttribute("aria-expanded")).toBe("true");
  expect(document.getElementById(collapse.getAttribute("aria-controls")!)).toBe(screen.getByRole("banner"));

  await user.click(collapse);

  const expand = screen.getByRole("button", { name: "Expand sidebar" });
  expect(expand.getAttribute("aria-expanded")).toBe("false");
  expect(useUiStore.getState().sidebarCollapsed).toBe(true);
  expect(screen.queryByRole("button", { name: "Collapse sidebar" })).toBeNull();
});

// It is a control, not a destination, so it is outside the navigation landmark
// and never carries aria-current.
it("keeps the toggle out of the navigation landmark", async () => {
  await renderWithRouter();

  const toggle = screen.getByRole("button", { name: "Collapse sidebar" });
  expect(screen.getByRole("navigation").contains(toggle)).toBe(false);
  expect(toggle.getAttribute("aria-current")).toBeNull();
});

describe("the agent state on the Chats link", () => {
  type Router = Awaited<ReturnType<typeof renderWithRouter>>;
  type Stub = ReturnType<typeof stubTransport>;

  const PROJECTS = [{ tag: "SAGA", name: "Saga", path: "/invented/saga" }];

  function stateReply(state: AgentState) {
    return successReply({ state });
  }

  function daemon(state: AgentState): Stub {
    return stubTransport({ "/chats/state": stateReply(state), "/projects": successReply(PROJECTS) });
  }

  async function open(path: string, stub: Stub): Promise<Router> {
    return renderWithRouter(path, stub.transport);
  }

  /** The query tells its observers one timer after the read ends. */
  async function readAgain(router: Router): Promise<void> {
    await act(async () => {
      await router.options.context.queryClient.invalidateQueries({ queryKey: daemonKeys.agentState() });
      await new Promise((resolve) => {
        setTimeout(resolve);
      });
    });
  }

  async function changeState(router: Router, stub: Stub, state: AgentState): Promise<void> {
    stub.replies["/chats/state"] = stateReply(state);
    await readAgain(router);
  }

  function chatsLink(): HTMLElement {
    return screen.getByRole("link", { name: /^Chats/ });
  }

  function iconOf(link: HTMLElement): HTMLElement {
    return link.querySelector("[aria-hidden='true']")!;
  }

  function moving(link: HTMLElement): boolean {
    return [...iconOf(link).querySelectorAll("*")].some((layer) => [...layer.classList].some((name) => name.startsWith("animate-")));
  }

  /** Each announcement lands one animation frame after its call. */
  async function spoken(): Promise<string[]> {
    await act(async () => {
      await new Promise((resolve) => {
        requestAnimationFrame(resolve);
      });
    });
    return useNoticeStore.getState().announced.map((message) => message.words);
  }

  it.each<[AgentState, string, string]>([
    ["off", "Chats", "text-graphic"],
    ["running", "Chats, agent works", "text-running"],
    ["needs-you", "Chats, needs you", "text-signal"],
  ])("names the link and colours the icon for %s", async (state, name, colour) => {
    await open("/settings", daemon(state));

    await waitFor(() => {
      expect(chatsLink().textContent).toBe(name);
    });
    expect(screen.getByRole("link", { name })).toBe(chatsLink());
    expect(iconOf(chatsLink()).classList.contains(colour)).toBe(true);
  });

  it("gives the Chats icon no fill on its current page", async () => {
    await open("/", daemon("off"));

    expect(chatsLink().getAttribute("aria-current")).toBe("page");
    expect(chatsLink().querySelector("svg")).toBeNull();
    expect(iconOf(chatsLink()).querySelector(".bg-current")).toBeNull();
  });

  it("reads the state again on a chat event of the feed", async () => {
    const stub = daemon("off");
    const { feed } = await openWithFeed("/settings", stub);

    stub.replies["/chats/state"] = stateReply("running");
    await feed.send([{ kind: "chat", tag: "SAGA", task: "SAGA-3", chat: 1, step: "dev:test", state: "working" }]);

    await waitFor(() => {
      expect(chatsLink().textContent).toBe("Chats, agent works");
    });
  });

  it("shows off with no motion before the first answer", async () => {
    const stub = daemon("running");
    stub.replies["/chats/state"] = new Promise(() => {});
    await open("/settings", stub);

    expect(chatsLink().textContent).toBe("Chats");
    expect(iconOf(chatsLink()).classList.contains("text-graphic")).toBe(true);
    expect(moving(chatsLink())).toBe(false);
  });

  it("keeps the last known state after a failed read, and plays no motion when the read recovers", async () => {
    const stub = daemon("running");
    const router = await open("/settings", stub);
    await waitFor(() => {
      expect(moving(chatsLink())).toBe(true);
    });
    const [ring] = iconOf(chatsLink()).children;

    stub.replies["/chats/state"] = refusalReply(500, { kind: "store", code: "chat-unreadable", message: "broken" });
    await readAgain(router);
    expect(chatsLink().textContent).toBe("Chats, agent works");
    expect(iconOf(chatsLink()).children[0]).toBe(ring);

    await changeState(router, stub, "running");
    expect(chatsLink().textContent).toBe("Chats, agent works");
    expect(iconOf(chatsLink()).children[0]).toBe(ring);
  });

  describe("the announcement", () => {
    async function afterFirstAnswer(path: string, state: AgentState) {
      const stub = daemon(state);
      const router = await open(path, stub);
      await waitFor(() => {
        expect(chatsLink().textContent).toBe(state === "off" ? "Chats" : "Chats, agent works");
      });
      await spoken();
      useNoticeStore.setState({ announced: [] });
      return { stub, router };
    }

    it("says it one time on a change into needs-you on another page", async () => {
      const { stub, router } = await afterFirstAnswer("/settings", "running");

      await changeState(router, stub, "needs-you");
      await changeState(router, stub, "needs-you");

      expect((await spoken()).filter((words) => words === NEEDS_YOU_WORDS)).toHaveLength(1);
    });

    it.each(["/?q=parser", "/?project=SAGA"])("says it on the filtered Chats page %s", async (path) => {
      const { stub, router } = await afterFirstAnswer(path, "off");

      await changeState(router, stub, "needs-you");

      expect(await spoken()).toContain(NEEDS_YOU_WORDS);
    });

    it.each(["/", "/?task=SAGA-3&chat=2", "/?q=%20%20", "/?project=NOPE", "/?project=lowercase"])(
      "says nothing on the Chats page with no filter or search at %s, whose list says it",
      async (path) => {
        const { stub, router } = await afterFirstAnswer(path, "off");

        await changeState(router, stub, "needs-you");

        expect(await spoken()).not.toContain(NEEDS_YOU_WORDS);
      },
    );

    it.each(["/", "/settings", "/?q=parser"])("says it for a first answer of needs-you at %s", async (path) => {
      await open(path, daemon("needs-you"));

      await waitFor(() => {
        expect(chatsLink().textContent).toBe("Chats, needs you");
      });
      expect(await spoken()).toContain(NEEDS_YOU_WORDS);
    });

    it.each<AgentState>(["running", "off"])("says nothing for a change into %s", async (state) => {
      const { stub, router } = await afterFirstAnswer("/settings", state === "off" ? "running" : "off");

      await changeState(router, stub, state);

      expect(await spoken()).not.toContain(NEEDS_YOU_WORDS);
    });

    it("says it again when the state comes back into needs-you", async () => {
      const { stub, router } = await afterFirstAnswer("/settings", "running");

      await changeState(router, stub, "needs-you");
      await spoken();
      await changeState(router, stub, "running");
      await changeState(router, stub, "needs-you");

      expect((await spoken()).filter((words) => words === NEEDS_YOU_WORDS)).toHaveLength(2);
    });
  });

  describe("the stop of the motion", () => {
    async function moved(state: AgentState) {
      const stub = daemon(state);
      const router = await open("/settings", stub);
      await waitFor(() => {
        expect(moving(chatsLink())).toBe(true);
      });
      return { router, stub };
    }

    it("stops on pointer enter, and stays stopped when the pointer leaves", async () => {
      await moved("running");

      fireEvent.pointerEnter(chatsLink());
      expect(moving(chatsLink())).toBe(false);

      fireEvent.pointerLeave(chatsLink());
      expect(moving(chatsLink())).toBe(false);
    });

    it("stops on focus, and stays stopped when the focus leaves", async () => {
      await moved("needs-you");

      fireEvent.focus(chatsLink());
      expect(moving(chatsLink())).toBe(false);

      fireEvent.blur(chatsLink());
      expect(moving(chatsLink())).toBe(false);
    });

    it("plays the motion of the next change of state, also back to a value that was stopped", async () => {
      const { router, stub } = await moved("needs-you");
      fireEvent.pointerEnter(chatsLink());

      await changeState(router, stub, "running");
      expect(moving(chatsLink())).toBe(true);

      fireEvent.pointerEnter(chatsLink());
      expect(moving(chatsLink())).toBe(false);

      await changeState(router, stub, "needs-you");
      expect(moving(chatsLink())).toBe(true);
    });

    it("stays stopped when a read gives the same state again", async () => {
      const { router, stub } = await moved("running");
      fireEvent.pointerEnter(chatsLink());

      await changeState(router, stub, "running");

      expect(moving(chatsLink())).toBe(false);
    });

    it("leaves the motion alone on another link", async () => {
      await moved("running");

      fireEvent.pointerEnter(screen.getByRole("link", { name: "Settings" }));
      fireEvent.focus(screen.getByRole("link", { name: "Settings" }));

      expect(moving(chatsLink())).toBe(true);
    });
  });
});
