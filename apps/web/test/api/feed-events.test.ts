import { matchQuery, QueryClient, type QueryKey } from "@tanstack/react-query";
import type { FeedEvent } from "@tasma/protocol";
import { describe, expect, it } from "vitest";
import { FEED_MAPPINGS, filtersOf, type FeedFilter } from "../../src/api/feed-events";
import { appKeys, daemonKeys } from "../../src/api/queries";

const queryClient = new QueryClient();

/** Whether any of the filters matches a query stored under `key`. */
function matches(filters: FeedFilter[], key: QueryKey): boolean {
  queryClient.setQueryData(key, null);
  const query = queryClient.getQueryCache().find({ queryKey: key, exact: true });
  if (query === undefined) {
    throw new Error("the query was not stored");
  }
  return filters.some((filter) => matchQuery(filter, query));
}

function keysMatched(event: FeedEvent, keys: Record<string, QueryKey>): string[] {
  const filters = filtersOf([event], FEED_MAPPINGS);
  return Object.entries(keys)
    .filter(([, key]) => matches(filters, key))
    .map(([name]) => name);
}

const sample = {
  task: daemonKeys.task("SAGA", "SAGA-1"),
  otherTask: daemonKeys.task("SAGA", "SAGA-2"),
  listing: daemonKeys.tasks("SAGA"),
  search: daemonKeys.taskSearch("SAGA", "login"),
  project: daemonKeys.project("SAGA"),
  projects: daemonKeys.projects(),
  otherProject: daemonKeys.project("ACME"),
  otherListing: daemonKeys.tasks("ACME"),
  otherProjectTask: daemonKeys.task("ACME", "ACME-1"),
  health: daemonKeys.health(),
  workflow: daemonKeys.workflow("review"),
  workflowRead: daemonKeys.workflowRead("review"),
  workflowList: daemonKeys.workflowList(),
  otherWorkflow: daemonKeys.workflow("triage"),
  otherWorkflowRead: daemonKeys.workflowRead("triage"),
  update: appKeys.update(),
};

describe("filtersOf", () => {
  it("returns one filter for each distinct key and match mode", () => {
    const event: FeedEvent = { kind: "task", tag: "SAGA", id: "SAGA-1", change: "changed" };

    expect(filtersOf([event, { ...event, change: "deleted" }], FEED_MAPPINGS)).toEqual(
      filtersOf([event], FEED_MAPPINGS),
    );
  });

  it("keeps an exact and a prefix filter of the same key apart", () => {
    const filters = filtersOf(
      [{ kind: "project", tag: "SAGA", change: "changed" }, { kind: "workflow", name: "review", change: "changed" }],
      FEED_MAPPINGS,
    );

    expect(filters).toContainEqual({ queryKey: daemonKeys.projects(), exact: true });
    expect(filters).toContainEqual({ queryKey: daemonKeys.projects() });
  });

  it("gives no filter for an event of a kind the table has no row for", () => {
    const event = { kind: "future", name: "x" } as unknown as FeedEvent;

    expect(filtersOf([event], FEED_MAPPINGS)).toEqual([]);
  });

  it("gives no filter for a kind that is only a name on the prototype of an object", () => {
    const event = { kind: "toString" } as unknown as FeedEvent;

    expect(filtersOf([event], FEED_MAPPINGS)).toEqual([]);
  });
});

describe("FEED_MAPPINGS", () => {
  it("makes a task event refresh its task, its listing and the searches of its project", () => {
    expect(keysMatched({ kind: "task", tag: "SAGA", id: "SAGA-1", change: "changed" }, sample)).toEqual([
      "task",
      "listing",
      "search",
    ]);
  });

  it("makes a deleted task refresh the deleted task too", () => {
    expect(keysMatched({ kind: "task", tag: "SAGA", id: "SAGA-1", change: "deleted" }, sample)).toContain("task");
  });

  it("makes a project event refresh the project list, the project and its tasks", () => {
    expect(keysMatched({ kind: "project", tag: "SAGA", change: "changed" }, sample)).toEqual([
      "task",
      "otherTask",
      "listing",
      "search",
      "project",
      "projects",
    ]);
  });

  it("makes a renamed project refresh the old and the new tag", () => {
    expect(keysMatched({ kind: "project", tag: "SAGA", change: "renamed", to: "ACME" }, sample)).toEqual([
      "task",
      "otherTask",
      "listing",
      "search",
      "project",
      "projects",
      "otherProject",
      "otherListing",
      "otherProjectTask",
    ]);
  });

  it("makes a config event refresh every daemon key", () => {
    const { update, ...daemon } = sample;

    expect(keysMatched({ kind: "config" }, sample)).toEqual(Object.keys(daemon));
    expect(keysMatched({ kind: "config" }, { update })).toEqual([]);
  });

  it("makes a workflow event refresh its own keys, the workflow list and the task reads", () => {
    expect(keysMatched({ kind: "workflow", name: "review", change: "changed" }, sample)).toEqual([
      "task",
      "otherTask",
      "listing",
      "search",
      "project",
      "projects",
      "otherProject",
      "otherListing",
      "otherProjectTask",
      "workflow",
      "workflowRead",
      "workflowList",
    ]);
  });

  it("makes a chat event refresh nothing", () => {
    const event: FeedEvent = { kind: "chat", tag: "SAGA", task: "SAGA-1", chat: 1, step: "build", state: "working" };

    expect(keysMatched(event, sample)).toEqual([]);
  });
});
