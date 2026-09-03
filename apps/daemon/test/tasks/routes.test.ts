import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { TaskList, WriteResult } from "@tasma/protocol";
import { taskRoutes } from "../../src/tasks/routes.js";
import { plant, projectsRoot, send, serving, success, taskFile, tasksDir, taskText, taskWithComments } from "../helpers.js";
import type { TestServer } from "../helpers.js";

/** A planted task under another status, and the frontmatter fields it also carries. */
function entryText(id: string, status: string, extra: string[]): string {
  const fields = extra.length === 0 ? "" : `${extra.join("\n")}\n`;
  return taskText(id).replace("status: To Do\n", `status: ${status}\n${fields}`);
}

describe("GET /projects/{project}/tasks", () => {
  /**
   * Three tasks and one file the index cannot place. `TASM-1` is blocked by a
   * task that is final and so is not blocked; `TASM-3` names a blocker no file
   * carries, which keeps it blocked and reports one finding.
   */
  async function tree(): Promise<string> {
    const root = await projectsRoot("TASM");
    const tasks = tasksDir(root, "TASM");
    await plant(join(tasks, "TASM-1.md"), entryText("TASM-1", "To Do", [
      "priority: high",
      "labels: [dev, ui]",
      "parent: TASM-9",
      "step: dev:review",
      "blocked_by: [TASM-2]",
    ]));
    await plant(join(tasks, "TASM-2.md"), entryText("TASM-2", "Done", []));
    await plant(join(tasks, "TASM-3.md"), entryText("TASM-3", "In Progress", ["blocked_by: [TASM-77]"]));
    await plant(join(tasks, "TASM-4.md"), entryText("TASM-5", "To Do", []));
    return root;
  }

  async function listed(server: TestServer, search: string): Promise<string[]> {
    const response = await send(server, "GET", `/projects/TASM/tasks${search}`);
    expect(response.status).toBe(200);
    const { data } = await success<TaskList>(response);
    return data.entries.map((entry) => entry.id);
  }

  it("answers with every entry of the project and the files it could not place", async () => {
    const root = await tree();
    const server = await serving(root, taskRoutes);

    const response = await send(server, "GET", "/projects/TASM/tasks");

    expect(response.status).toBe(200);
    const { data, diagnostics } = await success<TaskList>(response);
    expect(data.entries.map((entry) => entry.id)).toEqual(["TASM-1", "TASM-2", "TASM-3"]);
    expect(data.excluded).toEqual([
      { path: taskFile(root, "TASM", "TASM-4"), code: "task-file-misnamed", message: expect.any(String) as string },
    ]);
    // Nothing read the configuration, so nothing it could report is here.
    expect(diagnostics).toEqual([]);
  });

  it.each([
    ["status", "?status=to+do", ["TASM-1"]],
    ["priority", "?priority=HIGH", ["TASM-1"]],
    ["label", "?label=dev&label=ui", ["TASM-1"]],
    ["parent", "?parent=TASM-9", ["TASM-1"]],
    ["step", "?step=dev:review", ["TASM-1"]],
  ])("applies the %s filter", async (_name, search, expected) => {
    const server = await serving(await tree(), taskRoutes);

    await expect(listed(server, search)).resolves.toEqual(expected);
  });

  it("applies two filters together", async () => {
    const server = await serving(await tree(), taskRoutes);

    await expect(listed(server, "?label=dev&status=To+Do")).resolves.toEqual(["TASM-1"]);
  });

  it("keeps the blocked entries alone under blocked=true", async () => {
    const server = await serving(await tree(), taskRoutes);

    await expect(listed(server, "?blocked=true")).resolves.toEqual(["TASM-3"]);
  });

  it("keeps the unblocked entries alone under blocked=false", async () => {
    const server = await serving(await tree(), taskRoutes);

    await expect(listed(server, "?blocked=false")).resolves.toEqual(["TASM-1", "TASM-2"]);
  });

  it("reports a blocker that names no task once, whether or not the filter kept its task", async () => {
    const root = await tree();
    const server = await serving(root, taskRoutes);

    const response = await send(server, "GET", "/projects/TASM/tasks?blocked=false");

    const { data, diagnostics } = await success<TaskList>(response);
    expect(data.entries.map((entry) => entry.id)).not.toContain("TASM-3");
    expect(diagnostics).toEqual([
      {
        code: "blocked-by-unresolved",
        message: expect.stringContaining("TASM-77") as string,
        path: taskFile(root, "TASM", "TASM-3"),
      },
    ]);
  });

  it("carries the findings of the configuration file the blocked filter reads", async () => {
    const root = await projectsRoot("TASM");
    await plant(join(root, "projects", "TASM", "config.yml"), "statues: [New]\n");
    await plant(taskFile(root, "TASM", "TASM-1"), taskText("TASM-1"));
    const server = await serving(root, taskRoutes);

    const { diagnostics } = await success<TaskList>(await send(server, "GET", "/projects/TASM/tasks?blocked=false"));

    expect(diagnostics.map((finding) => finding.code)).toContain("config-key-unknown");
  });

  it("reads no configuration file for a listing that states no blocked filter", async () => {
    const root = await projectsRoot("TASM");
    await plant(join(root, "projects", "TASM", "config.yml"), "statues: [New]\n");
    await plant(taskFile(root, "TASM", "TASM-1"), taskText("TASM-1"));
    const server = await serving(root, taskRoutes);

    const { diagnostics } = await success<TaskList>(await send(server, "GET", "/projects/TASM/tasks"));

    expect(diagnostics).toEqual([]);
  });

  it.each([
    ["a key the route does not declare", "?stauts=To+Do"],
    ["a single-value key given twice", "?status=A&status=B"],
    ["a blocked that is neither true nor false", "?blocked=yes"],
  ])("refuses %s", async (_name, search) => {
    const server = await serving(await projectsRoot("TASM"), taskRoutes);

    const response = await send(server, "GET", `/projects/TASM/tasks${search}`);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { kind: "daemon", code: "malformed-request" },
    });
  });
});

describe("GET /projects/{project}/tasks/{id}", () => {
  it("answers with the whole task, its comments among them", async () => {
    const root = await projectsRoot("TASM");
    await plant(taskFile(root, "TASM", "TASM-1"), taskWithComments("TASM-1"));
    const server = await serving(root, taskRoutes);

    const response = await send(server, "GET", "/projects/TASM/tasks/TASM-1");

    expect(response.status).toBe(200);
    const { data } = await success<{ frontmatter: { id: string }; body: string; comments: { body: string }[] }>(
      response,
    );
    expect(data.frontmatter.id).toBe("TASM-1");
    expect(data.body).toContain("Body.");
    expect(data.comments.map((comment) => comment.body.trim())).toEqual(["Ünïcödé.", "Second body."]);
  });

  it("leaves the comments key out altogether under comments=false", async () => {
    const root = await projectsRoot("TASM");
    await plant(taskFile(root, "TASM", "TASM-1"), taskWithComments("TASM-1"));
    const server = await serving(root, taskRoutes);

    const response = await send(server, "GET", "/projects/TASM/tasks/TASM-1?comments=false");

    expect(response.status).toBe(200);
    const { data } = await success<Record<string, unknown>>(response);
    expect(Object.keys(data).toSorted()).toEqual(["body", "frontmatter"]);
  });

  it("answers with the comments under comments=true, which asks for the whole task", async () => {
    const root = await projectsRoot("TASM");
    await plant(taskFile(root, "TASM", "TASM-1"), taskWithComments("TASM-1"));
    const server = await serving(root, taskRoutes);

    const { data } = await success<{ comments: unknown[] }>(
      await send(server, "GET", "/projects/TASM/tasks/TASM-1?comments=true"),
    );

    expect(data.comments).toHaveLength(2);
  });

  it("refuses a comments option that is neither true nor false", async () => {
    const root = await projectsRoot("TASM");
    await plant(taskFile(root, "TASM", "TASM-1"), taskText("TASM-1"));
    const server = await serving(root, taskRoutes);

    const response = await send(server, "GET", "/projects/TASM/tasks/TASM-1?comments=maybe");

    expect(response.status).toBe(400);
  });

  it("forwards a store refusal of a task that does not exist", async () => {
    const server = await serving(await projectsRoot("TASM"), taskRoutes);

    const response = await send(server, "GET", "/projects/TASM/tasks/TASM-9");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { kind: "store", code: "task-not-found" } });
  });

  it("forwards a parse refusal of a file that will not read back", async () => {
    const root = await projectsRoot("TASM");
    await plant(taskFile(root, "TASM", "TASM-1"), "no frontmatter here\n");
    const server = await serving(root, taskRoutes);

    const response = await send(server, "GET", "/projects/TASM/tasks/TASM-1");

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { kind: "parse", code: "frontmatter-missing" },
    });
  });
});

describe("the write routes over a task", () => {
  let root: string;
  let server: TestServer;

  beforeEach(async () => {
    root = await projectsRoot("TASM");
    await plant(taskFile(root, "TASM", "TASM-1"), entryText("TASM-1", "To Do", ["priority: high"]));
    server = await serving(root, taskRoutes);
  });

  it("creates a task and answers with the write receipt", async () => {
    const response = await send(server, "POST", "/projects/TASM/tasks", { title: "Write it", body: "text" });

    expect(response.status).toBe(200);
    const { data } = await success<WriteResult>(response);
    expect(data).toEqual({ id: "TASM-2", status: "Backlog" });
    await expect(readFile(taskFile(root, "TASM", "TASM-2"), "utf8")).resolves.toContain("title: Write it");
  });

  it("reads an absent body as a change that sets nothing, which the engine then refuses", async () => {
    const response = await send(server, "POST", "/projects/TASM/tasks");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { kind: "store", code: "field-required" },
    });
  });

  it("updates a task and answers with the write receipt", async () => {
    const response = await send(server, "PATCH", "/projects/TASM/tasks/TASM-1", { status: "Done" });

    expect(response.status).toBe(200);
    await expect(success<WriteResult>(response)).resolves.toMatchObject({ data: { id: "TASM-1", status: "Done" } });
  });

  it("clears a field named with null", async () => {
    const response = await send(server, "PATCH", "/projects/TASM/tasks/TASM-1", { priority: null });

    expect(response.status).toBe(200);
    await expect(readFile(taskFile(root, "TASM", "TASM-1"), "utf8")).resolves.not.toContain("priority");
  });

  it("leaves a field the change does not name alone", async () => {
    const response = await send(server, "PATCH", "/projects/TASM/tasks/TASM-1", { status: "Done" });

    expect(response.status).toBe(200);
    await expect(readFile(taskFile(root, "TASM", "TASM-1"), "utf8")).resolves.toContain("priority: high");
  });

  it("deletes a task and answers with the write receipt", async () => {
    const response = await send(server, "DELETE", "/projects/TASM/tasks/TASM-1");

    expect(response.status).toBe(200);
    await expect(success<WriteResult>(response)).resolves.toEqual({ data: { id: "TASM-1" }, diagnostics: [] });
    await expect(readFile(taskFile(root, "TASM", "TASM-1"), "utf8")).rejects.toThrow();
  });

  it("forwards a store refusal of a task the delete finds no file for", async () => {
    const response = await send(server, "DELETE", "/projects/TASM/tasks/TASM-9");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { kind: "store", code: "task-not-found" } });
  });

  it("forwards a store refusal of a field the engine owns", async () => {
    const response = await send(server, "PATCH", "/projects/TASM/tasks/TASM-1", { id: "TASM-9" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { kind: "store", code: "field-not-writable" },
    });
  });

  it("forwards a serialize refusal of a value the writer cannot put in the file", async () => {
    const response = await send(server, "PATCH", "/projects/TASM/tasks/TASM-1", { body: 42 });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { kind: "serialize", code: "key-type" },
    });
  });

  it.each([
    ["an array", []],
    ["a scalar", "text"],
    ["null", null],
  ])("refuses a body that is %s rather than an object", async (_name, body) => {
    const response = await send(server, "POST", "/projects/TASM/tasks", body);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { kind: "daemon", code: "malformed-request" },
    });
  });

  it("refuses a body it cannot read before it opens the project the path names", async () => {
    const response = await send(server, "POST", "/projects/NOPE/tasks", "text");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { kind: "daemon", code: "malformed-request" },
    });
  });

  it("refuses any query key at all on a write route", async () => {
    const response = await send(server, "DELETE", "/projects/TASM/tasks/TASM-1?comments=false");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { kind: "daemon", code: "malformed-request" },
    });
  });
});

describe("two writes to one project that arrive at once", () => {
  let root: string;
  let server: TestServer;

  beforeEach(async () => {
    root = await projectsRoot("TASM");
    await plant(taskFile(root, "TASM", "TASM-1"), entryText("TASM-1", "To Do", ["priority: high"]));
    server = await serving(root, taskRoutes);
  });

  it("keeps both of two updates of one task", async () => {
    const responses = await Promise.all([
      send(server, "PATCH", "/projects/TASM/tasks/TASM-1", { title: "Renamed" }),
      send(server, "PATCH", "/projects/TASM/tasks/TASM-1", { status: "Done" }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const text = await readFile(taskFile(root, "TASM", "TASM-1"), "utf8");
    expect(text).toContain("title: Renamed");
    expect(text).toContain("status: Done");
  });

  it("gives each of eight creates its own id and its own file", async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, n) => send(server, "POST", "/projects/TASM/tasks", { title: `Task ${n}` })),
    );

    expect(responses.map((response) => response.status)).toEqual(Array.from({ length: 8 }, () => 200));
    const ids = await Promise.all(responses.map(async (response) => (await success<WriteResult>(response)).data.id));
    expect(new Set(ids).size).toBe(8);
    for (const id of ids) {
      await expect(readFile(taskFile(root, "TASM", id), "utf8")).resolves.toContain("title: Task");
    }
  });
});
