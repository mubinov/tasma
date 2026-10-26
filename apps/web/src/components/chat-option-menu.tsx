import { Menu } from "@base-ui/react/menu";
import { useId, useRef, useState, type ReactNode } from "react";
import type { ChatOption } from "../lib/chat-fold";
import { chatOptionValueName } from "../lib/chat-messages";
import { CaretDownIcon } from "../lib/icons";
import { useFocusLost } from "../lib/use-focus-lost";
import {
  GROUP_CLASS,
  LABEL_CLASS,
  MENU_RADIO_ITEM_CLASS,
  POPUP_CLASS,
  POSITIONER_CLASS,
  TRIGGER_CLASS,
} from "./control-classes";
import { RadioIndicator } from "./radio-indicator";

type ChatOptionMenuProps = {
  option: ChatOption;
  /** The values that are not offered. */
  hidden: readonly string[];
  /** The value of the pick in progress. */
  pending?: string | undefined;
  onPick: (value: string) => void;
  /** Called when the menu leaves the page with focus in it. */
  onFocusLost: () => void;
};

/**
 * The menu of one `select` config option of a chat, with the names and the
 * descriptions that the agent sends. The wait for a pick stands in the
 * trigger's own name, as in `PropertyMenu`.
 */
export function ChatOptionMenu({ option, hidden, pending, onPick, onFocusLost }: ChatOptionMenuProps): ReactNode {
  const labelId = useId();
  const triggerId = useId();
  const itemId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const shown = pending ?? option.current;
  const values = option.values.filter(({ value }) => !hidden.includes(value));

  useFocusLost(triggerRef, onFocusLost, open);

  return (
    <div className={GROUP_CLASS}>
      <span id={labelId} className={LABEL_CLASS}>
        {option.name}
      </span>
      <Menu.Root highlightItemOnHover={false} open={open} onOpenChange={setOpen}>
        <Menu.Trigger
          ref={triggerRef}
          id={triggerId}
          aria-labelledby={`${labelId} ${triggerId}`}
          className={TRIGGER_CLASS}
        >
          {chatOptionValueName(option, shown)}
          {/* The wait shows in the label, never in `disabled`. */}
          {pending !== undefined && "…"}
          <CaretDownIcon size={14} aria-hidden="true" className="shrink-0 text-dim" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="top" align="start" sideOffset={4} className={POSITIONER_CLASS}>
            <Menu.Popup aria-labelledby={labelId} className={`max-w-(--available-width) min-w-52 ${POPUP_CLASS}`}>
              <Menu.RadioGroup
                value={shown}
                onValueChange={(next: string) => {
                  if (next !== shown) {
                    onPick(next);
                  }
                }}
              >
                {values.map(({ value, name, description }, index) => {
                  const nameId = `${itemId}-${String(index)}-name`;
                  const descriptionId = `${itemId}-${String(index)}-description`;

                  return (
                    <Menu.RadioItem
                      // The agent can send the same value twice.
                      // eslint-disable-next-line @eslint-react/no-array-index-key
                      key={index}
                      value={value}
                      label={name}
                      closeOnClick
                      aria-labelledby={nameId}
                      aria-describedby={description === undefined ? undefined : descriptionId}
                      className={MENU_RADIO_ITEM_CLASS}
                    >
                      <RadioIndicator />
                      <span className="flex min-w-0 flex-col">
                        <span id={nameId}>{name}</span>
                        {description !== undefined && (
                          <span id={descriptionId} className="text-xs-plus text-dim">
                            {description}
                          </span>
                        )}
                      </span>
                    </Menu.RadioItem>
                  );
                })}
              </Menu.RadioGroup>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}
