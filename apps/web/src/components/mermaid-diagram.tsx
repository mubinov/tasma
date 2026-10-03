import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { renderMermaid, type MermaidMarkup } from "../lib/mermaid";
import { useResolvedTheme } from "../lib/theme";

type MermaidDiagramProps = { source: string };

function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * A ```` ```mermaid ```` block drawn as a static diagram in the current theme.
 * It shows the source until the diagram is ready, and the source with
 * Mermaid's message when Mermaid rejects it.
 */
export function MermaidDiagram({ source }: MermaidDiagramProps): ReactNode {
  const theme = useResolvedTheme();
  const [diagram, setDiagram] = useState<MermaidMarkup | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const noteId = useId();
  const sourceId = useId();

  useEffect(() => {
    const job = new AbortController();
    renderMermaid(source, theme, containerRef.current!, job.signal).then(
      (rendered) => {
        if (!job.signal.aborted) {
          setDiagram(rendered);
          setFailure(null);
        }
      },
      (error: unknown) => {
        if (!job.signal.aborted) {
          setDiagram(null);
          setFailure(messageOf(error));
        }
      },
    );
    return () => {
      job.abort();
    };
  }, [source, theme]);

  // Before paint, so the SVG never shows without its rules.
  useLayoutEffect(() => {
    if (diagram === null) {
      return;
    }
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(diagram.css);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    return () => {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((adopted) => adopted !== sheet);
    };
  }, [diagram]);

  const content = diagram === null
    ? (
        <pre className="font-mono text-xs-plus whitespace-pre">
          <code>{source}</code>
        </pre>
      )
    : (
        <figure aria-label={diagram.title ?? "Diagram"} aria-describedby={diagram.hasDescription ? undefined : sourceId}>
          {/* eslint-disable-next-line @eslint-react/dom-no-dangerously-set-innerhtml -- Mermaid sanitizes it */}
          <div dangerouslySetInnerHTML={{ __html: diagram.svg }} />
          {!diagram.hasDescription && (
            <span id={sourceId} className="sr-only">
              {source}
            </span>
          )}
        </figure>
      );

  return (
    <>
      {/* One element in every state, so focus stays on the block when the state changes. */}
      <div
        tabIndex={0}
        aria-describedby={failure === null ? undefined : noteId}
        className="relative mt-3 overflow-x-auto rounded-card bg-surface-2 px-3.5 py-3 contain-paint"
      >
        {content}
        {/*
          Mermaid empties this element and measures the labels in it, so React
          renders nothing into it. A gantt chart takes its width.
        */}
        <div ref={containerRef} aria-hidden className="invisible absolute inset-x-3.5 top-0 h-0 overflow-hidden" />
      </div>
      {failure !== null && (
        <div id={noteId} className="mt-1.5 text-xs-plus text-muted">
          <p>The diagram cannot be shown.</p>
          <p className="mt-1 font-mono whitespace-pre-wrap">{failure}</p>
        </div>
      )}
    </>
  );
}
