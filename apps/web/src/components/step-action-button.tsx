import { Button } from "@base-ui/react/button";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, type ReactNode } from "react";
import { usePendingChatStart, usePendingTaskWrites } from "../api/mutations";
import { ChatCircleIcon, CircleNotchIcon, PlayIcon } from "../lib/icons";
import { STEP_ACTION_MARK, stepActionVerb, type StepAction } from "../lib/step-action";
import { useChatStart } from "../lib/use-chat-start";
import { useFocusLost } from "../lib/use-focus-lost";
import { useNoticeStore } from "../store/notices";
import { BUTTON_FILLED_CLASS } from "./control-classes";
import { Tooltip } from "./tooltip";

type StepActionButtonProps = {
  tag: string;
  id: string;
  /** While a start of the task is pending, the start that was pressed. */
  action: StepAction;
  /** Called when the button leaves the page while it holds focus. */
  onFocusLost: () => void;
};

/** The step text is hidden by the width of the bar, or cut by its own. */
function stepTextClipped(element: HTMLElement): boolean {
  // jsdom has no `checkVisibility`.
  const visible = typeof element.checkVisibility !== "function" || element.checkVisibility();

  return !visible || element.scrollWidth > element.clientWidth;
}

/** "Start <step>" or "Open <step>" in the task view top bar. */
export function StepActionButton({ tag, id, action, onFocusLost }: StepActionButtonProps): ReactNode {
  const navigate = useNavigate();
  const start = useChatStart(tag, id);
  const starting = usePendingChatStart(id) !== undefined;
  // A step change must reach the daemon before a start.
  const writing = usePendingTaskWrites([tag]).writes.some((write) => write.id === id);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const stepRef = useRef<HTMLSpanElement>(null);
  const { kind, step } = action;
  const verb = stepActionVerb(action);
  const name = `${verb} ${step}`;
  const waiting = starting || writing;
  const lastRef = useRef({ kind, step, starting });

  useFocusLost(buttonRef, onFocusLost);

  // A screen reader does not speak a change of the name of the focused control by itself.
  const announceChange = useEffectEvent(() => {
    const last = lastRef.current;
    lastRef.current = { kind, step, starting };
    const changed = last.kind !== kind || last.step !== step;

    if (changed && !starting && !last.starting && document.activeElement === buttonRef.current) {
      useNoticeStore.getState().announce(name);
    }
  });

  useEffect(() => {
    announceChange();
  }, [kind, step, starting]);

  function press(): void {
    if (action.kind === "open") {
      void navigate({
        to: "/tasks/$project/$task",
        params: { project: tag, task: id },
        search: { chat: String(action.chat) },
      });
      return;
    }
    start(step, "task");
  }

  return (
    // The tooltip shows the name only while a part of it is not on screen.
    <Tooltip content={name} canOpen={() => stepTextClipped(stepRef.current!)}>
      <Button
        ref={buttonRef}
        type="button"
        {...STEP_ACTION_MARK}
        aria-label={starting ? `${name}, starting` : name}
        disabled={waiting}
        focusableWhenDisabled
        onClick={press}
        className={`shrink-0 ${BUTTON_FILLED_CLASS} @max-step-verb:w-8 @max-step-verb:justify-center @max-step-verb:px-0`}
      >
        {waiting
          ? <CircleNotchIcon size={14} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
          : kind === "start"
            ? <PlayIcon size={14} aria-hidden="true" />
            : <ChatCircleIcon size={14} aria-hidden="true" />}
        <span className="@max-step-verb:hidden">{verb}</span>
        <span ref={stepRef} className="max-w-48 truncate font-mono @max-step-text:hidden">{step}</span>
      </Button>
    </Tooltip>
  );
}
