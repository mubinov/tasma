import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskOutline, type OutlineEntry } from "../../src/components/task-outline";
import { stubIntersectionObserver, stubReducedMotion } from "../helpers";

let page: HTMLElement;
let aside: HTMLElement;

function heading(label: string): OutlineEntry {
  const element = document.createElement("h2");
  element.textContent = label;
  page.append(element);
  return { label, target: element, sentinel: element };
}

function comment(label: string): OutlineEntry {
  const article = document.createElement("article");
  const sentinel = document.createElement("span");
  article.append(sentinel);
  page.append(article);
  return { label, target: article, sentinel };
}

type OutlineOptions = { sidebar?: HTMLElement | null; pageScrollPadding?: number };

function renderOutline(
  headings: OutlineEntry[],
  comments: OutlineEntry[],
  { sidebar = aside, pageScrollPadding = 0 }: OutlineOptions = {},
) {
  return render(
    <TaskOutline
      headings={headings}
      comments={comments}
      sidebarRef={{ current: sidebar }}
      pageScrollPadding={pageScrollPadding}
    />,
    { container: aside },
  );
}

/** Makes the aside's scrollTop a plain value, which jsdom keeps at 0. */
function stubSidebarScroll(top: number): { top: number } {
  const scroll = { top };
  Object.defineProperty(aside, "scrollTop", {
    configurable: true,
    get: () => scroll.top,
    set: (value: number) => {
      scroll.top = value;
    },
  });
  return scroll;
}

function outline(): HTMLElement {
  return screen.getByRole("navigation", { name: "Contents" });
}

function line(label: string): HTMLElement {
  return within(outline()).getByRole("button", { name: label });
}

function current(): string[] {
  return within(outline())
    .getAllByRole("button")
    .filter((item) => item.getAttribute("aria-current") === "location")
    .map((item) => item.textContent);
}

function box(top: number, bottom: number): DOMRect {
  return { top, bottom } as DOMRect;
}

beforeEach(() => {
  page = document.createElement("div");
  aside = document.createElement("aside");
  document.body.append(page, aside);
});

afterEach(() => {
  cleanup();
  page.remove();
  aside.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the lines", () => {
  it("lists a line per heading, then Comments with the count and a line per comment title", () => {
    renderOutline([heading("Plan"), heading("Build")], [comment("Note 1"), comment("Note 1"), comment("Marker")]);

    const nav = outline();
    expect(nav.className).toBe("mt-4 hidden border-t border-line pt-4 lg:block");
    const [label, bodyList, commentsLabel, commentList] = [...nav.children];
    expect(label?.textContent).toBe("Contents");
    expect(label?.className).toBe("text-sm text-dim");
    expect(nav.getAttribute("aria-labelledby")).toBe(label?.id);
    expect(within(bodyList as HTMLElement).getAllByRole("button").map((item) => item.textContent)).toEqual(["Plan", "Build"]);
    expect(commentsLabel?.textContent).toBe("Comments 3");
    expect(commentsLabel?.className).toBe("mt-3 flex items-baseline gap-1.5 text-sm text-dim");
    expect(commentsLabel?.lastElementChild?.className).toBe("text-xs");
    expect(within(commentList as HTMLElement).getAllByRole("button").map((item) => item.textContent)).toEqual([
      "Note 1",
      "Note 1",
      "Marker",
    ]);
    expect(bodyList?.className).toBe("mt-1.5 space-y-0.5");

    const plan = line("Plan");
    expect(plan.tagName).toBe("BUTTON");
    expect(plan.getAttribute("type")).toBe("button");
    expect(plan.hasAttribute("aria-current")).toBe(false);
    expect(plan.className).toBe(
      "block w-full truncate border-l-2 py-0.5 pl-2.5 text-left text-xs-plus hover:text-text border-transparent text-muted",
    );
  });

  it("has no body group with no heading", () => {
    renderOutline([], [comment("Note 1")]);

    expect([...outline().children].map((child) => child.tagName)).toEqual(["P", "P", "UL"]);
  });

  it("has no comments group with no comment", () => {
    renderOutline([heading("Plan")], []);

    expect([...outline().children].map((child) => child.tagName)).toEqual(["P", "UL"]);
  });

  it("renders nothing with no heading and no comment", () => {
    renderOutline([], []);

    expect(aside.childElementCount).toBe(0);
  });
});

describe("activating a line", () => {
  it("scrolls its target to the top with motion and moves focus to it", async () => {
    const user = userEvent.setup();
    stubReducedMotion(false);
    const entry = comment("Note 1");
    const scrollIntoView = vi.fn();
    entry.target.scrollIntoView = scrollIntoView;
    const focus = vi.spyOn(entry.target, "focus");
    renderOutline([heading("Plan")], [entry]);

    await user.click(line("Note 1"));

    expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "start", behavior: "smooth" });
    expect(entry.target.tabIndex).toBe(-1);
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(document.activeElement).toBe(entry.target);
  });

  it("scrolls without motion when the system asks for reduced motion", async () => {
    const user = userEvent.setup();
    stubReducedMotion(true);
    const entry = heading("Plan");
    const scrollIntoView = vi.fn();
    entry.target.scrollIntoView = scrollIntoView;
    renderOutline([entry], []);

    await user.click(line("Plan"));

    expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "start", behavior: "auto" });
    expect(document.activeElement).toBe(entry.target);
  });
});

describe("the current line", () => {
  it("is the line of the last target whose sentinel has passed the line under the top", () => {
    const io = stubIntersectionObserver();
    const [plan, build] = [heading("Plan"), heading("Build")];
    const note = comment("Note 1");
    renderOutline([plan, build], [note], { pageScrollPadding: 64 });

    const [observer] = io.observers;
    expect(observer?.options).toEqual({ rootMargin: "-72px 0px 10000000px 0px", threshold: [0, 1] });
    expect([...(observer?.targets ?? [])]).toEqual([plan.sentinel, build.sentinel, note.sentinel]);
    expect(current()).toEqual([]);

    io.report({ target: plan.sentinel, top: 60, bottom: 84, isIntersecting: true });
    expect(current()).toEqual(["Plan"]);
    expect(line("Plan").className).toContain("border-graphic font-medium text-text");
    expect(line("Plan").className).not.toContain("border-transparent");

    io.report({ target: build.sentinel, top: -200 }, { target: note.sentinel, top: 71 });
    expect(current()).toEqual(["Note 1"]);

    io.report({ target: note.sentinel, top: 72, isIntersecting: true });
    expect(current()).toEqual(["Build"]);

    io.report(
      { target: plan.sentinel, top: 900, isIntersecting: true },
      { target: build.sentinel, top: 1200, isIntersecting: true },
    );
    expect(current()).toEqual([]);
  });

  it("puts the line 8px under the page's scroll padding, which follows the root font size", () => {
    const io = stubIntersectionObserver();
    const plan = heading("Plan");
    renderOutline([plan], [], { pageScrollPadding: 72 });

    expect(io.observers[0]?.options.rootMargin).toBe("-80px 0px 10000000px 0px");

    io.report({ target: plan.sentinel, top: 79.5 });
    expect(current()).toEqual(["Plan"]);

    io.report({ target: plan.sentinel, top: 80, isIntersecting: true });
    expect(current()).toEqual([]);
  });

  it("puts the line 8px under the window's top with no scroll padding on the page", () => {
    const io = stubIntersectionObserver();
    renderOutline([heading("Plan")], []);

    expect(io.observers[0]?.options.rootMargin).toBe("-8px 0px 10000000px 0px");
  });

  it("observes nothing before the page's scroll padding is measured, and observes again when it changes", () => {
    const io = stubIntersectionObserver();
    const plan = heading("Plan");
    const outlineWith = (pageScrollPadding: number | undefined) => (
      <TaskOutline
        headings={[plan]}
        comments={[]}
        sidebarRef={{ current: aside }}
        pageScrollPadding={pageScrollPadding}
      />
    );
    const { rerender } = render(outlineWith(undefined), { container: aside });
    expect(io.observers).toHaveLength(0);

    rerender(outlineWith(64));
    rerender(outlineWith(72));

    const [first, second] = io.observers;
    expect(first?.options.rootMargin).toBe("-72px 0px 10000000px 0px");
    expect(first?.targets.size).toBe(0);
    expect(second?.options.rootMargin).toBe("-80px 0px 10000000px 0px");
    expect([...(second?.targets ?? [])]).toEqual([plan.sentinel]);
  });

  it("observes the new sentinels when the entries change, and stops observing on unmount", () => {
    const io = stubIntersectionObserver();
    const plan = heading("Plan");
    const { rerender, unmount } = renderOutline([plan], []);
    const note = comment("Note 1");

    rerender(<TaskOutline headings={[plan]} comments={[note]} sidebarRef={{ current: aside }} pageScrollPadding={0} />);

    const [first, second] = io.observers;
    expect(first?.targets.size).toBe(0);
    expect([...(second?.targets ?? [])]).toEqual([plan.sentinel, note.sentinel]);

    unmount();
    expect(second?.targets.size).toBe(0);
  });

  it("scrolls the sidebar by the least that shows the current line", () => {
    const io = stubIntersectionObserver();
    const scroll = stubSidebarScroll(100);
    vi.spyOn(aside, "getBoundingClientRect").mockReturnValue(box(0, 300));
    const [plan, build] = [heading("Plan"), heading("Build")];
    const note = comment("Note 1");
    renderOutline([plan, build], [note]);
    vi.spyOn(line("Plan"), "getBoundingClientRect").mockReturnValue(box(-30, -12));
    vi.spyOn(line("Build"), "getBoundingClientRect").mockReturnValue(box(100, 118));
    vi.spyOn(line("Note 1"), "getBoundingClientRect").mockReturnValue(box(310, 328));

    io.report({ target: plan.sentinel, top: 0 });
    expect(scroll.top).toBe(70);

    io.report({ target: note.sentinel, top: 0 });
    expect(scroll.top).toBe(98);

    io.report({ target: note.sentinel, top: 100, isIntersecting: true }, { target: build.sentinel, top: 0 });
    expect(current()).toEqual(["Build"]);
    expect(scroll.top).toBe(98);
  });

  it("keeps the current line out of the sidebar's scroll padding, which the notice stack covers", () => {
    const io = stubIntersectionObserver();
    const scroll = stubSidebarScroll(100);
    aside.style.scrollPaddingTop = "10px";
    aside.style.scrollPaddingBottom = "120px";
    vi.spyOn(aside, "getBoundingClientRect").mockReturnValue(box(0, 300));
    const [plan, build] = [heading("Plan"), heading("Build")];
    renderOutline([plan, build], []);
    vi.spyOn(line("Plan"), "getBoundingClientRect").mockReturnValue(box(5, 23));
    vi.spyOn(line("Build"), "getBoundingClientRect").mockReturnValue(box(190, 208));

    io.report({ target: build.sentinel, top: 0 });
    expect(scroll.top).toBe(128);

    io.report({ target: build.sentinel, top: 100, isIntersecting: true }, { target: plan.sentinel, top: 0 });
    expect(scroll.top).toBe(123);
  });

  it("marks the current line with no sidebar to scroll", () => {
    const io = stubIntersectionObserver();
    const plan = heading("Plan");
    renderOutline([plan], [], { sidebar: null });

    io.report({ target: plan.sentinel, top: 0 });

    expect(current()).toEqual(["Plan"]);
  });
});
