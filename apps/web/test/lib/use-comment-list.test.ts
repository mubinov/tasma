import type { Comment } from "@tasma/protocol";
import { describe, expect, it } from "vitest";
import { commentRows, seenComments, type SeenComment } from "../../src/lib/use-comment-list";

function comment(id: number, fields: Partial<Comment> = {}): Comment {
  return { id, title: `Note ${String(id)}`, created: "2026-09-02T10:00:00Z", body: `Body ${String(id)}.`, ...fields };
}

/** Each held comment with the id order of the read that last held it. */
function seen(...entries: [Comment, number[]][]): ReadonlyMap<number, SeenComment> {
  return new Map(entries.map(([held, read]) => [held.id, { comment: held, read }]));
}

/** Runs the reads in turn, as the page's polls do, and draws the list after the last. */
function afterReads(editingIds: ReadonlySet<number>, ...reads: number[][]): number[] {
  let held: ReadonlyMap<number, SeenComment> = new Map();
  for (const read of reads) {
    held = seenComments(read.map((id) => comment(id)), editingIds, held);
  }

  return commentRows(reads.at(-1)!.map((id) => comment(id)), editingIds, held).map(({ comment: { id } }) => id);
}

describe("seenComments", () => {
  it("holds each comment being edited with its read, and nothing else", () => {
    const held = seenComments([comment(1), comment(2), comment(3)], new Set([2]), new Map());

    expect([...held]).toEqual([[2, { comment: comment(2), read: [1, 2, 3] }]]);
  });

  it("returns the same map where nothing moved", () => {
    const before = seen([comment(2), [1, 2]]);

    expect(seenComments([comment(1), comment(2)], new Set([2]), before)).toBe(before);
  });

  it("takes a changed comment and a new order from the read", () => {
    const before = seen([comment(2), [1, 2]]);
    const changed = comment(2, { body: "Edited on disk." });

    expect(seenComments([changed], new Set([2]), before).get(2)).toEqual({ comment: changed, read: [2] });
    expect(seenComments([comment(2)], new Set([2]), before).get(2)).toEqual({ comment: comment(2), read: [2] });
  });

  it("keeps a comment that left the file, and drops one whose editor closed", () => {
    const before = seen([comment(2), [1, 2, 3]], [comment(3), [1, 2, 3]]);

    const held = seenComments([comment(1)], new Set([2]), before);

    expect([...held.keys()]).toEqual([2]);
  });
});

describe("commentRows", () => {
  it("marks every comment the file holds but the last as followed by another", () => {
    const rows = commentRows([comment(1), comment(2)], new Set([2]), seen([comment(2), [1, 2]]));

    expect(rows.map(({ comment: { id }, onDisk, editing, lineEndRestored }) => [id, onDisk, editing, lineEndRestored]))
      .toEqual([[1, true, false, true], [2, true, true, false]]);
  });

  it("puts a detached card back at its place, without counting it as a comment that follows", () => {
    const rows = commentRows([comment(1)], new Set([2]), seen([comment(2), [1, 2]]));

    expect(rows.map(({ comment: { id }, onDisk, editing, lineEndRestored }) => [id, onDisk, editing, lineEndRestored]))
      .toEqual([[1, true, false, false], [2, false, true, false]]);
  });

  it("keeps the order of detached cards whatever order their editors opened in", () => {
    expect(afterReads(new Set([2, 1]), [1, 2, 3], [3])).toEqual([1, 2, 3]);
  });

  it("keeps the order of detached cards that left the file in separate reads", () => {
    expect(afterReads(new Set([1, 2]), [3, 1, 4, 2], [3, 4, 2], [3, 4])).toEqual([3, 1, 4, 2]);
    expect(afterReads(new Set([1, 2]), [3, 1, 2], [3, 2], [3])).toEqual([3, 1, 2]);
    expect(afterReads(new Set([1, 2]), [3, 1, 2], [3, 1], [3])).toEqual([3, 1, 2]);
  });

  it("puts a detached card first where nothing that stood before it is left", () => {
    expect(afterReads(new Set([4]), [5, 4, 6], [6])).toEqual([4, 6]);
    expect(afterReads(new Set([4]), [5, 4], [])).toEqual([4]);
  });

  it("puts a detached card after a comment that stood before it, the rest having gone", () => {
    expect(afterReads(new Set([4]), [5, 6, 4, 7], [5, 7])).toEqual([5, 4, 7]);
  });

  it("draws no card for an editor whose comment was never seen", () => {
    expect(commentRows([comment(1)], new Set([9]), new Map())).toHaveLength(1);
  });
});
