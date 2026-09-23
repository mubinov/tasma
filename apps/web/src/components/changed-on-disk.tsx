import { Button } from "@base-ui/react/button";
import { useId, type KeyboardEventHandler, type ReactNode, type RefObject } from "react";
import { WarningIcon } from "../lib/icons";
import type { EditorSubject } from "../lib/editor-subject";
import { reloadLabel } from "../lib/unsaved-words";
import { useFocusLost } from "../lib/use-focus-lost";

export type ChangedOnDiskProps = {
  /** Which editor the line belongs to, which names its reload control. */
  subject: EditorSubject;
  /** `HH:MM` of the read that first differed. */
  at: string;
  lineRef: RefObject<HTMLParagraphElement | null>;
  /** Writes nothing: the fields and the start text both become the text on disk. */
  onReload: () => void;
  /** The editor's keys, for a line outside the editor's form. A line inside the form gets them from the form. */
  onKeyDown?: KeyboardEventHandler;
  /** The line leaves while it holds the caret, which a read that ends the difference does. */
  onFocusLost: () => void;
  /** The line's own margins, which differ between the page and a comment card. */
  className?: string;
};

/**
 * Plain text rather than a live region of its own: the shell's spoken region
 * carries the announcement, and a region that arrives together with its words
 * is not announced.
 */
export function ChangedOnDisk(
  { subject, at, lineRef, onReload, onKeyDown, onFocusLost, className }: ChangedOnDiskProps,
): ReactNode {
  const wordsId = useId();
  useFocusLost(lineRef, onFocusLost);

  return (
    <p
      ref={lineRef}
      onKeyDown={onKeyDown}
      className={`flex max-w-2xl flex-wrap items-center gap-x-1.5 gap-y-1 text-sm ${className ?? "mb-4"}`}
    >
      <WarningIcon size={16} aria-hidden="true" className="shrink-0 text-signal" />
      <span id={wordsId}>
        <span className="text-signal">{`Changed on disk at ${at}, since you began.`}</span>
        {" "}
        <span className="text-muted">Saving overwrites that change.</span>
      </span>
      <Button
        type="button"
        aria-label={reloadLabel(subject)}
        aria-describedby={wordsId}
        onClick={onReload}
        className="text-text underline underline-offset-2"
      >
        Discard and reload
      </Button>
    </p>
  );
}
