import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { useRef, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "../../src/components/confirm-dialog";
import { NoticeStack, SpokenRegion } from "../../src/components/notice-stack";
import type { FinalFocus } from "../../src/lib/final-focus";
import { useNotice, useNoticeStore, type Notice, type NoticeContent } from "../../src/store/notices";
import { frame } from "../setup/notice-store";

const FIRST: Notice = {
  key: "task-read:SAGA-56",
  form: "warning",
  title: "2 warnings about SAGA-56",
  words: ["unterminated-fence · a fence is not closed", "label-case-converted · label \"Web\" was converted to \"web\""],
};

const SECOND: Notice = {
  key: "task-read:SAGA-57",
  form: "warning",
  title: "1 warning about SAGA-57",
  words: ["step-stale · step \"dev:doing\" is not a step of dev-personal"],
};

const CONTENT: NoticeContent = { form: FIRST.form, title: FIRST.title, words: FIRST.words };

function stack(): HTMLElement {
  return document.querySelector<HTMLElement>("main + div")!;
}

function stackTree(children?: ReactNode): ReactNode {
  return (
    <>
      <main tabIndex={-1} />
      <NoticeStack />
      {children}
    </>
  );
}

function renderStack(children?: ReactNode) {
  return render(stackTree(children));
}

function openKeys(): string[] {
  return useNoticeStore.getState().notices.map(({ key }) => key);
}

function show(...notices: Notice[]): void {
  act(() => {
    for (const notice of notices) {
      useNoticeStore.getState().showNotice(notice);
    }
  });
}

function dismissControls(): HTMLElement[] {
  return screen.getAllByRole("button", { name: "Dismiss" });
}

function panels(): HTMLElement[] {
  return [...stack().children] as HTMLElement[];
}

/**
 * Holds each closed panel in the DOM until `finish` runs for it, as a browser
 * does until the panel's animations end. jsdom has no animations, so a closed
 * panel otherwise leaves at once.
 */
function holdClosedPanels(): { finish: (panel: Element) => Promise<void> } {
  const finishers = new Map<Element, () => void>();
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value(this: Element) {
      if (!this.hasAttribute("data-ending-style")) {
        return [];
      }

      const finished = new Promise<void>((resolve) => {
        finishers.set(this, resolve);
      });
      return [{ finished, pending: false, playState: "running" }];
    },
  });
  return {
    finish: async (panel) => {
      // Base UI reads the animations an animation frame after the panel closes.
      await frame();
      await act(async () => {
        finishers.get(panel)?.();
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      });
    },
  };
}

// jsdom has no layout: each panel sits 300px below the previous one, the first
// at 100px, and the stack has a 32px top padding and a 900px scroll height.
function trackScroll(): { scrollTop: number } {
  const scroll = { scrollTop: 0 };
  stack().style.paddingTop = "32px";
  Object.defineProperty(stack(), "scrollHeight", { configurable: true, value: 900 });
  Object.defineProperty(stack(), "scrollTop", {
    configurable: true,
    get: () => scroll.scrollTop,
    set: (value: number) => {
      scroll.scrollTop = value;
    },
  });
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
    return 100 + 300 * [...(this.parentElement?.children ?? [])].indexOf(this);
  });
  return scroll;
}

function OpenDialog(): ReactNode {
  const finalFocusRef = useRef<FinalFocus>(null);

  return (
    <ConfirmDialog
      open
      title="Discard your changes?"
      description="There is no undo."
      cancelLabel="Keep editing"
      confirmLabel="Discard"
      onCancel={() => {}}
      onConfirm={() => {}}
      finalFocus={finalFocusRef}
    />
  );
}

function Screen({ noticeKey, content }: { noticeKey: string; content: NoticeContent | null }): ReactNode {
  useNotice(noticeKey, content);
  return null;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
});

describe("the stack", () => {
  it("shows the warning form: the title, one row per word and Dismiss", () => {
    renderStack();

    show(FIRST);

    expect(screen.getByText(FIRST.title).tagName).toBe("P");
    expect(within(stack()).getAllByRole("listitem").map((row) => row.textContent)).toEqual(FIRST.words);
    expect(dismissControls()).toHaveLength(1);
  });

  it("shows no muted line and no alert in the warning form", () => {
    renderStack();

    show(FIRST);

    const panel = stack().firstElementChild!;
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.querySelectorAll("p")).toHaveLength(1);
  });

  it("makes each panel a focusable dialog named by its title and described by its words", () => {
    renderStack();

    show(FIRST);

    const panel = stack().firstElementChild as HTMLElement;
    expect(panel.getAttribute("aria-modal")).toBe("false");
    expect(panel.tabIndex).toBe(0);
    expect(document.getElementById(panel.getAttribute("aria-labelledby")!)?.textContent).toBe(FIRST.title);
    expect(document.getElementById(panel.getAttribute("aria-describedby")!)?.textContent).toBe(FIRST.words.join(""));
  });

  it("shows a notice opened before the stack mounts", () => {
    useNoticeStore.getState().showNotice(FIRST);

    renderStack();

    expect(screen.getByText(FIRST.title)).toBeTruthy();
  });

  it("shows the failure form with no alert role: the title, the muted line, the words and Dismiss", async () => {
    const user = userEvent.setup();
    const failure: Notice = {
      key: "task-write-failure:SAGA-55",
      form: "failure",
      title: "SAGA-55 was not moved",
      line: "The daemon refused the write, and the task is back where it was. Its own words are below.",
      words: ["store/status-unknown · status \"Gone\" is not configured"],
    };
    renderStack();

    show(failure);

    const panel = stack().firstElementChild as HTMLElement;
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(within(stack()).queryByRole("alert")).toBeNull();
    const [title, description] = [...panel.children[1]!.children];
    const [line, words] = [...description!.children];
    expect(title?.textContent).toBe(failure.title);
    expect(title?.className).toContain("text-signal");
    expect(line?.textContent).toBe(failure.line);
    expect(line?.className).toContain("text-muted");
    expect(words?.textContent).toBe(failure.words[0]);
    expect(words?.className).toContain("font-mono");
    expect(within(panel).queryByRole("list")).toBeNull();

    await user.click(within(panel).getByRole("button", { name: "Dismiss" }));

    expect(openKeys()).toEqual([]);
  });

  it("describes each Dismiss control by the title of its notice", () => {
    renderStack();

    show(FIRST, SECOND);

    const descriptions = dismissControls().map(
      (control) => document.getElementById(control.getAttribute("aria-describedby")!)?.textContent,
    );
    expect(descriptions).toEqual([FIRST.title, SECOND.title]);
  });

  it("renders the newest of two notices last", () => {
    renderStack();

    show(FIRST, SECOND);

    const titles = [...stack().querySelectorAll("p")].map((title) => title.textContent);
    expect(titles).toEqual([FIRST.title, SECOND.title]);
  });

  it("is silent with a notice open or none, and a region only while a notice is open", () => {
    renderStack();

    expect(stack().children).toHaveLength(0);
    expect(stack().hasAttribute("role")).toBe(false);
    expect(stack().hasAttribute("aria-label")).toBe(false);
    expect(stack().getAttribute("aria-live")).toBe("off");

    show(FIRST, { ...SECOND, form: "failure" });

    expect(stack().getAttribute("role")).toBe("region");
    expect(stack().getAttribute("aria-label")).toBe("Notices");
    expect(stack().getAttribute("aria-live")).toBe("off");
    expect(stack().querySelector("[aria-live]")).toBeNull();
    expect(document.querySelector("[role=\"alert\"]")).toBeNull();
    expect(dismissControls().map((control) => control.getAttribute("aria-hidden"))).toEqual(["false", "false"]);
  });

  it("mounts a replaced notice as a new panel", () => {
    renderStack();
    show(FIRST);
    const panel = stack().firstElementChild;

    show({ ...FIRST, title: "1 warning about SAGA-56" });

    expect(stack().children).toHaveLength(1);
    expect(stack().firstElementChild).not.toBe(panel);
    expect(stack().firstElementChild?.querySelector("p")?.textContent).toBe("1 warning about SAGA-56");
  });

  it("mounts a notice closed and shown again with equal content in one update as a new panel", () => {
    renderStack();
    show(FIRST);
    const panel = stack().firstElementChild;

    act(() => {
      useNoticeStore.getState().closeNotice(FIRST.key);
      useNoticeStore.getState().showNotice({ ...FIRST });
    });

    expect(stack().children).toHaveLength(1);
    expect(stack().firstElementChild).not.toBe(panel);
  });

  it("scrolls the stack to the top of the bottom notice, not to its end, so a tall notice shows its title and Dismiss", () => {
    renderStack();
    const scroll = trackScroll();

    show(FIRST);

    expect(scroll.scrollTop).toBe(68);

    show(SECOND);

    expect(scroll.scrollTop).toBe(368);

    scroll.scrollTop = 0;
    show({ ...SECOND, words: [...SECOND.words, "step-stale · step \"dev:review\" is not a step of dev-personal"] });

    expect(scroll.scrollTop).toBe(368);
  });

  it("does not scroll the stack when focus is on a notice above the bottom one", () => {
    renderStack();
    const scroll = trackScroll();
    show(FIRST);
    const firstDismiss = dismissControls()[0]!;
    firstDismiss.focus();
    scroll.scrollTop = 0;

    show(SECOND);

    expect(scroll.scrollTop).toBe(0);
    expect(document.activeElement).toBe(firstDismiss);
  });

  it("scrolls the stack to the bottom notice when that notice holds focus", () => {
    renderStack();
    const scroll = trackScroll();
    show(FIRST, SECOND);
    dismissControls()[0]!.focus();
    scroll.scrollTop = 0;

    act(() => {
      useNoticeStore.getState().closeNotice(SECOND.key);
    });

    expect(scroll.scrollTop).toBe(68);
  });

  it("does not move focus when a notice opens", () => {
    renderStack();

    show(FIRST);

    expect(document.activeElement).toBe(document.body);
  });

  // jsdom counts all focus as focus-visible, so Base UI always moves focus to
  // the next panel here, as it does for the keyboard in a browser.
  it("moves focus after a keyboard Dismiss to the next panel, then after Escape to <main>", async () => {
    const user = userEvent.setup();
    renderStack();
    show(FIRST, SECOND);
    const [firstPanel] = panels();
    dismissControls()[1]!.focus();

    await user.keyboard("{Enter}");

    expect(document.activeElement).toBe(firstPanel);
    expect(openKeys()).toEqual([FIRST.key]);

    await user.keyboard("{Escape}");

    expect(document.activeElement).toBe(screen.getByRole("main"));
    expect(stack().children).toHaveLength(0);
  });

  it("moves focus to the newer panel when the notice above it is dismissed", async () => {
    const user = userEvent.setup();
    renderStack();
    show(FIRST, SECOND);
    const [, secondPanel] = panels();

    await user.click(dismissControls()[0]!);

    expect(document.activeElement).toBe(secondPanel);
    expect(openKeys()).toEqual([SECOND.key]);
  });

  it("moves focus to the Dismiss control of a replaced notice after the old panel leaves", () => {
    renderStack();
    show(FIRST);
    dismissControls()[0]!.focus();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");

    show({ ...FIRST, title: "1 warning about SAGA-56" });

    const [dismiss] = dismissControls();
    expect(document.activeElement).toBe(dismiss);
    expect(document.getElementById(dismiss!.getAttribute("aria-describedby")!)?.textContent).toBe(
      "1 warning about SAGA-56",
    );
    expect(focus).toHaveBeenCalledOnce();
  });

  it("moves focus to the other panel when a focused notice is replaced", () => {
    renderStack();
    show(FIRST, SECOND);
    dismissControls()[0]!.focus();

    show({ ...FIRST, title: "1 warning about SAGA-56" });

    const [secondPanel, replaced] = panels();
    expect(document.activeElement).toBe(secondPanel);
    expect(replaced?.querySelector("p")?.textContent).toBe("1 warning about SAGA-56");
  });

  it("keeps a panel open on a pointer drag down or right", () => {
    renderStack();
    show(FIRST);
    const [panel] = panels();

    for (const [x, y] of [[0, 120], [120, 0]] as const) {
      fireEvent.pointerDown(panel!, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(panel!, { pointerId: 1, clientX: x, clientY: y, movementX: x, movementY: y });
      fireEvent.pointerUp(panel!, { pointerId: 1, clientX: x, clientY: y });
    }

    expect(openKeys()).toEqual([FIRST.key]);
    expect(panels()).toHaveLength(1);
  });

  it("keeps Escape on a panel from the listeners of the page", async () => {
    const user = userEvent.setup();
    const onKeyDown = vi.fn();
    document.addEventListener("keydown", onKeyDown);
    renderStack();
    show(FIRST);
    panels()[0]!.focus();

    await user.keyboard("{Escape}");

    document.removeEventListener("keydown", onKeyDown);
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(openKeys()).toEqual([]);
  });

  it("does not move focus on F6 and renders no focus guard, so Tab from <main> still reaches the panel", async () => {
    const user = userEvent.setup();
    renderStack();
    show(FIRST);
    const main = screen.getByRole("main");
    main.focus();

    await user.keyboard("{F6}");

    expect(document.activeElement).toBe(main);
    expect(document.querySelector("[data-base-ui-focus-guard]")).toBeNull();

    await user.tab();

    expect(document.activeElement).toBe(panels()[0]);
  });

  it("moves focus to <main> when a focused notice closes without Dismiss", () => {
    const { rerender } = renderStack(<Screen noticeKey={FIRST.key} content={CONTENT} />);
    dismissControls()[0]!.focus();

    rerender(stackTree(<Screen noticeKey={FIRST.key} content={null} />));

    expect(document.activeElement).toBe(screen.getByRole("main"));
  });

  it("leaves focus where it is when a notice without focus closes", () => {
    renderStack(<button type="button">Outside</button>);
    show(FIRST);
    screen.getByRole("button", { name: "Outside" }).focus();

    act(() => {
      useNoticeStore.getState().closeNotice(FIRST.key);
    });

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Outside" }));
  });

  it("keeps a focus request until a panel mounts, then focuses its Dismiss", () => {
    renderStack();

    act(() => {
      useNoticeStore.getState().requestNoticeFocus();
    });

    expect(useNoticeStore.getState().noticeFocusRequested).toBe(true);

    show(FIRST);

    expect(document.activeElement).toBe(dismissControls()[0]);
    expect(useNoticeStore.getState().noticeFocusRequested).toBe(false);
  });

  it("drops a focus request when focus is elsewhere by the time the panel mounts", () => {
    renderStack(<button type="button">Outside</button>);
    const outside = screen.getByRole("button", { name: "Outside" });
    outside.focus();

    act(() => {
      useNoticeStore.getState().requestNoticeFocus();
    });
    show(FIRST);

    expect(document.activeElement).toBe(outside);
    expect(useNoticeStore.getState().noticeFocusRequested).toBe(false);
  });

  it("drops a focus request made while a panel is open and focus is elsewhere", () => {
    renderStack(<button type="button">Outside</button>);
    show(FIRST);
    const outside = screen.getByRole("button", { name: "Outside" });
    outside.focus();

    act(() => {
      useNoticeStore.getState().requestNoticeFocus();
    });

    expect(document.activeElement).toBe(outside);
    expect(useNoticeStore.getState().noticeFocusRequested).toBe(false);
  });

  it.each([
    { via: "Dismiss", close: (user: UserEvent) => user.click(dismissControls()[0]!) },
    {
      via: "Escape on the panel",
      close: async (user: UserEvent) => {
        panels()[0]!.focus();
        await user.keyboard("{Escape}");
      },
    },
  ])("records the content the reader closed with $via", async ({ close }) => {
    const user = userEvent.setup();
    renderStack();
    show(FIRST);

    await close(user);

    expect(openKeys()).toEqual([]);
    expect(useNoticeStore.getState().dismissed.get(FIRST.key)).toEqual({ ...CONTENT, line: undefined });
  });

  it("records no content for a notice closed or replaced from code", () => {
    renderStack();
    show(FIRST, SECOND);

    act(() => {
      useNoticeStore.getState().closeNotice(FIRST.key);
    });
    show({ ...SECOND, title: "2 warnings about SAGA-57" });

    expect(useNoticeStore.getState().dismissed.size).toBe(0);
    expect(panels()).toHaveLength(1);
  });

  it("does not count a closing panel as open for the scroll or the focus", async () => {
    const { finish } = holdClosedPanels();
    renderStack();
    const scroll = trackScroll();
    show(FIRST, SECOND);
    const [firstPanel, secondPanel] = panels();
    dismissControls()[0]!.focus();
    scroll.scrollTop = 0;

    act(() => {
      useNoticeStore.getState().closeNotice(SECOND.key);
    });

    expect(secondPanel?.hasAttribute("data-ending-style")).toBe(true);
    expect(scroll.scrollTop).toBe(68);

    act(() => {
      useNoticeStore.getState().closeNotice(FIRST.key);
    });
    await finish(firstPanel!);

    expect(firstPanel?.isConnected).toBe(false);
    expect(secondPanel?.isConnected).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });

  it("scrolls again to the new bottom panel once the replaced panel above it leaves", async () => {
    const { finish } = holdClosedPanels();
    renderStack();
    const scroll = trackScroll();
    show(FIRST, SECOND);
    const [, secondPanel] = panels();

    show({ ...SECOND, title: "2 warnings about SAGA-57" });

    expect(scroll.scrollTop).toBe(668);

    await finish(secondPanel!);

    expect(scroll.scrollTop).toBe(368);
  });

  it("does not scroll the stack when a panel above the bottom one closes or leaves", async () => {
    const { finish } = holdClosedPanels();
    renderStack();
    const scroll = trackScroll();
    show(FIRST, SECOND);
    const [firstPanel] = panels();
    scroll.scrollTop = 0;

    act(() => {
      useNoticeStore.getState().closeNotice(FIRST.key);
    });

    expect(firstPanel?.hasAttribute("data-ending-style")).toBe(true);
    expect(scroll.scrollTop).toBe(0);

    await finish(firstPanel!);

    expect(firstPanel?.isConnected).toBe(false);
    expect(scroll.scrollTop).toBe(0);
  });

  it("sends focus to the popup of an open modal dialog when the last focused panel closes", async () => {
    render(stackTree(<OpenDialog />));
    await waitFor(() => {
      expect(screen.getByRole("main", { hidden: true }).getAttribute("aria-hidden")).toBe("true");
    });
    show(FIRST);
    act(() => {
      dismissControls()[0]!.focus();
    });

    act(() => {
      useNoticeStore.getState().closeNotice(FIRST.key);
    });

    expect(document.activeElement).toBe(screen.getByRole("alertdialog"));
  });

  it("sends focus to <main> when <main> is hidden and no dialog is open", () => {
    renderStack();
    const main = screen.getByRole("main");
    main.setAttribute("aria-hidden", "true");
    show(FIRST);
    dismissControls()[0]!.focus();

    act(() => {
      useNoticeStore.getState().closeNotice(FIRST.key);
    });

    expect(document.activeElement).toBe(main);
  });

  // jsdom has no layout, so the classes that set the size are what can be checked.
  // The panels are 440px wide or the window less 32px. The padding holds their
  // shadow; on the right it is no wider than the gap to the window's edge.
  it("sizes the panels to 440px or the window less 32px, with room for their shadow", () => {
    renderStack();

    show(FIRST);

    for (const name of [
      "-m-8",
      "-mr-4",
      "sm:-mr-8",
      "p-8",
      "pr-4",
      "sm:pr-8",
      "w-[calc(100%+1rem)]",
      "max-w-[488px]",
      "sm:max-w-[504px]",
      "max-h-screen",
      "overflow-y-auto",
    ]) {
      expect(stack().classList.contains(name), name).toBe(true);
    }
    const panel = stack().firstElementChild!;
    for (const name of ["w-full", "shadow-float"]) {
      expect(panel.classList.contains(name), name).toBe(true);
    }
  });

  it("floats over the page on the notice layer, takes clicks only on the panels and animates each panel in", () => {
    renderStack();

    show(FIRST);

    for (const name of ["fixed", "z-(--layer-notice)", "pointer-events-none"]) {
      expect(stack().classList.contains(name), name).toBe(true);
    }
    const panel = stack().firstElementChild!;
    for (const name of ["pointer-events-auto", "animate-enter"]) {
      expect(panel.classList.contains(name), name).toBe(true);
    }
  });
});

describe("the room the page keeps for the stack", () => {
  function stubResizeObserver() {
    const observer = { report: () => {}, target: null as Element | null, disconnect: vi.fn() };
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          observer.report = callback;
        }

        observe(target: Element) {
          observer.target = target;
        }

        unobserve() {}

        disconnect() {
          observer.disconnect();
        }
      },
    );
    return observer;
  }

  function stackHeight(): string {
    return document.documentElement.style.getPropertyValue("--notice-stack-height");
  }

  it("sets the height the stack covers on <html> while a notice is open", () => {
    const observer = stubResizeObserver();
    const { unmount } = renderStack();
    stack().style.paddingTop = "32px";
    Object.defineProperty(stack(), "clientHeight", { configurable: true, value: 200 });

    expect(observer.target).toBe(stack());

    show(FIRST);
    observer.report();

    expect(stackHeight()).toBe("168px");

    act(() => {
      useNoticeStore.getState().closeNotice(FIRST.key);
    });
    observer.report();

    expect(stackHeight()).toBe("");

    show(FIRST);
    observer.report();
    unmount();

    expect(stackHeight()).toBe("");
    expect(observer.disconnect).toHaveBeenCalledOnce();
  });

  it("keeps no room for a panel that is closing", () => {
    const observer = stubResizeObserver();
    holdClosedPanels();
    renderStack();
    Object.defineProperty(stack(), "clientHeight", { configurable: true, value: 200 });
    show(FIRST);

    act(() => {
      useNoticeStore.getState().closeNotice(FIRST.key);
    });
    observer.report();

    expect(panels()).toHaveLength(1);
    expect(stackHeight()).toBe("");
  });

  it("gives <html> a bottom scroll padding of that height", () => {
    renderStack();

    expect(stack().classList.contains("[html:has(&)]:scroll-pb-(--notice-stack-height)")).toBe(true);
  });
});

describe("useNotice", () => {
  it("opens the notice on mount", () => {
    renderStack(<Screen noticeKey={FIRST.key} content={CONTENT} />);

    expect(useNoticeStore.getState().notices).toMatchObject([FIRST]);
    expect(screen.getByText(FIRST.title)).toBeTruthy();
  });

  it("shows nothing again when a re-render builds equal content", () => {
    const { rerender } = render(<Screen noticeKey={FIRST.key} content={CONTENT} />);
    const showNotice = vi.spyOn(useNoticeStore.getState(), "showNotice");

    rerender(<Screen noticeKey={FIRST.key} content={{ ...CONTENT, words: [...CONTENT.words] }} />);

    expect(showNotice).not.toHaveBeenCalled();
    expect(openKeys()).toEqual([FIRST.key]);
  });

  it("replaces the notice when the content changes", () => {
    const { rerender } = render(<Screen noticeKey={FIRST.key} content={CONTENT} />);

    rerender(<Screen noticeKey={FIRST.key} content={{ ...CONTENT, title: "1 warning about SAGA-56" }} />);

    expect(useNoticeStore.getState().notices).toMatchObject([{ ...FIRST, title: "1 warning about SAGA-56" }]);
  });

  it("closes the notice on null", () => {
    const { rerender } = render(<Screen noticeKey={FIRST.key} content={CONTENT} />);

    rerender(<Screen noticeKey={FIRST.key} content={null} />);

    expect(openKeys()).toEqual([]);
  });

  it("closes the notice on unmount", () => {
    const { unmount } = render(<Screen noticeKey={FIRST.key} content={CONTENT} />);

    unmount();

    expect(openKeys()).toEqual([]);
  });

  it("closes the notice of the previous key when the key changes", () => {
    const { rerender } = render(<Screen noticeKey={FIRST.key} content={CONTENT} />);

    rerender(<Screen noticeKey={SECOND.key} content={CONTENT} />);

    expect(useNoticeStore.getState().notices).toMatchObject([{ ...CONTENT, key: SECOND.key }]);
  });

  it("keeps equal content closed after Dismiss and opens changed content", async () => {
    const user = userEvent.setup();
    const { rerender } = renderStack(<Screen noticeKey={FIRST.key} content={CONTENT} />);

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    rerender(stackTree(<Screen noticeKey={FIRST.key} content={{ ...CONTENT, words: [...CONTENT.words] }} />));

    expect(openKeys()).toEqual([]);

    rerender(stackTree(<Screen noticeKey={FIRST.key} content={{ ...CONTENT, words: CONTENT.words.slice(1) }} />));

    expect(openKeys()).toEqual([FIRST.key]);
    expect(within(stack()).getAllByRole("listitem")).toHaveLength(1);
  });

  it("opens equal content again after the warnings disappear and come back", () => {
    const { rerender } = render(<Screen noticeKey={FIRST.key} content={CONTENT} />);
    act(() => {
      useNoticeStore.getState().dismissNotice(FIRST.key);
    });

    rerender(<Screen noticeKey={FIRST.key} content={null} />);
    rerender(<Screen noticeKey={FIRST.key} content={CONTENT} />);

    expect(openKeys()).toEqual([FIRST.key]);
  });
});

describe("the spoken region", () => {
  /** One animation frame of the fake clock, which is what an announcement waits for. */
  const FRAME = 16;

  function region(): HTMLElement {
    return document.querySelector<HTMLElement>("[aria-live].sr-only")!;
  }

  function messages(): (string | null)[] {
    return [...region().children].map(({ textContent }) => textContent);
  }

  /** Announces the words and runs the fake clock past the frame they wait for. */
  function announce(words: string): void {
    act(() => {
      useNoticeStore.getState().announce(words);
      vi.advanceTimersByTime(FRAME);
    });
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is mounted and empty before anything is said, so its first words are an addition", () => {
    render(<SpokenRegion />);

    expect(region().getAttribute("aria-live")).toBe("polite");
    expect(region().children).toHaveLength(0);
  });

  it("gives the same words said a frame apart a node each, so both are announced", () => {
    vi.useFakeTimers();
    render(<SpokenRegion />);

    announce("Saved.");
    announce("Saved.");

    expect(messages()).toEqual(["Saved.", "Saved."]);
  });

  it("drops a message seven seconds after it lands", () => {
    vi.useFakeTimers();
    render(<SpokenRegion />);
    announce("Saved.");

    act(() => {
      vi.advanceTimersByTime(6_999);
    });

    expect(region().children).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(region().children).toHaveLength(0);
  });

  it("says a message and a notice raised while a modal dialog is open, and neither is hidden by the dialog", async () => {
    render(stackTree(
      <>
        <SpokenRegion />
        <OpenDialog />
      </>,
    ));
    await waitFor(() => {
      expect(screen.getByRole("main", { hidden: true }).getAttribute("aria-hidden")).toBe("true");
    });

    act(() => {
      useNoticeStore.getState().announce("Changed on disk at 10:15. Saving overwrites that change.");
      useNoticeStore.getState().showNotice(SECOND);
    });

    await waitFor(() => {
      expect(messages()).toEqual([
        "Changed on disk at 10:15. Saving overwrites that change.",
        "1 warning about SAGA-57. step-stale · step \"dev:doing\" is not a step of dev-personal.",
      ]);
    });
    expect(region().closest("[aria-hidden]")).toBeNull();
    expect(region().closest("[inert]")).toBeNull();
    expect(stack().closest("[aria-hidden=\"true\"]")).toBeNull();
    expect(stack().closest("[inert]")).toBeNull();
  });
});
