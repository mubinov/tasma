import { useMutation, type QueryClient } from "@tanstack/react-query";
import type { Client, Config, Frontmatter, TaskEntry, TaskInput, Workflow } from "@tasma/protocol";
import { taskWriteOptions, usePendingTaskWrites } from "../api/mutations";
import { applyPending, buildColumns, type TaskWrite } from "./board";
import { placeWrites } from "./order";
import {
  applyPendingFrontmatter,
  priorityChoices,
  statusChoices,
  stepChoices,
  type PickerRow,
  type PropertyRow,
} from "./task-properties";
import { pageFailureLine } from "./write-failure";

export type TaskPropertiesOptions = {
  queryClient: QueryClient;
  client: Client;
  /** The project the task belongs to. */
  tag: string;
  id: string;
  /** The frontmatter of the last read that landed. */
  frontmatter: Frontmatter;
  config: Config;
  /** Every task of the project, which a status change reads its target column from. */
  entries: readonly TaskEntry[];
  /** `null` for a workflow that does not read, `undefined` while the read is in flight. */
  workflow: Workflow | null | undefined;
};

export type TaskProperties = {
  /** The frontmatter with the pending writes of this task laid over it. */
  frontmatter: Frontmatter;
  status: PropertyRow;
  priority: PropertyRow;
  /** `null` while the page knows no step to offer and the task holds none. */
  step: PropertyRow | null;
  /** Every task of the project, which the pickers offer. */
  entries: readonly TaskEntry[];
  labels: PickerRow<readonly string[]>;
  blockedBy: PickerRow<readonly string[]>;
  parent: PickerRow<string | null>;
};

/**
 * The editable values of the task sidebar: what each row offers, whether a
 * write of it is in flight, and what a pick sends. Each pick is its own write.
 */
export function useTaskProperties(options: TaskPropertiesOptions): TaskProperties {
  const { queryClient, client, tag, id, frontmatter, config, entries, workflow } = options;
  const { mutate: write } = useMutation(taskWriteOptions(queryClient, client, tag));
  const pending = usePendingTaskWrites(tag);
  const live = applyPendingFrontmatter(frontmatter, pending.writes);

  function busy(key: string): boolean {
    return pending.writes.some((sent) => sent.id === id && key in sent.change);
  }

  /** One notice title covers every property, and the row names itself in the muted line. */
  function sendWrites(writes: readonly TaskWrite[], property: string): void {
    write({ id, writes, failure: { title: `${id} was not changed`, line: (error) => pageFailureLine(error, property) } });
  }

  function send(change: TaskInput, property: string): void {
    sendWrites([{ id, change }], property);
  }

  /** An empty list is sent as `null`, which removes the key rather than leaving an empty list in the file. */
  function sendList(key: "labels" | "blocked_by", next: readonly string[], property: string): void {
    send({ [key]: next.length === 0 ? null : [...next] }, property);
  }

  /** The status write is the card menu's "Move to": the task lands at the top of its new column. */
  function pickStatus(value: string | null): void {
    if (value === null) {
      return;
    }

    const overlaid = applyPending(entries, pending.writes);
    // The menu offers only configured statuses, and each of them has a column.
    const column = buildColumns(config, overlaid, [])[config.statuses.indexOf(value)]!.matching;
    // The page's own read, never the listing: the unchanged-values guard of
    // placeWrites answers against the value the menu fired on, so a listing
    // that lags behind the file cannot drop the write.
    const moved: TaskEntry = { id, path: "", frontmatter: live, blocked: false };

    sendWrites(placeWrites(column.filter((entry) => entry.id !== id), moved, 0, value), "Status");
  }

  const steps = stepChoices(workflow);

  return {
    frontmatter: live,
    status: {
      choices: statusChoices(config),
      match: "without case",
      busy: busy("status"),
      onPick: pickStatus,
    },
    priority: {
      choices: priorityChoices(config),
      match: "without case",
      busy: busy("priority"),
      onPick: (value) => {
        send({ priority: value }, "Priority");
      },
    },
    step: steps.length === 0 && live.step === undefined
      ? null
      : {
          choices: steps,
          // A step differing in case is a step the workflow does not declare,
          // and the menu has to leave it unchecked for a pick to repair the row.
          match: "exact",
          busy: busy("step"),
          onPick: (value) => {
            send({ step: value }, "Step");
          },
        },
    entries,
    labels: {
      busy: busy("labels"),
      onPick: (next) => {
        sendList("labels", next, "Labels");
      },
    },
    blockedBy: {
      busy: busy("blocked_by"),
      onPick: (next) => {
        sendList("blocked_by", next, "Blocked by");
      },
    },
    parent: {
      busy: busy("parent"),
      onPick: (value) => {
        send({ parent: value }, "Parent");
      },
    },
  };
}
