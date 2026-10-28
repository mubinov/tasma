import { Combobox } from "@base-ui/react/combobox";
import { useNavigate } from "@tanstack/react-router";
import type { TaskEntry } from "@tasma/protocol";
import { useId, type ReactNode } from "react";
import { joinList, labelChoices, type BoardSubject } from "../lib/board";
import { CaretDownIcon, CheckIcon } from "../lib/icons";
import { GROUP_CLASS, LABEL_CLASS, TRIGGER_CLASS } from "./control-classes";
import { FilterPopup, PICKER_ITEM_CLASS } from "./property-picker";

type LabelFilterProps = {
  entries: readonly TaskEntry[];
  selected: readonly string[];
  subject: BoardSubject;
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
export function LabelFilter({ entries, selected, subject }: LabelFilterProps): ReactNode {
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
        <FilterPopup
          labelId={labelId}
          placeholder="Filter labels"
          empty={items.length === 0 ? `No labels in ${subject}` : "No label matches"}
        >
          {(label) => (
            <Combobox.Item key={label} value={label} className={PICKER_ITEM_CLASS}>
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
        </FilterPopup>
      </Combobox.Root>
    </div>
  );
}
