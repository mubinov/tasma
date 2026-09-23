import { Button } from "@base-ui/react/button";
import { Field } from "@base-ui/react/field";
import {
  useId,
  useLayoutEffect,
  useRef,
  type KeyboardEventHandler,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import type { FinalFocus } from "../lib/final-focus";
import { WarningIcon } from "../lib/icons";
import type { Draft } from "../lib/text-draft";
import { savingWords, subjectWords } from "../lib/unsaved-words";
import { useCommentEditing, type CommentEditingOptions, type CommentSubject } from "../lib/use-comment-editing";
import type { DiskChange } from "../lib/use-disk-change";
import { useFocusLost } from "../lib/use-focus-lost";
import { BUTTON_FILLED_CLASS, BUTTON_QUIET_CLASS, FIELD_BORDER_CLASS, FIELD_ERROR_CLASS } from "./control-classes";
import { ConfirmDialog } from "./confirm-dialog";
import { KeyHint, MarkdownEditor, MarkdownEditorHint } from "./markdown-editor";
import { ChangedOnDisk } from "./changed-on-disk";

/** The title input stands in for the `h3` of a card, so it carries that heading's type. */
const TITLE_CLASS
  = `w-full min-w-0 rounded-control bg-surface px-2 py-1 font-chrome text-base font-medium text-text placeholder:text-dim ${FIELD_BORDER_CLASS}`;

/**
 * What each control of the editor is called. Every one names its comment, since
 * several editors stand open at once, and each opens with the word the screen
 * draws so that speech input can name it.
 */
function editorLabels(subject: CommentSubject) {
  // The submit control's name while the write runs, which opens with the wait it draws.
  const waitingName = savingWords(subject);

  if (subject.kind === "new") {
    return {
      // The screen draws the placeholder "Title", so the name opens with it.
      title: "Title of the new comment",
      body: "New comment body",
      cancel: "Cancel the new comment",
      discard: "Discard the new comment",
      submit: "Add comment",
      submitText: "Add comment",
      waiting: "Adding…",
      waitingName,
      verb: "add",
      titlePlaceholder: "Title",
      bodyPlaceholder: "Write in markdown",
    };
  }

  const comment = `comment #${String(subject.id)}`;

  return {
    title: `Comment #${String(subject.id)} title`,
    body: `Comment #${String(subject.id)} body`,
    cancel: `Cancel editing ${comment}`,
    discard: `Discard ${comment}`,
    submit: `Save ${comment}`,
    submitText: "Save",
    waiting: "Saving…",
    waitingName,
    verb: "save",
    titlePlaceholder: undefined,
    bodyPlaceholder: undefined,
  };
}

type SubmitControlProps = {
  buttonRef: RefObject<HTMLButtonElement | null>;
  label: string;
  text: string;
  /** The control leaves because the comment did; the caret has to follow it while it is attached. */
  onFocusLost: () => void;
};

/**
 * Its own component so that its unmount is observable: a comment removed on disk
 * takes the control away, and the caret must leave it before it is detached.
 */
function SubmitControl({ buttonRef, label, text, onFocusLost }: SubmitControlProps): ReactNode {
  useFocusLost(buttonRef, onFocusLost);

  return (
    // A wait shows in the label, never in `disabled`.
    <Button ref={buttonRef} type="submit" aria-label={label} className={BUTTON_FILLED_CLASS}>
      {text}
    </Button>
  );
}

type CommentEditorProps = {
  subject: CommentSubject;
  /**
   * What names the card while its title is an input: the comment's title on
   * disk, or "New comment", the add form having no title on disk yet.
   */
  heading: string;
  /** The id, the author and the date of a card in editing. The add form has none of the three to show. */
  meta?: ReactNode;
  draft: Draft;
  onDraftChange: (draft: Draft) => void;
  /** Its own write is in flight. */
  saving: boolean;
  /** Marks the title input not valid and names the correction under it. */
  titleError?: string;
  /** Marks the body editor not valid and names the correction under it. */
  bodyError?: string;
  diskChange: DiskChange;
  /** The comment left the file while this editor was open, so Save is replaced by Discard. */
  removed: boolean;
  formRef: Ref<HTMLFormElement>;
  titleRef: Ref<HTMLInputElement>;
  cancelRef: Ref<HTMLButtonElement>;
  saveRef: RefObject<HTMLButtonElement | null>;
  diskLineRef: RefObject<HTMLParagraphElement | null>;
  removedLineRef: Ref<HTMLParagraphElement>;
  onSubmit: () => void;
  onKeyDown: KeyboardEventHandler;
  onCancel: () => void;
  /** Writes nothing: the fields and the start text both become the text on disk. */
  onReload: () => void;
  onDiskLineFocusLost: () => void;
  onSaveFocusLost: () => void;
  /** This editor's own discard dialog, which Cancel opens. */
  discardAsked: boolean;
  discardFocusRef: RefObject<FinalFocus>;
  onKeepEditing: () => void;
  onDiscard: () => void;
};

/**
 * The card in editing and the add form, which differ by their words alone.
 *
 * It renders no `Collapsible`: a comment the file marks collapsed, and a comment
 * whose body is empty on disk, would both put the body field, the hint and the
 * controls inside a closed panel with no control left to open it.
 */
export function CommentEditor({
  subject,
  heading,
  meta,
  draft,
  onDraftChange,
  saving,
  titleError,
  bodyError,
  diskChange,
  removed,
  formRef,
  titleRef,
  cancelRef,
  saveRef,
  diskLineRef,
  removedLineRef,
  onSubmit,
  onKeyDown,
  onCancel,
  onReload,
  onDiskLineFocusLost,
  onSaveFocusLost,
  discardAsked,
  discardFocusRef,
  onKeepEditing,
  onDiscard,
}: CommentEditorProps): ReactNode {
  const headingId = useId();
  const hintId = useId();
  const removedId = useId();
  const articleRef = useRef<HTMLElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const labels = editorLabels(subject);

  // The editor's own controls sit under the sticky header, and the page's scroll
  // padding clears the top bar alone. Written unconditionally, unlike the
  // reading card's, which returns early for a comment with no body.
  useLayoutEffect(() => {
    const article = articleRef.current;
    const header = headerRef.current;
    if (article === null || header === null || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      article.style.setProperty("--comment-header-height", `${String(header.offsetHeight)}px`);
    });
    observer.observe(header);

    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <article
      ref={articleRef}
      data-comment-id={subject.kind === "comment" ? subject.id : undefined}
      aria-labelledby={headingId}
      className="mt-3 rounded-card border border-line bg-surface"
    >
      {/* The top of the comment for the contents outline: unchanged while the card is edited. */}
      {subject.kind === "comment" && <span data-outline-sentinel="" className="block" />}
      {/* Clipped rather than hidden, so the card keeps its name while its title is an input. */}
      <h3 id={headingId} className="sr-only">{heading}</h3>
      <form
        ref={formRef}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
        onKeyDown={onKeyDown}
      >
        {diskChange.showing && (
          <ChangedOnDisk
            subject={subject}
            at={diskChange.at}
            lineRef={diskLineRef}
            onReload={onReload}
            onFocusLost={onDiskLineFocusLost}
            className="px-4 pt-3"
          />
        )}
        {/* A sticky header needs every box around it without overflow clipping, the card included. */}
        <div
          ref={headerRef}
          className="sticky top-top-bar z-(--layer-comment-header) rounded-t-card border-b border-line bg-surface px-4 pt-3 pb-2"
        >
          <Field.Root name="title" invalid={titleError !== undefined}>
            <Field.Label className="sr-only">{labels.title}</Field.Label>
            <Field.Control
              ref={titleRef}
              data-comment-title=""
              // Required to a screen reader alone: the native attribute would
              // put the browser's own bubble in place of the page's line.
              aria-required="true"
              // The keys work in both fields, so the hint describes this one too.
              // Base UI unions a caller's value with the field's own message ids,
              // so the blank-title line is kept beside it.
              aria-describedby={hintId}
              placeholder={labels.titlePlaceholder}
              value={draft.title}
              onValueChange={(title) => {
                onDraftChange({ ...draft, title });
              }}
              className={TITLE_CLASS}
            />
            {titleError !== undefined && (
              <Field.Error match className={FIELD_ERROR_CLASS}>{titleError}</Field.Error>
            )}
          </Field.Root>
          {meta}
        </div>
        <div className="px-4 pt-2.5 pb-3.5 [&_*]:scroll-mt-(--comment-header-height)">
          {removed && (
            <p
              ref={removedLineRef}
              id={removedId}
              tabIndex={-1}
              className="mb-3 flex max-w-2xl flex-wrap items-center gap-x-1.5 gap-y-1 text-sm"
            >
              <WarningIcon size={16} aria-hidden="true" className="shrink-0 text-signal" />
              <span>
                <span className="text-signal">This comment was removed on disk.</span>
                {" "}
                <span className="text-muted">It can no longer be saved.</span>
              </span>
            </p>
          )}
          <MarkdownEditor
            label={labels.body}
            name="body"
            value={draft.body}
            onValueChange={(body) => {
              onDraftChange({ ...draft, body });
            }}
            error={bodyError}
            placeholder={labels.bodyPlaceholder}
            controlClassName="min-h-[160px]"
            footer={(
              <MarkdownEditorHint id={hintId} className="mt-1.5">
                Markdown
                {" "}
                <span aria-hidden="true">·</span>
                <KeyHint mark="⌘↩" spoken="Command Enter">{labels.verb}</KeyHint>
                {" "}
                <span aria-hidden="true">·</span>
                <KeyHint mark="Esc" spoken="Escape">cancel</KeyHint>
              </MarkdownEditorHint>
            )}
          />
          <div className="mt-3 flex justify-end gap-2">
            {/* Not offered while a write runs, so the text cannot be dropped on its way to disk. */}
            {!saving && (
              <Button
                ref={cancelRef}
                type="button"
                aria-label={labels.cancel}
                onClick={onCancel}
                className={BUTTON_QUIET_CLASS}
              >
                Cancel
              </Button>
            )}
            {/* Save is removed rather than left to be refused: the daemon would
                answer comment-not-found, and a control whose only outcome is a
                failure notice is worse than no control. */}
            {removed
              ? (
                  <Button
                    type="button"
                    aria-label={labels.discard}
                    aria-describedby={removedId}
                    onClick={onCancel}
                    className={BUTTON_FILLED_CLASS}
                  >
                    Discard
                  </Button>
                )
              : (
                  <SubmitControl
                    buttonRef={saveRef}
                    label={saving ? labels.waitingName : labels.submit}
                    text={saving ? labels.waiting : labels.submitText}
                    onFocusLost={onSaveFocusLost}
                  />
                )}
          </div>
        </div>
      </form>
      <ConfirmDialog
        open={discardAsked}
        title="Discard your changes?"
        description={`${subjectWords(subject)} is not saved. There is no undo.`}
        cancelLabel="Keep editing"
        confirmLabel="Discard"
        onCancel={onKeepEditing}
        onConfirm={onDiscard}
        finalFocus={discardFocusRef}
        status={saving ? labels.waiting : undefined}
      />
    </article>
  );
}

export type EditingCommentProps = {
  options: CommentEditingOptions;
  /** See `CommentEditorProps.heading`. */
  heading: string;
  /** See `CommentEditorProps.meta`. */
  meta?: ReactNode;
};

/**
 * One editor, the card in editing or the add form. Its own component so that
 * closing the editor unmounts it: the draft and the registry entry both go with
 * it, and Edit opens again on the text on disk.
 */
export function EditingComment({ options, heading, meta }: EditingCommentProps): ReactNode {
  const editing = useCommentEditing(options);

  return (
    <CommentEditor
      subject={options.subject}
      heading={heading}
      meta={meta}
      draft={editing.draft}
      onDraftChange={editing.changeDraft}
      saving={editing.saving}
      titleError={editing.titleError}
      bodyError={editing.bodyError}
      diskChange={editing.diskChange}
      removed={editing.removed}
      formRef={editing.formRef}
      titleRef={editing.titleRef}
      cancelRef={editing.cancelRef}
      saveRef={editing.saveRef}
      diskLineRef={editing.diskLineRef}
      removedLineRef={editing.removedLineRef}
      onSubmit={editing.save}
      onKeyDown={editing.onKeyDown}
      onCancel={editing.cancel}
      onReload={editing.reload}
      onDiskLineFocusLost={editing.diskLineFocusLost}
      onSaveFocusLost={editing.saveFocusLost}
      discardAsked={editing.discardAsked}
      discardFocusRef={editing.discardFocusRef}
      onKeepEditing={editing.keepEditing}
      onDiscard={editing.discard}
    />
  );
}
