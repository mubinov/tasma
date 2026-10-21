import { hashKey, type QueryKey } from "@tanstack/react-query";
import type { FeedEvent } from "@tasma/protocol";
import { daemonKeys } from "./queries";

/** A key of the queries an event makes old, matched as a prefix unless `exact`. */
export type FeedFilter = { queryKey: QueryKey; exact?: boolean };

type Mapper<K extends FeedEvent["kind"]> = (event: Extract<FeedEvent, { kind: K }>) => FeedFilter[];

export type FeedMappings = { [K in FeedEvent["kind"]]: Mapper<K> };

export const FEED_MAPPINGS: FeedMappings = {
  // A delete that changes the references in other tasks sends a `task` event
  // for each of them, so the exact keys are enough.
  task: ({ tag, id }) => [
    { queryKey: daemonKeys.task(tag, id), exact: true },
    { queryKey: daemonKeys.tasks(tag), exact: true },
    { queryKey: daemonKeys.taskSearches(tag) },
  ],
  // The prefix covers the tasks: their reads check the statuses of the project.
  project: (event) => [
    { queryKey: daemonKeys.projects(), exact: true },
    { queryKey: daemonKeys.project(event.tag) },
    ...(event.change === "renamed" ? [{ queryKey: daemonKeys.project(event.to) }] : []),
  ],
  // The chat panel reads the state from the log, and the `seq` of the record
  // when it opens and after each reset of the log.
  chat: () => [],
  // The main config gives the statuses of a project that has none, and its
  // `workflows_path` moves every workflow.
  config: () => [{ queryKey: daemonKeys.all }],
  // Each task read reports `workflow-missing` and `step-stale`, and a project
  // read checks the workflows it declares.
  workflow: ({ name }) => [
    { queryKey: daemonKeys.workflow(name), exact: true },
    { queryKey: daemonKeys.workflowRead(name), exact: true },
    { queryKey: daemonKeys.workflowList(), exact: true },
    { queryKey: daemonKeys.projects() },
  ],
};

/**
 * The filters of all events, each distinct key and match mode once. An event
 * of a kind with no row is skipped: a daemon newer than this bundle can send it.
 */
export function filtersOf(events: readonly FeedEvent[], mappings: FeedMappings): FeedFilter[] {
  const filters = new Map<string, FeedFilter>();

  for (const event of events) {
    if (!Object.hasOwn(mappings, event.kind)) {
      continue;
    }

    const mapper = mappings[event.kind] as (event: FeedEvent) => FeedFilter[];
    for (const filter of mapper(event)) {
      const filterKey = `${filter.exact === true ? "exact" : "prefix"} ${hashKey(filter.queryKey)}`;
      if (!filters.has(filterKey)) {
        filters.set(filterKey, filter);
      }
    }
  }

  return [...filters.values()];
}
