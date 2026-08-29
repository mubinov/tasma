import { chmod, lstat, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  codes,
  plant,
  project,
  projectDir,
  read,
  statePath,
  storeError,
  taskFile,
  tasksDir,
  taskText,
  TIMESTAMP,
  tempRoot,
} from "./helpers.js";

/** A task file carrying comments, so that the comment counter has something to repair against. */
function withComments(id: string, counter: number): string {
  return `---
id: ${id}
title: Planted
status: To Do
created: "${TIMESTAMP}"
updated: "${TIMESTAMP}"
next_comment_id: ${counter}
---

Body.

<!-- task:comment {id: 1, title: One, created: "${TIMESTAMP}"} -->

First.

<!-- task:comment {id: 2, title: Two, created: "${TIMESTAMP}"} -->

Second.
`;
}

describe("comment ids", () => {
  it("issues the counter when it stands past every id in the file", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), withComments("TASM-1", 7));

    const result = await project(root).addComment("TASM-1", { title: "Note" });

    expect(result.commentId).toBe(7);
    expect(result.diagnostics).toEqual([]);
    expect(await read(taskFile(root, "TASM-1"))).toContain("next_comment_id: 8");
  });

  it("repairs a counter the file has already run past, and reports the repair", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), withComments("TASM-1", 2));

    const result = await project(root).addComment("TASM-1", { title: "Note" });

    expect(result.commentId).toBe(3);
    expect(codes(result.diagnostics)).toEqual(["stale-next-comment-id", "next-comment-id-repaired"]);
    expect(await read(taskFile(root, "TASM-1"))).toContain("next_comment_id: 4");
  });

  it("issues 1 when the counter stands below it", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1").replace("next_comment_id: 1", "next_comment_id: 0"));

    const result = await project(root).addComment("TASM-1", { title: "Note" });

    expect(result.commentId).toBe(1);
    expect(codes(result.diagnostics)).toEqual(["next-comment-id-repaired"]);
  });

  it("leaves a stale counter alone on a write that issues no id", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), withComments("TASM-1", 2));

    const result = await project(root).updateTask("TASM-1", { title: "Renamed" });

    expect(codes(result.diagnostics)).toEqual(["stale-next-comment-id"]);
    expect(await read(taskFile(root, "TASM-1"))).toContain("next_comment_id: 2");
  });

  it.each([
    ["one past the safe integer range, where adding one moves nothing", "9007199254740992"],
    ["written in exponent form, which names no id this engine writes", "1e21"],
    ["negative", "-5"],
  ])("passes over a counter that is %s and takes the ids in the file instead", async (_name, counter) => {
    const root = await tempRoot();
    const planted = withComments("TASM-1", 2).replace("next_comment_id: 2", `next_comment_id: ${counter}`);
    await plant(taskFile(root, "TASM-1"), planted);

    const result = await project(root).addComment("TASM-1", { title: "Note" });

    expect(result.commentId).toBe(3);
    expect(codes(result.diagnostics)).toContain("next-comment-id-repaired");
    expect(await read(taskFile(root, "TASM-1"))).toContain("next_comment_id: 4");
  });

  it("passes over a comment id past the safe integer range, which no later id can follow", async () => {
    const root = await tempRoot();
    const planted = withComments("TASM-1", 3).replace("{id: 2,", "{id: 1e21,");
    await plant(taskFile(root, "TASM-1"), planted);

    const result = await project(root).addComment("TASM-1", { title: "Note" });

    expect(result.commentId).toBe(3);
  });

  it("reports that no free comment id is left once the last one is taken", async () => {
    const root = await tempRoot();
    const last = String(Number.MAX_SAFE_INTEGER);
    const planted = withComments("TASM-1", 3).replace("{id: 2,", `{id: ${last},`);
    await plant(taskFile(root, "TASM-1"), planted);

    const error = await storeError(project(root).addComment("TASM-1", { title: "Note" }));

    expect(error.code).toBe("comment-exists");
    expect(error.path).toBe(taskFile(root, "TASM-1"));
  });
});

describe("the task counter", () => {
  it("takes the counter state.yml carries and writes one past it", async () => {
    const root = await tempRoot();
    await plant(statePath(root), "next_task_id: 7\n");

    const result = await project(root).createTask({ title: "First" });

    expect(result.id).toBe("TASM-7");
    expect(result.diagnostics).toEqual([]);
    expect(await read(statePath(root))).toContain("next_task_id: 8");
  });

  it("starts at 1 in a project with no task file, in silence", async () => {
    const root = await tempRoot();

    const result = await project(root).createTask({ title: "First" });

    expect(result.id).toBe("TASM-1");
    expect(result.diagnostics).toEqual([]);
  });

  it.each([
    ["a file that is not valid YAML", "next_task_id: [\n"],
    ["a file that is not a mapping", "- 4\n"],
    ["a counter that is not an integer", 'next_task_id: "4"\n'],
    ["a counter that is missing", "note: nothing here\n"],
    ["a counter below the first id", "next_task_id: 0\n"],
    ["a negative counter, which names no task file", "next_task_id: -5\n"],
    ["a counter past the safe integer range", "next_task_id: 1e21\n"],
  ])("rebuilds from the files on disk on %s", async (_name, text) => {
    const root = await tempRoot();
    await plant(statePath(root), text);
    await plant(taskFile(root, "TASM-4"), taskText("TASM-4"));

    const result = await project(root).createTask({ title: "Second" });

    expect(result.id).toBe("TASM-5");
    expect(codes(result.diagnostics)).toContain("next-task-id-rebuilt");
  });

  it("takes the highest id in the frontmatter, not the highest file name", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-5"), taskText("TASM-30"));

    expect((await project(root).createTask({ title: "Second" })).id).toBe("TASM-31");
  });

  it("takes the highest file name, so a file it cannot parse still counts", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-30"), "this file has no frontmatter\n");

    const result = await project(root).createTask({ title: "Second" });

    expect(result.id).toBe("TASM-31");
    expect(codes(result.diagnostics)).toContain("task-file-unreadable");
  });

  it("excludes a file of another project from the id floor but not from the name floor", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-30"), taskText("OTHER-99"));

    const result = await project(root).createTask({ title: "Second" });

    expect(result.id).toBe("TASM-31");
    expect(codes(result.diagnostics)).toContain("task-file-foreign");
  });

  it("rebuilds and retries once when the counter is behind the directory", async () => {
    const root = await tempRoot();
    await plant(statePath(root), "next_task_id: 1\n");
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));

    const result = await project(root).createTask({ title: "Second" });

    expect(result.id).toBe("TASM-2");
    expect(codes(result.diagnostics)).toEqual(["next-task-id-rebuilt", "next-task-id-advanced"]);
    expect(await read(statePath(root))).toContain("next_task_id: 3");
  });

  it("reports an unknown key of state.yml and keeps it on the next write", async () => {
    const root = await tempRoot();
    await plant(statePath(root), "next_task_id: 4\nnote: written by a later version\n");

    const result = await project(root).createTask({ title: "First" });

    expect(codes(result.diagnostics)).toEqual(["state-key-unknown"]);
    const state = await read(statePath(root));
    expect(state).toContain("note: written by a later version");
    expect(state).toContain("next_task_id: 5");
  });

  it("writes the task file before state.yml", async () => {
    const root = await tempRoot();
    // The tasks directory stays writable and the directory that holds state.yml
    // does not, so the create lands and the counter write is the step that fails.
    await mkdir(tasksDir(root), { recursive: true });
    await chmod(projectDir(root), 0o555);
    onTestFinished(() => chmod(projectDir(root), 0o755));

    await expect(project(root).createTask({ title: "First" })).rejects.toThrow();

    await expect(read(taskFile(root, "TASM-1"))).resolves.toContain("id: TASM-1");
  });
});

describe("a state file that stands there and cannot be used", () => {
  it("reports the rebuild although the project holds no task file yet", async () => {
    const root = await tempRoot();
    await plant(statePath(root), "next_task_id: [\n");

    const result = await project(root).createTask({ title: "First" });

    expect(result.id).toBe("TASM-1");
    expect(codes(result.diagnostics)).toEqual(["next-task-id-rebuilt"]);
  });

  it("reports nothing for a project that carries neither the file nor a task", async () => {
    const root = await tempRoot();

    expect((await project(root).createTask({ title: "First" })).diagnostics).toEqual([]);
  });

  it.each([
    ["a set, which a YAML tag resolves to no mapping this engine can write", "!!set\n? next_task_id\n"],
    ["an ordered mapping, which resolves to a Map", "!!omap\n- next_task_id: 7\n"],
    ["a scalar where the mapping belongs", "7\n"],
  ])("is replaced by a file this engine can write, for %s", async (_name, text) => {
    const root = await tempRoot();
    await plant(statePath(root), text);

    const result = await project(root).createTask({ title: "First" });

    expect(result.id).toBe("TASM-1");
    expect(codes(result.diagnostics)).toEqual(["next-task-id-rebuilt"]);
    expect(await read(statePath(root))).toContain("next_task_id: 2");
  });

  it("reads a name that holds no regular file as one it cannot use, and writes its own file over it", async () => {
    const root = await tempRoot();
    const outside = join(root, "outside.yml");
    await plant(outside, "next_task_id: 40\napi_token: a-secret\n");
    await symlink(outside, statePath(root));

    const result = await project(root).createTask({ title: "First" });

    expect(result.id).toBe("TASM-1");
    expect(codes(result.diagnostics)).toEqual(["next-task-id-rebuilt"]);
    // Nothing of the file the name pointed at was read into the store or lost.
    expect(await read(statePath(root))).not.toContain("api_token");
    expect(await read(outside)).toContain("next_task_id: 40");
    expect((await lstat(statePath(root))).isSymbolicLink()).toBe(false);
  });

  it("lets a fault that is not a missing file reach the caller", async () => {
    const root = await tempRoot();
    // A directory where the file belongs: readable as a path, not as a file.
    await mkdir(statePath(root), { recursive: true });

    await expect(project(root).createTask({ title: "First" })).rejects.toMatchObject({ code: "EISDIR" });
  });
});

describe("a task number no name can carry", () => {
  it("passes over a file name whose digits do not survive a number", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, `TASM-${"9".repeat(240)}`), "not a task file\n");

    const result = await project(root).createTask({ title: "First" });

    expect(result.id).toBe("TASM-1");
    // The name is not a task name, so it is reported and the counter starts
    // where a new project starts.
    expect(codes(result.diagnostics)).toEqual(["task-file-unexpected"]);
  });

  it("reports that no free number is left once the last one is taken", async () => {
    const root = await tempRoot();
    const last = String(Number.MAX_SAFE_INTEGER);
    await plant(taskFile(root, `TASM-${last}`), taskText(`TASM-${last}`));

    const error = await storeError(project(root).createTask({ title: "First" }));

    expect(error.code).toBe("task-exists");
    expect(error.path).toBe(tasksDir(root));
  });
});

describe("a state file the YAML library gives up on", () => {
  it("is rebuilt like any other file the engine cannot read", async () => {
    const root = await tempRoot();
    // More aliases than the library expands, so the document parses and refuses
    // to become values.
    await plant(
      statePath(root),
      `next_task_id: 9
a: &a [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]
c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]
d: [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]
`,
    );

    expect((await project(root).createTask({ title: "First" })).id).toBe("TASM-1");
  });
});
