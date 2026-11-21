import { Menu } from "@base-ui/react/menu";
import { useId, useState, type ReactNode, type Ref } from "react";
import { CaretDownIcon } from "../lib/icons";
import {
  FIELD_HINT_CLASS,
  FIELD_TRIGGER_CLASS,
  MENU_RADIO_ITEM_CLASS,
  POPUP_CLASS,
  POSITIONER_CLASS,
} from "./control-classes";
import { RadioIndicator } from "./radio-indicator";

export type AppListState = "loading" | "failed" | "ready";

const STATE_TEXT = { loading: "Loading…", failed: "Not loaded" } as const;

type AppSelectProps = {
  label: string;
  /** The text of the item that saves `""`. */
  emptyLabel: string;
  hint?: string;
  apps: readonly { id: string; name: string }[] | undefined;
  state: AppListState;
  /** The id of the failure line of the group, while the group shows it. */
  failureId?: string;
  /** The saved bundle id. */
  value: string;
  onChange: (id: string) => void;
  ref?: Ref<HTMLButtonElement>;
};

/**
 * The dropdown of one app setting. A saved id that is not in `apps` shows as
 * the empty item and is not written back, so the app is used again after a new
 * install.
 *
 * While the list is not ready, the trigger refuses to open but stays enabled:
 * Base UI's menu trigger has no `focusableWhenDisabled`, and focus has to stay
 * on it and be able to move to it.
 */
export function AppSelect(props: AppSelectProps): ReactNode {
  const { label, emptyLabel, hint, apps, state, failureId, value, onChange, ref } = props;
  const labelId = useId();
  const triggerId = useId();
  const hintId = useId();
  const [open, setOpen] = useState(false);
  const ready = state === "ready";
  const list = apps ?? [];
  const current = list.find((app) => app.id === value);
  const shown = current?.id ?? "";
  const describedBy = [failureId, hint === undefined ? undefined : hintId].filter(Boolean).join(" ");

  return (
    <div>
      <span id={labelId} className="block text-sm text-dim">
        {label}
      </span>
      <Menu.Root
        highlightItemOnHover={false}
        open={open}
        onOpenChange={(next) => {
          setOpen(next && ready);
        }}
      >
        <Menu.Trigger
          ref={ref}
          id={triggerId}
          aria-labelledby={`${labelId} ${triggerId}`}
          aria-describedby={describedBy === "" ? undefined : describedBy}
          aria-disabled={ready ? undefined : true}
          className={`mt-1.5 ${FIELD_TRIGGER_CLASS} aria-disabled:hover:border-line`}
        >
          <span className={`min-w-0 wrap-anywhere ${ready ? "" : "text-dim"}`}>
            {ready ? (current?.name ?? emptyLabel) : STATE_TEXT[state]}
          </span>
          <CaretDownIcon size={14} aria-hidden="true" className="shrink-0 text-dim" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner align="start" sideOffset={4} className={POSITIONER_CLASS}>
            <Menu.Popup
              aria-labelledby={labelId}
              className={`max-h-(--available-height) w-(--anchor-width) overflow-y-auto ${POPUP_CLASS}`}
            >
              <Menu.RadioGroup
                value={shown}
                onValueChange={(next: string) => {
                  if (next !== shown) {
                    onChange(next);
                  }
                }}
              >
                <Menu.RadioItem value="" closeOnClick className={MENU_RADIO_ITEM_CLASS}>
                  <RadioIndicator />
                  {emptyLabel}
                </Menu.RadioItem>
                {list.length > 0 && <Menu.Separator className="my-1.5 h-px bg-line" />}
                {list.map((app) => (
                  <Menu.RadioItem key={app.id} value={app.id} closeOnClick className={MENU_RADIO_ITEM_CLASS}>
                    <RadioIndicator />
                    <span className="min-w-0 wrap-anywhere">{app.name}</span>
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {hint !== undefined && (
        <p id={hintId} className={`mt-1.5 ${FIELD_HINT_CLASS}`}>
          {hint}
        </p>
      )}
    </div>
  );
}
