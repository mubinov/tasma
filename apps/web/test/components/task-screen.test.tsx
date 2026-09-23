import type { Diagnostic, Frontmatter, TaskEntry, Transport, TransportReply } from "@tasma/protocol";
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatClock } from "../../src/lib/clock";
import { useNoticeStore } from "../../src/store/notices";
import { useUiStore } from "../../src/store/ui";
import { refusalReply, renderWithRouter, stubIntersectionObserver, successReply } from "../helpers";
import {
  LISTING_PATH,
  TASK_PATH,
  backLink,
  caret,
  comment,
  commentCard,
  daemon,
  entry,
  field,
  frontmatter,
  listing,
  metaLine,
  noCaret,
  sidebar,
  task,
  topBar,
} from "../task-screen-fixtures";

/** Replaces ResizeObserver with one that reports a target only when a test asks. */
function stubResizeObservers() {
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

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({
    lastTasksProject: null,
    boardReturn: null,
    boardRestorePending: false,
    revealedColumns: new Set(),
  });
  useNoticeStore.setState({ notices: [], dismissed: new Map() });
  document.title = "tasma";
});

afterEach(() => {
  cleanup();
  document.documentElement.style.scrollPaddingTop = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the page", () => {
  it("heads the page with the title, the id shown above it, and the meta line", async () => {
    const { transport } = daemon({
      [TASK_PATH]: task({ fields: { priority: "high", workflow: "dev", step: "approve" } }),
    });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("Build the parser");
    expect(heading.className).toContain("wrap-anywhere");
    const id = heading.nextElementSibling;
    expect(id?.textContent).toBe("SAGA-3");
    expect(heading.parentElement?.className).toContain("flex-col-reverse");

    const [status, priority, step] = [...metaLine().children];
    expect(status?.textContent).toBe("In Progress");
    expect(status?.className).toContain("rounded-control");
    expect(priority?.textContent).toBe("high");
    expect(priority?.className).toBe("font-medium text-text");
    expect(step?.textContent).toBe("approve, step 2 of 2, a human's step");
    expect(step?.firstElementChild?.className).toContain("bg-signal");
    expect(step?.querySelector("i")).toBeNull();
    expect(document.title).toBe("SAGA-3 Build the parser · tasma");
  });

  it("keeps the back link in a top bar that stays while the page scrolls", async () => {
    const { transport } = daemon();
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const back = backLink();
    expect(back.getAttribute("href")).toBe("/tasks?projects=SAGA");
    expect(back.parentElement?.className).toContain("sticky");
    expect(back.parentElement?.className).toContain("z-(--layer-top-bar)");
    expect(back.parentElement?.classList.contains("h-top-bar")).toBe(true);
    expect(back.parentElement?.classList.contains("[html:has(&)]:scroll-pt-16")).toBe(true);
    expect(back.parentElement?.parentElement?.className).toBe("contents lg:block lg:min-w-0 lg:flex-1");
    expect(back.parentElement?.parentElement?.nextElementSibling).toBe(sidebar());
    const current = screen.getAllByRole("link").filter((link) => link.getAttribute("aria-current") === "page");
    expect(current.map((link) => link.textContent)).toEqual(["Tasks"]);
  });

  it("returns to the project's board through the back link", async () => {
    const user = userEvent.setup();
    const { transport } = daemon({ "/projects/SAGA/tasks": successReply({ entries: [], excluded: [] }) });
    const router = await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    await user.click(backLink());

    expect(router.state.location.pathname).toBe("/tasks");
    expect(router.state.location.search).toEqual({ projects: "SAGA" });
  });

  it("carries the label filter of the board the reader left", async () => {
    const user = userEvent.setup();
    useUiStore.setState({
      boardReturn: { projects: "SAGA", labels: "web,infra", scrollX: 0, scrollY: 1200, taskId: "SAGA-3" },
    });
    const { transport } = daemon();
    const router = await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    expect(backLink().getAttribute("href")).toBe("/tasks?projects=SAGA&labels=web,infra");

    await user.click(backLink());

    expect(router.state.location.search).toEqual({ projects: "SAGA", labels: "web,infra" });
  });

  // A page opened directly holds no record, and a record of another board is not this page's to return to.
  it.each([
    { what: "no record", record: null },
    { what: "a record for another project", record: { projects: "DELTA", labels: "web", scrollX: 0, scrollY: 80, taskId: "DELTA-1" } },
  ])("opens the project's board unfiltered with $what", async ({ record }) => {
    useUiStore.setState({ boardReturn: record });
    const { transport } = daemon();
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    expect(backLink().getAttribute("href")).toBe("/tasks?projects=SAGA");
  });

  it("mutes a priority that is not the top one, and shows a stale step as its name alone", async () => {
    const { transport } = daemon({ [TASK_PATH]: task({ fields: { priority: "low", workflow: "gone", step: "review" } }) });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const [, priority, step] = [...metaLine().children];
    expect(priority?.textContent).toBe("low");
    expect(priority?.getAttribute("class")).toBeNull();
    expect(step?.children).toHaveLength(1);
    expect(step?.firstElementChild?.className).toBe("font-mono text-xs text-dim");
  });

  it.each([{ status: "Done" }, { status: "done" }])("shows no step for the final status $status", async ({ status }) => {
    const { transport } = daemon({ [TASK_PATH]: task({ fields: { status, workflow: "dev", step: "approve" } }) });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    expect([...metaLine().children].map((item) => item.textContent)).toEqual([status]);
  });

  it("renders the body without its leading title heading", async () => {
    const { transport } = daemon({
      [TASK_PATH]: task({ body: "# Build the parser\n\nRead the file.\n\n## Plan\n\nSplit it." }),
    });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 2, name: "Plan" })).toBeTruthy();
    expect(screen.getByText("Read the file.")).toBeTruthy();
  });

  it("renders no body for a body of spaces, and the empty comment section after the meta line", async () => {
    const { transport } = daemon({ [TASK_PATH]: task({ body: "  \n\n " }) });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    expect(metaLine().nextElementSibling).toBe(screen.getByRole("region", { name: "Comments 0" }));
  });

  it("renders the comment section for a read that carries no comments, so Add comment is reachable", async () => {
    const { transport } = daemon({ [TASK_PATH]: successReply({ frontmatter: frontmatter(), body: "Text." }) });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    expect(screen.getByText("Text.")).toBeTruthy();
    const section = screen.getByRole("region", { name: "Comments 0" });
    expect(within(section).queryAllByRole("listitem")).toEqual([]);
    expect(within(section).getByRole("button", { name: "Add comment" })).toBeTruthy();
  });
});

describe("the comments", () => {
  const COMMENTS = [
    comment(1, { author: "reviewer", created: new Date(2026, 8, 13, 10, 24).toISOString() }),
    comment(2, { collapsed: true, body: "Folded **text**." }),
    comment(5, { title: "Marker only", body: " \n" }),
  ];

  it("lists every comment in file order under a heading with the count", async () => {
    const { transport } = daemon({ [TASK_PATH]: task({ comments: COMMENTS }) });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const section = screen.getByRole("region", { name: "Comments 3" });
    const items = within(section).getAllByRole("listitem");
    expect(items.map((item) => within(item).getByRole("heading", { level: 3 }).textContent)).toEqual([
      "Note 1",
      "Note 2",
      "Marker only",
    ]);
  });

  it("heads a comment with its id, its author and its date", async () => {
    const { transport } = daemon({ [TASK_PATH]: task({ comments: COMMENTS }) });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const first = commentCard("Note 1");
    const line = within(first).getByRole("heading", { level: 3 }).parentElement!.nextElementSibling!;
    expect(line.textContent).toBe("#1·reviewer·2026-09-13 10:24");
    expect(line.querySelector("time")?.getAttribute("dateTime")).toBe(COMMENTS[0]!.created);
    expect(commentCard("Note 2").querySelector("h3")?.parentElement?.nextElementSibling?.textContent).toMatch(/^#2·\d{4}-/);
  });

  it("opens a comment unless its file says collapsed, and folds it with the caret", async () => {
    const user = userEvent.setup();
    const { transport } = daemon({ [TASK_PATH]: task({ comments: COMMENTS }) });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const open = caret("Note 1");
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Body of note 1.")).toBeTruthy();

    const folded = caret("Note 2");
    expect(folded.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Folded")).toBeNull();

    await user.click(folded);
    expect(folded.getAttribute("aria-expanded")).toBe("true");
    expect(within(commentCard("Note 2")).getByText("text").tagName).toBe("STRONG");

    await user.click(open);
    expect(screen.queryByText("Body of note 1.")).toBeNull();
  });

  it("gives a comment with no text no caret and no panel", async () => {
    const { transport } = daemon({ [TASK_PATH]: task({ comments: COMMENTS }) });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const card = commentCard("Marker only");
    expect(noCaret("Marker only")).toBeNull();
    expect([...card.children].map((child) => child.tagName)).toEqual(["SPAN", "DIV"]);
  });

  it("sticks a comment's header under the top bar, and starts the card with an empty sentinel", async () => {
    const { transport } = daemon({ [TASK_PATH]: task({ comments: COMMENTS }) });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    for (const [title, id] of [["Note 1", "1"], ["Note 2", "2"], ["Marker only", "5"]] as const) {
      const card = commentCard(title);
      expect(card.dataset.commentId).toBe(id);
      const [sentinel, header] = [...card.children];
      expect(sentinel?.className).toBe("block");
      expect(sentinel?.hasAttribute("data-outline-sentinel")).toBe(true);
      expect(sentinel?.childNodes).toHaveLength(0);
      for (const name of [
        "sticky",
        "top-top-bar",
        "z-(--layer-comment-header)",
        "rounded-t-card",
        "bg-surface",
        "group-data-closed/comment:rounded-b-card",
      ]) {
        expect(header?.classList.contains(name), name).toBe(true);
      }
      expect(card.className).not.toContain("overflow");
    }
  });

  it("sets the header's height on the comment, the scroll margin of every element in its text", async () => {
    const resize = stubResizeObservers();
    const { transport } = daemon({
      [TASK_PATH]: task({ comments: [comment(1), comment(5, { title: "Marker only", body: "" })] }),
    });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const card = commentCard("Note 1");
    const [, header, panel] = [...card.children] as HTMLElement[];
    expect(panel?.classList.contains("[&_*]:scroll-mt-(--comment-header-height)")).toBe(true);

    Object.defineProperty(header, "offsetHeight", { configurable: true, value: 63 });
    resize.report(header!);
    expect(card.parentElement?.style.getPropertyValue("--comment-header-height")).toBe("63px");

    Object.defineProperty(header, "offsetHeight", { configurable: true, value: 85 });
    resize.report(header!);
    expect(card.parentElement?.style.getPropertyValue("--comment-header-height")).toBe("85px");

    expect(resize.observed(commentCard("Marker only").children[1]!)).toBe(false);
    cleanup();
    expect(resize.observed(header!)).toBe(false);
  });
});

describe("the title in the top bar and scroll to top", () => {
  function barTitle(): HTMLElement {
    return backLink().nextElementSibling as HTMLElement;
  }

  it("carries Edit at the right end of the bar while the page reads", async () => {
    const { transport } = daemon();
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const edit = within(topBar()).getByRole("button", { name: "Edit" });
    expect(edit.parentElement?.className).toContain("ml-auto");
  });

  it("hides the id and the title in the top bar, and the control, until the h1 has scrolled under the bar", async () => {
    const io = stubIntersectionObserver();
    const resize = stubResizeObservers();
    // The bar's rem height at an 18px root font size.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return { height: this.classList.contains("h-top-bar") ? 59.625 : 0 } as DOMRect;
    });
    const { transport } = daemon();
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);
    const heading = screen.getByRole("heading", { level: 1 });
    resize.report(topBar());

    const title = barTitle();
    expect(title.getAttribute("aria-hidden")).toBe("true");
    expect([...title.children].map((child) => [child.textContent, child.className])).toEqual([
      ["SAGA-3", "shrink-0 font-mono text-sm text-dim"],
      ["Build the parser", "truncate font-chrome text-base font-medium"],
    ]);
    expect(title.classList.contains("invisible")).toBe(true);
    expect(title.classList.contains("opacity-0")).toBe(true);
    expect(title.classList.contains("duration-(--duration-fast)")).toBe(true);
    expect(heading.tabIndex).toBe(-1);
    expect(screen.queryByRole("button", { name: "Scroll to top" })).toBeNull();
    const [observer] = io.observers.filter((item) => item.targets.has(heading));
    expect(observer?.options.rootMargin).toBe("-59.625px 0px 0px 0px");

    io.report({ target: heading, top: -20, bottom: 59.5 });
    expect(title.classList.contains("invisible")).toBe(false);
    expect(title.classList.contains("opacity-100")).toBe(true);
    expect(screen.getByRole("button", { name: "Scroll to top" })).toBeTruthy();

    io.report({ target: heading, top: 30, bottom: 60, isIntersecting: true });
    expect(title.classList.contains("invisible")).toBe(true);
    expect(screen.queryByRole("button", { name: "Scroll to top" })).toBeNull();

    io.report({ target: heading, top: 900, bottom: 930 });
    expect(title.classList.contains("invisible")).toBe(true);
  });

  it("observes nothing until the top bar is measured, and observes again with the new lengths when the bar resizes", async () => {
    const io = stubIntersectionObserver();
    const resize = stubResizeObservers();
    let barHeight = 53;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return { height: this.classList.contains("h-top-bar") ? barHeight : 0 } as DOMRect;
    });
    document.documentElement.style.scrollPaddingTop = "64px";
    const { transport } = daemon({ [TASK_PATH]: task({ body: "## Plan" }) });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);
    const heading = screen.getByRole("heading", { level: 1 });
    const plan = screen.getByRole("heading", { level: 2, name: "Plan" });
    const rootMargins = () => [heading, plan].map((target) => io.observers
      .filter((observer) => observer.targets.has(target))
      .map(({ options }) => options.rootMargin));
    expect(rootMargins()).toEqual([[], []]);

    resize.report(topBar());
    expect(rootMargins()).toEqual([["-53px 0px 0px 0px"], ["-72px 0px 10000000px 0px"]]);

    // The root font size goes from 16px to 18px on the open page.
    barHeight = 59.625;
    document.documentElement.style.scrollPaddingTop = "72px";
    resize.report(topBar());
    expect(rootMargins()).toEqual([["-59.625px 0px 0px 0px"], ["-80px 0px 10000000px 0px"]]);

    const bar = topBar();
    cleanup();
    expect(resize.observed(bar)).toBe(false);
  });

  it("puts the control last in the content column", async () => {
    const io = stubIntersectionObserver();
    const resize = stubResizeObservers();
    const { transport } = daemon();
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    resize.report(topBar());
    io.report({ target: screen.getByRole("heading", { level: 1 }), top: -40, bottom: -10 });

    const column = backLink().parentElement!.parentElement!;
    expect(column.lastElementChild).toBe(screen.getByRole("button", { name: "Scroll to top" }));
  });
});

describe("the contents outline", () => {
  const BODY = "Intro.\n\n## Plan\n\nSplit it.\n\n### Deep\n\nMore.\n\n## Build\n\nDone.";

  const COMMENTS = [comment(1), comment(2, { collapsed: true }), comment(5, { title: "Marker only", body: "" })];

  function outline(): HTMLElement {
    return within(sidebar()).getByRole("navigation", { name: "Contents" });
  }

  function lines(): string[] {
    return within(outline()).getAllByRole("button").map((line) => line.textContent);
  }

  it("ends the sidebar with the body's top headings, then the comment titles under Comments and the count", async () => {
    const { transport } = daemon({ [TASK_PATH]: task({ body: BODY, comments: COMMENTS }) });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    expect(lines()).toEqual(["Plan", "Build", "Note 1", "Note 2", "Marker only"]);
    expect(within(outline()).getByText(/^Comments/).textContent).toBe("Comments 3");
    expect(outline().parentElement?.parentElement).toBe(sidebar());
    expect(outline().parentElement).toBe(sidebar().lastElementChild);
  });

  it("has no body group for a body with no h2, and no nav with no heading and no comment", async () => {
    const { transport, replies } = daemon({ [TASK_PATH]: task({ body: "Text.\n\n- A list.", comments: [comment(1)] }) });
    const router = await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    expect(lines()).toEqual(["Note 1"]);
    expect(within(outline()).getAllByRole("list")).toHaveLength(1);

    replies["/projects/SAGA/tasks/SAGA-4"] = task({ fields: { id: "SAGA-4", title: "Write the docs" }, body: "Text." });
    await act(async () => {
      await router.navigate({ to: "/tasks/$project/$task", params: { project: "SAGA", task: "SAGA-4" } });
    });

    expect(within(sidebar()).queryByRole("navigation")).toBeNull();
    expect(sidebar().lastElementChild?.childElementCount).toBe(0);
  });

  it("marks the line of a comment by the sentinel at the top of its card, and a heading by the heading", async () => {
    const io = stubIntersectionObserver();
    const resize = stubResizeObservers();
    const { transport } = daemon({ [TASK_PATH]: task({ body: BODY, comments: COMMENTS }) });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);
    resize.report(topBar());

    const current = () => within(outline()).queryAllByRole("button").filter((line) => line.hasAttribute("aria-current"));
    io.report({ target: screen.getByRole("heading", { level: 2, name: "Build" }), top: -40, bottom: -16 });
    expect(current().map((line) => line.textContent)).toEqual(["Build"]);

    io.report({ target: commentCard("Note 2").querySelector("[data-outline-sentinel]")!, top: -10 });
    expect(current().map((line) => line.textContent)).toEqual(["Note 2"]);
  });

  it("labels a heading line with the heading's visible text, without the words only a screen reader hears", async () => {
    const { transport } = daemon({
      [TASK_PATH]: task({ body: "## Read [the guide](https://example.com) first\n\n## Plan" }),
    });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const heading = screen.getByRole("heading", { level: 2, name: /^Read the guide/ });
    expect(heading.querySelector(".sr-only")?.textContent).toBe(" (opens in a new tab)");
    expect(lines()).toEqual(["Read the guide first", "Plan"]);
    expect(within(outline()).getByRole("button", { name: "Read the guide first" })).toBeTruthy();
    expect(heading.textContent).toBe("Read the guide (opens in a new tab) first");
  });
});

describe("the sidebar", () => {
  const CREATED = new Date(2026, 8, 1, 9, 5).toISOString();
  const UPDATED = new Date(2026, 8, 14, 18, 27).toISOString();

  it("shows the state, workflow, relations and record groups beside the content, each after a rule but the first", async () => {
    const { transport } = daemon({
      [TASK_PATH]: task({
        fields: { priority: "high", labels: ["web", "infra"], workflow: "dev", step: "research", created: CREATED, updated: UPDATED },
      }),
    });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const aside = sidebar();
    for (const name of ["lg:sticky", "lg:h-screen", "lg:w-task-sidebar", "lg:border-l", "lg:border-t-0", "border-t"]) {
      expect(aside.classList.contains(name), name).toBe(true);
    }
    expect(aside.parentElement?.classList.contains("lg:flex-row")).toBe(true);
    expect(aside.previousElementSibling?.contains(screen.getByRole("heading", { level: 1 }))).toBe(true);

    const groups = [...aside.querySelectorAll("dl")];
    expect(groups[0]?.className).toContain("grid-cols-[5.25rem_minmax(0,1fr)]");
    expect(groups.map((group) => [...group.querySelectorAll("dt")].map((term) => term.textContent))).toEqual([
      ["Status", "Priority", "Labels"],
      ["Workflow", "Step"],
      ["Blocked by", "Parent"],
      ["Created", "Updated"],
    ]);
    expect(groups.map((group) => group.classList.contains("border-t"))).toEqual([false, true, true, true]);

    expect(field("Status").textContent).toBe("In Progress");
    expect(field("Priority").textContent).toBe("high");
    expect(field("Labels").textContent).toBe("web, infra");
    expect(within(field("Labels")).getByText("web").parentElement?.className).toContain("text-muted");
    expect(field("Workflow").textContent).toBe("dev");
    expect(field("Step").textContent).toBe("research, step 1 of 2, an agent's step");
    expect(field("Step").querySelectorAll("i")).toHaveLength(2);
    expect(field("Blocked by").className).toContain("col-span-full");

    const created = field("Created").querySelector("time");
    expect(created?.getAttribute("dateTime")).toBe(CREATED);
    expect(created?.textContent).toBe("2026-09-01 09:05");
    expect(field("Updated").textContent).toBe("2026-09-14 18:27");
    expect(groups.flatMap((group) => [...group.querySelectorAll("dd")]).every((value) => value.classList.contains("wrap-anywhere"))).toBe(true);
  });

  it("is a tab stop only while it scrolls, with its focus ring inside", async () => {
    const observed: Element[] = [];
    const disconnect = vi.fn();
    let report = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        callback: () => void;
        aside = false;

        constructor(callback: () => void) {
          this.callback = callback;
        }

        observe(target: Element) {
          if (target.tagName === "ASIDE") {
            this.aside = true;
            report = this.callback;
          }
          if (this.aside) {
            observed.push(target);
          }
        }

        unobserve() {}

        disconnect() {
          if (this.aside) {
            disconnect();
          }
        }
      },
    );
    const { transport } = daemon();
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const aside = sidebar();
    expect(observed).toEqual([aside, ...aside.children]);
    expect(aside.tabIndex).toBe(-1);
    expect(aside.classList.contains("focus-visible:-outline-offset-2")).toBe(true);

    Object.defineProperty(aside, "clientHeight", { configurable: true, value: 600 });
    Object.defineProperty(aside, "scrollHeight", { configurable: true, value: 601 });
    act(() => {
      report();
    });
    expect(aside.tabIndex).toBe(0);

    Object.defineProperty(aside, "scrollHeight", { configurable: true, value: 600 });
    act(() => {
      report();
    });
    expect(aside.tabIndex).toBe(-1);

    cleanup();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("keeps room for the notice stack below the page's last row and a focus scroll's target", async () => {
    const { transport } = daemon();
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const aside = sidebar();
    const frame = aside.parentElement!;
    const content = screen.getByRole("heading", { level: 1 }).parentElement!.parentElement!;
    const room = (spacing: number) => `[calc(--spacing(${String(spacing)})+var(--notice-stack-height,0px))]`;
    expect(frame.classList.contains(`-mb-${room(6)}`)).toBe(true);
    expect(frame.classList.contains(`sm:-mb-${room(10)}`)).toBe(true);
    expect(content.classList.contains(`lg:pb-${room(12)}`)).toBe(true);
    expect(aside.classList.contains(`pb-${room(8)}`)).toBe(true);
    expect(aside.classList.contains("lg:scroll-pb-(--notice-stack-height)")).toBe(true);
  });

  it("reads None for a missing priority, labels, workflow, step, blockers and parent", async () => {
    const { transport } = daemon();
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    for (const label of ["Priority", "Labels", "Workflow", "Step", "Blocked by", "Parent"]) {
      expect(within(field(label)).getByText("None").className).toBe("text-dim");
    }
    for (const label of ["Priority", "Labels", "Workflow", "Step"]) {
      expect(field(label).textContent).toBe("None");
    }
    // The pencil stands first in a relation row, and the list after it.
    for (const label of ["Blocked by", "Parent"]) {
      expect(field(label).lastElementChild?.textContent).toBe("None");
    }
    // Priority is a control, so its None stands inside the trigger. The task
    // names no workflow and holds no step, so Step offers nothing and stays text.
    expect(field("Priority").firstElementChild?.tagName).toBe("BUTTON");
    expect(field("Step").firstElementChild?.className).toBe("text-dim");
  });

  it.each([
    { case: "a stale step", fields: { workflow: "gone", step: "review" } },
    { case: "the step of a task in a final status", fields: { status: "Done", workflow: "dev", step: "review" } },
  ])("shows $case as its name in dim, with no dot and no track", async ({ fields }) => {
    const { transport } = daemon({ [TASK_PATH]: task({ fields }) });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const trigger = within(field("Step")).getByRole("button");
    expect(trigger.children).toHaveLength(1);
    expect(trigger.firstElementChild?.textContent).toBe("review");
    expect(trigger.firstElementChild?.className).toBe("font-mono text-xs text-dim");
    expect(field("Step").querySelector("i")).toBeNull();
  });

  it("writes each key of custom on its own line", async () => {
    const { transport } = daemon({ [TASK_PATH]: task({ fields: { custom: { rounds: 2, review: { by: "bot" } } } }) });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const lines = [...field("Custom").children];
    expect(lines.map((line) => line.textContent)).toEqual(["rounds: 2", "review: {\"by\":\"bot\"}"]);
    expect(lines[0]?.className).toBe("font-mono text-xs-plus");
  });

  it.each([{ case: "no custom", fields: {} }, { case: "an empty custom", fields: { custom: {} } }])(
    "shows no Custom row for $case",
    async ({ fields }) => {
      const { transport } = daemon({ [TASK_PATH]: task({ fields }) });
      await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

      expect(within(sidebar()).queryByText("Custom")).toBeNull();
    },
  );
});

describe("the relations", () => {
  const ENTRIES = [
    entry("SAGA-1", "Done", "Write the grammar"),
    entry("SAGA-2", "In Progress", "Lex the input"),
    entry("SAGA-7", "Backlog", "Ship the parser"),
  ];

  function related(fields: Partial<Frontmatter>) {
    return daemon({ [TASK_PATH]: task({ fields }), [LISTING_PATH]: listing(ENTRIES) });
  }

  function rows(label: string): HTMLElement[] {
    return within(field(label)).getAllByRole("listitem");
  }

  it("shows each blocker as its status in brackets, its id and its title, in the order of blocked_by", async () => {
    const { transport } = related({ blocked_by: ["SAGA-2", "LOOM-4", "SAGA-1"], parent: "SAGA-7" });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    expect(rows("Blocked by").map((row) => row.textContent.trim())).toEqual([
      "[In Progress] SAGA-2 Lex the input",
      "[Not found] LOOM-4",
      "[Done] SAGA-1 Write the grammar",
    ]);
    expect(rows("Parent").map((row) => row.textContent.trim())).toEqual(["[Backlog] SAGA-7 Ship the parser"]);
  });

  it("makes the whole row one link to its task, with the id underlined and the title not", async () => {
    const user = userEvent.setup();
    const { transport } = related({ blocked_by: ["SAGA-2"] });
    const router = await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const link = within(field("Blocked by")).getByRole("link", { name: "[In Progress] SAGA-2 Lex the input" });
    expect(link.getAttribute("href")).toBe("/tasks/SAGA/SAGA-2");
    const id = within(link).getByText("SAGA-2");
    expect(id.className).toContain("underline");
    expect(within(link).getByText("Lex the input").className).not.toContain("underline");

    await user.click(link);

    expect(router.state.location.pathname).toBe("/tasks/SAGA/SAGA-2");
  });

  it("marks a blocking row, dims a resolved one, and mutes the status of the parent", async () => {
    const { transport } = related({ blocked_by: ["SAGA-2", "SAGA-1"], parent: "SAGA-7" });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const [blocking, resolved] = rows("Blocked by").map((row) => within(row).getByRole("link"));
    const [parent] = rows("Parent").map((row) => within(row).getByRole("link"));

    expect(blocking?.className).toContain("text-text");
    expect(blocking?.querySelector("svg")?.getAttribute("class")).toContain("text-signal");
    expect(within(blocking!).getByText("[In Progress]").className).toContain("text-signal");

    expect(resolved?.className).toContain("text-dim");
    expect(resolved?.querySelector("svg")).toBeNull();
    expect(within(resolved!).getByText("[Done]").className).toBe("");

    expect(parent?.className).toContain("text-text");
    expect(parent?.querySelector("svg")).toBeNull();
    expect(within(parent!).getByText("[Backlog]").className).toContain("text-muted");
  });

  it("keeps the mark in its own column, and wraps the status, the id and the title as text beside it", async () => {
    const { transport } = related({ blocked_by: ["SAGA-2", "LOOM-4"] });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const [listed, unlisted] = rows("Blocked by").map((row) => row.firstElementChild as HTMLElement);
    for (const row of [listed!, unlisted!]) {
      expect(row.className).toContain("flex items-start gap-x-2");
      expect([...row.children].map((child) => child.className)).toEqual([
        "flex h-5 w-3.5 shrink-0 items-center",
        "min-w-0 flex-1",
      ]);
    }
    expect(within(listed!).getByText("[In Progress]").className).toBe("text-signal");
    expect(within(listed!).getByText("Lex the input").className).toBe("block");
  });

  it("shows an id the listing does not hold as [Not found], with no link and no underline", async () => {
    const { transport } = related({ blocked_by: ["LOOM-4"], parent: "LOOM-9" });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const [blocker] = rows("Blocked by");
    expect(within(blocker!).queryByRole("link")).toBeNull();
    expect(blocker?.querySelector("svg")?.getAttribute("class")).toContain("text-signal");
    expect(within(blocker!).getByText("[Not found]").className).toContain("text-signal");
    expect(within(blocker!).getByText("LOOM-4").className).not.toContain("underline");

    const [parent] = rows("Parent");
    expect(parent?.textContent.trim()).toBe("[Not found] LOOM-9");
    expect(within(parent!).queryByRole("link")).toBeNull();
    expect(parent?.querySelector("svg")).toBeNull();
    expect(within(parent!).getByText("[Not found]").className).toContain("text-muted");
  });
});

describe("the blocked summary", () => {
  const ENTRIES = [entry("SAGA-1", "Done", "Write the grammar"), entry("SAGA-2", "In Progress", "Lex the input")];

  it("names only the blockers that still block, a listed one as a link", async () => {
    const { transport } = daemon({
      [TASK_PATH]: task({ fields: { blocked_by: ["SAGA-1", "SAGA-2", "LOOM-4"] } }),
      [LISTING_PATH]: listing(ENTRIES),
    });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const [, summary] = [...metaLine().children];
    expect(summary?.textContent).toBe("blocked by SAGA-2, LOOM-4");
    const words = within(summary as HTMLElement).getByText("blocked by");
    expect(words.className).toBe("inline-flex h-5 items-center gap-1 align-top whitespace-nowrap text-signal");
    expect(words.querySelector("svg")).not.toBeNull();
    const links = within(summary as HTMLElement).getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([["SAGA-2", "/tasks/SAGA/SAGA-2"]]);
    expect(links[0]?.className).toContain("wrap-anywhere");
    const unlisted = within(summary as HTMLElement).getByText("LOOM-4");
    expect(unlisted.tagName).toBe("SPAN");
    expect(unlisted.className).toContain("wrap-anywhere");
  });

  it("is absent when every blocker is resolved", async () => {
    const { transport } = daemon({
      [TASK_PATH]: task({ fields: { blocked_by: ["SAGA-1"] } }),
      [LISTING_PATH]: listing(ENTRIES),
    });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    expect([...metaLine().children].map((item) => item.textContent)).toEqual(["In Progress"]);
  });
});

describe("opening a task from the board", () => {
  const ENTRY: TaskEntry = { id: "SAGA-3", path: "/repos/saga/tasks/SAGA-3.md", blocked: false, frontmatter: frontmatter({ workflow: "dev", step: "research" }) };

  it("asks the daemon for the task alone when the board's reads are in the cache", async () => {
    const user = userEvent.setup();
    const { transport, paths } = daemon({
      "/projects/SAGA/tasks": successReply({ entries: [ENTRY], excluded: [] }),
      [TASK_PATH]: task({ fields: { workflow: "dev", step: "research" } }),
    });
    const router = await renderWithRouter("/tasks?projects=SAGA", transport);
    paths.length = 0;

    await user.click(screen.getByRole("link", { name: "Build the parser" }));

    expect(router.state.location.pathname).toBe("/tasks/SAGA/SAGA-3");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Build the parser");
    expect(paths).toEqual([TASK_PATH]);
  });
});

describe("polling", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  /** One poll interval, then the zero-delay timer the query cache notifies its observers through. */
  async function poll() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
  }

  it("reads the task, the project and the listing again every 5 seconds", async () => {
    const { transport, paths, replies } = daemon({ [TASK_PATH]: task({ comments: [comment(1)] }) });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);
    paths.length = 0;

    replies[TASK_PATH] = task({ comments: [comment(1), comment(2)] });
    await poll();

    expect(paths.toSorted()).toEqual(["/projects/SAGA", LISTING_PATH, TASK_PATH]);
    expect(screen.getByRole("region", { name: "Comments 2" })).toBeTruthy();
  });

  it("measures the new header when a poll gives a comment its first text", async () => {
    const resize = stubResizeObservers();
    const { transport, replies } = daemon({ [TASK_PATH]: task({ comments: [comment(1, { body: "" })] }) });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);
    const before = commentCard("Note 1").children[1]!;
    expect(resize.observed(before)).toBe(false);

    replies[TASK_PATH] = task({ comments: [comment(1)] });
    await poll();

    const header = commentCard("Note 1").children[1]!;
    expect(header).not.toBe(before);
    expect(resize.observed(header)).toBe(true);
  });

  it("reads the contents outline again when a poll changes the task", async () => {
    const { transport, replies } = daemon({ [TASK_PATH]: task({ body: "## Plan", comments: [comment(1)] }) });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);
    const outline = () => within(sidebar()).getByRole("navigation", { name: "Contents" });

    replies[TASK_PATH] = task({ body: "## Plan\n\n## Ship", comments: [comment(1), comment(2, { title: "Shipped" })] });
    await poll();

    expect(within(outline()).getAllByRole("button").map((line) => line.textContent)).toEqual(["Plan", "Ship", "Note 1", "Shipped"]);
    expect(within(outline()).getByText(/^Comments/).textContent).toBe("Comments 2");
  });

  it("keeps the DOM of a comment a poll did not change", async () => {
    const { transport, replies } = daemon({ [TASK_PATH]: task({ comments: [comment(1), comment(2)] }) });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);
    const unchanged = screen.getByText("Body of note 1.");

    replies[TASK_PATH] = task({ comments: [comment(1), comment(2, { body: "Rewritten." })] });
    await poll();

    expect(screen.getByText("Rewritten.")).toBeTruthy();
    expect(screen.getByText("Body of note 1.")).toBe(unchanged);
  });

  it("opens a comment a poll gives text, unless its file says collapsed", async () => {
    const { transport, replies } = daemon({
      [TASK_PATH]: task({ comments: [comment(1, { body: "" }), comment(2, { body: "", collapsed: true })] }),
    });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    replies[TASK_PATH] = task({ comments: [comment(1), comment(2, { collapsed: true })] });
    await poll();

    expect(caret("Note 1").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Body of note 1.")).toBeTruthy();
    expect(caret("Note 2").getAttribute("aria-expanded")).toBe("false");
  });

  it("gives an open comment whose text a poll removes the closed header", async () => {
    const { transport, replies } = daemon({ [TASK_PATH]: task({ comments: [comment(1)] }) });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);
    expect(commentCard("Note 1").hasAttribute("data-open")).toBe(true);

    replies[TASK_PATH] = task({ comments: [comment(1, { body: "" })] });
    await poll();

    const card = commentCard("Note 1");
    expect(card.hasAttribute("data-open")).toBe(false);
    expect(card.hasAttribute("data-closed")).toBe(true);
    expect(noCaret("Note 1")).toBeNull();
  });

  it("drops a blocker from the blocked summary once a poll of the listing finds it resolved", async () => {
    const { transport, replies } = daemon({
      [TASK_PATH]: task({ fields: { blocked_by: ["SAGA-2"] } }),
      [LISTING_PATH]: listing([entry("SAGA-2", "In Progress", "Lex the input")]),
    });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);
    expect(metaLine().children).toHaveLength(2);

    replies[LISTING_PATH] = listing([entry("SAGA-2", "Done", "Lex the input")]);
    await poll();

    expect(metaLine().children).toHaveLength(1);
    expect(within(field("Blocked by")).getByRole("link").textContent.trim()).toBe("[Done] SAGA-2 Lex the input");
  });

  it("shows the step of a workflow a poll brings once its read lands", async () => {
    const { transport, replies } = daemon();
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);
    expect(metaLine().children).toHaveLength(1);

    replies[TASK_PATH] = task({ fields: { workflow: "dev", step: "research" } });
    await poll();

    await vi.waitFor(() => {
      expect(metaLine().children[1]?.textContent).toBe("research, step 1 of 2, an agent's step");
    });
  });
});

describe("the warnings of the task read", () => {
  const BLOCKER: Diagnostic = { code: "blocked-by-unresolved", message: "SAGA-9 names no task", path: "/p/SAGA-3.md" };
  const STALE: Diagnostic = { code: "stale-next-comment-id", message: "next_comment_id is below 4", path: "/p/SAGA-3.md", line: 4 };

  /** The titles on screen, in the notice stack that follows <main>. */
  function notices(): HTMLElement[] {
    return within(screen.getByRole("main").nextElementSibling as HTMLElement).queryAllByText(/warnings? about SAGA-/);
  }

  it("opens one warning notice, which a poll with the same warnings does not open again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { transport, replies } = daemon({ [TASK_PATH]: task({ diagnostics: [BLOCKER, STALE] }) });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const [title] = notices();
    expect(title?.textContent).toBe("2 warnings about SAGA-3");
    const words = within(title!.parentElement!).getAllByRole("listitem").map((item) => item.textContent);
    expect(words).toEqual(["blocked-by-unresolved · SAGA-9 names no task", "stale-next-comment-id · next_comment_id is below 4"]);

    replies[TASK_PATH] = task({ diagnostics: [{ ...BLOCKER }, { ...STALE }] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_010);
    });

    expect(notices()).toEqual([title]);
    expect(screen.queryByRole("heading", { level: 2, name: /warning/ })).toBeNull();
  });

  it("closes the notice when the reader goes to the board", async () => {
    const user = userEvent.setup();
    const { transport } = daemon({
      [TASK_PATH]: task({ diagnostics: [BLOCKER] }),
      "/projects/SAGA/tasks": successReply({ entries: [], excluded: [] }),
    });
    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);
    expect(notices().map((notice) => notice.textContent)).toEqual(["1 warning about SAGA-3"]);

    await user.click(backLink());

    expect(notices()).toEqual([]);
  });

  it("starts the next task afresh: its comments as its file says, and no notice of the task before", async () => {
    const { transport } = daemon({
      [TASK_PATH]: task({ comments: [comment(1, { collapsed: true })], diagnostics: [BLOCKER] }),
      "/projects/SAGA/tasks/SAGA-4": task({ fields: { id: "SAGA-4", title: "Write the docs" }, comments: [comment(1)] }),
    });
    const router = await renderWithRouter("/tasks/SAGA/SAGA-3", transport);
    expect(caret("Note 1").getAttribute("aria-expanded")).toBe("false");
    expect(notices()).toHaveLength(1);

    await act(async () => {
      await router.navigate({ to: "/tasks/$project/$task", params: { project: "SAGA", task: "SAGA-4" } });
    });

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Write the docs");
    expect(caret("Note 1").getAttribute("aria-expanded")).toBe("true");
    expect(notices()).toEqual([]);
  });
});

describe("a failed load", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("hands an id no URL segment can carry to the not-found screen, with no request", async () => {
    const { transport, paths } = daemon();
    await renderWithRouter("/tasks/SAGA/%5C", transport);

    expect(screen.getByRole("main").textContent).toContain("names nothing the application can show");
    expect(paths).toEqual([]);
  });

  it.each<{ case: string; path: string; replies: Record<string, TransportReply>; words: string[] }>([
    {
      case: "a task the project does not hold",
      path: "/tasks/SAGA/OTHER-1",
      replies: {
        "/projects/SAGA/tasks/OTHER-1": refusalReply(404, { kind: "store", code: "task-not-found", message: "no task OTHER-1" }),
      },
      words: ["store/task-not-found", "no task OTHER-1"],
    },
    {
      case: "a task file that does not parse",
      path: "/tasks/SAGA/SAGA-3",
      replies: {
        [TASK_PATH]: refusalReply(422, {
          kind: "parse",
          code: "frontmatter-invalid",
          message: "/repos/saga/tasks/SAGA-3.md:2: the frontmatter is not YAML",
          line: 2,
        }),
      },
      words: ["parse/frontmatter-invalid", "SAGA-3.md:2: the frontmatter is not YAML"],
    },
    {
      case: "a project the daemon refuses",
      path: "/tasks/SAGA/SAGA-3",
      replies: { "/projects/SAGA": refusalReply(422, { kind: "store", code: "config-invalid", message: "statuses is empty" }) },
      words: ["store/config-invalid", "statuses is empty"],
    },
    {
      case: "a listing the daemon refuses",
      path: "/tasks/SAGA/SAGA-3",
      replies: { [LISTING_PATH]: refusalReply(422, { kind: "store", code: "config-invalid", message: "priorities is empty" }) },
      words: ["store/config-invalid", "priorities is empty"],
    },
  ])("shows the refusal for $case", async ({ path, replies, words }) => {
    const { transport } = daemon(replies);
    await renderWithRouter(path, transport);

    const alert = screen.getByRole("alert");
    expect(document.title).toBe("Request refused · tasma");
    expect(within(alert).getByRole("heading", { level: 1 }).textContent).toBe("the daemon refused this request");
    for (const word of words) {
      expect(alert.textContent).toContain(word);
    }
  });

  it.each([
    { case: "an answer with no envelope", reply: { status: 502 }, heading: "tasma cannot read the daemon's answer" },
    { case: "no answer at all", reply: null, heading: "tasma cannot reach the daemon" },
  ])("shows the transport failure for $case, with Retry", async ({ reply, heading }) => {
    const { transport: answering } = daemon();
    const transport: Transport = (request) =>
      request.path === TASK_PATH
        ? reply === null ? Promise.reject(new Error("connection refused")) : Promise.resolve(reply)
        : answering(request);

    await renderWithRouter("/tasks/SAGA/SAGA-3", transport);

    const alert = screen.getByRole("alert");
    expect(within(alert).getByRole("heading", { level: 1 }).textContent).toBe(heading);
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("the notice for failed polls", () => {
  const GONE = refusalReply(404, { kind: "store", code: "task-not-found", message: "no task SAGA-3" });

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  async function poll() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
  }

  it("opens after two failed polls, naming a task deleted while its page is open, and closes after a successful poll", async () => {
    const { transport, replies } = daemon();
    const router = await renderWithRouter("/tasks/SAGA/SAGA-3", transport);
    const readAt = router.options.context.queryClient.getQueryState(["daemon", "projects", "SAGA", "tasks", "SAGA-3"])!.dataUpdatedAt;

    replies[TASK_PATH] = GONE;
    await poll();
    expect(useNoticeStore.getState().notices).toEqual([]);

    await poll();
    expect(useNoticeStore.getState().notices).toMatchObject([
      {
        key: "task-poll:SAGA-3",
        form: "failure",
        title: "SAGA-3 is not up to date",
        line: `The last reads of SAGA-3 failed. The page shows the task as it was at ${formatClock(readAt)}.`,
        words: ["store/task-not-found · no task SAGA-3"],
      },
    ]);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Build the parser");

    replies[TASK_PATH] = task();
    await poll();
    expect(useNoticeStore.getState().notices).toEqual([]);
  });

  it("counts the failed polls of the listing too, keeps the notice while the task reads succeed, and closes when the reader leaves the page", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    const { transport, replies } = daemon();
    const router = await renderWithRouter("/tasks/SAGA/SAGA-3", transport);
    const readAt = router.options.context.queryClient.getQueryState(["daemon", "projects", "SAGA", "tasks"])!.dataUpdatedAt;

    replies[LISTING_PATH] = refusalReply(422, { kind: "store", code: "config-invalid", message: "priorities is empty" });
    await poll();
    await poll();
    const [notice] = useNoticeStore.getState().notices;
    expect(useNoticeStore.getState().notices.map(({ words }) => words)).toEqual([["store/config-invalid · priorities is empty"]]);
    expect(notice?.line).toBe(`The last reads of SAGA-3 failed. The page shows the task as it was at ${formatClock(readAt)}.`);

    await poll();
    expect(useNoticeStore.getState().notices).toHaveLength(1);
    expect(useNoticeStore.getState().notices[0]).toBe(notice);

    await user.click(backLink());

    expect(useNoticeStore.getState().notices.filter(({ key }) => key === "task-poll:SAGA-3")).toEqual([]);
  });
});
