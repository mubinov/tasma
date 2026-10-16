import { Button } from "@base-ui/react/button";
import { Input } from "@base-ui/react/input";
import { useId, type ReactNode } from "react";
import { CaretDownIcon, CaretUpIcon, XIcon } from "../lib/icons";
import type { TaskFind } from "../lib/use-task-find";
import { ICON_BUTTON_CLASS, LABEL_CLASS } from "./control-classes";

// The `graphic` border, which keeps 3:1, shows that there is a match to go to.
const STEP_BUTTON_CLASS
  = "inline-flex min-h-8 w-8 items-center justify-center rounded-control border bg-surface-2 text-dim not-data-disabled:border-graphic not-data-disabled:hover:text-text data-disabled:border-line";

type FindBarProps = { id: string; find: TaskFind };

/** The find row of the task page, the second line of its top bar. */
export function FindBar({ id, find }: FindBarProps): ReactNode {
  const labelId = useId();
  const counterId = useId();
  const { rowRef, fieldRef, text, counter, hasMatches, changeText, step, escape, close } = find;

  return (
    <div
      ref={rowRef}
      id={id}
      role="search"
      aria-labelledby={labelId}
      data-find-row=""
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          escape();
        }
      }}
      className="flex flex-wrap items-center gap-2 border-t border-line px-6 py-2 sm:px-10"
    >
      <span id={labelId} className={LABEL_CLASS}>
        Find
      </span>
      {/* The input draws no ring of its own: the box's border takes the focus colour, and the caret shows focus. */}
      <div className="flex h-8 min-w-32 grow basis-32 items-center sm:grow-0 sm:basis-60 rounded-control border border-graphic bg-bg px-2 text-sm focus-within:border-focus">
        <Input
          ref={fieldRef}
          type="text"
          role="searchbox"
          autoComplete="off"
          spellCheck={false}
          aria-labelledby={labelId}
          aria-describedby={counterId}
          value={text}
          onValueChange={changeText}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              step(event.shiftKey ? -1 : 1);
            }
          }}
          className="h-full min-w-0 flex-1 bg-transparent focus-visible:outline-none"
        />
      </div>
      {/* The field's description, so the count is heard in the field and not a second time on its own. */}
      <span id={counterId} aria-hidden="true" className="text-xs-plus text-dim tabular-nums">
        {counter}
      </span>
      {/* Focusable while disabled, so a poll that takes every match away keeps focus on the button. */}
      <Button
        aria-label="Previous match"
        disabled={!hasMatches}
        focusableWhenDisabled
        onClick={() => {
          step(-1);
        }}
        className={STEP_BUTTON_CLASS}
      >
        <CaretUpIcon size={14} aria-hidden="true" />
      </Button>
      <Button
        aria-label="Next match"
        disabled={!hasMatches}
        focusableWhenDisabled
        onClick={() => {
          step(1);
        }}
        className={STEP_BUTTON_CLASS}
      >
        <CaretDownIcon size={14} aria-hidden="true" />
      </Button>
      <Button aria-label="Close find" onClick={close} className={ICON_BUTTON_CLASS}>
        <XIcon size={14} aria-hidden="true" />
      </Button>
    </div>
  );
}
