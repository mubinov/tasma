import { Combobox } from "@base-ui/react/combobox";
import { Field } from "@base-ui/react/field";
import type { TaskEntry } from "@tasma/protocol";
import { useId, useState, type ReactNode } from "react";
import { labelCorrection, labelFault } from "../lib/label-form";
import {
  carriedLabelItems,
  labelItems,
  labelMatches,
  sameLabel,
  sameLabelItem,
  type LabelItem,
  type PickerRow,
} from "../lib/task-properties";
import { FIELD_ERROR_CLASS, FIELD_HINT_CLASS, PROPERTY_BUTTON_CLASS } from "./control-classes";
import { LabelList, LabelMark } from "./label-list";
import { PICKER_ITEM_CLASS, PickerCheck, PropertyPicker } from "./property-picker";

type LabelPickerProps = {
  /** The id of the row's label, which names the trigger with the trigger's own text. */
  labelId: string;
  /** Every task of the project, which the labels and their counts come from. */
  entries: readonly TaskEntry[];
  /** The labels of the task, with the pending writes laid over them. */
  labels: readonly string[];
  row: PickerRow<readonly string[]>;
};

function labelCount(count: number): string {
  return `${String(count)} ${count === 1 ? "label" : "labels"}`;
}

/** The daemon refuses a whole write that states one label of this kind. */
function isUnsendableLabel(label: string): boolean {
  return labelFault(label) !== undefined;
}

function joinNames(names: readonly string[]): string {
  return names
    .map((name, index) => `${index === 0 ? "" : index === names.length - 1 ? " and " : ", "}"${name}"`)
    .join("");
}

function unsendableNotice(names: readonly string[]): string | undefined {
  if (names.length === 0) {
    return undefined;
  }
  return names.length === 1
    ? `${joinNames(names)} is not a valid label. Changing this list removes it.`
    : `${joinNames(names)} are not valid labels. Changing this list removes them.`;
}

type StatusFacts = {
  correction: string | undefined;
  added: string | null;
  /** The text typed, when the Add row offers it. */
  addName: string | undefined;
  empty: string | undefined;
  matchCount: number;
};

function labelStatus({ correction, added, addName, empty, matchCount }: StatusFacts): string {
  if (correction !== undefined) {
    return correction;
  }
  if (added !== null) {
    return `Added "${added}"`;
  }
  if (addName !== undefined) {
    return `Add "${addName}"`;
  }
  return empty ?? labelCount(matchCount);
}

/**
 * The labels of a task, as a value that opens every label of the project. A
 * check writes the list at once; a name that matches no label is added as
 * typed, and the daemon stores it lower-cased.
 *
 * A label of a form the daemon refuses is offered only when the task carries
 * it: shown checked and not interactive, named by a line, and left out of each
 * list a pick sends.
 */
export function LabelPicker({ labelId, entries, labels, row }: LabelPickerProps): ReactNode {
  const valueId = useId();
  const hintId = useId();
  const errorId = useId();
  // Announced until the next keystroke or until the popup closes.
  const [added, setAdded] = useState<string | null>(null);
  const value: LabelItem[] = labels.map((label) => ({ kind: "label", label }));

  function add(name: string): void {
    row.onPick([...labels.filter((label) => !isUnsendableLabel(label)), name]);
    setAdded(name);
  }

  return (
    <PropertyPicker
      multiple
      labelId={labelId}
      trigger={{
        className: PROPERTY_BUTTON_CLASS,
        labelledBy: `${labelId} ${valueId}`,
        content: (
          <span id={valueId} className="inline-flex min-w-0 flex-wrap items-center">
            {labels.length === 0 ? <span className="text-dim">None</span> : <LabelList labels={labels} phrasing />}
            {/* The wait shows in the label, never in `disabled`. */}
            {row.busy && "…"}
          </span>
        ),
      }}
      placeholder="Filter or add a label"
      items={labelItems(entries).filter((item) => !isUnsendableLabel(item.label))}
      live={{ items: carriedLabelItems(labels), order: (a, b) => a.label.localeCompare(b.label) }}
      itemKey={(item) => item.label.toLowerCase()}
      isItemEqualToValue={sameLabelItem}
      isItemDisabled={(item) => isUnsendableLabel(item.label)}
      value={value}
      onValueChange={(next) => {
        const taken = next.find((item) => item.kind === "add");
        row.onPick(next.map((item) => item.label));
        if (taken !== undefined) {
          setAdded(taken.label);
        }
      }}
      onType={() => {
        setAdded(null);
      }}
      onClose={() => {
        setAdded(null);
      }}
      view={({ items, query, deferredQuery }) => {
        const matches = items.filter((item) => labelMatches(item, deferredQuery));
        const exists = items.some((item) => sameLabel(item.label, query));
        const correction = query === "" || exists ? undefined : labelCorrection(query);
        const addable = query !== "" && !exists && correction === undefined;
        const rows: LabelItem[] = addable ? [...matches, { kind: "add", label: query }] : matches;
        let empty: string | undefined;
        if (rows.length === 0) {
          empty = items.length === 0 ? "No labels in this project" : "No label matches";
        }

        const unsendable = items.flatMap((item) => (isUnsendableLabel(item.label) ? [item.label] : []));

        return {
          rows,
          status: labelStatus({
            correction,
            added,
            addName: addable ? query : undefined,
            empty,
            matchCount: matches.length,
          }),
          empty,
          invalid: correction !== undefined,
          field: (
            <>
              {correction !== undefined && (
                <Field.Error id={errorId} match className={FIELD_ERROR_CLASS}>{correction}</Field.Error>
              )}
              <Field.Description id={hintId} className={`mt-1.5 ${FIELD_HINT_CLASS}`}>
                Type a name that does not exist to add it.
              </Field.Description>
            </>
          ),
          notice: unsendableNotice(unsendable),
          describedBy: correction === undefined ? hintId : `${hintId} ${errorId}`,
          onEnter: addable
            ? () => {
                add(query);
              }
            : undefined,
        };
      }}
    >
      {(item) => item.kind === "add"
        ? (
            <Combobox.Item key="add" value={item} className={PICKER_ITEM_CLASS}>
              <span className="w-3.5 shrink-0" />
              <span className="min-w-0 wrap-anywhere">{`Add "${item.label}"`}</span>
            </Combobox.Item>
          )
        : (
            <Combobox.Item
              key={`label:${item.label.toLowerCase()}`}
              value={item}
              disabled={isUnsendableLabel(item.label)}
              className={PICKER_ITEM_CLASS}
            >
              <PickerCheck />
              {isUnsendableLabel(item.label) && <span className="shrink-0 text-dim">[Not valid]</span>}
              <LabelMark label={item.label} />
              {/* No count until the listing counts the label: a 0 would deny that the task carries it. */}
              {item.count !== undefined && <span className="ml-auto text-xs text-dim">{item.count}</span>}
            </Combobox.Item>
          )}
    </PropertyPicker>
  );
}
