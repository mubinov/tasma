import { Field } from "@base-ui/react/field";
import type { ReactNode, Ref } from "react";
import { FIELD_BORDER_CLASS, FIELD_ERROR_CLASS, FIELD_HINT_CLASS, FIELD_KBD_CLASS } from "./control-classes";

/*
 * `field-sizing-content` is how the field grows with its text, which is why it
 * takes `resize-none` where the drawing sets `resize: vertical`: a drag writes
 * an explicit height that stops the growth, and a resize handle is a
 * pointer-only affordance with no keyboard equivalent. The line height is read
 * from the base token rather than written as a literal, so the value stays in
 * the theme.
 */
const CONTROL_CLASS = `w-full rounded-card bg-surface px-3.5 py-3 font-mono text-sm leading-(--text-base--line-height) text-text placeholder:text-dim resize-none field-sizing-content ${FIELD_BORDER_CLASS}`;

export type MarkdownEditorProps = {
  /**
   * The field's name in speech. Always hidden, so the screen supplies the
   * visible label — and this string has to be the text that screen draws, or
   * the two drift apart and speech input can no longer name the control.
   */
  label: string;
  /** The key a `<Form errors>` entry is matched by. */
  name: string;
  value: string;
  onValueChange: (value: string) => void;
  /** On the root: the width of the field and of its footer. */
  className?: string;
  /** On the textarea: its least height. */
  controlClassName?: string;
  /**
   * Rendered after the control. A hint in it reaches `aria-describedby` only
   * through `MarkdownEditorHint`: `FIELD_HINT_CLASS` alone gives the same look
   * and no association.
   */
  footer?: ReactNode;
  placeholder?: string;
  /** Marks the field not valid and supplies the line. There is no separate `invalid` prop. */
  error?: string;
  ref?: Ref<HTMLTextAreaElement>;
};

/**
 * The mono markdown field every editor of the application is built from.
 *
 * A field marked not valid always carries text, because the border cannot tell
 * the state on its own: `signal` beside `graphic` is 1.6:1. The state and its
 * explanation are therefore one prop, so no caller can mark a field with no
 * line to read. Not-valid arrives by two paths and each brings its own line:
 * `error`, and a `<Form errors>` entry keyed by `name`, which Base UI matches
 * itself. No native constraint is exposed, so computed validity cannot fire.
 *
 * `Field.Error` is not a live region. A caller that shows an error while focus
 * is already inside the field must move focus or speak it.
 */
export function MarkdownEditor({
  label,
  name,
  value,
  onValueChange,
  className,
  controlClassName,
  footer,
  placeholder,
  error,
  ref,
}: MarkdownEditorProps): ReactNode {
  return (
    <Field.Root name={name} invalid={error !== undefined} className={className}>
      <Field.Label className="sr-only">{label}</Field.Label>
      <Field.Control
        ref={ref}
        render={<textarea />}
        value={value}
        onValueChange={(next) => {
          onValueChange(next);
        }}
        placeholder={placeholder}
        // The field holds markdown source in every caller.
        spellCheck={false}
        className={`${CONTROL_CLASS} ${controlClassName ?? ""}`}
      />
      {/*
        * `match` is what forces the render on the `error` path: the `invalid`
        * prop derives the field state alone and never writes into the validity
        * data `Field.Error` gates itself on, so a bare part would render
        * nothing there. The other form passes no children at all, because Base
        * UI merges props by assignment and a `children: undefined` would write
        * over its own message from a `<Form errors>` entry.
        */}
      {error === undefined
        ? <Field.Error className={FIELD_ERROR_CLASS} />
        : <Field.Error match className={FIELD_ERROR_CLASS}>{error}</Field.Error>}
      {footer}
    </Field.Root>
  );
}

export type MarkdownEditorHintProps = {
  children: ReactNode;
  /** Appended to the hint class, never substituted for it. */
  className?: string;
  /** For a caller that describes a second field with the same hint, which `Field.Root` cannot reach. */
  id?: string;
};

/** The hint a caller composes its footer from, so the hint is tied to the field wherever it sits. */
export function MarkdownEditorHint({ children, className, id }: MarkdownEditorHintProps): ReactNode {
  return (
    <Field.Description id={id} className={`${FIELD_HINT_CLASS} ${className ?? ""}`}>
      {children}
    </Field.Description>
  );
}

export type KeyHintProps = {
  /** The mark on the key, which a screen reader is not given. */
  mark: string;
  /** The same key in words, for a reader that speaks neither ⌘ nor ↩. */
  spoken: string;
  children: ReactNode;
};

/** One key and what it does, as a part of `MarkdownEditorHint`. */
export function KeyHint({ mark, spoken, children }: KeyHintProps): ReactNode {
  return (
    <span className="inline-flex items-center gap-1">
      <kbd className={FIELD_KBD_CLASS}>
        <span aria-hidden="true">{mark}</span>
        <span className="sr-only">{spoken}</span>
      </kbd>
      {/* The space separates the words in speech; flex drops it from the layout. */}
      {" "}
      {children}
    </span>
  );
}
