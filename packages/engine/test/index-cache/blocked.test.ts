import { describe, expect, it } from "vitest";
import { type BlockedResult, type IndexEntry, resolveBlocked } from "@tasma/engine";

const FINAL = ["Done"];

/** One entry of a listing, with only the fields the rule reads stated. */
function entry(id: string, status: string, blocked_by?: string[]): IndexEntry {
  return {
    id,
    path: `/tasks/${id}.md`,
    frontmatter: {
      id,
      title: id,
      status,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
      next_comment_id: 1,
      ...(blocked_by === undefined ? {} : { blocked_by }),
    },
  };
}

/** The ids of the flagged entries, sorted, which is what an assertion compares. */
function flaggedIds(result: BlockedResult): string[] {
  return result.entries.filter((listed) => listed.blocked).map((listed) => listed.id).sort();
}

function blockedIds(entries: IndexEntry[], finalStatuses: readonly string[] = FINAL): string[] {
  return flaggedIds(resolveBlocked(entries, finalStatuses));
}

describe("resolveBlocked", () => {
  it("blocks no task that states no blocker", () => {
    expect(blockedIds([entry("SAGA-1", "To Do"), entry("SAGA-2", "Done")])).toEqual([]);
  });

  it("blocks no task whose blocker list is empty", () => {
    expect(blockedIds([entry("SAGA-1", "To Do", [])])).toEqual([]);
  });

  it("blocks no task whose every blocker reached a final status", () => {
    const entries = [entry("SAGA-1", "To Do", ["SAGA-2", "SAGA-3"]), entry("SAGA-2", "Done"), entry("SAGA-3", "Done")];

    expect(blockedIds(entries)).toEqual([]);
  });

  it("blocks a task while one of its blockers is open", () => {
    const entries = [
      entry("SAGA-1", "To Do", ["SAGA-2", "SAGA-3"]),
      entry("SAGA-2", "Done"),
      entry("SAGA-3", "In Progress"),
    ];

    expect(blockedIds(entries)).toEqual(["SAGA-1"]);
  });

  it("reads a status that matches a final status in another case as final", () => {
    const entries = [entry("SAGA-1", "To Do", ["SAGA-2"]), entry("SAGA-2", "done")];

    expect(blockedIds(entries)).toEqual([]);
  });

  it("honours every status of the final list", () => {
    const entries = [
      entry("SAGA-1", "To Do", ["SAGA-2"]),
      entry("SAGA-2", "Cancelled"),
      entry("SAGA-3", "To Do", ["SAGA-4"]),
      entry("SAGA-4", "In Progress"),
    ];

    expect(blockedIds(entries, ["Done", "Cancelled"])).toEqual(["SAGA-3"]);
  });

  it("blocks a task whose blocker names no entry, and reports the id once", () => {
    const entries = [entry("SAGA-1", "To Do", ["SAGA-9"]), entry("SAGA-2", "Done")];

    const result = resolveBlocked(entries, FINAL);

    expect(flaggedIds(result)).toEqual(["SAGA-1"]);
    expect(result.unresolved).toEqual([
      {
        code: "blocked-by-unresolved",
        message: 'this task states the blocker "SAGA-9", which the listing holds no task for',
        path: "/tasks/SAGA-1.md",
      },
    ]);
  });

  it("strips from a reported blocker the characters that would drive a terminal", () => {
    const entries = [entry("SAGA-1", "To Do", ["\u001b[31mred\u2028"])];

    expect(resolveBlocked(entries, FINAL).unresolved[0]?.message).toBe(
      'this task states the blocker " [31mred ", which the listing holds no task for',
    );
  });

  it("cuts a reported blocker to the length the index chose", () => {
    const entries = [entry("SAGA-1", "To Do", ["x".repeat(80)])];

    expect(resolveBlocked(entries, FINAL).unresolved[0]?.message).toBe(
      `this task states the blocker "${"x".repeat(60)}...", which the listing holds no task for`,
    );
  });

  it("reports one diagnostic per unresolved blocker of one task", () => {
    const entries = [entry("SAGA-1", "To Do", ["SAGA-8", "SAGA-9"])];

    expect(resolveBlocked(entries, FINAL).unresolved).toHaveLength(2);
  });

  it("reports an unresolved blocker once however often the file states it", () => {
    // A reader accepts any list of strings, so a hand-edited file reaches the
    // index with the repeat the store would have dropped on a write.
    const entries = [entry("SAGA-1", "To Do", ["SAGA-9", "SAGA-9", "SAGA-9"])];

    const result = resolveBlocked(entries, FINAL);

    expect(flaggedIds(result)).toEqual(["SAGA-1"]);
    expect(result.unresolved).toHaveLength(1);
  });

  it("reports the same unresolved blocker once for each task that states it", () => {
    const entries = [entry("SAGA-1", "To Do", ["SAGA-9"]), entry("SAGA-2", "To Do", ["SAGA-9"])];

    expect(resolveBlocked(entries, FINAL).unresolved.map((diagnostic) => diagnostic.path)).toEqual([
      "/tasks/SAGA-1.md",
      "/tasks/SAGA-2.md",
    ]);
  });

  it("blocks a task whose blocker the index excluded, which reaches it as an id naming no entry", () => {
    // The blocker's file is in the project and unreadable, so the listing holds
    // no entry for it.
    const entries = [entry("SAGA-1", "To Do", ["SAGA-2"])];

    const result = resolveBlocked(entries, FINAL);

    expect(flaggedIds(result)).toEqual(["SAGA-1"]);
    expect(result.unresolved).toHaveLength(1);
  });

  it("blocks both tasks of a cycle and terminates", () => {
    const entries = [entry("SAGA-1", "To Do", ["SAGA-2"]), entry("SAGA-2", "To Do", ["SAGA-1"])];

    const result = resolveBlocked(entries, FINAL);

    expect(flaggedIds(result)).toEqual(["SAGA-1", "SAGA-2"]);
    expect(result.unresolved).toEqual([]);
  });

  it("follows one level alone, so a blocker's own blocker is not walked", () => {
    // SAGA-2 blocks SAGA-1 and is itself final, so SAGA-1 is not blocked. Only a
    // walk past it would reach the open SAGA-3 and block SAGA-1 as well.
    const entries = [entry("SAGA-1", "To Do", ["SAGA-2"]), entry("SAGA-2", "Done", ["SAGA-3"]), entry("SAGA-3", "To Do")];

    expect(blockedIds(entries)).toEqual(["SAGA-2"]);
  });

  it("answers for no task over an empty listing", () => {
    const result = resolveBlocked([], FINAL);

    expect(flaggedIds(result)).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it("returns every entry in the input order, each unblocked entry with blocked false", () => {
    const entries = [entry("SAGA-3", "To Do", ["SAGA-1"]), entry("SAGA-1", "In Progress"), entry("SAGA-2", "Done")];

    const listed = resolveBlocked(entries, FINAL).entries;

    expect(listed.map(({ id, blocked }) => ({ id, blocked }))).toEqual([
      { id: "SAGA-3", blocked: true },
      { id: "SAGA-1", blocked: false },
      { id: "SAGA-2", blocked: false },
    ]);
  });

  it("keeps the id, the path and the frontmatter object of each entry", () => {
    const entries = [entry("SAGA-1", "To Do", ["SAGA-2"]), entry("SAGA-2", "Done")];

    const listed = resolveBlocked(entries, FINAL).entries;

    expect(listed).toHaveLength(entries.length);
    listed.forEach((flagged, n) => {
      expect(flagged.id).toBe(entries[n]!.id);
      expect(flagged.path).toBe(entries[n]!.path);
      expect(flagged.frontmatter).toBe(entries[n]!.frontmatter);
    });
  });
});
