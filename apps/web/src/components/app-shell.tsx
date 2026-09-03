import { Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, type ReactNode } from "react";
import { Sidebar } from "./sidebar";

export function AppShell(): ReactNode {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // A retry replaces the failure panel without navigating anywhere, which the
  // path alone cannot see.
  const failing = useRouterState({ select: (state) => state.matches.some((match) => match.status === "error") });
  const mainRef = useRef<HTMLElement>(null);
  const shownRef = useRef({ pathname, failing });

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
      <main ref={mainRef} tabIndex={-1} className="min-w-0 flex-1 p-6 sm:p-10">
        <Outlet />
      </main>
    </div>
  );
}
