import { Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, type ReactNode } from "react";
import { Sidebar } from "./sidebar";

export function AppShell(): ReactNode {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const mainRef = useRef<HTMLElement>(null);
  const shownPathRef = useRef(pathname);

  // The path is compared rather than the renders counted: the first paint has
  // navigated nowhere, and StrictMode runs every mount effect twice.
  useEffect(() => {
    if (shownPathRef.current === pathname) {
      return;
    }

    shownPathRef.current = pathname;
    mainRef.current?.focus();
  }, [pathname]);

  return (
    <div className="flex min-h-screen bg-bg text-text">
      <Sidebar />
      <main ref={mainRef} tabIndex={-1} className="min-w-0 flex-1 p-6 sm:p-10">
        <Outlet />
      </main>
    </div>
  );
}
