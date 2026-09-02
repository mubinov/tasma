import { symlink } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { type Project, SNAPSHOT } from "@tasma/engine";
import { codes, plant, project, projectConfig, read, storeError, taskFile, taskText, tempRoot } from "./helpers.js";

/** A project holding `TASM-1`, and the handle that wrote it. */
async function seeded(root: string): Promise<Project> {
  const handle = project(root);
  await handle.createTask({ title: "First" });
  return handle;
}

describe("labels", () => {
  it.each([["backend"], ["b2b"], ["a-b"], ["a--b"], ["0"], ["design", "research"]])(
    "writes the conforming labels %s",
    async (...labels) => {
      const root = await tempRoot();
      const handle = await seeded(root);

      const result = await handle.updateTask("TASM-1", { labels });

      expect(result.labels).toEqual(labels);
      expect(result.diagnostics).toEqual([]);
      expect((await handle.readTask("TASM-1")).task.frontmatter.labels).toEqual(labels);
    },
  );

  it.each(["customer request", "customer_request", "a:b", "a.b", "-a", "a-", "", "ä", "a/b"])(
    "rejects the label %s",
    async (label) => {
      const root = await tempRoot();
      const handle = await seeded(root);

      const error = await storeError(handle.updateTask("TASM-1", { labels: [label] }));

      expect(error.code).toBe("label-invalid");
      expect(error.message).toContain(label);
    },
  );

  it("names the character that failed", async () => {
    const root = await tempRoot();
    const handle = await seeded(root);

    expect((await storeError(handle.updateTask("TASM-1", { labels: ["a b"] }))).message).toContain('" "');
  });

  it("converts an uppercase label and reports the conversion", async () => {
    const root = await tempRoot();
    const handle = await seeded(root);

    const result = await handle.updateTask("TASM-1", { labels: ["Customer-Request"] });

    expect(result.labels).toEqual(["customer-request"]);
    expect(codes(result.diagnostics)).toEqual(["label-case-converted"]);
    expect((await handle.readTask("TASM-1")).task.frontmatter.labels).toEqual(["customer-request"]);
  });

  it("drops a duplicate the conversion produced and reports it", async () => {
    const root = await tempRoot();
    const handle = await seeded(root);

    const result = await handle.updateTask("TASM-1", { labels: ["Backend", "backend"] });

    expect(result.labels).toEqual(["backend"]);
    expect(codes(result.diagnostics)).toEqual(["label-case-converted", "label-duplicate-dropped"]);
  });

  it("drops a duplicate that no conversion produced", async () => {
    const root = await tempRoot();
    const handle = await seeded(root);

    const result = await handle.updateTask("TASM-1", { labels: ["backend", "backend"] });

    expect(result.labels).toEqual(["backend"]);
    expect(codes(result.diagnostics)).toEqual(["label-duplicate-dropped"]);
  });

  it("reports the conversion although the write turns out to change nothing", async () => {
    const root = await tempRoot();
    const handle = await seeded(root);
    await handle.updateTask("TASM-1", { labels: ["customer-request"] });
    const before = await read(taskFile(root, "TASM-1"));

    const result = await handle.updateTask("TASM-1", { labels: ["Customer-Request"] });

    expect(codes(result.diagnostics)).toEqual(["label-case-converted"]);
    expect(result.labels).toEqual(["customer-request"]);
    expect(await read(taskFile(root, "TASM-1"))).toBe(before);
  });

  it("clears the labels when the change names them with no value", async () => {
    const root = await tempRoot();
    const handle = await seeded(root);
    await handle.updateTask("TASM-1", { labels: ["backend"] });

    const result = await handle.updateTask("TASM-1", { labels: undefined });

    expect(result.labels).toBeUndefined();
    expect((await handle.readTask("TASM-1")).task.frontmatter.labels).toBeUndefined();
  });

  it("rejects a labels value that is not a list of strings", async () => {
    const root = await tempRoot();
    const handle = await seeded(root);

    expect((await storeError(handle.updateTask("TASM-1", { labels: "backend" }))).code).toBe("label-invalid");
  });
});

describe("status and priority", () => {
  async function declaring(text: string): Promise<{ root: string; handle: Project }> {
    const root = await tempRoot();
    await plant(projectConfig(root), text);
    return { root, handle: project(root) };
  }

  it("accepts a value the declared list carries", async () => {
    const { handle } = await declaring("statuses: [Backlog, In Progress]\n");
    await handle.createTask({ title: "First" });

    const result = await handle.updateTask("TASM-1", { status: "In Progress" });

    expect(result.status).toBe("In Progress");
    expect(result.diagnostics).toEqual([]);
  });

  it("corrects a single case-insensitive match and reports it", async () => {
    const { handle } = await declaring("statuses: [Backlog, In Progress]\n");
    await handle.createTask({ title: "First" });

    const result = await handle.updateTask("TASM-1", { status: "in progress" });

    expect(result.status).toBe("In Progress");
    expect(codes(result.diagnostics)).toEqual(["status-case-corrected"]);
    expect((await handle.readTask("TASM-1")).task.frontmatter.status).toBe("In Progress");
  });

  it("throws when the declared list carries no match", async () => {
    const { handle } = await declaring("statuses: [Backlog, Done]\n");
    await handle.createTask({ title: "First" });

    const error = await storeError(handle.updateTask("TASM-1", { status: "Shipped" }));

    expect(error.code).toBe("status-unknown");
    expect(error.message).toContain("Shipped");
    expect(error.message).toContain("Backlog");
  });

  it("throws when two declared entries match case-insensitively", async () => {
    const { handle } = await declaring("statuses: [Done, done]\n");
    await handle.createTask({ title: "First" });

    expect((await storeError(handle.updateTask("TASM-1", { status: "DONE" }))).code).toBe("status-unknown");
  });

  it("corrects a priority the same way", async () => {
    const root = await tempRoot();
    const handle = await seeded(root);

    const result = await handle.updateTask("TASM-1", { priority: "HIGH" });

    expect(result.priority).toBe("high");
    expect(codes(result.diagnostics)).toEqual(["priority-case-corrected"]);
  });

  it("throws on a priority the declared list does not carry", async () => {
    const root = await tempRoot();
    const handle = await seeded(root);

    expect((await storeError(handle.updateTask("TASM-1", { priority: "urgent" }))).code).toBe("priority-unknown");
  });

  it("throws on a status value that is not a string", async () => {
    const root = await tempRoot();
    const handle = await seeded(root);

    expect((await storeError(handle.updateTask("TASM-1", { status: 3 }))).code).toBe("status-unknown");
  });

  it("clears a priority the change names with no value", async () => {
    const root = await tempRoot();
    const handle = await seeded(root);
    await handle.updateTask("TASM-1", { priority: "high" });

    const result = await handle.updateTask("TASM-1", { priority: undefined });

    expect(result.priority).toBeUndefined();
    expect((await handle.readTask("TASM-1")).task.frontmatter.priority).toBeUndefined();
  });

  it("takes the default status on a create that states none", async () => {
    const { handle } = await declaring("statuses: [Triage, Doing]\n");

    expect((await handle.createTask({ title: "First" })).status).toBe("Triage");
  });

  it("validates a status a create states", async () => {
    const { handle } = await declaring("statuses: [Triage, Doing]\n");

    expect((await storeError(handle.createTask({ title: "First", status: "Done" }))).code).toBe("status-unknown");
  });
});

describe("blocked_by", () => {
  /** A project holding `TASM-1` and `TASM-2`, and the handle that wrote both. */
  async function twoTasks(root: string): Promise<Project> {
    const handle = project(root);
    await handle.createTask({ title: "First" });
    await handle.createTask({ title: "Second" });
    return handle;
  }

  it("stores the ids of tasks the project holds", async () => {
    const root = await tempRoot();
    const handle = await twoTasks(root);

    const result = await handle.updateTask("TASM-1", { blocked_by: ["TASM-2"] });

    expect(result.blocked_by).toEqual(["TASM-2"]);
    expect(result.diagnostics).toEqual([]);
    expect((await handle.readTask("TASM-1")).task.frontmatter.blocked_by).toEqual(["TASM-2"]);
  });

  it("rejects a value that is not a list of strings", async () => {
    const root = await tempRoot();
    const handle = await twoTasks(root);

    const error = await storeError(handle.updateTask("TASM-1", { blocked_by: "TASM-2" }));

    expect(error.code).toBe("blocked-by-invalid");
    expect(error.message).toContain("list of strings");
  });

  it("rejects the task's own id, which no task can be blocked by", async () => {
    const root = await tempRoot();
    const handle = await twoTasks(root);

    const error = await storeError(handle.updateTask("TASM-1", { blocked_by: ["TASM-1"] }));

    expect(error.code).toBe("blocked-by-invalid");
    expect(error.message).toContain("a task cannot block itself");
  });

  it.each(["", "TASM", "1", "tasm-2", "CLIB-2", "../../etc/passwd", "TASM-1.5"])(
    "rejects the id %s, which is no task id of this project",
    async (id) => {
      const root = await tempRoot();
      const handle = await twoTasks(root);

      const error = await storeError(handle.updateTask("TASM-1", { blocked_by: [id] }));

      expect(error.code).toBe("blocked-by-unknown");
      expect(error.message).toContain(id);
    },
  );

  it("rejects a well-formed id the project holds no file for", async () => {
    const root = await tempRoot();
    const handle = await twoTasks(root);

    const error = await storeError(handle.updateTask("TASM-1", { blocked_by: ["TASM-9"] }));

    expect(error.code).toBe("blocked-by-unknown");
    expect(error.message).toContain("names no task of project TASM");
  });

  it("rejects a symbolic link standing at a blocker's name, which is no task file", async () => {
    const root = await tempRoot();
    const handle = await twoTasks(root);
    await symlink(taskFile(root, "TASM-2"), taskFile(root, "TASM-9"));

    expect((await storeError(handle.updateTask("TASM-1", { blocked_by: ["TASM-9"] }))).code).toBe("blocked-by-unknown");
  });

  it("stores an id stated twice once, in its first position, and reports the drop", async () => {
    const root = await tempRoot();
    const handle = await twoTasks(root);
    await handle.createTask({ title: "Third" });

    const result = await handle.updateTask("TASM-1", { blocked_by: ["TASM-3", "TASM-2", "TASM-3"] });

    expect(result.blocked_by).toEqual(["TASM-3", "TASM-2"]);
    expect(codes(result.diagnostics)).toEqual(["blocked-by-duplicate-dropped"]);
  });

  it("stores the ids a create states", async () => {
    const root = await tempRoot();
    const handle = await twoTasks(root);

    const result = await handle.createTask({ title: "Third", blocked_by: ["TASM-1"] });

    expect(result.blocked_by).toEqual(["TASM-1"]);
    expect((await handle.readTask(result.id)).task.frontmatter.blocked_by).toEqual(["TASM-1"]);
  });

  it("refuses a create that names the id it is about to receive, which no task holds yet", async () => {
    const root = await tempRoot();
    const handle = await twoTasks(root);

    expect((await storeError(handle.createTask({ title: "Third", blocked_by: ["TASM-3"] }))).code).toBe(
      "blocked-by-unknown",
    );
  });

  it("clears the field when the change names it with no value", async () => {
    const root = await tempRoot();
    const handle = await twoTasks(root);
    await handle.updateTask("TASM-1", { blocked_by: ["TASM-2"] });

    const result = await handle.updateTask("TASM-1", { blocked_by: undefined });

    expect(result.blocked_by).toBeUndefined();
    expect((await handle.readTask("TASM-1")).task.frontmatter.blocked_by).toBeUndefined();
  });

  it("edits the title of a task whose file holds a blocker the project no longer has", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1", "blocked_by: [TASM-9]\n"));

    await project(root).updateTask("TASM-1", { title: "Renamed" });

    expect((await project(root).readTask("TASM-1")).task.frontmatter.blocked_by).toEqual(["TASM-9"]);
  });
});

describe("values already on disk", () => {
  it("edits the title of a task whose status configuration no longer declares", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1").replace("status: To Do", "status: Archived"));

    const result = await project(root).updateTask("TASM-1", { title: "Renamed" });

    expect(result.status).toBeUndefined();
    expect((await project(root).readTask("TASM-1")).task.frontmatter.status).toBe("Archived");
  });

  it("edits the title of a task whose labels no writer would write today", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1", "labels: [Backend]\n"));

    await project(root).updateTask("TASM-1", { title: "Renamed" });

    expect((await project(root).readTask("TASM-1")).task.frontmatter.labels).toEqual(["Backend"]);
  });
});

describe("fields the store owns", () => {
  it.each(["id", "created", "updated", "next_comment_id"])("rejects %s in a change", async (field) => {
    const root = await tempRoot();
    const handle = await seeded(root);

    const error = await storeError(handle.updateTask("TASM-1", { [field]: "TASM-2" }));

    expect(error.code).toBe("field-not-writable");
    expect(error.message).toContain(field);
  });

  it("rejects an id that would otherwise make a duplicate of it", async () => {
    const root = await tempRoot();
    const handle = await seeded(root);

    expect((await storeError(handle.updateTask("TASM-1", { id: "TASM-2" }))).code).toBe("field-not-writable");
    expect((await handle.readTask("TASM-1")).task.frontmatter.id).toBe("TASM-1");
  });

  it.each(["id", "created", "updated", "next_comment_id"])("rejects %s on a create", async (field) => {
    const root = await tempRoot();

    expect((await storeError(project(root).createTask({ title: "First", [field]: 1 }))).code).toBe(
      "field-not-writable",
    );
  });

  it.each(["id", "created", "updated"])("rejects %s on a comment", async (field) => {
    const root = await tempRoot();
    const handle = await seeded(root);

    expect((await storeError(handle.addComment("TASM-1", { title: "Note", [field]: 1 }))).code).toBe(
      "field-not-writable",
    );
  });

  it("rejects a store-owned field on a comment edit", async () => {
    const root = await tempRoot();
    const handle = await seeded(root);
    await handle.addComment("TASM-1", { title: "Note" });

    expect((await storeError(handle.updateComment("TASM-1", 1, { created: 1 }))).code).toBe("field-not-writable");
  });

  it.each([
    ["a comment the store builds", (handle: Project) => handle.addComment("TASM-1", { title: "Note", [SNAPSHOT]: {} })],
    ["a task", (handle: Project) => handle.updateTask("TASM-1", { [SNAPSHOT]: {} })],
  ])("rejects a snapshot marker stated as a symbol on %s, which a spread carries with the fields", async (
    _name,
    write,
  ) => {
    const root = await tempRoot();
    const handle = await seeded(root);

    const error = await storeError(write(handle));

    expect(error.code).toBe("field-not-writable");
    expect(error.message).toContain("snapshot");
  });
});

describe("a field the format requires", () => {
  it("rejects a create that states none", async () => {
    const root = await tempRoot();

    const error = await storeError(project(root).createTask({}));

    expect(error.code).toBe("field-required");
    expect(error.message).toContain("title");
  });

  it("rejects a comment that states none", async () => {
    const root = await tempRoot();
    const handle = await seeded(root);

    expect((await storeError(handle.addComment("TASM-1", { body: "text" }))).code).toBe("field-required");
  });

  it("rejects a status cleared by an update, the way it rejects a title", async () => {
    const root = await tempRoot();
    const handle = await seeded(root);

    const error = await storeError(handle.updateTask("TASM-1", { status: undefined }));

    expect(error.code).toBe("field-required");
    expect(error.message).toContain("status");
  });

  it("rejects a title cleared by an update", async () => {
    const root = await tempRoot();
    const handle = await seeded(root);

    expect((await storeError(handle.updateTask("TASM-1", { title: undefined }))).code).toBe("field-required");
  });

  it("rejects a comment title cleared by an edit", async () => {
    const root = await tempRoot();
    const handle = await seeded(root);
    await handle.addComment("TASM-1", { title: "Note" });

    expect((await storeError(handle.updateComment("TASM-1", 1, { title: undefined }))).code).toBe("field-required");
  });
});

describe("a key of no field", () => {
  it("rejects a frontmatter key this format does not define, rather than dropping it", async () => {
    const root = await tempRoot();
    const handle = await seeded(root);

    const error = await storeError(handle.updateTask("TASM-1", { reviewer: "alex" }));

    expect(error.code).toBe("field-not-writable");
    expect(error.message).toContain("reviewer");
    expect(error.message).toContain("custom");
  });

  it("rejects one on a create", async () => {
    const root = await tempRoot();

    expect((await storeError(project(root).createTask({ title: "First", reviewer: "alex" }))).code).toBe(
      "field-not-writable",
    );
  });

  it("rejects one on a comment", async () => {
    const root = await tempRoot();
    const handle = await seeded(root);

    expect((await storeError(handle.addComment("TASM-1", { title: "Note", reviewer: "alex" }))).code).toBe(
      "field-not-writable",
    );
  });
});
