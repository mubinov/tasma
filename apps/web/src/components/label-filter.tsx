import { Combobox } from "@base-ui/react/combobox";
import { useNavigate } from "@tanstack/react-router";
import type { TaskEntry } from "@tasma/protocol";
import { useId, type ReactNode } from "react";
import { joinList, labelChoices } from "../lib/board";
import { CaretDownIcon, CheckIcon, MagnifyingGlassIcon } from "../lib/icons";
import { GROUP_CLASS, LABEL_CLASS, POPUP_CLASS, POSITIONER_CLASS, TRIGGER_CLASS } from "./control-classes";

type LabelFilterProps = {
  entries: readonly TaskEntry[];
  selected: readonly string[];
};

function sameLabel(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function containsText(label: string, query: string): boolean {
  return label.toLowerCase().includes(query.toLowerCase());
}

/**
 * The items and the value are label strings alike: Base UI compares an item with
 * a value, and appends the item itself to the value on a check.
 */
export function LabelFilter({ entries, selected }: LabelFilterProps): ReactNode {
  const navigate = useNavigate();
  const labelId = useId();
  const valueId = useId();
  const choices = labelChoices(entries);
  const counts = new Map(choices.map((choice) => [choice.label.toLowerCase(), choice.count]));
  const items = [
    ...choices.map((choice) => choice.label),
    ...selected.filter((label) => !choices.some((choice) => sameLabel(choice.label, label))),
  ];

  return (
    <div className={GROUP_CLASS}>
      <span id={labelId} className={LABEL_CLASS}>
        Labels
      </span>
      {/* Hover does not highlight an item, so the ring is never a hover mark. */}
      <Combobox.Root
        multiple
        highlightItemOnHover={false}
        items={items}
        value={[...selected]}
        isItemEqualToValue={sameLabel}
        filter={containsText}
        onValueChange={(next: string[]) => {
          void navigate({ to: "/tasks", search: (previous) => ({ ...previous, labels: joinList(next) }) });
        }}
      >
        {/* Named by the value, not by itself: the trigger is a combobox, and the
            name of a combobox in a label reference is its value, which is empty. */}
        <Combobox.Trigger aria-labelledby={`${labelId} ${valueId}`} className={TRIGGER_CLASS}>
          <span id={valueId} className="max-w-64 truncate">
            {selected.length === 0 ? "Any" : selected.join(", ")}
          </span>
          <CaretDownIcon size={14} aria-hidden="true" className="shrink-0 text-dim" />
        </Combobox.Trigger>
        <Combobox.Portal>
          <Combobox.Positioner align="end" sideOffset={4} className={POSITIONER_CLASS}>
            {/* The popup, the input and the list are named by the "Labels" text,
                which stays in view beside the trigger while the popup is open. */}
            <Combobox.Popup aria-labelledby={labelId} className={`w-62 ${POPUP_CLASS}`}>
              <div className="mb-1.5 flex h-8 items-center gap-2 rounded-control border border-line bg-bg px-2 text-sm">
                <MagnifyingGlassIcon size={14} aria-hidden="true" className="text-dim" />
                <Combobox.Input
                  aria-labelledby={labelId}
                  placeholder="Filter labels"
                  className="min-w-0 flex-1 bg-transparent placeholder:text-dim focus-visible:outline-none"
                />
              </div>
              <Combobox.Empty className="px-2 py-1.5 text-sm text-dim empty:p-0">
                {items.length === 0 ? "No labels in this project" : "No label matches"}
              </Combobox.Empty>
              <Combobox.List aria-labelledby={labelId} className="max-h-72 overflow-y-auto">
                {(label: string) => (
                  // The input keeps DOM focus, so the ring marks the highlighted
                  // item; it is inset because the scrolling list clips outside it.
                  <Combobox.Item
                    key={label}
                    value={label}
                    className="flex min-h-8 items-center gap-2 rounded-control px-2 py-1 text-sm text-text hover:bg-surface-2 data-[highlighted]:bg-surface-2 data-[highlighted]:outline-3 data-[highlighted]:-outline-offset-3 data-[highlighted]:outline-graphic"
                  >
                    <Combobox.ItemIndicator
                      keepMounted
                      className={({ selected: checked }) => `flex w-3.5 shrink-0 ${checked ? "" : "invisible"}`}
                    >
                      <CheckIcon size={14} aria-hidden="true" />
                    </Combobox.ItemIndicator>
                    <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-graphic" />
                    <span className="min-w-0 wrap-anywhere">{label}</span>
                    <span className="ml-auto text-xs text-dim">{counts.get(label.toLowerCase()) ?? 0}</span>
                  </Combobox.Item>
                )}
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
    </div>
  );
}
