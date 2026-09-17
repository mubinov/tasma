import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoticeStack } from "../../src/components/notice-stack";
import { ScrollToTop } from "../../src/components/scroll-to-top";
import { useNoticeStore } from "../../src/store/notices";
import { stubReducedMotion } from "../helpers";

function Page({ scrolled }: { scrolled: boolean }): ReactNode {
  const headingRef = useRef<HTMLHeadingElement>(null);

  return (
    <>
      <h1 ref={headingRef} tabIndex={-1}>Build the parser</h1>
      <ScrollToTop scrolled={scrolled} headingRef={headingRef} />
      <NoticeStack />
    </>
  );
}

function control(): HTMLElement | null {
  return screen.queryByRole("button", { name: "Scroll to top" });
}

function openNotice() {
  act(() => {
    useNoticeStore.getState().showNotice({ key: "task-read:SAGA-3", form: "warning", title: "1 warning", words: ["stale"] });
  });
}

beforeEach(() => {
  useNoticeStore.setState({ notices: [], dismissed: new Map() });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("when it shows", () => {
  it("is absent at rest and present once the page has scrolled, at the bottom right of the content", () => {
    const { rerender } = render(<Page scrolled={false} />);
    expect(control()).toBeNull();

    rerender(<Page scrolled />);

    const button = control()!;
    expect(button.getAttribute("type")).toBe("button");
    for (const name of [
      "fixed",
      "right-6",
      "bottom-6",
      "lg:right-[calc(var(--spacing-task-sidebar)+--spacing(6))]",
      "z-(--layer-scroll-to-top)",
      "size-9",
      "rounded-full",
      "border-line",
      "shadow-float",
      "hover:border-graphic",
    ]) {
      expect(button.classList.contains(name), name).toBe(true);
    }
    expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("is absent while a notice is open, and present again after Dismiss", async () => {
    const user = userEvent.setup();
    render(<Page scrolled />);

    openNotice();
    expect(control()).toBeNull();

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(control()).not.toBeNull();
  });
});

describe("a click", () => {
  it.each([
    { reduce: false, behavior: "smooth" },
    { reduce: true, behavior: "auto" },
  ])("scrolls to the top with behavior $behavior and moves focus to the h1", async ({ reduce, behavior }) => {
    const user = userEvent.setup();
    stubReducedMotion(reduce);
    const scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);
    render(<Page scrolled />);

    await user.click(control()!);

    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 0, behavior });
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
  });
});

describe("focus when the control leaves", () => {
  it("moves to the Dismiss control of the notice that takes the corner of a scrolled page", () => {
    render(<Page scrolled />);
    act(() => {
      control()!.focus();
    });

    openNotice();

    expect(control()).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Dismiss" }));
  });

  it("moves to the h1 when the page is back at the top", () => {
    const { rerender } = render(<Page scrolled />);
    act(() => {
      control()!.focus();
    });

    rerender(<Page scrolled={false} />);

    expect(control()).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
  });

  it("moves to the h1 when a notice opens as the page gets back to the top", () => {
    const { rerender } = render(<Page scrolled />);
    act(() => {
      control()!.focus();
    });

    act(() => {
      useNoticeStore.getState().showNotice({ key: "task-read:SAGA-3", form: "warning", title: "1 warning", words: ["stale"] });
      rerender(<Page scrolled={false} />);
    });

    expect(control()).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
  });

  it("does not move again when the control comes back and leaves without focus", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Page scrolled />);
    act(() => {
      control()!.focus();
    });
    openNotice();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();

    rerender(<Page scrolled={false} />);

    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("stays where it is when the control did not hold it", () => {
    const { rerender } = render(<Page scrolled />);

    rerender(<Page scrolled={false} />);

    expect(control()).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});
