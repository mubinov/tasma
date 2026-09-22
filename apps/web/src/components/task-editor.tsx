import { Button } from "@base-ui/react/button";
import { Field } from "@base-ui/react/field";
import { useId, type KeyboardEventHandler, type ReactNode, type Ref, type RefObject } from "react";
import { WarningIcon } from "../lib/icons";
import type { Draft } from "../lib/text-draft";
import { useFocusLost } from "../lib/use-focus-lost";
import { FIELD_BORDER_CLASS, FIELD_ERROR_CLASS } from "./control-classes";
import { KeyHint, MarkdownEditor, MarkdownEditorHint } from "./markdown-editor";

/** The title input carries the type of the heading it stands in for. */
const TITLE_CLASS
  = `mt-1 w-full max-w-2xl rounded-control bg-surface px-3 py-1.5 font-chrome text-xl font-semibold text-text ${FIELD_BORDER_CLASS}`;

export type ChangedOnDiskProps = {
  /** `HH:MM` of the read that first differed. */
  at: string;
  lineRef: RefObject<HTMLParagraphElement | null>;
  /** Writes nothing: the fields and the start text both become the text on disk. */
  onReload: () => void;
  onKeyDown: KeyboardEventHandler;
  /** The line leaves while it holds the caret, which a read that ends the difference does. */
  onFocusLost: () => void;
};

/**
 * Plain text rather than a live region of its own: the shell's spoken region
 * carries the announcement, and a region that arrives together with its words
 * is not announced.
 */
export function ChangedOnDisk({ at, lineRef, onReload, onKeyDown, onFocusLost }: ChangedOnDiskProps): ReactNode {
  const wordsId = useId();
  useFocusLost(lineRef, onFocusLost);

  return (
    <p ref={lineRef} onKeyDown={onKeyDown} className="mb-4 flex max-w-2xl flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
      <WarningIcon size={16} aria-hidden="true" className="shrink-0 text-signal" />
      <span id={wordsId}>
        <span className="text-signal">{`Changed on disk at ${at}, since you began.`}</span>
        {" "}
        <span className="text-muted">Saving overwrites that change.</span>
      </span>
      <Button
        type="button"
        aria-describedby={wordsId}
        onClick={onReload}
        className="text-text underline underline-offset-2"
      >
        Discard and reload
      </Button>
    </p>
  );
}

export type TaskEditorProps = {
  /** Ties the Save control of the top bar to this form. */
  formId: string;
  formRef: Ref<HTMLFormElement>;
  draft: Draft;
  onDraftChange: (draft: Draft) => void;
  titleRef: Ref<HTMLInputElement>;
  /** Marks the title input not valid and names the correction under it. */
  titleError?: string;
  /** Marks the body editor not valid and names the correction under it. */
  bodyError?: string;
  /** The meta line, which keeps the place it has in reading, between the two fields. */
  meta: ReactNode;
  onSubmit: () => void;
  onKeyDown: KeyboardEventHandler;
};

/**
 * The two fields of the task page. They are one form, so Enter in the title
 * input saves through the same handler every other path reaches, and the Save
 * control can sit in the top bar.
 */
export function TaskEditor({
  formId,
  formRef,
  draft,
  onDraftChange,
  titleRef,
  titleError,
  bodyError,
  meta,
  onSubmit,
  onKeyDown,
}: TaskEditorProps): ReactNode {
  return (
    <form
      id={formId}
      ref={formRef}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      onKeyDown={onKeyDown}
    >
      <Field.Root name="title" invalid={titleError !== undefined}>
        <Field.Label className="sr-only">Title</Field.Label>
        <Field.Control
          ref={titleRef}
          // Required to a screen reader alone: the native attribute would put
          // the browser's own bubble in place of the page's line.
          aria-required="true"
          value={draft.title}
          onValueChange={(title) => {
            onDraftChange({ ...draft, title });
          }}
          className={TITLE_CLASS}
        />
        {titleError !== undefined && <Field.Error match className={FIELD_ERROR_CLASS}>{titleError}</Field.Error>}
      </Field.Root>
      {meta}
      <MarkdownEditor
        label="Body"
        name="body"
        value={draft.body}
        onValueChange={(body) => {
          onDraftChange({ ...draft, body });
        }}
        error={bodyError}
        className="mt-8 max-w-2xl"
        controlClassName="min-h-[420px]"
        footer={(
          <MarkdownEditorHint className="mt-1.5">
            Markdown
            {" "}
            <span aria-hidden="true">·</span>
            <KeyHint mark="⌘↩" spoken="Command Enter">save</KeyHint>
            {" "}
            <span aria-hidden="true">·</span>
            <KeyHint mark="Esc" spoken="Escape">cancel</KeyHint>
          </MarkdownEditorHint>
        )}
      />
    </form>
  );
}
