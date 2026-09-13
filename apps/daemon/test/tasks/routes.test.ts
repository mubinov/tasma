import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { IndexedProject, TaskChange } from "@tasma/engine";
import { routes } from "@tasma/protocol";
import type { TaskList, TaskText, WriteResult } from "@tasma/protocol";
import type { HandlerRequest } from "../../src/http/router.js";
import { createProjectHost } from "../../src/projects/host.js";
import type { ProjectHost } from "../../src/projects/host.js";
import { taskRoutes } from "../../src/tasks/routes.js";
import { WriteQueue } from "../../src/tasks/serialize.js";
import {
  plant,
  plantSteps,
  projectConfig,
  projectsRoot,
  send,
  serving,
  startTestServer,
  success,
  taskFile,
  tasksDir,
  taskText,
  taskWithComments,
  until,
} from "../helpers.js";
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
    expect(data.entries.map(({ id, blocked }) => ({ id, blocked }))).toEqual([
      { id: "TASM-1", blocked: false },
      { id: "TASM-2", blocked: false },
      { id: "TASM-3", blocked: true },
    ]);
    expect(data.excluded).toEqual([
      { path: taskFile(root, "TASM", "TASM-4"), code: "task-file-misnamed", message: expect.any(String) as string },
    ]);
    expect(diagnostics).toEqual([
      {
        code: "blocked-by-unresolved",
        message: expect.stringContaining("TASM-77") as string,
        path: taskFile(root, "TASM", "TASM-3"),
      },
    ]);
  });

  it("flags a blocked entry that another filter kept, and reports its unresolved blocker", async () => {
    const root = await tree();
    const server = await serving(root, taskRoutes);

    const response = await send(server, "GET", "/projects/TASM/tasks?status=In+Progress");

    const { data, diagnostics } = await success<TaskList>(response);
    expect(data.entries.map(({ id, blocked }) => ({ id, blocked }))).toEqual([{ id: "TASM-3", blocked: true }]);
    expect(diagnostics).toEqual([
      {
        code: "blocked-by-unresolved",
        message: expect.stringContaining("TASM-77") as string,
        path: taskFile(root, "TASM", "TASM-3"),
      },
    ]);
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

  it("carries the findings of the configuration file for a listing that states no filter", async () => {
    const root = await projectsRoot("TASM");
    await plant(projectConfig(root, "TASM"), "statues: [New]\n");
    await plant(taskFile(root, "TASM", "TASM-1"), taskText("TASM-1"));
    const server = await serving(root, taskRoutes);

    const { diagnostics } = await success<TaskList>(await send(server, "GET", "/projects/TASM/tasks"));

    expect(diagnostics.map((finding) => finding.code)).toContain("config-key-unknown");
  });

  it("refuses a listing that states no filter over an invalid configuration", async () => {
    const root = await projectsRoot("TASM");
    await plant(projectConfig(root, "TASM"), "statuses: [To Do, Done]\nfinal_statuses: [Closed]\n");
    await plant(taskFile(root, "TASM", "TASM-1"), taskText("TASM-1"));
    const server = await serving(root, taskRoutes);

    const response = await send(server, "GET", "/projects/TASM/tasks");

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { kind: "store", code: "config-invalid" },
    });
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

describe("GET /projects/{project}/tasks/{id}/text", () => {
  /** A tree holding the planted task, and the bytes it was planted with. */
  async function planted(text = taskWithComments("TASM-1")): Promise<{ server: TestServer; text: string }> {
    const root = await projectsRoot("TASM");
    await plant(taskFile(root, "TASM", "TASM-1"), text);
    return { server: await serving(root, taskRoutes), text };
  }

  async function textOf(server: TestServer, search: string): Promise<TaskText> {
    const response = await send(server, "GET", `/projects/TASM/tasks/TASM-1/text${search}`);
    expect(response.status).toBe(200);
    return (await success<TaskText>(response)).data;
  }

  it("answers with the file byte for byte", async () => {
    const { server, text } = await planted();

    await expect(textOf(server, "")).resolves.toEqual({ text, hidden: [] });
  });

  it("leaves the body of a collapsed comment out under collapsed=false, and names it", async () => {
    const { server, text } = await planted();

    await expect(textOf(server, "?collapsed=false")).resolves.toEqual({
      text: text.replace("\nSecond body.\n", ""),
      hidden: [2],
    });
  });

  it("answers with one comment alone, its marker and its body", async () => {
    const { server, text } = await planted();

    await expect(textOf(server, "?comment=2")).resolves.toEqual({
      text: text.slice(text.indexOf("<!-- task:comment\n")),
      hidden: [],
    });
  });

  it("refuses a comment id the file carries no comment under", async () => {
    const { server } = await planted();

    const response = await send(server, "GET", "/projects/TASM/tasks/TASM-1/text?comment=9");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { kind: "store", code: "comment-not-found" },
    });
  });

  it("forwards a store refusal of a task that does not exist", async () => {
    const { server } = await planted();

    const response = await send(server, "GET", "/projects/TASM/tasks/TASM-9/text");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { kind: "store", code: "task-not-found" } });
  });

  it("refuses the two selections together", async () => {
    const { server } = await planted();

    const response = await send(server, "GET", "/projects/TASM/tasks/TASM-1/text?comment=2&collapsed=false");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { kind: "daemon", code: "malformed-request" },
    });
  });

  it("carries the findings of the file it read on the envelope", async () => {
    const { server } = await planted(taskWithComments("TASM-1").replace("next_comment_id: 3", "next_comment_id: 2"));

    const response = await send(server, "GET", "/projects/TASM/tasks/TASM-1/text");

    const { diagnostics } = await success<TaskText>(response);
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["stale-next-comment-id"]);
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

  it("takes the deleted id out of a task that named it, which the blocked filter then lists no more", async () => {
    await plant(taskFile(root, "TASM", "TASM-2"), entryText("TASM-2", "To Do", ["blocked_by: [TASM-1]"]));

    const response = await send(server, "DELETE", "/projects/TASM/tasks/TASM-1");

    expect(response.status).toBe(200);
    await expect(success<WriteResult>(response)).resolves.toEqual({ data: { id: "TASM-1" }, diagnostics: [] });
    await expect(readFile(taskFile(root, "TASM", "TASM-2"), "utf8")).resolves.not.toContain("blocked_by");
    const listed = await send(server, "GET", "/projects/TASM/tasks?blocked=true");
    await expect(success<TaskList>(listed)).resolves.toMatchObject({ data: { entries: [] } });
    const all = await success<TaskList>(await send(server, "GET", "/projects/TASM/tasks"));
    expect(all.data.entries.map(({ id, blocked }) => ({ id, blocked }))).toEqual([{ id: "TASM-2", blocked: false }]);
  });

  it.each([
    ["POST", "/projects/TASM/tasks", { title: "Blocked" }],
    ["PATCH", "/projects/TASM/tasks/TASM-1", {}],
  ])("takes the turn of a listed blocker alone, however many unknown ones a %s states", async (method, path, fields) => {
    await plant(taskFile(root, "TASM", "TASM-2"), entryText("TASM-2", "To Do", []));
    const turns = vi.spyOn(WriteQueue.prototype, "run");
    onTestFinished(() => turns.mockRestore());
    const unknown = Array.from({ length: 10_000 }, (_, n) => `TASM-${n + 100}`);

    const response = await send(server, method, path, { ...fields, blocked_by: [...unknown, "TASM-2"] });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { kind: "store", code: "blocked-by-unknown" },
    });
    // The write's own key, and the key of TASM-2.
    expect(turns).toHaveBeenCalledTimes(2);
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

/**
 * A step is set through the task patch and no route of its own, so this is where
 * the daemon pins that. Every rule below is the engine's, and the daemon adds no
 * check of its own.
 */
describe("the step of a task, set through the patch that writes it", () => {
  let root: string;
  let server: TestServer;

  beforeEach(async () => {
    root = await projectsRoot("TASM");
    await plant(projectConfig(root, "TASM"), "workflows: [dev]\n");
    await plantSteps(root, "dev", "dev:research", "dev:implement");
    await plant(taskFile(root, "TASM", "TASM-1"), entryText("TASM-1", "To Do", ["workflow: dev"]));
    server = await serving(root, taskRoutes);
  });

  it("writes a step the task's workflow declares", async () => {
    const response = await send(server, "PATCH", "/projects/TASM/tasks/TASM-1", { step: "dev:research" });

    expect(response.status).toBe(200);
    await expect(success<WriteResult>(response)).resolves.toEqual({ data: { id: "TASM-1" }, diagnostics: [] });
    await expect(readFile(taskFile(root, "TASM", "TASM-1"), "utf8")).resolves.toContain("step: dev:research");
  });

  it("clears the step named with null", async () => {
    await send(server, "PATCH", "/projects/TASM/tasks/TASM-1", { step: "dev:research" });

    const response = await send(server, "PATCH", "/projects/TASM/tasks/TASM-1", { step: null });

    expect(response.status).toBe(200);
    await expect(readFile(taskFile(root, "TASM", "TASM-1"), "utf8")).resolves.not.toContain("step:");
  });

  it("refuses a step the task's workflow does not declare", async () => {
    const response = await send(server, "PATCH", "/projects/TASM/tasks/TASM-1", { step: "dev:release" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { kind: "store", code: "step-unknown" } });
  });

  it("refuses a workflow the project does not declare, along with the step of it", async () => {
    await plantSteps(root, "review", "review:read");

    const response = await send(server, "PATCH", "/projects/TASM/tasks/TASM-1", {
      workflow: "review",
      step: "review:read",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { kind: "store", code: "workflow-unknown" },
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

  /**
   * A server whose create and update are held until a delete has entered its
   * handler, so the order in `reached` is the queue's decision rather than the
   * order the socket delivered.
   */
  async function heldServer(): Promise<{ held: TestServer; reached: string[] }> {
    const inner = createProjectHost({ root });
    onTestFinished(() => inner.close());

    const reached: string[] = [];
    let queued!: () => void;
    const behind = new Promise<void>((resolve) => {
      queued = resolve;
    });
    async function heldWrite(name: string, write: () => Promise<WriteResult>): Promise<WriteResult> {
      reached.push(name);
      await behind;
      const result = await write();
      reached.push(`${name} done`);
      return result;
    }
    const host: ProjectHost = {
      ...inner,
      async open(tag) {
        const opened = await inner.open(tag);
        // The routes under test call these five alone.
        const index = {
          query: () => opened.index.query(),
          referencesTo: (id: string) => opened.index.referencesTo(id),
          createTask: (change: TaskChange) => heldWrite("create", () => opened.index.createTask(change)),
          updateTask: (id: string, change: TaskChange) =>
            heldWrite("patch", () => opened.index.updateTask(id, change)),
          async deleteTask(id: string) {
            reached.push("delete");
            return opened.index.deleteTask(id);
          },
        } as Partial<IndexedProject> as IndexedProject;
        return { ...opened, index };
      },
    };
    const entries = taskRoutes(host).map((entry) => {
      if (entry.route !== routes.deleteTask) return entry;
      return {
        ...entry,
        handler: (request: HandlerRequest) => {
          queued();
          return entry.handler(request);
        },
      };
    });
    return { held: await startTestServer(entries), reached };
  }

  it("runs a delete after the patch of a task it takes a reference out of, and keeps both changes", async () => {
    await plant(taskFile(root, "TASM", "TASM-2"), entryText("TASM-2", "To Do", ["blocked_by: [TASM-1]"]));
    const { held, reached } = await heldServer();

    const patching = send(held, "PATCH", "/projects/TASM/tasks/TASM-2", { title: "Renamed" });
    await until(() => reached.includes("patch"), "the patch took its turn");
    const deleted = await send(held, "DELETE", "/projects/TASM/tasks/TASM-1");

    expect((await patching).status).toBe(200);
    expect(deleted.status).toBe(200);
    expect(reached).toEqual(["patch", "patch done", "delete"]);
    const text = await readFile(taskFile(root, "TASM", "TASM-2"), "utf8");
    expect(text).toContain("title: Renamed");
    expect(text).not.toContain("blocked_by");
  });

  it("runs a delete after a patch that states the deleted task as a blocker, and takes the blocker out", async () => {
    await plant(taskFile(root, "TASM", "TASM-2"), entryText("TASM-2", "To Do", []));
    const { held, reached } = await heldServer();

    const patching = send(held, "PATCH", "/projects/TASM/tasks/TASM-2", { blocked_by: ["TASM-1"] });
    await until(() => reached.includes("patch"), "the patch took its turn");
    const deleted = await send(held, "DELETE", "/projects/TASM/tasks/TASM-1");

    expect((await patching).status).toBe(200);
    expect(deleted.status).toBe(200);
    expect(reached).toEqual(["patch", "patch done", "delete"]);
    await expect(readFile(taskFile(root, "TASM", "TASM-2"), "utf8")).resolves.not.toContain("blocked_by");
  });

  it("runs a delete after a create that states the deleted task as a blocker, and takes the blocker out", async () => {
    const { held, reached } = await heldServer();

    const creating = send(held, "POST", "/projects/TASM/tasks", { title: "Blocked", blocked_by: ["TASM-1"] });
    await until(() => reached.includes("create"), "the create took its turn");
    const deleted = await send(held, "DELETE", "/projects/TASM/tasks/TASM-1");

    const created = await success<WriteResult>(await creating);
    expect(deleted.status).toBe(200);
    expect(reached).toEqual(["create", "create done", "delete"]);
    await expect(readFile(taskFile(root, "TASM", created.data.id), "utf8")).resolves.not.toContain("blocked_by");
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
