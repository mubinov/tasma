import type { ReactNode } from "react";

type LabelListProps = {
  labels: readonly string[];
  /** Added to the list's own classes. */
  className?: string;
  /** Renders the rows as phrasing content, for a list inside a button, where a `ul` is not valid. */
  phrasing?: boolean;
};

const LIST_CLASS = "flex flex-wrap gap-x-3 gap-y-1";

const ROW_CLASS = "inline-flex items-center gap-1.5 text-muted";

export function LabelMark({ label }: { label: string }): ReactNode {
  return (
    <>
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-graphic" />
      <span className="min-w-0 wrap-anywhere">{label}</span>
    </>
  );
}

export function LabelList({ labels, className = "", phrasing = false }: LabelListProps): ReactNode {
  const listClass = `${LIST_CLASS} ${className}`;

  if (phrasing) {
    return (
      <span className={listClass}>
        {labels.map((label, index) => (
          // A hand-edited task file can hold the same label twice.
          // eslint-disable-next-line @eslint-react/no-array-index-key
          <span key={index} className={ROW_CLASS}>
            {/* The dot and the gap separate the labels on screen alone, so the
                accessible name takes a comma and a space. The space stays
                outside the sr-only span: a name is built from the trimmed text
                of each element. A flex row does not render a text node that is
                only whitespace. */}
            {index > 0 && (
              <>
                <span className="sr-only">,</span>
                {" "}
              </>
            )}
            <LabelMark label={label} />
          </span>
        ))}
      </span>
    );
  }

  return (
    <ul className={listClass}>
      {labels.map((label, index) => (
        // A hand-edited task file can hold the same label twice.
        // eslint-disable-next-line @eslint-react/no-array-index-key
        <li key={index} className={ROW_CLASS}>
          <LabelMark label={label} />
        </li>
      ))}
    </ul>
  );
}
