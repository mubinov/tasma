import { Collapsible } from "@base-ui/react/collapsible";
import type { Comment } from "@tasma/protocol";
import { useId, type ReactNode } from "react";
import { CaretDownIcon } from "../lib/icons";
import { formatStamp } from "../lib/task-page";
import { Markdown } from "./markdown";

/** The caret folds the comment for this reader alone and writes nothing. */
export function CommentCard({ comment }: { comment: Comment }): ReactNode {
  const titleId = useId();
  const { id, title, author, created, body, collapsed } = comment;
  const hasBody = body.trim() !== "";

  return (
    <li>
      {/* The open state starts again when a poll gives the comment text or takes it away. */}
      <Collapsible.Root
        key={hasBody ? "text" : "marker"}
        render={<article />}
        aria-labelledby={titleId}
        defaultOpen={hasBody && collapsed !== true}
        className="group/comment mt-3 rounded-card border border-line bg-surface"
      >
        <div className="px-4 pt-3 group-data-closed/comment:pb-3 group-data-open/comment:border-b group-data-open/comment:border-line group-data-open/comment:pb-2">
          <div className="flex items-center gap-1">
            <h3 id={titleId} className="mr-2 min-w-0 flex-1 font-chrome text-base font-medium wrap-anywhere">
              {title}
            </h3>
            {hasBody && (
              <Collapsible.Trigger
                aria-label="Comment text"
                className="flex size-6 shrink-0 items-center justify-center rounded-control text-dim hover:text-text"
              >
                <CaretDownIcon
                  size={14}
                  aria-hidden="true"
                  className="transition-transform duration-(--duration-fast) group-data-closed/comment:-rotate-90"
                />
              </Collapsible.Trigger>
            )}
          </div>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs-plus text-dim">
            <span className="font-mono text-xs">{`#${String(id)}`}</span>
            {author !== undefined && (
              <>
                <span aria-hidden="true">·</span>
                <span className="min-w-0 wrap-anywhere">{author}</span>
              </>
            )}
            <span aria-hidden="true">·</span>
            <time dateTime={created}>{formatStamp(created)}</time>
          </p>
        </div>
        {hasBody && (
          <Collapsible.Panel className="px-4 pt-2.5 pb-3.5">
            <Markdown text={body} base={4} />
          </Collapsible.Panel>
        )}
      </Collapsible.Root>
    </li>
  );
}
