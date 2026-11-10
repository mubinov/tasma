import { Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, type ReactNode } from "react";
import { chatKey, NEW_CHAT_KEY } from "../lib/chat-list-announcements";
import { SETUP_PATH } from "../lib/setup-steps";
import { TITLE_COVER_ID } from "../lib/use-top-bar-lengths";
import { useNoticeStore } from "../store/notices";
import { useUiStore } from "../store/ui";
import { NoticeStack, SpokenRegion } from "./notice-stack";
import { Sidebar } from "./sidebar";

export function AppShell(): ReactNode {
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // The Dashboard place of the address: the New chat view, or the key of an open chat of a project.
  const dashboardPlace = useRouterState({
    select: ({ location: { pathname: path, search } }) => {
      if (path !== "/") {
        return null;
      }
      if (search.new === "1") {
        return NEW_CHAT_KEY;
      }
      const { tag, chat } = search;

      return tag === undefined || chat === undefined ? null : chatKey({ tag, chat: Number(chat) });
    },
  });
  const startedChat = useUiStore((state) => state.startedChat);
  // A retry replaces the failure panel without navigating anywhere, which the
  // path alone cannot see.
  const failing = useRouterState({ select: (state) => state.matches.some((match) => match.status === "error") });
  // The match rather than the path: the path changes when a navigation starts,
  // and the setup screen stays on the page until the next screen has its data.
  const onSetup = useRouterState({ select: (state) => state.matches.some((match) => match.routeId === SETUP_PATH) });
  const mainRef = useRef<HTMLElement>(null);
  const shownRef = useRef({ pathname, failing, onSetup });
  const editRequest = useUiStore((state) => state.editRequest);
  const requestedPathname = editRequest === null
    ? null
    : router.buildLocation({
      to: "/tasks/$project/$task",
      params: { project: editRequest.tag, task: editRequest.id },
    }).pathname;

  // A card menu's Edit raises its request before the navigation, and only the
  // page it names takes it. Anywhere else is a page that will never take it —
  // a route whose read failed, or a reader who left first — and a request left
  // standing would open an editor unasked the next time that task is opened.
  const dropStaleEdit = useEffectEvent(() => {
    if (requestedPathname !== null && requestedPathname !== pathname) {
      useUiStore.getState().takeEditRequest();
    }
  });

  useEffect(() => {
    dropStaleEdit();
  }, [pathname]);

  // In the shell, and not on the Dashboard: a check there stops when the screen unmounts.
  const endStartedChat = useEffectEvent(() => {
    if (startedChat === null || dashboardPlace === NEW_CHAT_KEY || dashboardPlace === chatKey(startedChat)) {
      return;
    }

    const ui = useUiStore.getState();
    const words = ui.takeStartedWords();

    ui.setStartedChat(null);
    if (words === null) {
      return;
    }
    // A change of screen moves the focus to the page in the effect below, and the live message loses to it.
    if (shownRef.current.pathname === pathname) {
      useNoticeStore.getState().announce(words);
    } else {
      ui.setArrivalWords(words);
    }
  });

  useEffect(() => {
    endStartedChat();
  }, [dashboardPlace, startedChat]);

  // What the region shows is compared rather than the renders counted: the first
  // paint replaced nothing, and StrictMode runs every mount effect twice.
  useEffect(() => {
    const shown = shownRef.current;

    if (shown.pathname === pathname && shown.failing === failing && shown.onSetup === onSetup) {
      return;
    }

    shownRef.current = { pathname, failing, onSetup };
    const main = mainRef.current;

    if (main !== null) {
      main.focus();

      // A live message and a focus move compete, and the live message loses.
      const words = useUiStore.getState().takeArrivalWords();

      if (words !== null) {
        useNoticeStore.getState().announce(words);
      }
    }
  }, [pathname, failing, onSetup]);

  // Each child keeps its place in both layouts: a message in the spoken region
  // has to survive the move from the setup screen to the next page.
  return (
    <div className={onSetup ? "flex min-h-screen flex-col bg-bg text-text" : "flex min-h-screen bg-bg text-text"}>
      {!onSetup && <Sidebar />}
      {/* It takes pointer events, so `elementFromPoint` reads a target under the band as covered. Its bottom line is a
          shadow because a border draws also at height 0. Beside a sidebar, the frame of the sidebar draws it. */}
      <div
        id={TITLE_COVER_ID}
        aria-hidden="true"
        className={`fixed inset-x-0 top-0 z-(--layer-title-cover) h-(--title-band) overflow-hidden bg-surface-2 text-center font-chrome text-base leading-(--title-band) font-semibold text-text select-none ${onSetup ? "shadow-[inset_0_-1px_0_var(--color-line)]" : ""}`}
      >
        Tasma
      </div>
      {onSetup
        ? <Outlet />
        : (
            <main
              ref={mainRef}
              tabIndex={-1}
              className="min-w-0 flex-1 p-6 pt-[calc(--spacing(6)+var(--title-band))] pb-[calc(--spacing(6)+var(--notice-stack-height,0px))] sm:p-10 sm:pt-[calc(--spacing(10)+var(--title-band))] sm:pb-[calc(--spacing(10)+var(--notice-stack-height,0px))]"
            >
              <Outlet />
            </main>
          )}
      <NoticeStack />
      <SpokenRegion />
    </div>
  );
}
