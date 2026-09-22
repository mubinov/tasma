import { Combobox } from "@base-ui/react/combobox";
import { Field } from "@base-ui/react/field";
import { useDeferredValue, useId, useRef, useState, type ReactNode } from "react";
import { CheckIcon, MagnifyingGlassIcon } from "../lib/icons";
import { FIELD_BORDER_CLASS, POPUP_CLASS, POSITIONER_CLASS } from "./control-classes";

// The input keeps DOM focus, so the ring marks the highlighted item; it is
// inset because the scrolling list clips outside it.
export const PICKER_ITEM_CLASS
  = "flex min-h-8 items-center gap-2 rounded-control px-2 py-1 text-sm text-text hover:bg-surface-2 data-[highlighted]:bg-surface-2 data-[highlighted]:outline-2 data-[highlighted]:-outline-offset-2 data-[highlighted]:outline-focus";

/**
 * The check of an item. It keeps its width while unchecked, so the items stand
 * in one column, and it stands on the item's first line.
 */
export function PickerCheck(): ReactNode {
  return (
    <Combobox.ItemIndicator
      keepMounted
      className={({ selected }) => `flex h-5 w-3.5 shrink-0 items-center self-start ${selected ? "" : "invisible"}`}
    >
      <CheckIcon size={14} aria-hidden="true" />
    </Combobox.ItemIndicator>
  );
}

/** What a caller derives its view from, on each render of an open picker. */
export type PickerQuery<Item> = {
  items: readonly Item[];
  /** The text as typed, for what must not lag behind a keystroke. */
  query: string;
  /** The text to filter the list by, which can lag behind the keystrokes on a long list. */
  deferredQuery: string;
};

export type PickerView<Item> = {
  rows: readonly Item[];
  /** Announced politely whenever it changes. */
  status: string;
  /** Shown above the list when it holds nothing to pick. */
  empty?: string;
  invalid?: boolean;
  /** Rendered inside the filter field, under its search row. */
  field?: ReactNode;
  /** A line above the list that names what the next pick leaves out. It describes the filter field. */
  notice?: ReactNode;
  /** The ids of the caller's own parts that describe the filter field. */
  describedBy?: string;
  /** Called on Enter while no item is highlighted, in place of Base UI's own Enter. The query clears after it. */
  onEnter?: () => void;
};

type Selection<Item>
  = | { multiple: true; value: readonly Item[]; onValueChange: (next: Item[]) => void }
    | { multiple: false; value: Item; onValueChange: (next: Item) => void };

export type PropertyPickerProps<Item> = Selection<Item> & {
  /** The id of the row's label, which names the popup, the filter field and the list. */
  labelId: string;
  trigger: {
    className: string;
    /** The ids that name the trigger. A trigger is a combobox, so none of them can be the trigger itself. */
    labelledBy: string;
    content: ReactNode;
  };
  placeholder: string;
  /** Held from the moment the popup opens until it closes. */
  items: readonly Item[];
  /**
   * Joined to the items as they arrive while the popup is open, and never taken
   * out of them. The items take `order` once a live item joins them.
   */
  live?: { items: readonly Item[]; order: (a: Item, b: Item) => number };
  itemKey: (item: Item) => string;
  isItemEqualToValue: (item: Item, value: Item) => boolean;
  /**
   * Matches the items the caller renders `disabled`. Such an item keeps the
   * check it had when the popup opened, and a list the picker sends never holds
   * it. The items as drawn decide, not the value the caller passes.
   */
  isItemDisabled: (item: Item) => boolean;
  view: (query: PickerQuery<Item>) => PickerView<Item>;
  onClose?: () => void;
  /** Called on each keystroke in the filter field, and not when a pick clears the field. */
  onType?: () => void;
  /** Renders one `Combobox.Item`, given its place in the rows. */
  children: (item: Item, index: number) => ReactNode;
};

type Held<Item> = { items: readonly Item[]; locked: readonly Item[] };

// Base UI also sets the value from typeahead on a closed trigger and from
// autofill, neither of which the reader sees as a pick.
function onPick<Next>(send: (next: Next) => void): (next: Next, details: Combobox.Root.ChangeEventDetails) => void {
  return (next, { reason }) => {
    if (reason === "item-press") {
      send(next);
    }
  };
}

function join<Item>(
  held: readonly Item[],
  live: PropertyPickerProps<Item>["live"],
  itemKey: (item: Item) => string,
): readonly Item[] {
  if (live === undefined) {
    return held;
  }

  const keys = new Set(held.map(itemKey));
  const fresh = live.items.filter((item) => !keys.has(itemKey(item)));

  return fresh.length === 0 ? held : [...held, ...fresh].sort(live.order);
}

/**
 * A value that opens a filterable list of the values it can take. It holds no
 * query of the daemon and no mutation.
 *
 * The listing refetches while the popup is open, so the items are held from
 * the moment it opens: rows are never taken out, inserted or recounted under
 * the reader. A live item joins them, which is how a value just added to the
 * task appears in the list. The list only grows while the popup is open.
 *
 * Base UI does not wire a `Field` to an input inside a positioner, so the
 * filter input carries its own `aria-invalid` and `aria-describedby`.
 */
export function PropertyPicker<Item>(props: PropertyPickerProps<Item>): ReactNode {
  const { labelId, trigger, placeholder, items, live, itemKey, isItemEqualToValue } = props;
  const { isItemDisabled, view, onClose, onType, children } = props;
  const [open, setOpen] = useState(false);
  const [held, setHeld] = useState<Held<Item> | null>(null);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const highlightedRef = useRef(false);
  const noticeId = useId();
  const current = join(held?.items ?? items, live, itemKey);

  if (held !== null && current !== held.items) {
    setHeld({ ...held, items: current });
  }

  const { rows, status, empty, invalid = false, field, notice, describedBy, onEnter } = view({
    items: current,
    query,
    deferredQuery,
  });
  let describedIds = describedBy;
  if (notice !== undefined) {
    describedIds = describedBy === undefined ? noticeId : `${describedBy} ${noticeId}`;
  }

  function changeOpen(next: boolean): void {
    setOpen(next);

    if (!next) {
      setHeld(null);
      onClose?.();
      return;
    }

    const locked = props.multiple
      ? current.filter((item) => isItemDisabled(item) && props.value.some((value) => isItemEqualToValue(item, value)))
      : [];
    setHeld({ items: current, locked });
  }

  const root = {
    items: current,
    filteredItems: rows,
    open,
    onOpenChange: changeOpen,
    inputValue: query,
    onInputValueChange: (next: string, { reason }: Combobox.Root.ChangeEventDetails) => {
      setQuery(next);
      if (reason === "input-change") {
        onType?.();
      }
    },
    onItemHighlighted: (item: Item | undefined) => {
      highlightedRef.current = item !== undefined;
    },
    isItemEqualToValue,
    itemToStringLabel: itemKey,
    // Hover does not highlight an item, so the ring is never a hover mark.
    highlightItemOnHover: false,
  };

  const inner = (
    <>
      <Combobox.Trigger aria-labelledby={trigger.labelledBy} className={trigger.className}>
        {trigger.content}
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner align="end" sideOffset={4} className={POSITIONER_CLASS}>
          <Combobox.Popup aria-labelledby={labelId} className={`w-62 ${POPUP_CLASS}`}>
            <Field.Root invalid={invalid} className="mb-1.5">
              <Field.Item className={`flex h-8 items-center gap-2 rounded-control bg-bg px-2 text-sm ${FIELD_BORDER_CLASS}`}>
                <MagnifyingGlassIcon size={14} aria-hidden="true" className="shrink-0 text-dim" />
                <Combobox.Input
                  aria-labelledby={labelId}
                  aria-invalid={invalid || undefined}
                  aria-describedby={describedIds}
                  placeholder={placeholder}
                  onKeyDown={(event) => {
                    if (
                      event.key !== "Enter"
                      || event.nativeEvent.isComposing
                      || highlightedRef.current
                      || onEnter === undefined
                    ) {
                      return;
                    }

                    event.preventBaseUIHandler();
                    event.preventDefault();
                    onEnter();
                    setQuery("");
                  }}
                  className="min-w-0 flex-1 bg-transparent placeholder:text-dim focus-visible:outline-none"
                />
              </Field.Item>
              {field}
            </Field.Root>
            {notice !== undefined && (
              <p id={noticeId} className="mb-1.5 px-2 text-xs-plus text-muted wrap-anywhere">{notice}</p>
            )}
            {/* Mounted with the popup, so a change of its text is announced. */}
            <Combobox.Status className="sr-only">{status}</Combobox.Status>
            {empty !== undefined && <div className="px-2 py-1.5 text-sm text-dim">{empty}</div>}
            {/* Mounted and empty: a list with no rows lets Escape reach the popup's parent unless the part is
                mounted. `Combobox.Status` already speaks the empty text, so the part is no live region. */}
            <Combobox.Empty role="presentation" aria-live="off" />
            <Combobox.List aria-labelledby={labelId} className="max-h-72 overflow-y-auto">
              {(item: Item, index: number) => children(item, index)}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </>
  );

  if (props.multiple) {
    const { value, onValueChange } = props;
    const locked = (held?.locked ?? []).filter((item) => !value.some((chosen) => isItemEqualToValue(item, chosen)));
    const disabled = new Set(current.filter(isItemDisabled).map(itemKey));

    return (
      <Combobox.Root
        multiple
        {...root}
        value={[...value, ...locked]}
        onValueChange={onPick((next: Item[]) => {
          onValueChange(next.filter((item) => !disabled.has(itemKey(item))));
        })}
      >
        {inner}
      </Combobox.Root>
    );
  }

  return (
    <Combobox.Root
      {...root}
      value={props.value}
      onValueChange={onPick((next: Item | null) => {
        if (next !== null) {
          props.onValueChange(next);
        }
      })}
    >
      {inner}
    </Combobox.Root>
  );
}
