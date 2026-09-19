import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog, type ConfirmDialogProps } from "../../src/components/confirm-dialog";
import type { FinalFocus } from "../../src/lib/final-focus";
import { useNoticeStore } from "../../src/store/notices";

/** Longer than the status region's own hold, so a write past it lands at once. */
const PAST_HOLD = 1100;

type ConfirmProps = Partial<Omit<ConfirmDialogProps, "finalFocus">> & {
  /** False leaves the dialog out of the tree, the way a route change does while it is still open. */
  mounted?: boolean;
};

/**
 * Mounts the dialog beside the two elements a caller can send focus to, the way
 * a screen does: the control that opened it, and a region that survives its
 * unmount.
 */
function Confirm({ open = true, mounted = true, ...props }: ConfirmProps): ReactNode {
  const openerRef = useRef<HTMLButtonElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const [toShell, setToShell] = useState(false);

  return (
    <>
      <button type="button" ref={openerRef}>
        Delete task
      </button>
      <button
        type="button"
        onClick={() => {
          setToShell(true);
        }}
      >
        Aim at the shell
      </button>
      <div ref={shellRef} tabIndex={-1}>
        <button type="button">Inside the shell</button>
      </div>
      {mounted && (
        <ConfirmDialog
          open={open}
          title="Delete this task?"
          description="SAGA-56 and its comments are removed from disk."
          confirmLabel="Delete"
          onCancel={() => {}}
          onConfirm={() => {}}
          finalFocus={toShell ? shellRef : openerRef}
          {...props}
        />
      )}
    </>
  );
}

/**
 * A caller holding an element rather than a React ref, which is the shape a
 * destination found with querySelector takes. React clears a ref it owns when
 * the element unmounts; this one keeps the detached node, which is the case the
 * component guards.
 */
function DetachedDestination({ open, present }: { open: boolean; present: boolean }): ReactNode {
  const destinationRef = useRef<HTMLElement | null>(null);

  return (
    <>
      {present && (
        <button
          type="button"
          ref={(node) => {
            if (node !== null) {
              destinationRef.current = node;
            }
          }}
        >
          The row being deleted
        </button>
      )}
      <button type="button">Still on the page</button>
      <ConfirmDialog
        open={open}
        title="Delete this task?"
        description="SAGA-56 and its comments are removed from disk."
        confirmLabel="Delete"
        onCancel={() => {}}
        onConfirm={() => {}}
        finalFocus={destinationRef}
      />
    </>
  );
}

function dialog(): HTMLElement {
  return screen.getByRole("alertdialog");
}

function cancel(): HTMLElement {
  return within(dialog()).getByRole("button", { name: "Cancel" });
}

function statusRegion(): HTMLElement {
  return within(dialog()).getByRole("status");
}

beforeEach(() => {
  useNoticeStore.setState({ modalDialogs: 0 });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the dialog", () => {
  it("is an alertdialog named by its title and described by its body", () => {
    render(<Confirm />);

    expect(dialog().getAttribute("aria-labelledby")).not.toBeNull();
    expect(screen.getByRole("alertdialog", { name: "Delete this task?" })).toBe(dialog());
    const described = document.getElementById(dialog().getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toBe("SAGA-56 and its comments are removed from disk.");
  });

  /*
   * The invariant base-ui.test.tsx guards for a popover: the theme class sits
   * on <html>, above every portal, so a portalled dialog keeps its tokens.
   */
  it("renders the popup outside the app container, under the themed root", () => {
    document.documentElement.className = "dark";
    const { container } = render(<Confirm />);

    expect(container.contains(dialog())).toBe(false);
    expect(document.documentElement.contains(dialog())).toBe(true);
    expect(document.querySelector(".dark")).toBe(document.documentElement);
    document.documentElement.className = "";
  });

  it("starts focus on Cancel, which reads Cancel unless the caller names its own label", async () => {
    render(<Confirm />);
    await waitFor(() => {
      expect(document.activeElement).toBe(cancel());
    });

    cleanup();
    render(<Confirm cancelLabel="Keep editing" />);

    await waitFor(() => {
      expect(document.activeElement).toBe(within(dialog()).getByRole("button", { name: "Keep editing" }));
    });
  });

  it("holds Tab inside the panel, and off the page behind it", async () => {
    const user = userEvent.setup();
    const { container } = render(<Confirm />);
    await waitFor(() => {
      expect(document.activeElement).toBe(cancel());
    });

    await user.tab();
    expect(document.activeElement).toBe(within(dialog()).getByRole("button", { name: "Delete" }));

    // Past the last control a focus guard takes it, which returns focus to the
    // panel in a browser. What jsdom's focus model can pin is the other half:
    // the page behind the dialog is inert, so no further Tab reaches it.
    await user.tab();
    await user.tab();
    expect(container.getAttribute("aria-hidden")).toBe("true");
    expect(container.contains(document.activeElement)).toBe(false);
  });

  /*
   * Chrome keeps the page behind the dialog readable by a screen reader when
   * the control that opened it still holds focus, and jsdom has no such rule —
   * so what is pinned here is the mechanism rather than the tree: the click
   * that opens the dialog leaves focus on nothing, in the same commit. Base UI
   * moves it into the panel a frame later, so the assertion runs before any
   * await.
   */
  it("leaves no element outside the panel focused in the commit that opens it", () => {
    function FromClick(): ReactNode {
      const openerRef = useRef<HTMLButtonElement>(null);
      const [open, setOpen] = useState(false);

      return (
        <>
          <button
            type="button"
            ref={openerRef}
            onClick={() => {
              setOpen(true);
            }}
          >
            Leave the editor
          </button>
          <ConfirmDialog
            open={open}
            title="Discard your changes?"
            description="There is no undo."
            cancelLabel="Keep editing"
            confirmLabel="Discard"
            onCancel={() => {}}
            onConfirm={() => {}}
            finalFocus={openerRef}
          />
        </>
      );
    }

    render(<FromClick />);
    const opener = screen.getByRole("button", { name: "Leave the editor" });
    opener.focus();

    fireEvent.click(opener);

    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
  });

  /*
   * jsdom computes no layout, so the scroll pattern is asserted on the class
   * strings. Whether a tall panel is reachable is checked in a browser.
   */
  it("scrolls its viewport and centres the panel by margin", () => {
    render(<Confirm />);

    const viewport = dialog().parentElement;
    expect(viewport?.className).toContain("overflow-y-auto");
    expect(viewport?.className).toContain("items-start");
    expect(dialog().className).toContain("my-auto");
  });
});

describe("the exits", () => {
  it("cancels on Esc and on the Cancel control, and confirms on neither", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(<Confirm onCancel={onCancel} onConfirm={onConfirm} />);
    await waitFor(() => {
      expect(document.activeElement).toBe(cancel());
    });

    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);

    await user.click(cancel());
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  /** Pins the modal rule the component relies on rather than sets. */
  it("closes nothing and calls nothing on a press outside the panel", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<Confirm onCancel={onCancel} />);

    await user.click(document.body);

    expect(screen.queryByRole("alertdialog")).not.toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("leaves the dialog open on a confirm, with the wait in the label and not in disabled", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const { rerender } = render(<Confirm onConfirm={onConfirm} />);

    await user.click(within(dialog()).getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).not.toBeNull();

    rerender(<Confirm onConfirm={onConfirm} confirmLabel="Deleting…" />);

    const confirming = within(dialog()).getByRole("button", { name: "Deleting…" });
    expect(confirming.hasAttribute("disabled")).toBe(false);
  });
});

describe("where focus goes when it closes", () => {
  it("sends focus where the ref points, and elsewhere after the caller re-points it", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Confirm />);
    await waitFor(() => {
      expect(document.activeElement).toBe(cancel());
    });

    rerender(<Confirm open={false} />);
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete task" }));
    });

    await user.click(screen.getByRole("button", { name: "Aim at the shell" }));
    rerender(<Confirm open />);
    await waitFor(() => {
      expect(document.activeElement).toBe(cancel());
    });
    rerender(<Confirm open={false} />);

    // Base UI resolves a non-tabbable destination to its first tabbable
    // descendant, so focus lands on the control inside the region, not on it.
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Inside the shell" }));
    });
  });

  it("falls back to the element focused before it opened when the destination has left the document", async () => {
    const { rerender } = render(<DetachedDestination open={false} present />);
    const surviving = screen.getByRole("button", { name: "Still on the page" });
    surviving.focus();

    rerender(<DetachedDestination open present />);
    await waitFor(() => {
      expect(document.activeElement).toBe(cancel());
    });

    // The destination leaves with the row the confirmed write removes. Without
    // the guard Base UI focuses the detached node, which drops focus to <body>.
    rerender(<DetachedDestination open={false} present={false} />);

    await waitFor(() => {
      expect(document.activeElement).toBe(surviving);
    });
  });

  it("leaves focus alone for a destination of \"keep\", so the screen that replaces the page keeps it", async () => {
    function LeaveAlone({ open }: { open: boolean }): ReactNode {
      const nowhereRef = useRef<FinalFocus>("keep");

      return (
        <>
          <button type="button">Still on the page</button>
          <ConfirmDialog
            open={open}
            title="Discard your changes?"
            description="There is no undo."
            confirmLabel="Discard"
            onCancel={() => {}}
            onConfirm={() => {}}
            finalFocus={nowhereRef}
          />
        </>
      );
    }

    const { rerender } = render(<LeaveAlone open />);
    await waitFor(() => {
      expect(document.activeElement).toBe(cancel());
    });

    rerender(<LeaveAlone open={false} />);
    const elsewhere = screen.getByRole("button", { name: "Still on the page" });
    elsewhere.focus();

    // The window Base UI would restore focus in, which it must not use here.
    await act(async () => {
      await Promise.resolve();
    });

    expect(document.activeElement).toBe(elsewhere);
  });

  /** The route-change path: the dialog leaves with the screen rather than closing. */
  it("sends focus there when the dialog is unmounted while still open", async () => {
    const user = userEvent.setup();
    // Aimed before the dialog opens: Base UI hides the page behind it, so a
    // control outside the popup is out of the accessibility tree while it is up.
    const { rerender } = render(<Confirm open={false} />);
    await user.click(screen.getByRole("button", { name: "Aim at the shell" }));
    rerender(<Confirm open />);
    await waitFor(() => {
      expect(document.activeElement).toBe(cancel());
    });

    rerender(<Confirm mounted={false} />);

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Inside the shell" }));
    });
  });
});

describe("the status region", () => {
  it("is inside the popup, on screen and empty as soon as the dialog opens", () => {
    vi.useFakeTimers();
    render(<Confirm status="Deleting…" />);

    expect(statusRegion().textContent).toBe("");
    expect(statusRegion().className).not.toContain("sr-only");
  });

  it("speaks a status set in the same commit as open, after the hold", () => {
    vi.useFakeTimers();
    render(<Confirm status="Deleting…" />);
    expect(statusRegion().textContent).toBe("");

    act(() => {
      vi.advanceTimersByTime(PAST_HOLD);
    });

    expect(statusRegion().textContent).toBe("Deleting…");
  });

  it("renders the region and no words for a dialog that has nothing to say", () => {
    vi.useFakeTimers();
    render(<Confirm />);

    act(() => {
      vi.advanceTimersByTime(PAST_HOLD);
    });

    expect(statusRegion().textContent).toBe("");
  });

  it("clears a status left from the previous opening when the dialog opens again", () => {
    vi.useFakeTimers();
    const { rerender } = render(<Confirm status="The daemon refused the write" />);
    act(() => {
      vi.advanceTimersByTime(PAST_HOLD);
    });
    expect(statusRegion().textContent).toBe("The daemon refused the write");

    rerender(<Confirm open={false} status="The daemon refused the write" />);
    rerender(<Confirm open status="The daemon refused the write" />);

    expect(statusRegion().textContent).toBe("");
  });

  /*
   * Two identical consecutive messages are one node and are spoken once, so the
   * required order — the wait between two refusals — is what makes the second
   * refusal a new node. The observable is the node's identity, since the first
   * and third words are the same.
   */
  it("replaces the node for each change, so a refusal repeated after a wait is announced again", () => {
    vi.useFakeTimers();
    const refusal = "The daemon refused the write";
    const { rerender } = render(<Confirm status={refusal} />);
    act(() => {
      vi.advanceTimersByTime(PAST_HOLD);
    });
    const first = statusRegion().firstElementChild;

    rerender(<Confirm status="Deleting…" />);
    const waiting = statusRegion().firstElementChild;
    rerender(<Confirm status={refusal} />);
    const second = statusRegion().firstElementChild;

    expect([first?.textContent, waiting?.textContent, second?.textContent]).toEqual([refusal, "Deleting…", refusal]);
    expect(new Set([first, waiting, second]).size).toBe(3);
  });
});

describe("the count of open modal dialogs", () => {
  it("is one while the dialog is open and none after it closes", async () => {
    const { rerender } = render(<Confirm />);
    expect(useNoticeStore.getState().modalDialogs).toBe(1);

    rerender(<Confirm open={false} />);

    await waitFor(() => {
      expect(useNoticeStore.getState().modalDialogs).toBe(0);
    });
  });

  it("is none after the dialog is unmounted while still open", () => {
    const { rerender } = render(<Confirm />);
    expect(useNoticeStore.getState().modalDialogs).toBe(1);

    rerender(<Confirm mounted={false} />);

    expect(useNoticeStore.getState().modalDialogs).toBe(0);
  });
});
