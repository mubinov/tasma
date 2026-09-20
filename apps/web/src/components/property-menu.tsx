import { Menu } from "@base-ui/react/menu";
import { useId, useRef, useState, type ReactNode } from "react";
import { groupValue, type PropertyRow } from "../lib/task-properties";
import { useFocusLost } from "../lib/use-focus-lost";
import {
  MENU_RADIO_ITEM_CLASS,
  POPUP_CLASS,
  POSITIONER_CLASS,
  PROPERTY_BUTTON_CLASS,
} from "./control-classes";
import { RadioIndicator } from "./radio-indicator";

export type PropertyMenuProps = {
  /** The id of the row's dt, which names the trigger with the trigger's own text. */
  labelId: string;
  /** The value as the task file holds it. */
  value: string | undefined;
  /** Every field of one row in one object, so a field cannot be paired with another row's. */
  row: PropertyRow;
  /**
   * Adds a separator and a "None" radio item of the same group, valued with
   * the empty string, which calls back with null.
   */
  clearable: boolean;
  /** The trigger's content: text, or StepMark for Step. */
  trigger: ReactNode;
  /** Called when the control leaves the page while it, or its open menu, holds focus. */
  onFocusLost: () => void;
};

/**
 * A value that opens a menu of the values it can take. It holds no query and no
 * mutation, so an unsaved draft drives it as readily as a stored task.
 *
 * An accessible name does not follow `aria-labelledby` through a second hop, so
 * the popup points at the row's label of its own rather than at the trigger.
 *
 * The wait for a write stands in the trigger's own name, which the menu reads
 * out when it closes and hands focus back — "Status, Done…". `aria-busy` is not
 * used for it: it asks a reader to hold that very name back until the change
 * settles, which is the opposite of announcing the wait.
 */
export function PropertyMenu(props: PropertyMenuProps): ReactNode {
  const { labelId, value, row, clearable, trigger, onFocusLost } = props;
  const { choices, match, busy, onPick } = row;
  const triggerId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const current = groupValue(value, choices, match);

  useFocusLost(triggerRef, onFocusLost, open);

  return (
    <Menu.Root highlightItemOnHover={false} open={open} onOpenChange={setOpen}>
      <Menu.Trigger
        ref={triggerRef}
        id={triggerId}
        aria-labelledby={`${labelId} ${triggerId}`}
        className={PROPERTY_BUTTON_CLASS}
      >
        {trigger}
        {/* The wait shows in the label, never in `disabled`. */}
        {busy && "…"}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} className={POSITIONER_CLASS}>
          <Menu.Popup aria-labelledby={labelId} className={`min-w-52 ${POPUP_CLASS}`}>
            <Menu.RadioGroup
              value={current}
              onValueChange={(next: string) => {
                if (next !== current) {
                  onPick(next === "" ? null : next);
                }
              }}
            >
              {choices.map((choice, index) => (
                // A hand-edited configuration can hold the same value twice.
                // eslint-disable-next-line @eslint-react/no-array-index-key
                <Menu.RadioItem key={index} value={choice.value} closeOnClick className={MENU_RADIO_ITEM_CLASS}>
                  <RadioIndicator />
                  {choice.label}
                </Menu.RadioItem>
              ))}
              {clearable && (
                <>
                  {/* A menu that holds "None" alone opens on the item, not on a rule. */}
                  {choices.length > 0 && <Menu.Separator className="my-1.5 h-px bg-line" />}
                  <Menu.RadioItem value="" closeOnClick className={MENU_RADIO_ITEM_CLASS}>
                    <RadioIndicator />
                    None
                  </Menu.RadioItem>
                </>
              )}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
