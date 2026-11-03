import { Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, type ReactNode } from "react";
import { TITLE_COVER_ID } from "../lib/use-top-bar-lengths";
import { useUiStore } from "../store/ui";
import { NoticeStack, SpokenRegion } from "./notice-stack";
import { Sidebar } from "./sidebar";

export function AppShell(): ReactNode {
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // A retry replaces the failure panel without navigating anywhere, which the
  // path alone cannot see.
  const failing = useRouterState({ select: (state) => state.matches.some((match) => match.status === "error") });
  const mainRef = useRef<HTMLElement>(null);
  const shownRef = useRef({ pathname, failing });
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

  // What the region shows is compared rather than the renders counted: the first
  // paint replaced nothing, and StrictMode runs every mount effect twice.
  useEffect(() => {
    if (shownRef.current.pathname === pathname && shownRef.current.failing === failing) {
      return;
    }

    shownRef.current = { pathname, failing };
    mainRef.current?.focus();
  }, [pathname, failing]);

  return (
    <div className="flex min-h-screen bg-bg text-text">
      <Sidebar />
      {/* It takes pointer events, so `elementFromPoint` reads a target under the band as covered. */}
      <div
        id={TITLE_COVER_ID}
        aria-hidden="true"
        className="fixed inset-x-0 top-0 z-(--layer-title-cover) h-(--title-band) bg-bg"
      />
      <main
        ref={mainRef}
        tabIndex={-1}
        className="min-w-0 flex-1 p-6 pt-[calc(--spacing(6)+var(--title-band))] pb-[calc(--spacing(6)+var(--notice-stack-height,0px))] sm:p-10 sm:pt-[calc(--spacing(10)+var(--title-band))] sm:pb-[calc(--spacing(10)+var(--notice-stack-height,0px))]"
      >
        <Outlet />
      </main>
      <NoticeStack />
      <SpokenRegion />
    </div>
  );
}
