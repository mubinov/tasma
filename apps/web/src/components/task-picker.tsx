import { Combobox } from "@base-ui/react/combobox";
import type { TaskEntry } from "@tasma/protocol";
import { Fragment, useId, type ReactNode } from "react";
import { PencilSimpleIcon } from "../lib/icons";
import {
  chosenTaskItem,
  isUnsendableTask,
  NO_TASK,
  sameTaskItem,
  taskItemIds,
  taskItems,
  taskMatches,
  type PickerRow,
  type TaskItem,
} from "../lib/task-properties";
import { PICKER_ITEM_CLASS, PickerCheck, PropertyPicker } from "./property-picker";

type TaskPickerProps = {
  /** The id of the row's label, which names the trigger after "Edit". */
  labelId: string;
  className: string;
  /** Every task of the project, which the picker offers. */
  entries: readonly TaskEntry[];
  /** The task the page shows, which the picker leaves out. */
  id: string;
} & (
  | { multiple: true; value: readonly string[]; row: PickerRow<readonly string[]> }
  | { multiple: false; value: string | undefined; row: PickerRow<string | null> }
);

function taskCount(count: number): string {
  return `${String(count)} ${count === 1 ? "task" : "tasks"}`;
}

function joinIds(ids: readonly string[]): ReactNode {
  return ids.map((id, index) => (
    <Fragment key={id}>
      {index > 0 && (index === ids.length - 1 ? " and " : ", ")}
      <span className="font-mono">{id}</span>
    </Fragment>
  ));
}

/**
 * A pencil that opens the tasks of the project: many of them for a list,
 * one of them or "None" for a single value.
 *
 * The daemon refuses a write that states a blocker id naming no task, or this
 * task's own id, so a stored id of either kind is shown checked and not
 * interactive, a line names it, and each pick leaves it out of the list it
 * sends.
 */
export function TaskPicker(props: TaskPickerProps): ReactNode {
  const { labelId, className, entries, id } = props;
  const editId = useId();
  const chosen = props.multiple ? props.value : props.value === undefined ? [] : [props.value];
  const items = taskItems(entries, id, chosen);

  const selection = props.multiple
    ? {
        multiple: true as const,
        value: props.value.map((value) => chosenTaskItem(entries, id, value)),
        onValueChange: (next: TaskItem[]) => {
          props.row.onPick(taskItemIds(next));
        },
      }
    : {
        multiple: false as const,
        value: props.value === undefined ? NO_TASK : chosenTaskItem(entries, id, props.value),
        onValueChange: (next: TaskItem) => {
          const picked = next.kind === "none" ? null : next.id;
          if (picked !== (props.value ?? null)) {
            props.row.onPick(picked);
          }
        },
      };

  return (
    <PropertyPicker<TaskItem>
      {...selection}
      labelId={labelId}
      trigger={{
        className,
        labelledBy: `${editId} ${labelId}`,
        content: (
          <>
            <PencilSimpleIcon size={14} aria-hidden="true" />
            <span id={editId} className="sr-only">Edit</span>
          </>
        ),
      }}
      placeholder="Filter tasks"
      items={props.multiple ? items : [...items, NO_TASK]}
      itemKey={(item) => (item.kind === "none" ? "none" : `id:${item.id}`)}
      isItemEqualToValue={sameTaskItem}
      isItemDisabled={isUnsendableTask}
      view={({ items: held, deferredQuery }) => {
        const rows = held.filter((item) => taskMatches(item, deferredQuery));
        const count = rows.filter((item) => item.kind !== "none").length;
        let empty: string | undefined;
        if (count === 0) {
          empty = held.some((item) => item.kind !== "none") ? "No task matches" : "No tasks in this project";
        }

        const missing = props.multiple ? held.flatMap((item) => (item.kind === "missing" ? [item.id] : [])) : [];
        const self = props.multiple ? held.flatMap((item) => (item.kind === "self" ? [item.id] : [])) : [];
        const dropped = missing.length + self.length;

        return {
          rows,
          status: empty ?? taskCount(count),
          empty,
          notice: dropped === 0
            ? undefined
            : (
                <>
                  {missing.length > 0 && (
                    <>
                      {joinIds(missing)}
                      {missing.length === 1 ? " names no task. " : " name no task. "}
                    </>
                  )}
                  {self.length > 0 && (
                    <>
                      {joinIds(self)}
                      {" is this task. "}
                    </>
                  )}
                  {dropped === 1 ? "Changing this list removes it." : "Changing this list removes them."}
                </>
              ),
        };
      }}
    >
      {(item, index) => {
        switch (item.kind) {
          case "none":
            return (
              <Fragment key="none">
                {/* A list that holds "None" alone opens on the item, not on a rule. */}
                {index > 0 && <Combobox.Separator className="my-1.5 h-px bg-line" />}
                <Combobox.Item value={item} className={PICKER_ITEM_CLASS}>
                  <PickerCheck />
                  None
                </Combobox.Item>
              </Fragment>
            );
          case "missing":
          case "self":
            return (
              <Combobox.Item key={`id:${item.id}`} value={item} disabled className={PICKER_ITEM_CLASS}>
                <PickerCheck />
                <span className="min-w-0 text-dim wrap-anywhere">
                  {item.kind === "missing" ? "[Not found]" : "[This task]"}
                  {" "}
                  <span className="font-mono text-xs-plus">{item.id}</span>
                </span>
              </Combobox.Item>
            );
          case "task":
            return (
              <Combobox.Item key={`id:${item.id}`} value={item} className={PICKER_ITEM_CLASS}>
                <PickerCheck />
                <span className="min-w-0 flex-1 wrap-anywhere">
                  <span className="block">
                    <span className="font-mono text-xs-plus">{item.id}</span>
                    {" "}
                    <span className="text-muted">{`[${item.status}]`}</span>
                  </span>
                  <span className="block">{item.title}</span>
                </span>
              </Combobox.Item>
            );
        }
      }}
    </PropertyPicker>
  );
}
