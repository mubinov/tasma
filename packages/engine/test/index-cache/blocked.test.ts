import { describe, expect, it } from "vitest";
import { type IndexEntry, resolveBlocked } from "@tasma/engine";

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

/** The blocked ids, sorted, which is what an assertion compares. */
function blockedIds(entries: IndexEntry[], finalStatuses: readonly string[] = FINAL): string[] {
  return [...resolveBlocked(entries, finalStatuses).blocked].sort();
}

describe("resolveBlocked", () => {
  it("blocks no task that states no blocker", () => {
    expect(blockedIds([entry("TASM-1", "To Do"), entry("TASM-2", "Done")])).toEqual([]);
  });

  it("blocks no task whose blocker list is empty", () => {
    expect(blockedIds([entry("TASM-1", "To Do", [])])).toEqual([]);
  });

  it("blocks no task whose every blocker reached a final status", () => {
    const entries = [entry("TASM-1", "To Do", ["TASM-2", "TASM-3"]), entry("TASM-2", "Done"), entry("TASM-3", "Done")];

    expect(blockedIds(entries)).toEqual([]);
  });

  it("blocks a task while one of its blockers is open", () => {
    const entries = [
      entry("TASM-1", "To Do", ["TASM-2", "TASM-3"]),
      entry("TASM-2", "Done"),
      entry("TASM-3", "In Progress"),
    ];

    expect(blockedIds(entries)).toEqual(["TASM-1"]);
  });

  it("reads a status that matches a final status in another case as final", () => {
    const entries = [entry("TASM-1", "To Do", ["TASM-2"]), entry("TASM-2", "done")];

    expect(blockedIds(entries)).toEqual([]);
  });

  it("honours every status of the final list", () => {
    const entries = [
      entry("TASM-1", "To Do", ["TASM-2"]),
      entry("TASM-2", "Cancelled"),
      entry("TASM-3", "To Do", ["TASM-4"]),
      entry("TASM-4", "In Progress"),
    ];

    expect(blockedIds(entries, ["Done", "Cancelled"])).toEqual(["TASM-3"]);
  });

  it("blocks a task whose blocker names no entry, and reports the id once", () => {
    const entries = [entry("TASM-1", "To Do", ["TASM-9"]), entry("TASM-2", "Done")];

    const result = resolveBlocked(entries, FINAL);

    expect([...result.blocked]).toEqual(["TASM-1"]);
    expect(result.unresolved).toEqual([
      {
        code: "blocked-by-unresolved",
        message: 'this task states the blocker "TASM-9", which the listing holds no task for',
        path: "/tasks/TASM-1.md",
      },
    ]);
  });

  it("strips from a reported blocker the characters that would drive a terminal", () => {
    const entries = [entry("TASM-1", "To Do", ["\u001b[31mred\u2028"])];

    expect(resolveBlocked(entries, FINAL).unresolved[0]?.message).toBe(
      'this task states the blocker " [31mred ", which the listing holds no task for',
    );
  });

  it("cuts a reported blocker to the length the index chose", () => {
    const entries = [entry("TASM-1", "To Do", ["x".repeat(80)])];

    expect(resolveBlocked(entries, FINAL).unresolved[0]?.message).toBe(
      `this task states the blocker "${"x".repeat(60)}...", which the listing holds no task for`,
    );
  });

  it("reports one diagnostic per unresolved blocker of one task", () => {
    const entries = [entry("TASM-1", "To Do", ["TASM-8", "TASM-9"])];

    expect(resolveBlocked(entries, FINAL).unresolved).toHaveLength(2);
  });

  it("reports an unresolved blocker once however often the file states it", () => {
    // A reader accepts any list of strings, so a hand-edited file reaches the
    // index with the repeat the store would have dropped on a write.
    const entries = [entry("TASM-1", "To Do", ["TASM-9", "TASM-9", "TASM-9"])];

    const result = resolveBlocked(entries, FINAL);

    expect([...result.blocked]).toEqual(["TASM-1"]);
    expect(result.unresolved).toHaveLength(1);
  });

  it("reports the same unresolved blocker once for each task that states it", () => {
    const entries = [entry("TASM-1", "To Do", ["TASM-9"]), entry("TASM-2", "To Do", ["TASM-9"])];

    expect(resolveBlocked(entries, FINAL).unresolved.map((diagnostic) => diagnostic.path)).toEqual([
      "/tasks/TASM-1.md",
      "/tasks/TASM-2.md",
    ]);
  });

  it("blocks a task whose blocker the index excluded, which reaches it as an id naming no entry", () => {
    // The blocker's file is in the project and unreadable, so the listing holds
    // no entry for it.
    const entries = [entry("TASM-1", "To Do", ["TASM-2"])];

    const result = resolveBlocked(entries, FINAL);

    expect([...result.blocked]).toEqual(["TASM-1"]);
    expect(result.unresolved).toHaveLength(1);
  });

  it("blocks both tasks of a cycle and terminates", () => {
    const entries = [entry("TASM-1", "To Do", ["TASM-2"]), entry("TASM-2", "To Do", ["TASM-1"])];

    const result = resolveBlocked(entries, FINAL);

    expect([...result.blocked].sort()).toEqual(["TASM-1", "TASM-2"]);
    expect(result.unresolved).toEqual([]);
  });

  it("follows one level alone, so a blocker's own blocker is not walked", () => {
    // TASM-2 blocks TASM-1 and is itself final, so TASM-1 is not blocked. Only a
    // walk past it would reach the open TASM-3 and block TASM-1 as well.
    const entries = [entry("TASM-1", "To Do", ["TASM-2"]), entry("TASM-2", "Done", ["TASM-3"]), entry("TASM-3", "To Do")];

    expect(blockedIds(entries)).toEqual(["TASM-2"]);
  });

  it("answers for no task over an empty listing", () => {
    const result = resolveBlocked([], FINAL);

    expect([...result.blocked]).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });
});
