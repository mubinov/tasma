import { ContextMenu } from "@base-ui/react/context-menu";
import { mergeProps } from "@base-ui/react/merge-props";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { appAvailable } from "../api/app";
import { openInBrowser, type Browser } from "../api/browsers";
import { browsersQuery } from "../api/queries";
import { tagOf } from "../lib/board";
import { NO_CONTEXT_SELECT_MARK } from "../lib/context-select";
import { openFileLink, revealFileLink } from "../lib/file-link";
import { menuBrowsers } from "../lib/menu-browsers";
import { browserOpenFailure, copyFailure, type CopyKind } from "../lib/write-failure";
import { reopenNotice, useNoticeStore, type Notice, type ShowNotice } from "../store/notices";
import { useUiStore } from "../store/ui";
import { MENU_ITEM_CLASS, POPUP_CLASS, POSITIONER_CLASS } from "./control-classes";

/** A link that `MarkdownLink` renders. `href` is the href it receives; `path` is absolute. */
export type MenuTarget
  = | { kind: "web" | "editor" | "mail"; href: string }
    | { kind: "task"; href: string; id: string }
    | { kind: "file"; path: string; line: number | undefined };

const MENU_NAMES: Record<MenuTarget["kind"], string> = {
  web: "Web link",
  task: "Task link",
  file: "File link",
  editor: "Editor link",
  mail: "Mail link",
};

const COPIED_WORDS: Record<CopyKind, string> = { link: "Link copied", path: "Path copied", text: "Copied" };

const SEPARATOR_CLASS = "my-1.5 h-px bg-line";

const LINK_MENU = "data-link-menu";

const LINK_MENU_MARK = { [LINK_MENU]: "" } as const;

/** The positioner puts the top of the menu this far above the point of its event. */
const MENU_RISE = 5;

/** The `contextmenu` events that `openBelow` sends, which `LinkMenuKeys` lets through. */
const sentEvents = new WeakSet<Event>();

/** Opens the menu of `link` with its top at the bottom of the first line box of the link. */
function openBelow(link: Element): void {
  // The link has focus, so it has a line box.
  const line = link.getClientRects()[0]!;
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: line.left,
    clientY: line.bottom + MENU_RISE,
  });
  sentEvents.add(event);
  link.dispatchEvent(event);
}

function sameRange(a: Range, b: Range): boolean {
  return a.compareBoundaryPoints(Range.START_TO_START, b) === 0 && a.compareBoundaryPoints(Range.END_TO_END, b) === 0;
}

/** A link to the task on show keeps the search, so its open chat stays open. */
export function TaskLink({ task, ...props }: ComponentProps<"a"> & { task: string }): ReactNode {
  const shown = useParams({ strict: false }).task === task;
  return (
    <Link
      {...props}
      to="/tasks/$project/$task"
      params={{ project: tagOf(task), task }}
      search={shown ? true : {}}
    />
  );
}

async function openLinkIn(url: string, browser: Browser, fail: ShowNotice): Promise<void> {
  try {
    await openInBrowser(url, browser.id);
  } catch {
    fail(browserOpenFailure(browser.name, url));
  }
}

/** A separator and one item for each browser of the menu list, or nothing while the list has no entry. */
function BrowserItems({ href, fail }: { href: string; fail: ShowNotice }): ReactNode {
  const list = useQuery({ ...browsersQuery(), enabled: appAvailable() }).data;
  const browser = useUiStore((state) => state.linkSettings.browser);
  const devBrowser = useUiStore((state) => state.linkSettings.devBrowser);
  const browsers = list === undefined ? [] : menuBrowsers(list, browser, devBrowser);
  if (browsers.length === 0) {
    return null;
  }
  return (
    <>
      <ContextMenu.Separator className={SEPARATOR_CLASS} />
      {browsers.map((entry) => (
        <ContextMenu.Item
          key={entry.id}
          onClick={() => {
            void openLinkIn(href, entry, fail);
          }}
          className={MENU_ITEM_CLASS}
        >
          {`Open in ${entry.name}`}
        </ContextMenu.Item>
      ))}
    </>
  );
}

type ItemsProps = {
  target: MenuTarget;
  /** The selected text that holds the link, kept at open. */
  selected: string | null;
  onCopy: (value: string, what: CopyKind) => void;
  /** Shows the notice of a failed item. */
  fail: ShowNotice;
};

function KindItems({ target, onCopy, fail }: Omit<ItemsProps, "selected">): ReactNode {
  function copyItem(label: string, value: string, what: CopyKind): ReactNode {
    return (
      <ContextMenu.Item
        onClick={() => {
          onCopy(value, what);
        }}
        className={MENU_ITEM_CLASS}
      >
        {label}
      </ContextMenu.Item>
    );
  }

  switch (target.kind) {
    case "web":
      return (
        <>
          {copyItem("Copy link", target.href, "link")}
          <BrowserItems href={target.href} fail={fail} />
        </>
      );
    case "task":
      return (
        <>
          <ContextMenu.LinkItem closeOnClick render={<TaskLink task={target.id} />} className={MENU_ITEM_CLASS}>
            Open task
          </ContextMenu.LinkItem>
          {copyItem("Copy link", target.href, "link")}
        </>
      );
    case "file":
      return (
        <>
          <ContextMenu.Item
            onClick={() => {
              void openFileLink(target.path, target.line, fail);
            }}
            className={MENU_ITEM_CLASS}
          >
            Open
          </ContextMenu.Item>
          <ContextMenu.Item
            onClick={() => {
              void revealFileLink(target.path, fail);
            }}
            className={MENU_ITEM_CLASS}
          >
            Show in Finder
          </ContextMenu.Item>
          {copyItem("Copy path", target.path, "path")}
        </>
      );
    case "editor":
    case "mail":
      return (
        <>
          <ContextMenu.LinkItem
            closeOnClick
            href={target.href}
            target="_blank"
            rel="noreferrer"
            className={MENU_ITEM_CLASS}
          >
            Open
          </ContextMenu.LinkItem>
          {copyItem("Copy link", target.href, "link")}
        </>
      );
  }
}

function LinkMenuItems({ target, selected, onCopy, fail }: ItemsProps): ReactNode {
  return (
    <>
      {selected !== null && (
        <>
          <ContextMenu.Item
            onClick={() => {
              onCopy(selected, "text");
            }}
            className={MENU_ITEM_CLASS}
          >
            Copy
          </ContextMenu.Item>
          <ContextMenu.Separator className={SEPARATOR_CLASS} />
        </>
      )}
      <KindItems target={target} onCopy={onCopy} fail={fail} />
    </>
  );
}

type LinkContextMenuProps = Omit<ComponentProps<typeof ContextMenu.Trigger>, "children" | "render"> & {
  target: MenuTarget;
  /** The anchor of the link. */
  children: ReactElement;
};

/**
 * The anchor of a link with the Tasma link menu on right click, Control-click
 * and Control-Return. The other props are those of the tooltip trigger that
 * renders it.
 */
export function LinkContextMenu({ target, children, ...props }: LinkContextMenuProps): ReactNode {
  const [selected, setSelected] = useState<{ text: string; range: Range } | null>(null);
  const closedRef = useRef(true);
  // The result of an item waits for the menu to close: focus then returns to the link, and the screen reader reading
  // the link would cut off an announcement made at the same time. A slow result can land in a later menu of the link.
  const pendingResultsRef = useRef<(() => void)[]>([]);

  function afterMenuClose(show: () => void): void {
    if (closedRef.current) {
      show();
    } else {
      pendingResultsRef.current.push(show);
    }
  }

  function showPendingResults(): void {
    closedRef.current = true;
    const pending = pendingResultsRef.current;
    pendingResultsRef.current = [];
    for (const show of pending) {
      show();
    }
  }

  const showPendingAtUnmount = useEffectEvent(showPendingResults);

  useEffect(
    () => () => {
      showPendingAtUnmount();
    },
    [],
  );

  function fail(notice: Notice): void {
    afterMenuClose(() => {
      reopenNotice(notice);
    });
  }

  async function copy(value: string, what: CopyKind): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      afterMenuClose(() => {
        useNoticeStore.getState().announce(COPIED_WORDS[what]);
      });
    } catch {
      fail(copyFailure(what, value));
    }
  }

  function restoreSelection(): void {
    const selection = getSelection();
    if (selected === null || selection === null) {
      return;
    }
    if (selection.rangeCount === 1 && sameRange(selection.getRangeAt(0), selected.range)) {
      return;
    }
    selection.removeAllRanges();
    selection.addRange(selected.range);
  }

  const handlers: ComponentProps<typeof ContextMenu.Trigger> = {
    onContextMenu: (event) => {
      const selection = getSelection();
      if (selection === null || selection.isCollapsed || !selection.getRangeAt(0).intersectsNode(event.currentTarget)) {
        setSelected(null);
        return;
      }
      setSelected({ text: selection.toString(), range: selection.getRangeAt(0).cloneRange() });
    },
    onKeyDown: (event) => {
      if (event.key === "Enter" && event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
        event.preventDefault();
        openBelow(event.currentTarget);
      }
    },
    // macOS sends a Control-click as a `contextmenu` and then a `click`.
    onClick: (event) => {
      if (event.ctrlKey) {
        event.preventDefault();
      }
    },
  };

  return (
    <ContextMenu.Root
      highlightItemOnHover={false}
      onOpenChange={(open) => {
        if (open) {
          closedRef.current = false;
        }
      }}
      onOpenChangeComplete={(open) => {
        if (open) {
          return;
        }
        showPendingResults();
        // A focus move can clear the selection, and Base UI returns focus after this callback, in a microtask.
        requestAnimationFrame(restoreSelection);
      }}
    >
      <ContextMenu.Trigger
        {...mergeProps<typeof ContextMenu.Trigger>(props, handlers)}
        {...NO_CONTEXT_SELECT_MARK}
        {...LINK_MENU_MARK}
        render={children}
      />
      <ContextMenu.Portal>
        <ContextMenu.Positioner sideOffset={-MENU_RISE} className={POSITIONER_CLASS}>
          <ContextMenu.Popup aria-label={MENU_NAMES[target.kind]} className={`min-w-52 select-none ${POPUP_CLASS}`}>
            <LinkMenuItems
              target={target}
              selected={selected?.text ?? null}
              onCopy={(value, what) => {
                void copy(value, what);
              }}
              fail={fail}
            />
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function inBox(box: DOMRect, { clientX, clientY }: MouseEvent): boolean {
  return clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom;
}

/**
 * Opens the menu of the focused link below the link for a `contextmenu` that
 * no pointer press started, as VoiceOver's show-menu action sends: on the link,
 * or at a point inside its box, which for a wrapped link can be outside its
 * line boxes.
 */
export function LinkMenuKeys(): ReactNode {
  useEffect(() => {
    let pressed = false;

    function onPress(): void {
      pressed = true;
    }

    function onEnd(): void {
      pressed = false;
    }

    function onContextMenu(event: MouseEvent): void {
      const fromPointer = pressed;
      pressed = false;
      const link = document.activeElement;
      if (fromPointer || sentEvents.has(event) || !link?.hasAttribute(LINK_MENU)) {
        return;
      }
      const onLink = event.target instanceof Node && link.contains(event.target);
      if (!onLink && !inBox(link.getBoundingClientRect(), event)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      openBelow(link);
    }

    document.addEventListener("pointerdown", onPress, true);
    document.addEventListener("pointerup", onEnd, true);
    document.addEventListener("pointercancel", onEnd, true);
    document.addEventListener("keydown", onEnd, true);
    document.addEventListener("contextmenu", onContextMenu, true);
    return () => {
      document.removeEventListener("pointerdown", onPress, true);
      document.removeEventListener("pointerup", onEnd, true);
      document.removeEventListener("pointercancel", onEnd, true);
      document.removeEventListener("keydown", onEnd, true);
      document.removeEventListener("contextmenu", onContextMenu, true);
    };
  }, []);

  return null;
}
