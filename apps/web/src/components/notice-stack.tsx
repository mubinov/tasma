import { Toast, type ToastObject } from "@base-ui/react/toast";
import { useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { WarningIcon, XIcon } from "../lib/icons";
import { useFocusLost } from "../lib/use-focus-lost";
import { useNoticeStore, type OpenNotice } from "../store/notices";

/** Set on <html> while a notice is open: the height the stack covers above the window's bottom edge. */
const STACK_HEIGHT_PROPERTY = "--notice-stack-height";

type NoticeToast = ToastObject<OpenNotice>;

/** A closed panel stays in the DOM until Base UI removes it. */
function openPanels(viewport: HTMLElement): HTMLElement[] {
  return [...viewport.querySelectorAll<HTMLElement>(":scope > [data-notice-panel]:not([data-ending-style])")];
}

function newestDismiss(viewport: HTMLElement): HTMLElement | null {
  return openPanels(viewport).at(-1)?.querySelector("button") ?? null;
}

/**
 * Where focus goes when it would drop to <body>: the newest Dismiss, else the
 * popup of an open modal dialog, else <main>. A modal dialog hides <main> but
 * does not make it inert.
 */
function fallbackTarget(viewport: HTMLElement): HTMLElement | null {
  const main = viewport.parentElement?.querySelector<HTMLElement>(":scope > main") ?? null;
  const dialog = main?.getAttribute("aria-hidden") === "true"
    ? [
        ...document.querySelectorAll<HTMLElement>(
          ":is([role=\"dialog\"], [role=\"alertdialog\"])[data-open]:not([data-notice-panel])",
        ),
      ].at(-1) ?? null
    : null;
  return newestDismiss(viewport) ?? dialog ?? main;
}

/**
 * The stack is `fixed`, so it is the offsetParent of its panels; the browser
 * limits a scrollTop past the end, so a panel that fits shows whole. Returns
 * whether a closed panel above the bottom one moves it up when it leaves.
 */
function scrollToBottomPanel(viewport: HTMLElement): boolean {
  const bottomPanel = openPanels(viewport).at(-1);
  if (bottomPanel === undefined) {
    return false;
  }

  // A notice above the bottom one that holds focus stays in view.
  const focus = document.activeElement;
  if (!viewport.contains(focus) || bottomPanel.contains(focus)) {
    viewport.scrollTop = bottomPanel.offsetTop - Number.parseFloat(getComputedStyle(viewport).paddingTop);
  }

  return [...viewport.querySelectorAll(":scope > [data-ending-style]")].some(
    (ending) => (ending.compareDocumentPosition(bottomPanel) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
  );
}

/**
 * The open notices at the window's bottom right, the newest at the bottom. The
 * store is the source of truth, and the spoken region is the only announcer.
 */
export function NoticeStack(): ReactNode {
  // Base UI saves the focused element on F6 and never clears it; its focus
  // guards then send Tab from <main> back to that element.
  useEffect(() => {
    function block(event: globalThis.KeyboardEvent): void {
      if (event.key === "F6") {
        event.stopPropagation();
      }
    }

    window.addEventListener("keydown", block, true);
    return () => {
      window.removeEventListener("keydown", block, true);
    };
  }, []);

  return (
    <Toast.Provider timeout={0} limit={Number.POSITIVE_INFINITY}>
      <NoticeBridge />
      <NoticeViewport />
    </Toast.Provider>
  );
}

/** Makes the toasts equal to the open notices of the store. */
function NoticeBridge(): null {
  const notices = useNoticeStore(useShallow((state) => state.notices));
  const { toasts, add, close } = Toast.useToastManager<OpenNotice>();

  useLayoutEffect(() => {
    const present = new Set(toasts.map(({ id }) => id));
    for (const notice of notices) {
      const id = String(notice.serial);
      if (!present.has(id)) {
        add({
          id,
          data: notice,
          // A close from code has already removed the serial from the store.
          onClose: () => {
            const { notices: open, dismissNotice } = useNoticeStore.getState();
            if (open.some(({ serial }) => serial === notice.serial)) {
              dismissNotice(notice.key);
            }
          },
        });
      }
    }

    const open = new Set(notices.map(({ serial }) => String(serial)));
    for (const toast of toasts) {
      // A second close of an ending toast moves focus one panel further.
      if (!open.has(toast.id) && toast.transitionStatus !== "ending") {
        close(toast.id);
      }
    }
  }, [notices, toasts, add, close]);

  return null;
}

function NoticeViewport(): ReactNode {
  const { toasts } = Toast.useToastManager<OpenNotice>();
  const focusRequested = useNoticeStore((state) => state.noticeFocusRequested);
  const clearNoticeFocusRequest = useNoticeStore((state) => state.clearNoticeFocusRequest);
  const viewportRef = useRef<HTMLDivElement>(null);
  const focusLostRef = useRef(false);
  const rescrollRef = useRef(false);
  const newestId = toasts.find(({ transitionStatus }) => transitionStatus !== "ending")?.id ?? null;
  const closing = toasts.some(({ transitionStatus }) => transitionStatus === "ending");

  useLayoutEffect(() => {
    rescrollRef.current = scrollToBottomPanel(viewportRef.current!);
  }, [newestId]);

  useLayoutEffect(() => {
    if (!closing && rescrollRef.current) {
      rescrollRef.current = false;
      scrollToBottomPanel(viewportRef.current!);
    }
  }, [closing]);

  // A panel mounts one commit after its notice opens, so focus moves on a
  // change of the toasts or of the focus request, never on a change of the
  // notices, and never takes focus from a place Base UI chose.
  useLayoutEffect(() => {
    const viewport = viewportRef.current!;
    const lost = focusLostRef.current;
    focusLostRef.current = false;
    const onBody = document.activeElement === document.body;
    if (focusRequested) {
      if (!onBody) {
        clearNoticeFocusRequest();
        return;
      }

      const dismiss = newestDismiss(viewport);
      if (dismiss !== null) {
        dismiss.focus({ preventScroll: true });
        clearNoticeFocusRequest();
        return;
      }
    }

    if (lost && onBody) {
      fallbackTarget(viewport)?.focus();
    }
  }, [toasts, focusRequested, clearNoticeFocusRequest]);

  // A notice opens by itself, so the page keeps room for the stack below its
  // content and a focus scroll keeps its target clear of the stack.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const page = document.documentElement;
    if (viewport === null || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      if (openPanels(viewport).length === 0) {
        page.style.removeProperty(STACK_HEIGHT_PROPERTY);
      } else {
        const height = viewport.clientHeight - Number.parseFloat(getComputedStyle(viewport).paddingTop);
        page.style.setProperty(STACK_HEIGHT_PROPERTY, `${String(height)}px`);
      }
    });
    observer.observe(viewport);

    return () => {
      observer.disconnect();
      page.style.removeProperty(STACK_HEIGHT_PROPERTY);
    };
  }, []);

  // A scroll container clips the shadows inside it, so the padding holds the
  // panels' shadow and the negative margin keeps the panels where they would be
  // without it. The right padding is no wider than the gap to the window's edge,
  // so the scrollbar stays on screen. The padding takes no clicks from the page
  // under it.
  //
  // `aria-live="off"` stays present: a Base UI modal leaves an `[aria-live]`
  // element out of the `aria-hidden` it puts on the page behind it. An empty
  // stack is no landmark.
  const empty = toasts.length === 0;
  return (
    <Toast.Viewport
      ref={viewportRef}
      role={empty ? undefined : "region"}
      aria-live="off"
      aria-label={empty ? undefined : "Notices"}
      className="pointer-events-none fixed right-4 bottom-8 z-(--layer-notice) -m-8 -mr-4 flex max-h-screen w-[calc(100%+1rem)] max-w-[488px] flex-col gap-2 overflow-y-auto p-8 pr-4 sm:right-10 sm:-mr-8 sm:max-w-[504px] sm:pr-8 [html:has(&)]:scroll-pb-(--notice-stack-height)"
    >
      {toasts.toReversed().map((toast) => (
        <NoticePanel
          key={toast.id}
          toast={toast}
          onFocusLost={() => {
            focusLostRef.current = true;
          }}
        />
      ))}
    </Toast.Viewport>
  );
}

/**
 * What the application says to a screen reader alone. It is mounted with the
 * shell, so it is on the page before anything writes to it: a region that
 * arrives with its first words is not announced. Polite, so it never takes the
 * caret; each message is a node of its own, so the same words said twice are
 * two additions and are announced twice.
 *
 * Base UI exempts an element carrying `aria-live` from the `aria-hidden` and
 * `inert` a modal dialog puts on the page behind it, so the region is heard
 * while a dialog is open. `role="status"` alone does not earn the exemption.
 */
export function SpokenRegion(): ReactNode {
  const announced = useNoticeStore(useShallow((state) => state.announced));

  return (
    <div aria-live="polite" aria-relevant="additions" className="sr-only">
      {announced.map(({ serial, words }) => <p key={serial}>{words}</p>)}
    </div>
  );
}

type NoticePanelProps = {
  toast: NoticeToast;
  /** The panel leaves while focus is inside it. */
  onFocusLost: () => void;
};

const WORDS_CLASS = "mt-2 space-y-1 rounded-control bg-surface-2 px-2.5 py-2 font-mono text-xs-plus text-dim wrap-anywhere";

/** Escape on a panel closes that panel alone and never reaches a dialog's Escape handler. */
function stopEscapePropagation(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.stopPropagation();
  }
}

function NoticePanel({ toast, onFocusLost }: NoticePanelProps): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusLost(panelRef, onFocusLost);
  // The bridge adds every toast with its notice.
  const notice = toast.data!;

  return (
    <Toast.Root
      ref={panelRef}
      toast={toast}
      swipeDirection={[]}
      data-notice-panel=""
      onKeyDown={stopEscapePropagation}
      className="pointer-events-auto flex w-full animate-enter gap-3 rounded-card border border-line bg-surface px-4 py-3 shadow-float"
    >
      <WarningIcon size={20} aria-hidden="true" className="mt-px shrink-0 text-signal" />
      <div className="min-w-0 flex-1">
        <Toast.Title id={titleId} render={<p />} className="font-chrome text-base font-medium text-signal">
          {notice.title}
        </Toast.Title>
        <Toast.Description render={<div />}>
          {notice.line !== undefined && <p className="mt-0.5 text-sm text-muted">{notice.line}</p>}
          {notice.form === "failure"
            ? (
                <div className={WORDS_CLASS}>
                  {notice.words.map((word, index) => (
                    // Two words can be identical, so the position is the only
                    // stable identity a row has.
                    // eslint-disable-next-line @eslint-react/no-array-index-key
                    <p key={index}>{word}</p>
                  ))}
                </div>
              )
            : (
                <ul className={WORDS_CLASS}>
                  {notice.words.map((word, index) => (
                    // eslint-disable-next-line @eslint-react/no-array-index-key
                    <li key={index}>{word}</li>
                  ))}
                </ul>
              )}
        </Toast.Description>
      </div>
      <Toast.Close
        aria-label="Dismiss"
        aria-describedby={titleId}
        aria-hidden={false}
        className="-mt-[3px] -mr-2 flex size-7 shrink-0 items-center justify-center self-start rounded-control text-dim hover:text-text"
      >
        <XIcon size={16} aria-hidden="true" />
      </Toast.Close>
    </Toast.Root>
  );
}
