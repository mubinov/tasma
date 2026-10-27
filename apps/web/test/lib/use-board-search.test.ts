import type { TaskEntry } from "@tasma/protocol";
import { describe, expect, it } from "vitest";
import { createAppQueryClient } from "../../src/api/client";
import { taskSearchQuery } from "../../src/api/queries";
import { cachedSearchIds, searchIds } from "../../src/lib/use-board-search";
import { entry, taggedEntry } from "../board-fixtures";
import { testContext } from "../helpers";

function read(entries: TaskEntry[]) {
  return { data: { entries, excluded: [] }, diagnostics: [] };
}

describe("searchIds", () => {
  it("joins the ids of every read", () => {
    const ids = searchIds([read([entry(1), entry(2)]), read([taggedEntry("DELTA", 11)])]);

    expect(ids === null ? null : [...ids]).toEqual(["SAGA-1", "SAGA-2", "DELTA-11"]);
  });

  it("gives null for no read, and while one read is missing", () => {
    expect(searchIds([])).toBeNull();
    expect(searchIds([read([entry(1)]), undefined])).toBeNull();
  });
});

describe("cachedSearchIds", () => {
  const { client } = testContext();

  it("joins the cached search results of the tags for the text", () => {
    const queryClient = createAppQueryClient();
    queryClient.setQueryData(taskSearchQuery(client, "SAGA", "parser").queryKey, read([entry(1)]));
    queryClient.setQueryData(taskSearchQuery(client, "DELTA", "parser").queryKey, read([taggedEntry("DELTA", 11)]));
    queryClient.setQueryData(taskSearchQuery(client, "DELTA", "docs").queryKey, read([taggedEntry("DELTA", 12)]));

    const ids = cachedSearchIds(queryClient, client, ["DELTA", "SAGA"], "parser");

    expect(ids === null ? null : [...ids]).toEqual(["DELTA-11", "SAGA-1"]);
  });

  it("gives null for an empty text, and while the cache has no result of one tag", () => {
    const queryClient = createAppQueryClient();
    queryClient.setQueryData(taskSearchQuery(client, "SAGA", "").queryKey, read([entry(1)]));
    queryClient.setQueryData(taskSearchQuery(client, "SAGA", "parser").queryKey, read([entry(1)]));

    expect(cachedSearchIds(queryClient, client, ["SAGA"], "")).toBeNull();
    expect(cachedSearchIds(queryClient, client, ["DELTA", "SAGA"], "parser")).toBeNull();
  });
});
