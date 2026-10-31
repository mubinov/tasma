import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState, type ComponentProps, type ReactNode, type Ref } from "react";
import { usePendingChatStart } from "../api/mutations";
import { taskChatsQuery, workflowQuery } from "../api/queries";
import { ArrowClockwiseIcon, ChatCircleIcon, CircleNotchIcon, DotsThreeVerticalIcon, PlayIcon } from "../lib/icons";
import { actionStep, openFromBoard, stepAction, stepActionVerb, type StepAction } from "../lib/step-action";
import { useChatStart } from "../lib/use-chat-start";
import { useNoticeStore } from "../store/notices";
import { useUiStore } from "../store/ui";
import { MENU_ITEM_CLASS, MENU_RADIO_ITEM_CLASS, POPUP_CLASS, POSITIONER_CLASS } from "./control-classes";
import { RadioIndicator } from "./radio-indicator";

export type CardMenuItemsProps = {
  /** The tag of the project the task belongs to. */
  tag: string;
  id: string;
  /** As the task file holds it. */
  status: string;
  /** The project's statuses, in order. */
  statuses: readonly string[];
  /** Called with a configured status the task does not already have. */
  onMove: (status: string) => void;
  /** Given only when a visible card of the same column is above the card. */
  onMoveUp?: () => void;
  /** Given only when a visible card of the same column is below the card. */
  onMoveDown?: () => void;
  /** Called before the card opens its task in this tab. */
  onOpen: () => void;
  /** Asks to delete the task. */
  onDelete: (id: string) => void;
  /** Asks to restart the chat of the step, which replaces `chat`. */
  onRestart: (id: string, step: string, chat: number) => void;
  /** As the task file holds them. */
  workflow?: string;
  step?: string;
};

type StepMenuItemProps = Pick<CardMenuItemsProps, "tag" | "id" | "step" | "onOpen" | "onRestart"> & { workflow: string };

/**
 * "Start <step>", or "Open <step>" and "Restart <step>", with a separator
 * under them. It mounts with its menu, reads the chats at each open, and keeps
 * the kind of its first read until the menu closes, so the name of a
 * highlighted item does not change. Disabled until that read lands, so a menu
 * opened by the keyboard highlights the next item.
 */
function StepMenuItem({ tag, id, workflow, step: taskStep, onOpen, onRestart }: StepMenuItemProps): ReactNode {
  const router = useRouter();
  const { client, queryClient } = router.options.context;
  const workflowRead = useQuery(workflowQuery(client, workflow), queryClient);
  const chatsRead = useQuery({ ...taskChatsQuery(client, tag, id), refetchOnMount: "always" }, queryClient);
  const start = useChatStart(tag, id);
  const pendingStart = usePendingChatStart(id);
  const itemRef = useRef<HTMLDivElement>(null);
  const [kept, setKept] = useState<StepAction | null>(null);
  const step = actionStep({ workflow, step: taskStep }, workflowRead.data?.data);
  const readsLanded = !workflowRead.isPending && chatsRead.isFetchedAfterMount;

  if (kept === null && readsLanded && step !== null) {
    // A failed read gives Start: the start route answers the chat that exists.
    setKept(chatsRead.isSuccess ? stepAction(step, chatsRead.data.data) : { kind: "start", step });
  }

  let ready: StepAction | null = null;
  let phase: "starting" | "ready" | "reading";
  let text: string;
  let name: string;

  // A pending start or restart of the task allows no second one.
  if (pendingStart?.restart !== undefined) {
    phase = "starting";
    text = `Restarting ${pendingStart.step}`;
    name = `${text}, ${id}`;
  } else if (pendingStart !== undefined) {
    phase = "starting";
    text = `Start ${pendingStart.step}`;
    name = `${text}, ${id}, starting`;
  } else if (kept !== null) {
    ready = kept;
    phase = "ready";
    text = `${stepActionVerb(kept)} ${kept.step}`;
    name = `${text}, ${id}`;
  } else {
    phase = "reading";
    text = "Reading the chats";
    name = `Reading the chats of ${id}`;
  }

  const lastPhaseRef = useRef(phase);

  // A screen reader does not speak a change of the name of the highlighted item by itself.
  const announceReady = useEffectEvent(() => {
    const last = lastPhaseRef.current;
    lastPhaseRef.current = phase;
    if (phase === "ready" && last !== "ready" && itemRef.current?.hasAttribute("data-highlighted") === true) {
      useNoticeStore.getState().announce(name);
    }
  });

  useEffect(() => {
    announceReady();
  }, [phase]);

  if (!workflowRead.isPending && step === null) {
    return null;
  }

  const restart = ready?.kind === "open" ? ready : null;

  async function press(action: StepAction): Promise<void> {
    onOpen();
    await openFromBoard(router, tag, id, action.kind === "open" ? action.chat : undefined);
    if (action.kind === "start") {
      start(action.step, "card");
    }
  }

  return (
    <>
      <Menu.Item
        ref={itemRef}
        aria-label={name}
        disabled={ready === null}
        onClick={ready === null
          ? undefined
          : () => {
              void press(ready);
            }}
        className={MENU_ITEM_CLASS}
      >
        {ready === null
          ? <CircleNotchIcon size={14} aria-hidden="true" className="shrink-0 animate-spin motion-reduce:animate-none" />
          : ready.kind === "open"
            ? <ChatCircleIcon size={14} aria-hidden="true" className="shrink-0" />
            : <PlayIcon size={14} aria-hidden="true" className="shrink-0" />}
        {text}
      </Menu.Item>
      {/* Hidden, not unmounted: Base UI keeps the highlight on an index, which an item mounted above shifts. */}
      <Menu.Item
        hidden={restart === null}
        aria-label={restart === null ? undefined : `Restart ${restart.step}, ${id}`}
        onClick={restart === null
          ? undefined
          : () => {
              onRestart(id, restart.step, restart.chat);
            }}
        className={MENU_ITEM_CLASS}
      >
        {restart !== null && (
          <>
            <ArrowClockwiseIcon size={14} aria-hidden="true" className="shrink-0" />
            {`Restart ${restart.step}`}
          </>
        )}
      </Menu.Item>
      <Menu.Separator className="my-1.5 h-px bg-line" />
    </>
  );
}

/** The items of both card menus. */
function CardMenuItems({
  tag,
  id,
  status,
  statuses,
  onMove,
  onMoveUp,
  onMoveDown,
  onOpen,
  onDelete,
  onRestart,
  workflow,
  step,
}: CardMenuItemsProps): ReactNode {
  const navigate = useNavigate();
  const requestEdit = useUiStore((state) => state.requestEdit);
  const key = status.toLowerCase();
  const current = statuses.find((candidate) => candidate.toLowerCase() === key) ?? null;

  function openTask(): void {
    onOpen();
    void navigate({ to: "/tasks/$project/$task", params: { project: tag, task: id } });
  }

  return (
    <>
      {workflow !== undefined && (
        <StepMenuItem tag={tag} id={id} workflow={workflow} step={step} onOpen={onOpen} onRestart={onRestart} />
      )}
      <Menu.Item onClick={openTask} className={MENU_ITEM_CLASS}>
        <span className="w-3.5 shrink-0" />
        Open task
      </Menu.Item>
      {/* The request goes through the store, not the address, so a reload opens the page in reading. */}
      <Menu.Item
        onClick={() => {
          requestEdit(tag, id);
          openTask();
        }}
        className={MENU_ITEM_CLASS}
      >
        <span className="w-3.5 shrink-0" />
        Edit
      </Menu.Item>
      <Menu.Separator className="my-1.5 h-px bg-line" />
      <Menu.RadioGroup
        value={current}
        onValueChange={(next: string) => {
          if (next.toLowerCase() !== key) {
            onMove(next);
          }
        }}
      >
        <Menu.GroupLabel className="pt-1 pr-2 pb-0.5 pl-7.5 text-xs text-dim">Move to</Menu.GroupLabel>
        {statuses.map((candidate, index) => (
          // A hand-edited configuration can hold the same status twice.
          // eslint-disable-next-line @eslint-react/no-array-index-key
          <Menu.RadioItem key={index} value={candidate} closeOnClick className={MENU_RADIO_ITEM_CLASS}>
            <RadioIndicator />
            {candidate}
          </Menu.RadioItem>
        ))}
        {onMoveUp !== undefined && (
          <Menu.Item onClick={onMoveUp} className={MENU_ITEM_CLASS}>
            <span className="w-3.5 shrink-0" />
            Move up
          </Menu.Item>
        )}
        {onMoveDown !== undefined && (
          <Menu.Item onClick={onMoveDown} className={MENU_ITEM_CLASS}>
            <span className="w-3.5 shrink-0" />
            Move down
          </Menu.Item>
        )}
      </Menu.RadioGroup>
      <Menu.Separator className="my-1.5 h-px bg-line" />
      {/* The right-click popup has no name, so the item names the task itself. */}
      <Menu.Item
        aria-label={`Delete ${id}`}
        onClick={() => {
          onDelete(id);
        }}
        className={MENU_ITEM_CLASS}
      >
        <span className="w-3.5 shrink-0" />
        Delete
      </Menu.Item>
    </>
  );
}

type CardMenuProps = CardMenuItemsProps & {
  buttonRef?: Ref<HTMLButtonElement>;
  /**
   * The id of the card's title, which describes the menu button.
   * The task id in the button's name tells the menu buttons of a board apart.
   */
  titleId?: string;
  onOpenChange?: (open: boolean) => void;
};

/** The menu button at the right end of the card's top row, shown while the card is hovered or holds focus. */
export function CardMenu({ buttonRef, titleId, onOpenChange, ...menu }: CardMenuProps): ReactNode {
  return (
    <Menu.Root highlightItemOnHover={false} onOpenChange={onOpenChange}>
      <Menu.Trigger
        ref={buttonRef}
        aria-label={`Task menu ${menu.id}`}
        aria-describedby={titleId}
        className="absolute top-1.5 right-2 flex size-6 items-center justify-center rounded-control text-dim opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100 hover:bg-surface-2 hover:text-text data-[popup-open]:bg-surface-2 data-[popup-open]:text-text data-[popup-open]:opacity-100"
      >
        <DotsThreeVerticalIcon size={16} aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} className={POSITIONER_CLASS}>
          <Menu.Popup className={`min-w-52 ${POPUP_CLASS}`}>
            <CardMenuItems {...menu} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

type CardContextMenuProps = ComponentProps<typeof ContextMenu.Trigger> & {
  menu: CardMenuItemsProps;
  onOpenChange?: (open: boolean) => void;
};

function fromOutside(event: { currentTarget: EventTarget; target: EventTarget }): boolean {
  return !(event.currentTarget as Node).contains(event.target as Node);
}

/**
 * The card itself, with the items of the card menu on right click and long press.
 * The menu button's popup renders in a portal, and its React events bubble
 * through the card, so an event from outside the card opens nothing.
 */
export function CardContextMenu({ menu, onOpenChange, children, ...card }: CardContextMenuProps): ReactNode {
  return (
    <ContextMenu.Root highlightItemOnHover={false} onOpenChange={onOpenChange}>
      <ContextMenu.Trigger
        {...card}
        onContextMenu={(event) => {
          if (fromOutside(event)) {
            event.preventBaseUIHandler();
          }
        }}
        onTouchStart={(event) => {
          if (fromOutside(event)) {
            event.preventBaseUIHandler();
          }
        }}
      >
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className={POSITIONER_CLASS}>
          <ContextMenu.Popup className={`min-w-52 ${POPUP_CLASS}`}>
            <CardMenuItems {...menu} />
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
