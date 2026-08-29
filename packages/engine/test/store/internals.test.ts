import { writeFileSync } from "node:fs";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTask, type TaskComment, TaskStoreError } from "@tasma/engine";
import { frontmatterNumber } from "../../src/store/ids.js";
import { projectPaths } from "../../src/store/paths.js";
import { assertSnapshots, createTaskFile, timestamp } from "../../src/store/store.js";
import type { StoreDiagnostic } from "../../src/store/types.js";
import {
  codes,
  plant,
  PROJECT,
  statePath,
  storeError,
  storeFault,
  taskFile,
  tasksDir,
  taskText,
  TIMESTAMP,
  tempRoot,
} from "./helpers.js";

const PATH = "/tmp/tree/projects/TASM/tasks/TASM-1.md";

function parsed() {
  return parseTask(`${taskText("TASM-1")}\n<!-- task:comment {id: 1, title: One, created: "${TIMESTAMP}"} -->\n`).task;
}

// States the public API is built to make unreachable, staged against the module
// that holds each rather than through an operation, and the two helpers the
// store exports for a test to reach.

describe("assertSnapshots", () => {
  it("accepts a task that still carries the source of every region it read", () => {
    expect(() => assertSnapshots(parsed(), [], PATH)).not.toThrow();
  });

  it("rejects a task whose own source a copy dropped", () => {
    const error = storeFault(() => assertSnapshots(structuredClone(parsed()), [], PATH));

    expect(error.code).toBe("snapshot-lost");
    expect(error.path).toBe(PATH);
  });

  it("rejects a task one of whose comments lost its source", () => {
    const task = parsed();
    const copied = { ...task, comments: task.comments.map((comment) => structuredClone(comment)) };

    expect(() => assertSnapshots(copied, [], PATH)).toThrow(TaskStoreError);
  });

  it("passes over a comment the store built rather than read", () => {
    const task = parsed();
    const appended: TaskComment = { id: 2, title: "Two", created: TIMESTAMP, body: "" };

    expect(() => assertSnapshots({ ...task, comments: [...task.comments, appended] }, [appended], PATH)).not.toThrow();
  });
});

describe("a second collision", () => {
  it("reports the directory rather than guessing again", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));
    await plant(statePath(root), "next_task_id: 1\n");
    const paths = projectPaths({ project: PROJECT, root });
    const diagnostics: StoreDiagnostic[] = [];

    // The directory gains the retried name while the text of the retry is built.
    const build = (id: string): string => {
      writeFileSync(join(tasksDir(root), `${id}.md`), taskText(id), "utf8");
      return taskText(id);
    };

    const error = await storeError(createTaskFile(paths, diagnostics, build));

    expect(error.code).toBe("task-exists");
    expect(error.path).toBe(taskFile(root, "TASM-2"));
  });
});

describe("a fault that is not a filesystem fault", () => {
  it.each([["an error", new Error("the text could not be built")], ["a value of another kind", "not an error"]])(
    "reaches the caller as it stands, with no retry, for %s",
    async (_name, thrown) => {
      const root = await tempRoot();
      const paths = projectPaths({ project: PROJECT, root });
      const diagnostics: StoreDiagnostic[] = [];

      const raised = await createTaskFile(paths, diagnostics, () => {
        throw thrown;
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(raised).toBe(thrown);
      expect(diagnostics).toEqual([]);
    },
  );
});

describe("a name the rebuild reads after the scan classified it", () => {
  it.each([
    [
      "a symbolic link swapped in behind the scan",
      async (root: string) => {
        await plant(join(root, "outside.md"), taskText("TASM-9"));
        await mkdir(tasksDir(root), { recursive: true });
        await symlink(join(root, "outside.md"), taskFile(root, "TASM-1"));
      },
    ],
    ["a name the read no longer finds", async () => {}],
  ])("counts toward no frontmatter floor and is reported, for %s", async (_name, stage) => {
    const root = await tempRoot();
    await stage(root);
    const paths = projectPaths({ project: PROJECT, root });
    const diagnostics: StoreDiagnostic[] = [];

    const claimed = await frontmatterNumber(paths, taskFile(root, "TASM-1"), diagnostics);

    expect(claimed).toBeUndefined();
    expect(codes(diagnostics)).toEqual(["task-file-unreadable"]);
  });
});

describe("timestamp", () => {
  it.each([
    [-300, "2026-01-01T19:30:00-05:00"],
    [330, "2026-01-02T06:00:00+05:30"],
    [0, "2026-01-02T00:30:00+00:00"],
  ])("writes the offset %i minutes east of UTC as the format requires", (offset, written) => {
    expect(timestamp(new Date("2026-01-02T00:30:00Z"), offset)).toBe(written);
  });
});
