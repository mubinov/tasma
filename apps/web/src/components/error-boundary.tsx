import { Button } from "@base-ui/react/button";
import { useMatch, useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { ProtocolError, TransportError } from "@tasma/protocol";
import { Component, useEffect, useRef, type ReactNode } from "react";
import { DAEMON_URL } from "../api/transport";
import { useDocumentTitle } from "../lib/document-title";

// A thrown value need not be an `Error`: a thrown string leaves `message`
// undefined, and a thrown `null` would read as "nothing failed".
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

type Presentation = {
  /** Names the tab, which otherwise keeps naming the screen that is gone. */
  title: string;
  heading: string;
  /** Names no control: the Retry button renders only where a caller passed a reset. */
  advice: string;
  detail: ReactNode;
  /** Repeating the call is only worth offering where it could answer next time. */
  offersRetry: boolean;
};

/**
 * A refusal earns its own arm rather than falling through to the render crash:
 * "tasma stopped rendering" would be actively wrong about the `config-invalid`
 * the daemon answers for a `config.yml` the reader can go and fix.
 */
function describeFailure(error: unknown): Presentation {
  // `status` is set only where an answer arrived, and that tells the two
  // transport faults apart: one carrying a status may well have been carried
  // out, so it can promise neither a missing daemon nor an untouched disk.
  if (error instanceof TransportError && error.status === undefined) {
    return {
      title: "No daemon",
      heading: "tasma cannot reach the daemon",
      advice: "Start the daemon at the address below. Nothing on disk has been read or changed.",
      detail: DAEMON_URL,
      offersRetry: true,
    };
  }

  if (error instanceof TransportError && error.status !== undefined) {
    return {
      title: "Unreadable answer",
      heading: "tasma cannot read the daemon's answer",
      advice: "The address below answered, and not with a daemon reply. Start the daemon there if it is not running.",
      detail: (
        <>
          <span className="block text-muted">{`${DAEMON_URL} · HTTP ${error.status}`}</span>
          {error.message}
        </>
      ),
      offersRetry: true,
    };
  }

  if (error instanceof ProtocolError) {
    return {
      title: "Request refused",
      heading: "the daemon refused this request",
      advice: "The daemon read the request and would not carry it out. Its own words are below.",
      detail: (
        <>
          <span className="block text-muted">{`${error.failure.kind}/${error.failure.code}`}</span>
          {/* The client validates `kind` alone, so a message that is not a
              string would throw from inside this panel — the one place no
              boundary above it catches. */}
          {String(error.failure.message)}
        </>
      ),
      offersRetry: false,
    };
  }

  return {
    title: "Stopped rendering",
    heading: "tasma stopped rendering",
    advice: "Restart the window. If it keeps happening, the message below is what to report.",
    detail: toError(error).message,
    offersRetry: false,
  };
}

type ErrorPanelProps = {
  error: unknown;
  reset?: () => void;
  /** Whether the repeat this panel asked for is running right now. */
  retrying?: boolean;
};

/**
 * The failure panel, with no landmark of its own: the router renders it inside
 * the shell's `<main>`.
 *
 * Retry calls `reset` and touches no query client: `useQueryClient` throws where
 * no provider is mounted, and `ErrorScreen` renders this panel outside the
 * router. `reset` is optional because the class boundary has nothing to repeat.
 */
export function ErrorPanel({ error, reset, retrying = false }: ErrorPanelProps): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  // The state this panel mounted in. A flip later must not move focus again.
  const mountedRetryingRef = useRef(retrying);
  const { title, heading, advice, detail, offersRetry } = describeFailure(error);

  useDocumentTitle(title);

  // The tree that held the focused element is gone, so focus would fall back to
  // <body>. Moving it here is also what announces the failure: a live region
  // inserted already populated may not be read at all. A retry rebuilds this
  // panel, and the reader who pressed Retry belongs on its replacement rather
  // than back on the message.
  useEffect(() => {
    const landing = mountedRetryingRef.current ? retryRef.current ?? panelRef.current : panelRef.current;
    landing?.focus();
  }, []);

  return (
    <div
      ref={panelRef}
      // An alert re-inserted with the same words would read the reader's own
      // click back to them as the answer. While the repeat runs it is a wait.
      role={retrying ? "status" : "alert"}
      aria-busy={retrying}
      tabIndex={-1}
      className="w-full max-w-lg rounded-panel border border-line bg-surface p-6"
    >
      <h1 className="font-chrome text-lg font-semibold">{heading}</h1>
      <p className="mt-2 text-sm text-muted">{advice}</p>
      <p className="mt-4 rounded-card bg-surface-2 p-3 font-mono text-xs text-dim wrap-anywhere">{detail}</p>
      {offersRetry && reset !== undefined && (
        // The hover mark is the border, not the fill: two surfaces alone are
        // about 1.1:1 apart and tell no state from another. The wait is in the
        // label, not in `disabled`, which would drop the focus resting here.
        <Button
          ref={retryRef}
          type="button"
          onClick={reset}
          className="mt-4 h-9 rounded-control border border-line bg-surface-2 px-3 text-sm text-text hover:border-graphic"
        >
          {retrying ? "Retrying…" : "Retry"}
        </Button>
      )}
    </div>
  );
}

/**
 * Retry invalidates the router rather than calling the `reset` it is handed:
 * `reset` clears the boundary's own state alone, and the match it re-renders is
 * still the errored one, so the identical panel comes straight back. Only
 * `invalidate` replaces the match and re-runs the loader.
 *
 * It wraps the panel rather than the panel calling `useRouter` itself, because
 * `ErrorScreen` renders the panel where no router is mounted.
 */
export function RouteFailure({ error }: ErrorComponentProps): ReactNode {
  const router = useRouter();
  // This match's own fetch, never the router's `isLoading`, which is set for any
  // pending navigation — the one committing this very failure included. The
  // match stays errored while its repeat runs, so the fetch is what knows an
  // answer is still coming.
  const retrying = useMatch({ strict: false, select: (match) => match.isFetching !== false });

  return <ErrorPanel error={error} retrying={retrying} reset={() => void router.invalidate()} />;
}

/**
 * The failure panel as the whole page. Used where no shell renders around it, so
 * it carries the one `<main>` the document has.
 */
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
