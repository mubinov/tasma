import { Button } from "@base-ui/react/button";
import { Menu } from "@base-ui/react/menu";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { usePendingChatStart, usePendingTaskWrites } from "../api/mutations";
import { focusChatHeading, focusInView } from "../lib/focus-in-view";
import { ArrowClockwiseIcon, ChatCircleIcon, CircleNotchIcon, PlayIcon } from "../lib/icons";
import { STEP_ACTION_MARK, stepActionVerb, type StepAction } from "../lib/step-action";
import { useChatStart } from "../lib/use-chat-start";
import { focusDropped, useFocusLost } from "../lib/use-focus-lost";
import { useNoticeStore } from "../store/notices";
import { BUTTON_FILLED_CLASS, MENU_ITEM_CLASS } from "./control-classes";
import * as SplitButton from "./split-button";
import { Tooltip } from "./tooltip";

/** A narrow bar hides the step text, then the verb, and leaves a 32 px icon. */
const NARROW_CLASS = "@max-step-verb:w-8 @max-step-verb:justify-center @max-step-verb:px-0";

const VERB_CLASS = "@max-step-verb:hidden";

const STEP_CLASS = "max-w-48 truncate font-mono @max-step-text:hidden";

const SPINNER = <CircleNotchIcon size={14} aria-hidden="true" className="shrink-0 animate-spin motion-reduce:animate-none" />;

type StepActionButtonProps = {
  tag: string;
  id: string;
  /** While a start or a restart of the task is pending, the action that was pressed. */
  action: StepAction;
  /** The panel shows the chat that the action opens. */
  chatShown: boolean;
  /** The menu part of "Open <step>", where focus returns from the restart dialog. */
  menuRef: RefObject<HTMLButtonElement | null>;
  /** "Restart <step>" was chosen in the menu. */
  onRestart: (step: string, chat: number) => void;
  /** Called when the control leaves the page while it holds focus. */
  onFocusLost: () => void;
};

/** The step text is hidden by the width of the bar, or cut by its own. */
function stepTextClipped(element: HTMLElement): boolean {
  // jsdom has no `checkVisibility`.
  const visible = typeof element.checkVisibility !== "function" || element.checkVisibility();

  return !visible || element.scrollWidth > element.clientWidth;
}

type StartControlProps = {
  name: string;
  verb: string;
  step: string;
  busy: boolean;
  starting: boolean;
  actionRef: RefObject<HTMLButtonElement | null>;
  stepRef: RefObject<HTMLSpanElement | null>;
  onPress: () => void;
  onLost: () => void;
};

function StartControl(
  { name, verb, step, busy, starting, actionRef, stepRef, onPress, onLost }: StartControlProps,
): ReactNode {
  useFocusLost(actionRef, onLost);

  return (
    // The tooltip shows the name only while a part of it is not on screen.
    <Tooltip content={name} canOpen={() => stepTextClipped(stepRef.current!)}>
      <Button
        ref={actionRef}
        type="button"
        {...STEP_ACTION_MARK}
        aria-label={starting ? `${name}, starting` : name}
        disabled={busy}
        focusableWhenDisabled
        onClick={onPress}
        className={`shrink-0 ${BUTTON_FILLED_CLASS} ${NARROW_CLASS}`}
      >
        {busy ? SPINNER : <PlayIcon size={14} aria-hidden="true" />}
        <span className={VERB_CLASS}>{verb}</span>
        <span ref={stepRef} className={STEP_CLASS}>{step}</span>
      </Button>
    </Tooltip>
  );
}

type OpenControlProps = {
  name: string;
  /** The name of the action part, with the wait. */
  actionName: string;
  menuName: string;
  verb: string;
  step: string;
  busy: boolean;
  /** The action part only. */
  disabled: boolean;
  actionRef: RefObject<HTMLButtonElement | null>;
  stepRef: RefObject<HTMLSpanElement | null>;
  menuRef: RefObject<HTMLButtonElement | null>;
  onPress: () => void;
  onRestart: () => void;
  onActionFocus: (focused: boolean) => void;
  onLost: () => void;
};

function OpenControl({
  name,
  actionName,
  menuName,
  verb,
  step,
  busy,
  disabled,
  actionRef,
  stepRef,
  menuRef,
  onPress,
  onRestart,
  onActionFocus,
  onLost,
}: OpenControlProps): ReactNode {
  useFocusLost(actionRef, onLost);

  return (
    <SplitButton.Root variant="outline" {...STEP_ACTION_MARK}>
      {/* A wrapper is the trigger, so the tooltip opens on hover also while the action part is disabled. */}
      <Tooltip content={name} canOpen={() => stepTextClipped(stepRef.current!)}>
        <span className="inline-flex">
          <SplitButton.Action
            ref={actionRef}
            icon={<ChatCircleIcon size={14} aria-hidden="true" className="shrink-0" />}
            busy={busy}
            disabled={disabled}
            aria-label={actionName}
            onClick={onPress}
            onFocus={() => {
              onActionFocus(true);
            }}
            onBlur={() => {
              onActionFocus(false);
            }}
            className={NARROW_CLASS}
          >
            <span className={VERB_CLASS}>{verb}</span>
            <span ref={stepRef} className={STEP_CLASS}>{step}</span>
          </SplitButton.Action>
        </span>
      </Tooltip>
      <SplitButton.Menu ref={menuRef} label={menuName} busy={busy} onFocusLost={onLost}>
        <Menu.Item onClick={onRestart} className={MENU_ITEM_CLASS}>
          <ArrowClockwiseIcon size={14} aria-hidden="true" className="shrink-0" />
          {`Restart ${step}`}
        </Menu.Item>
      </SplitButton.Menu>
    </SplitButton.Root>
  );
}

/**
 * The step action in the task view top bar: a filled "Start <step>", or an
 * outline "Open <step>" with "Restart <step>" in its menu. It moves focus
 * itself when one control replaces the other, or when the action part becomes
 * disabled, while it holds focus.
 */
export function StepActionButton(
  { tag, id, action, chatShown, menuRef, onRestart, onFocusLost }: StepActionButtonProps,
): ReactNode {
  const navigate = useNavigate();
  const start = useChatStart(tag, id);
  const pending = usePendingChatStart(id);
  const startPending = pending !== undefined;
  const starting = startPending && pending.restart === undefined;
  const restarting = pending?.restart !== undefined;
  // A step change must reach the daemon before a start.
  const writing = usePendingTaskWrites([tag]).writes.some((write) => write.id === id);
  const actionRef = useRef<HTMLButtonElement>(null);
  const stepRef = useRef<HTMLSpanElement>(null);
  const swappedRef = useRef(false);
  const actionFocusedRef = useRef(false);
  const { kind, step } = action;
  const verb = restarting ? "Restarting" : stepActionVerb(action);
  const name = `${verb} ${step}`;
  const busy = startPending || writing;
  const actionDisabled = kind === "open" && chatShown && !busy;
  const actionName = writing && !restarting ? `${name}, waiting` : name;
  const menuName = `More ${step} actions${restarting ? ", restarting" : writing ? ", waiting" : ""}`;
  const lastRef = useRef({ kind, step, startPending });

  function lost(): void {
    swappedRef.current = true;
    onFocusLost();
  }

  // The new control takes the focus that the old one held. Speaking its name is the reader's part.
  useLayoutEffect(() => {
    actionFocusedRef.current = false;
    if (!swappedRef.current) {
      return;
    }
    swappedRef.current = false;
    if (!focusDropped()) {
      return;
    }
    const part = actionRef.current!;
    if (part.disabled) {
      focusChatHeading();
    } else {
      focusInView(part);
    }
  }, [kind]);

  // An engine can fire `blur` when `disabled` is set, so the ref and the active element are both read.
  useLayoutEffect(() => {
    if (actionDisabled && (actionFocusedRef.current || document.activeElement === actionRef.current)) {
      actionFocusedRef.current = false;
      focusChatHeading();
    }
  }, [actionDisabled]);

  // A screen reader does not speak a change of the name of the focused control by itself.
  const announceChange = useEffectEvent(() => {
    const last = lastRef.current;
    lastRef.current = { kind, step, startPending };
    const part = actionRef.current!;
    if (
      last.kind === kind && last.step !== step && !startPending && !last.startPending
      && document.activeElement === part
    ) {
      useNoticeStore.getState().announce(part.getAttribute("aria-label")!);
    }
  });

  useEffect(() => {
    announceChange();
  }, [kind, step, startPending]);

  if (kind === "start") {
    return (
      <StartControl
        name={name}
        verb={verb}
        step={step}
        busy={busy}
        starting={starting}
        actionRef={actionRef}
        stepRef={stepRef}
        onPress={() => {
          start(step, "task");
        }}
        onLost={lost}
      />
    );
  }

  const { chat } = action;

  return (
    <OpenControl
      name={name}
      actionName={actionName}
      menuName={menuName}
      verb={verb}
      step={step}
      busy={busy}
      disabled={actionDisabled}
      actionRef={actionRef}
      stepRef={stepRef}
      menuRef={menuRef}
      onPress={() => {
        void navigate({ to: "/tasks/$project/$task", params: { project: tag, task: id }, search: { chat: String(chat) } });
      }}
      onRestart={() => {
        onRestart(step, chat);
      }}
      onActionFocus={(focused) => {
        actionFocusedRef.current = focused;
      }}
      onLost={lost}
    />
  );
}
