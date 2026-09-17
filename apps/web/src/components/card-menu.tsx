import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import { useNavigate } from "@tanstack/react-router";
import type { ComponentProps, ReactNode, Ref } from "react";
import { CheckIcon, DotsThreeVerticalIcon } from "../lib/icons";
import { MENU_ITEM_CLASS, MENU_RADIO_ITEM_CLASS, POPUP_CLASS, POSITIONER_CLASS } from "./control-classes";

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
};

/** The items of both card menus. */
function CardMenuItems({ tag, id, status, statuses, onMove, onMoveUp, onMoveDown }: CardMenuItemsProps): ReactNode {
  const navigate = useNavigate();
  const key = status.toLowerCase();
  const current = statuses.find((candidate) => candidate.toLowerCase() === key) ?? null;

  return (
    <>
      <Menu.Item
        onClick={() => {
          void navigate({ to: "/tasks/$project/$task", params: { project: tag, task: id } });
        }}
        className={MENU_ITEM_CLASS}
      >
        <span className="w-3.5 shrink-0" />
        Open task
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
            <Menu.RadioItemIndicator keepMounted className="flex w-3.5 shrink-0 data-[unchecked]:invisible">
              <CheckIcon size={14} aria-hidden="true" />
            </Menu.RadioItemIndicator>
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
    </>
  );
}

type CardMenuProps = CardMenuItemsProps & {
  buttonRef?: Ref<HTMLButtonElement>;
  /** The id of the card's title, which tells the menu buttons of a board apart. */
  titleId?: string;
};

/** The menu button at the right end of the card's top row, shown while the card is hovered or holds focus. */
export function CardMenu({ buttonRef, titleId, ...menu }: CardMenuProps): ReactNode {
  return (
    <Menu.Root highlightItemOnHover={false}>
      <Menu.Trigger
        ref={buttonRef}
        aria-label="Task menu"
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

type CardContextMenuProps = ComponentProps<typeof ContextMenu.Trigger> & { menu: CardMenuItemsProps };

function fromOutside(event: { currentTarget: EventTarget; target: EventTarget }): boolean {
  return !(event.currentTarget as Node).contains(event.target as Node);
}

/**
 * The card itself, with the items of the card menu on right click and long press.
 * The menu button's popup renders in a portal, and its React events bubble
 * through the card, so an event from outside the card opens nothing.
 */
export function CardContextMenu({ menu, children, ...card }: CardContextMenuProps): ReactNode {
  return (
    <ContextMenu.Root highlightItemOnHover={false}>
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
