import { Component, useEffect, useRef, type ReactNode } from "react";
import { useDocumentTitle } from "../lib/document-title";

// A thrown value need not be an `Error`: a thrown string leaves `message`
// undefined, and a thrown `null` would read as "nothing failed".
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function ErrorPanel({ error }: { error: unknown }): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null);

  useDocumentTitle("Stopped rendering");

  // The tree that held the focused element is gone, so focus would fall back to
  // <body>. Moving it here is also what announces the failure: a live region
  // inserted already populated may not be read at all.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  return (
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
  );
}

export function ErrorScreen({ error }: { error: unknown }): ReactNode {
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg p-6 text-text">
      <ErrorPanel error={error} />
    </main>
  );
}

type ErrorBoundaryProps = { children: ReactNode };

type ErrorBoundaryState = { error: Error | null };

// Guards what the router itself renders; everything inside a route is caught by
// the router. Render errors only: handlers and promises need their own catch.
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

    return <ErrorScreen error={error} />;
  }
}
