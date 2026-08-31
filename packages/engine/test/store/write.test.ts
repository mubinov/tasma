import { readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseTask, type Project } from "@tasma/engine";
import { fixture } from "../format/fixtures.js";
import { afterFrontmatter } from "../format/tasks.js";
import { plantWorkflow, stepsOnly } from "../workflow/helpers.js";
import {
  codes,
  plant,
  project,
  projectConfig,
  read,
  tasksDir,
  taskFile,
  taskText,
  TIMESTAMP,
  tempRoot,
} from "./helpers.js";

/** The reference example under this project's tag: every optional key, YAML comments and two comments. */
function richTask(): string {
  return fixture("valid/example.md").replaceAll("PROJ-", "TASM-");
}

describe("createTask", () => {
  it("writes every field it is given and reads them back", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "workflows: [delivery]\n");
    await plantWorkflow(root, "delivery", stepsOnly("build"));
    const handle = project(root);

    const result = await handle.createTask({
      title: "Import the address book",
      status: "In Progress",
      priority: "high",
      order: 4200,
      labels: ["import"],
      parent: "TASM-30",
      workflow: "delivery",
      step: "build",
      custom: { workflow: { attempts: 2 } },
      body: "\n# Goal\n\nText.\n",
    });

    expect(result.id).toBe("TASM-1");
    const { task } = await handle.readTask("TASM-1");
    expect(task.frontmatter).toMatchObject({
      id: "TASM-1",
      title: "Import the address book",
      status: "In Progress",
      priority: "high",
      order: 4200,
      labels: ["import"],
      parent: "TASM-30",
      workflow: "delivery",
      step: "build",
      custom: { workflow: { attempts: 2 } },
      next_comment_id: 1,
    });
    expect(task.frontmatter.created).toBe(task.frontmatter.updated);
    expect(task.body).toBe("\n# Goal\n\nText.\n");
  });

  it("writes data of another component under custom", async () => {
    const root = await tempRoot();

    await project(root).createTask({ title: "First", custom: { review: { reviewer: "alex" } } });

    expect(parseTask(await read(taskFile(root, "TASM-1"))).task.frontmatter.custom).toEqual({
      review: { reviewer: "alex" },
    });
  });

  it("creates the tasks directory on demand", async () => {
    const root = await tempRoot();

    await project(root).createTask({ title: "First" });

    await expect(readdir(tasksDir(root))).resolves.toEqual(["TASM-1.md"]);
  });

  it("stamps created and updated with the current time, to the second and with an offset", async () => {
    const root = await tempRoot();

    await project(root).createTask({ title: "First" });

    const { created } = (await project(root).readTask("TASM-1")).task.frontmatter;
    expect(created).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(Math.abs(Date.parse(created) - Date.now())).toBeLessThan(60_000);
  });
});

describe("updateTask", () => {
  it("leaves every region it did not change byte-identical", async () => {
    const root = await tempRoot();
    const source = richTask();
    await plant(taskFile(root, "TASM-42"), source);

    await project(root).updateTask("TASM-42", { title: "Renamed" });

    const written = await read(taskFile(root, "TASM-42"));
    expect(afterFrontmatter(written)).toBe(afterFrontmatter(source));
    expect(parseTask(written).task.frontmatter).toMatchObject({
      title: "Renamed",
      custom: { workflow: { attempts: 2 } },
      labels: ["import"],
    });
  });

  it("moves updated for a title change", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));

    await project(root).updateTask("TASM-1", { title: "Renamed" });

    const { frontmatter } = (await project(root).readTask("TASM-1")).task;
    expect(frontmatter.updated).not.toBe(TIMESTAMP);
    expect(frontmatter.created).toBe(TIMESTAMP);
  });

  it("leaves updated alone for a change of order alone", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));

    await project(root).updateTask("TASM-1", { order: 100 });

    const { frontmatter } = (await project(root).readTask("TASM-1")).task;
    expect(frontmatter.order).toBe(100);
    expect(frontmatter.updated).toBe(TIMESTAMP);
  });

  it("moves updated when order changes together with another field", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));

    await project(root).updateTask("TASM-1", { order: 100, title: "Renamed" });

    expect((await project(root).readTask("TASM-1")).task.frontmatter.updated).not.toBe(TIMESTAMP);
  });

  it("writes the body a change states", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));

    await project(root).updateTask("TASM-1", { body: "\nRewritten.\n" });

    const { frontmatter, body } = (await project(root).readTask("TASM-1")).task;
    expect(body).toBe("\nRewritten.\n");
    expect(frontmatter.updated).not.toBe(TIMESTAMP);
  });

  it("clears the body a change states with no value", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));

    await project(root).updateTask("TASM-1", { body: undefined });

    const { frontmatter, body } = (await project(root).readTask("TASM-1")).task;
    expect(body).toBe("");
    expect(frontmatter.updated).not.toBe(TIMESTAMP);
  });

  it("changes nothing when every field it states already holds that value", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));
    const before = await read(taskFile(root, "TASM-1"));

    const result = await project(root).updateTask("TASM-1", { title: "Planted", status: "To Do" });

    expect(result.diagnostics).toEqual([]);
    expect(await read(taskFile(root, "TASM-1"))).toBe(before);
  });

  it("forwards a diagnostic of the reader with the path and the line it points at", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), `${taskText("TASM-1")}\n\`\`\`sh\nnever closed\n`);

    const result = await project(root).updateTask("TASM-1", { title: "Renamed" });

    expect(result.diagnostics).toEqual([
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- an asymmetric matcher is typed `any`
      { code: "unterminated-fence", message: expect.any(String), path: taskFile(root, "TASM-1"), line: 12 },
    ]);
  });
});

describe("comments", () => {
  async function withComment(root: string): Promise<Project> {
    const handle = project(root);
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));
    await handle.addComment("TASM-1", { title: "First note", author: "alex", body: "\nText.\n" });
    return handle;
  }

  it("appends a comment and issues its id", async () => {
    const root = await tempRoot();
    const handle = await withComment(root);

    const { task } = await handle.readTask("TASM-1");

    expect(task.comments).toHaveLength(1);
    expect(task.comments[0]).toMatchObject({ id: 1, title: "First note", author: "alex" });
    expect(task.comments[0]?.body).toBe("\nText.\n");
    expect(task.frontmatter.next_comment_id).toBe(2);
    expect(task.frontmatter.updated).not.toBe(TIMESTAMP);
  });

  it("moves both timestamps on a comment edit", async () => {
    const root = await tempRoot();
    const handle = await withComment(root);

    await handle.updateComment("TASM-1", 1, { title: "Edited" });

    const { task } = await handle.readTask("TASM-1");
    expect(task.comments[0]).toMatchObject({ title: "Edited" });
    expect(task.comments[0]?.updated).toBeTypeOf("string");
    expect(task.frontmatter.updated).not.toBe(TIMESTAMP);
  });

  it("clears the body of a comment on an edit that states none", async () => {
    const root = await tempRoot();
    const handle = await withComment(root);

    await handle.updateComment("TASM-1", 1, { body: undefined });

    expect((await handle.readTask("TASM-1")).task.comments[0]?.body).toBe("");
  });

  it("writes the body of a comment edit", async () => {
    const root = await tempRoot();
    const handle = await withComment(root);

    await handle.updateComment("TASM-1", 1, { body: "\nRewritten.\n" });

    expect((await handle.readTask("TASM-1")).task.comments[0]?.body).toBe("\nRewritten.\n");
  });

  it("changes nothing when a comment edit states the values the comment holds", async () => {
    const root = await tempRoot();
    const handle = await withComment(root);
    const before = await read(taskFile(root, "TASM-1"));

    await handle.updateComment("TASM-1", 1, { title: "First note" });

    expect(await read(taskFile(root, "TASM-1"))).toBe(before);
  });

  it("deletes a comment and leaves the counter where it stands", async () => {
    const root = await tempRoot();
    const handle = await withComment(root);

    await handle.deleteComment("TASM-1", 1);

    const { task } = await handle.readTask("TASM-1");
    expect(task.comments).toEqual([]);
    expect(task.frontmatter.next_comment_id).toBe(2);
  });

  it("keeps a comment it did not touch byte-identical", async () => {
    const root = await tempRoot();
    const source = richTask();
    await plant(taskFile(root, "TASM-42"), source);

    await project(root).updateComment("TASM-42", 1, { title: "Renamed" });

    const written = await read(taskFile(root, "TASM-42"));
    const marker = source.slice(source.indexOf("<!-- task:comment\n"));
    expect(written).toContain(marker);
  });
});

describe("deleteTask", () => {
  it("removes the file", async () => {
    const root = await tempRoot();
    const handle = project(root);
    await handle.createTask({ title: "First" });

    const result = await handle.deleteTask("TASM-1");

    expect(result.id).toBe("TASM-1");
    await expect(readdir(tasksDir(root))).resolves.toEqual([]);
  });

  it.each([
    ["carries the id of another task", taskText("TASM-30")],
    ["cannot be parsed at all", "no frontmatter here\n"],
  ])("removes a file that %s, because it opens none", async (_name, text) => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), text);

    await project(root).deleteTask("TASM-1");

    await expect(readdir(tasksDir(root))).resolves.toEqual([]);
  });
});

describe("listTaskIds", () => {
  it("reads the names of the task files, in the order of their number", async () => {
    const root = await tempRoot();
    const handle = project(root);
    for (const title of ["First", "Second", "Third"]) await handle.createTask({ title });

    const { ids, diagnostics } = await handle.listTaskIds();

    expect(ids).toEqual(["TASM-1", "TASM-2", "TASM-3"]);
    expect(diagnostics).toEqual([]);
  });

  it("reads a project with no tasks directory as empty", async () => {
    const root = await tempRoot();

    await expect(project(root).listTaskIds()).resolves.toEqual({ ids: [], diagnostics: [] });
  });

  it("returns an id whose file carries another id, because it reads names alone", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-30"));

    const { ids } = await project(root).listTaskIds();

    expect(ids).toEqual(["TASM-1"]);
    expect(codes((await project(root).listTaskIds()).diagnostics)).toEqual([]);
  });
});
