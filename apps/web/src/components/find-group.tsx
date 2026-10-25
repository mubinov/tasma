import { Button } from "@base-ui/react/button";
import { Input } from "@base-ui/react/input";
import { useId, type ReactNode } from "react";
import { CaretDownIcon, CaretUpIcon } from "../lib/icons";
import type { TaskFind } from "../lib/use-task-find";
import { LABEL_CLASS } from "./control-classes";
import { FIND_OPEN_FLOOR, FIND_OPEN_WIDTHS } from "./find-open-classes";

// The `graphic` border, which keeps 3:1, shows that there is a match to go to.
const STEP_BUTTON_CLASS
  = `inline-flex size-8 shrink-0 items-center justify-center rounded-control border bg-surface-2 text-dim not-data-disabled:border-graphic not-data-disabled:hover:text-text data-disabled:border-line ${FIND_OPEN_FLOOR.stepButton}`;

/** The find group of the task page, on the line of its top bar before the button that opens and closes it. */
export function FindGroup({ find }: { find: TaskFind }): ReactNode {
  const labelId = useId();
  const counterId = useId();
  const { fieldRef, text, counter, hasMatches, changeText, step, escape } = find;

  return (
    <div
      role="search"
      aria-labelledby={labelId}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          escape();
        }
      }}
      className={`flex min-w-0 items-center gap-2 ${FIND_OPEN_FLOOR.group} ${FIND_OPEN_WIDTHS.group}`}
    >
      <span id={labelId} className={`shrink-0 ${LABEL_CLASS}`}>
        Find
      </span>
      {/* The input draws no ring of its own: the box's border takes the focus colour, and the caret shows focus. */}
      <div
        className={`flex h-8 w-60 min-w-0 items-center gap-2 overflow-hidden rounded-control border border-graphic bg-bg px-2 text-sm focus-within:border-focus ${FIND_OPEN_FLOOR.field} ${FIND_OPEN_WIDTHS.field}`}
      >
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
        {/* The field's description, so the count is heard in the field and not a second time on its own. */}
        <span id={counterId} aria-hidden="true" className="shrink-0 text-xs-plus text-dim tabular-nums">
          {counter}
        </span>
      </div>
      {/* Focusable while disabled, so a read that takes every match away keeps focus on the button. */}
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
    </div>
  );
}
