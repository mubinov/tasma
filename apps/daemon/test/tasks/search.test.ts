import { describe, expect, it } from "vitest";
import { TaskParseError, TaskStoreError } from "@tasma/engine";
import type { ListedEntry, ReadResult, Task, TaskComment } from "@tasma/engine";
import { searchEntries, words } from "../../src/tasks/search.js";
import { TIMESTAMP } from "../helpers.js";

function entry(id: string): ListedEntry {
  return {
    id,
    path: `/tmp/${id}.md`,
    frontmatter: { id, title: id, status: "To Do", created: TIMESTAMP, updated: TIMESTAMP, next_comment_id: 1 },
    blocked: false,
  };
}

function comment(title: string, body: string, fields: Partial<TaskComment> = {}): TaskComment {
  return { id: 1, title, body, created: TIMESTAMP, ...fields };
}

function task(id: string, title: string, body = "", comments: TaskComment[] = []): Task {
  return {
    frontmatter: { id, title, status: "To Do", created: TIMESTAMP, updated: TIMESTAMP, next_comment_id: 1 },
    body,
    comments,
  };
}

/** A project whose reads answer from `tasks`, or throw what `faults` holds for an id. */
function project(tasks: Task[], faults: Record<string, unknown> = {}) {
  const byId = new Map(tasks.map((held) => [held.frontmatter.id, held]));
  return {
    readTask: async (id: string): Promise<ReadResult> => {
      await Promise.resolve();
      if (id in faults) throw faults[id];
      return { task: byId.get(id)!, diagnostics: [] };
    },
  };
}

async function found(tasks: Task[], q: string): Promise<string[]> {
  const entries = tasks.map((held) => entry(held.frontmatter.id));
  const kept = await searchEntries(project(tasks), entries, words(q));
  return kept.map((held) => held.id);
}

describe("words", () => {
  it.each([
    ["no text", undefined],
    ["empty text", ""],
    ["whitespace alone", "  \t\n"],
  ])("reads %s as no word", (_name, q) => {
    expect(words(q)).toEqual([]);
  });

  it("splits on any run of whitespace and lowercases each word", () => {
    expect(words(" Drag  CARD ")).toEqual(["drag", "card"]);
  });
});

describe("searchEntries", () => {
  it("keeps a task that holds every word, wherever each one is", async () => {
    const tasks = [
      task("SAGA-1", "Drag the board", "", [comment("Note", "The card sticks.")]),
      task("SAGA-2", "Drag the column"),
      task("SAGA-3", "Planted", "A card alone."),
    ];

    await expect(found(tasks, "drag card")).resolves.toEqual(["SAGA-1"]);
  });

  it("finds a word in the body of a collapsed comment", async () => {
    const tasks = [task("SAGA-1", "Planted", "", [comment("Note", "Hidden lantern.", { collapsed: true })])];

    await expect(found(tasks, "lantern")).resolves.toEqual(["SAGA-1"]);
  });

  it("finds a word in the title of a comment", async () => {
    const tasks = [task("SAGA-1", "Planted", "", [comment("Lantern", "Body.")])];

    await expect(found(tasks, "lantern")).resolves.toEqual(["SAGA-1"]);
  });

  it("finds a word in the id", async () => {
    await expect(found([task("SAGA-17", "Planted"), task("SAGA-2", "Planted")], "saga-17")).resolves.toEqual([
      "SAGA-17",
    ]);
  });

  it("matches without regard to case on either side", async () => {
    await expect(found([task("SAGA-1", "LaNtErN")], "LANTERN")).resolves.toEqual(["SAGA-1"]);
  });

  it.each([
    ["a label", "urgent"],
    ["the status", "waiting"],
    ["the step", "dev:review"],
    ["the priority", "high"],
    ["a comment author", "alice"],
    ["a date", "2026-01-01"],
    ["a custom field", "lantern"],
  ])("does not find a word that is only in %s", async (_name, q) => {
    const held = task("SAGA-1", "Planted", "Body.", [comment("Note", "Text.", { author: "alice", custom: { lamp: "lantern" } })]);
    held.frontmatter = {
      ...held.frontmatter,
      status: "Waiting",
      step: "dev:review",
      priority: "high",
      labels: ["urgent"],
      custom: { lamp: "lantern" },
    };

    await expect(found([held], q)).resolves.toEqual([]);
  });

  it("does not match a word across the boundary of two fields", async () => {
    await expect(found([task("SAGA-1", "Fix dr", "ag the card")], "drag")).resolves.toEqual([]);
  });

  it("keeps the order of the entries it was given", async () => {
    const tasks = ["SAGA-3", "SAGA-1", "SAGA-2"].map((id) => task(id, "Lantern"));
    const slow = {
      readTask: async (id: string): Promise<ReadResult> => {
        await new Promise((resolve) => setTimeout(resolve, id === "SAGA-3" ? 20 : 0));
        return { task: tasks.find((held) => held.frontmatter.id === id)!, diagnostics: [] };
      },
    };

    const kept = await searchEntries(slow, tasks.map((held) => entry(held.frontmatter.id)), ["lantern"]);

    expect(kept.map((held) => held.id)).toEqual(["SAGA-3", "SAGA-1", "SAGA-2"]);
  });

  it.each([
    ["a file that is gone", new TaskStoreError("task-not-found", "gone")],
    ["a file that does not parse", new TaskParseError("marker-invalid", 3, "bad marker")],
    ["a file that holds another id", new TaskStoreError("id-mismatch", "another id")],
    ["a file the system refuses", Object.assign(new Error("denied"), { code: "EACCES", syscall: "open" })],
  ])("drops the task of %s, and keeps the others", async (_name, fault) => {
    const tasks = [task("SAGA-1", "Lantern"), task("SAGA-2", "Lantern")];

    const kept = await searchEntries(project(tasks, { "SAGA-1": fault }), [entry("SAGA-1"), entry("SAGA-2")], ["lantern"]);

    expect(kept.map((held) => held.id)).toEqual(["SAGA-2"]);
  });

  it.each([
    ["the index is closed", new TaskStoreError("index-closed", "closed")],
    ["the project is gone", new TaskStoreError("project-not-found", "gone")],
    ["the project is invalid", new TaskStoreError("project-invalid", "invalid")],
    ["the code is wrong", new TypeError("broken")],
  ])("fails when %s", async (_name, fault) => {
    const tasks = [task("SAGA-1", "Lantern"), task("SAGA-2", "Lantern")];

    await expect(
      searchEntries(project(tasks, { "SAGA-1": fault }), [entry("SAGA-1"), entry("SAGA-2")], ["lantern"]),
    ).rejects.toBe(fault);
  });

  it("holds no more than eight reads in progress at a time", async () => {
    const tasks = Array.from({ length: 20 }, (_unused, at) => task(`SAGA-${at + 1}`, "Lantern"));
    let running = 0;
    let most = 0;
    const counted = {
      readTask: async (id: string): Promise<ReadResult> => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 1));
        running -= 1;
        return { task: tasks.find((held) => held.frontmatter.id === id)!, diagnostics: [] };
      },
    };

    const kept = await searchEntries(counted, tasks.map((held) => entry(held.frontmatter.id)), ["lantern"]);

    expect(kept).toHaveLength(20);
    expect(most).toBe(8);
  });
});
