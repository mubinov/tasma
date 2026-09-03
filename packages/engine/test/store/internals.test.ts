import { writeFileSync } from "node:fs";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTask, type TaskComment, TaskStoreError, type Workflows } from "@tasma/engine";
import { causeOf, pathOf } from "../../src/store/errors.js";
import { frontmatterNumber } from "../../src/store/ids.js";
import { projectPaths } from "../../src/store/paths.js";
import { assertSnapshots, createTaskFile, timestamp } from "../../src/store/store.js";
import type { StoreDiagnostic } from "../../src/store/types.js";
import { validateBlockedBy, validateLabels } from "../../src/store/validate.js";
import { openWorkflowsForRead, reportWorkflowInto } from "../../src/store/workflow.js";
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

describe("validateLabels over a list as long as a request body carries", () => {
  // Staged against the validator rather than through a write, because a write of
  // this list would spend its time in the serializer instead. A scan of what is
  // stored costs the square of the length here, which is minutes; membership
  // through a set costs one pass, which is the test's own runtime.
  it("deduplicates in one pass, so the cost follows the length rather than its square", () => {
    const labels = Array.from({ length: 100_000 }, (_, at) => `label-${at}`);
    const diagnostics: StoreDiagnostic[] = [];

    const stored = validateLabels(labels, PATH, diagnostics);

    expect(stored).toEqual(labels);
    expect(diagnostics).toEqual([]);
  });

  // A repeat is reported once, not once per element: the reply a write answers
  // with is a caller's to inflate otherwise, from a body the limit bounds into a
  // diagnostic list nothing bounds.
  it("reports a value stated many times once, so the report follows the distinct values", () => {
    const diagnostics: StoreDiagnostic[] = [];

    const stored = validateLabels(Array.from({ length: 100_000 }, () => "Backend"), PATH, diagnostics);

    expect(stored).toEqual(["backend"]);
    expect(codes(diagnostics)).toEqual(["label-case-converted", "label-duplicate-dropped"]);
  });
});

describe("validateBlockedBy over a list as long as a request body carries", () => {
  it("reports an id stated many times once, so the report follows the distinct ids", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));
    const paths = projectPaths({ project: PROJECT, root });
    const diagnostics: StoreDiagnostic[] = [];

    const stored = await validateBlockedBy(
      Array.from({ length: 100_000 }, () => "TASM-1"),
      paths,
      "TASM-2",
      PATH,
      diagnostics,
    );

    expect(stored).toEqual(["TASM-1"]);
    expect(codes(diagnostics)).toEqual(["blocked-by-duplicate-dropped"]);
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
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- throwing a non-Error is the case under test
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

describe("causeOf", () => {
  it.each([
    [new Error("the file could not be read"), "the file could not be read"],
    [new TaskStoreError("task-not-found", "there is no task TASM-1"), "there is no task TASM-1"],
    ["a value of another kind", "a value of another kind"],
    [undefined, "undefined"],
  ])("states the explanation of %s without the class that carried it", (thrown, explanation) => {
    expect(causeOf(thrown)).toBe(explanation);
  });
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

describe("reportWorkflowInto", () => {
  /** A handle whose read raises what the loader never raises. */
  function raising(error: Error): Workflows {
    return {
      directory: "/tmp/tree/workflows",
      pathsOf: (name) => ({ directory: `/tmp/tree/workflows/${name}`, file: "" }),
      list: () => Promise.reject(error),
      read: () => Promise.reject(error),
      readStep: () => Promise.reject(error),
    };
  }

  it("leaves a fault that is no store error as it stands, rather than reporting it", async () => {
    const frontmatter = parsed().frontmatter;
    frontmatter.workflow = "dev";

    const workflows = raising(new Error("broken"));

    await expect(reportWorkflowInto(() => Promise.resolve(workflows), frontmatter, PATH, [])).rejects.toThrow("broken");
  });
});

describe("openWorkflowsForRead", () => {
  const ROOT = "/tmp/tree";

  it("stands on the directory the user's configuration names", async () => {
    const diagnostics: StoreDiagnostic[] = [];

    const workflows = await openWorkflowsForRead(ROOT, () => Promise.resolve("/srv/flows"), diagnostics);

    expect(workflows.directory).toBe("/srv/flows");
    expect(diagnostics).toEqual([]);
  });

  it("stands on the built-in directory when the configuration names none", async () => {
    const workflows = await openWorkflowsForRead(ROOT, () => Promise.resolve(undefined), []);

    expect(workflows.directory).toBe(join(ROOT, "workflows"));
  });

  it.each([
    ["a store fault of another code", new TaskStoreError("task-not-found", "no such task")],
    ["a fault that names no code", new Error("broken")],
  ])("leaves %s as it stands, rather than degrading the read", async (_name, error) => {
    await expect(openWorkflowsForRead(ROOT, () => Promise.reject(error), [])).rejects.toThrow(error.message);
  });
});

describe("pathOf", () => {
  it("names the path a fault of the filesystem carries", () => {
    expect(pathOf(Object.assign(new Error("broken"), { path: "/tmp/x" }))).toBe("/tmp/x");
  });

  it.each([
    ["a fault that is no object", "broken"],
    ["a fault that names none", new Error("broken")],
    ["a fault whose path is no string", Object.assign(new Error("broken"), { path: 3 })],
  ])("names no path for %s", (_name, error) => {
    expect(pathOf(error)).toBeUndefined();
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
