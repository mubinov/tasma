import { Component, useEffect, useRef, type ReactNode } from "react";

/**
 * A fallback is handed whatever was thrown, which need not be an `Error`: a
 * thrown string or object leaves `message` undefined, and a thrown `null` would
 * read as "nothing failed" and re-render the children that just threw.
 */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * The one failure screen. The router catches a throw from a route component
 * before any boundary above it can, so it renders this too — see
 * `defaultErrorComponent` in src/router.ts.
 */
export function ErrorPanel({ error }: { error: unknown }): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null);

  // The tree that held the focused element is gone, so focus would fall back to
  // <body>. Moving it onto the panel is also what announces the failure
  // reliably: a live region inserted already populated may not be read at all.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  // The panel replaces the whole tree, <main> included, so it carries its own
  // landmark: role="alert" announces the failure but is not navigable.
  //
  // The commonest real message is a module URL — one unbroken token. Its
  // min-content width would size the panel past a narrow window, and a centred
  // flex child wider than its container overflows on both sides, so the heading
  // leaves the left edge where no scrolling reaches it. wrap-anywhere breaks
  // inside the token; w-full holds the panel to the space actually available.
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg p-6 text-text">
      <div
        ref={panelRef}
        role="alert"
        tabIndex={-1}
        className="w-full max-w-lg rounded-panel border border-line bg-surface p-6"
      >
        <h1 className="font-chrome text-lg font-semibold">tasma stopped rendering</h1>
        <p className="mt-2 text-sm text-muted">
          Restart the window. If it keeps happening, the message below is what to report.
        </p>
        <p className="mt-4 rounded-card bg-surface-2 p-3 font-mono text-xs text-dim wrap-anywhere">
          {toError(error).message}
        </p>
      </div>
    </main>
  );
}

type ErrorBoundaryProps = { children: ReactNode };

type ErrorBoundaryState = { error: Error | null };

/**
 * React unmounts the whole application when a component throws while
 * rendering. In a packaged desktop app that leaves a blank window and no way
 * to find out why, because devtools are usually unavailable there.
 *
 * This one guards what the router itself renders; everything inside a route is
 * caught by the router and rendered through the same panel.
 *
 * Render errors only: event handlers and promises still need their own catch.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: toError(error) };
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) {
      return this.props.children;
    }

    return <ErrorPanel error={error} />;
  }
}
