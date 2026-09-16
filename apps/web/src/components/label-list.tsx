import type { ReactNode } from "react";

type LabelListProps = {
  labels: readonly string[];
  /** Added to the list's own classes. */
  className?: string;
};

export function LabelList({ labels, className }: LabelListProps): ReactNode {
  return (
    <ul className={`flex flex-wrap gap-x-3 gap-y-1 ${className ?? ""}`}>
      {labels.map((label, index) => (
        // A hand-edited task file can hold the same label twice.
        // eslint-disable-next-line @eslint-react/no-array-index-key
        <li key={index} className="inline-flex items-center gap-1.5 text-muted">
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-graphic" />
          <span className="min-w-0 wrap-anywhere">{label}</span>
        </li>
      ))}
    </ul>
  );
}
