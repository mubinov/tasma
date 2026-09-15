import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoticeStack } from "../../src/components/notice-stack";
import { useNotice, useNoticeStore, type Notice, type NoticeContent } from "../../src/store/notices";

const FIRST: Notice = {
  key: "task-read:TASM-56",
  form: "warning",
  title: "2 warnings about TASM-56",
  words: ["unterminated-fence · a fence is not closed", "label-case-converted · label \"Web\" was converted to \"web\""],
};

const SECOND: Notice = {
  key: "task-read:TASM-57",
  form: "warning",
  title: "1 warning about TASM-57",
  words: ["step-stale · step \"dev:doing\" is not a step of dev-personal"],
};

const CONTENT: NoticeContent = { form: FIRST.form, title: FIRST.title, words: FIRST.words };

function stack(): HTMLElement {
  return document.querySelector<HTMLElement>("[aria-live]")!;
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

function Screen({ noticeKey, content }: { noticeKey: string; content: NoticeContent | null }): ReactNode {
  useNotice(noticeKey, content);
  return null;
}

beforeEach(() => {
  useNoticeStore.setState({ notices: [], dismissed: new Map() });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the stack", () => {
  it("shows the warning form: the title, one row per word and Dismiss", () => {
    renderStack();

    show(FIRST);

    expect(screen.getByText(FIRST.title).tagName).toBe("P");
    expect(within(stack()).getAllByRole("listitem").map((row) => row.textContent)).toEqual(FIRST.words);
    expect(dismissControls()).toHaveLength(1);
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

  it("keeps a polite live region mounted while the stack is empty", () => {
    renderStack();

    expect(stack().getAttribute("aria-live")).toBe("polite");
    expect(stack().getAttribute("aria-relevant")).toBe("additions");
    expect(stack().children).toHaveLength(0);
  });

  it("mounts a replaced notice as a new panel, so the live region announces it", () => {
    renderStack();
    show(FIRST);
    const panel = stack().firstElementChild;

    show({ ...FIRST, title: "1 warning about TASM-56" });

    expect(stack().children).toHaveLength(1);
    expect(stack().firstElementChild).not.toBe(panel);
    expect(stack().firstElementChild?.querySelector("p")?.textContent).toBe("1 warning about TASM-56");
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

  it("moves focus after Dismiss to the Dismiss control now at the bottom, then to <main>", async () => {
    const user = userEvent.setup();
    renderStack();
    show(FIRST, SECOND);
    const [firstDismiss, secondDismiss] = dismissControls();

    await user.click(secondDismiss!);

    expect(document.activeElement).toBe(firstDismiss);
    expect(openKeys()).toEqual([FIRST.key]);

    await user.click(firstDismiss!);

    expect(document.activeElement).toBe(screen.getByRole("main"));
    expect(stack().children).toHaveLength(0);
  });

  it("moves focus to the bottom Dismiss control when a notice above it is dismissed", async () => {
    const user = userEvent.setup();
    renderStack();
    show(FIRST, SECOND);
    const [firstDismiss, secondDismiss] = dismissControls();

    await user.click(firstDismiss!);

    expect(document.activeElement).toBe(secondDismiss);
    expect(openKeys()).toEqual([SECOND.key]);
  });

  it("moves focus to the bottom Dismiss control when a focused notice is replaced and moves to the bottom", () => {
    renderStack();
    show(FIRST, SECOND);
    dismissControls()[0]!.focus();

    show({ ...FIRST, title: "1 warning about TASM-56" });

    const bottomDismiss = dismissControls().at(-1);
    expect(document.activeElement).toBe(bottomDismiss);
    expect(document.getElementById(bottomDismiss!.getAttribute("aria-describedby")!)?.textContent).toBe(
      "1 warning about TASM-56",
    );
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

  it("gives <html> a bottom scroll padding of that height", () => {
    renderStack();

    expect(stack().classList.contains("[html:has(&)]:scroll-pb-(--notice-stack-height)")).toBe(true);
  });
});

describe("useNotice", () => {
  it("opens the notice on mount", () => {
    renderStack(<Screen noticeKey={FIRST.key} content={CONTENT} />);

    expect(useNoticeStore.getState().notices).toEqual([FIRST]);
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

    rerender(<Screen noticeKey={FIRST.key} content={{ ...CONTENT, title: "1 warning about TASM-56" }} />);

    expect(useNoticeStore.getState().notices).toEqual([{ ...FIRST, title: "1 warning about TASM-56" }]);
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

    expect(useNoticeStore.getState().notices).toEqual([{ ...CONTENT, key: SECOND.key }]);
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
