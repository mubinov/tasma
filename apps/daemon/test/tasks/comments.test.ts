import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import type { CommentHeader, WriteResult } from "@tasma/protocol";
import { taskRoutes } from "../../src/tasks/routes.js";
import { plant, projectsRoot, send, serving, success, taskFile, taskText, taskWithComments, TIMESTAMP } from "../helpers.js";
import type { TestServer } from "../helpers.js";

describe("GET /projects/{project}/tasks/{id}/comments", () => {
  it("answers with one header per comment, the body replaced by its size in bytes", async () => {
    const root = await projectsRoot("TASM");
    await plant(taskFile(root, "TASM", "TASM-1"), taskWithComments("TASM-1"));
    const server = await serving(root, taskRoutes);

    const response = await send(server, "GET", "/projects/TASM/tasks/TASM-1/comments");

    expect(response.status).toBe(200);
    const { data } = await success<CommentHeader[]>(response);
    expect(data).toEqual([
      {
        id: 1,
        title: "First",
        created: TIMESTAMP,
        author: "almaz",
        // The body runs to the line before the next marker: eleven characters
        // and, because four of them are multi-byte, fifteen bytes.
        bytes: 15,
        // The lines the comment sits on inside `taskWithComments`; an edit to
        // that fixture moves both this pair and the next.
        lines: { start: 12, end: 15 },
      },
      {
        id: 2,
        title: "Second",
        created: TIMESTAMP,
        updated: TIMESTAMP,
        collapsed: true,
        custom: { round: 2 },
        bytes: 14,
        lines: { start: 16, end: 25 },
      },
    ]);
  });

  it("answers with an empty list for a task that holds no comment", async () => {
    const root = await projectsRoot("TASM");
    await plant(taskFile(root, "TASM", "TASM-1"), taskText("TASM-1"));
    const server = await serving(root, taskRoutes);

    const response = await send(server, "GET", "/projects/TASM/tasks/TASM-1/comments");

    expect(response.status).toBe(200);
    await expect(success<CommentHeader[]>(response)).resolves.toEqual({ data: [], diagnostics: [] });
  });

  it("forwards a store refusal of a task that does not exist", async () => {
    const server = await serving(await projectsRoot("TASM"), taskRoutes);

    const response = await send(server, "GET", "/projects/TASM/tasks/TASM-9/comments");

    expect(response.status).toBe(404);
  });

  it("refuses any query key at all", async () => {
    const root = await projectsRoot("TASM");
    await plant(taskFile(root, "TASM", "TASM-1"), taskText("TASM-1"));
    const server = await serving(root, taskRoutes);

    const response = await send(server, "GET", "/projects/TASM/tasks/TASM-1/comments?comments=false");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { kind: "daemon", code: "malformed-request" },
    });
  });
});

describe("the write routes over a comment", () => {
  let root: string;
  let server: TestServer;

  beforeEach(async () => {
    root = await projectsRoot("TASM");
    await plant(taskFile(root, "TASM", "TASM-1"), taskWithComments("TASM-1"));
    server = await serving(root, taskRoutes);
  });

  it("adds a comment and answers with the write receipt", async () => {
    const response = await send(server, "POST", "/projects/TASM/tasks/TASM-1/comments", {
      title: "Third",
      body: "text",
    });

    expect(response.status).toBe(200);
    await expect(success<WriteResult>(response)).resolves.toEqual({
      data: { id: "TASM-1", commentId: 3 },
      diagnostics: [],
    });
    await expect(readFile(taskFile(root, "TASM", "TASM-1"), "utf8")).resolves.toContain("Third");
  });

  it("updates a comment and answers with the write receipt", async () => {
    const response = await send(server, "PATCH", "/projects/TASM/tasks/TASM-1/comments/1", { title: "Renamed" });

    expect(response.status).toBe(200);
    await expect(success<WriteResult>(response)).resolves.toMatchObject({ data: { id: "TASM-1", commentId: 1 } });
    await expect(readFile(taskFile(root, "TASM", "TASM-1"), "utf8")).resolves.toContain("Renamed");
  });

  it("clears a comment field named with null", async () => {
    const response = await send(server, "PATCH", "/projects/TASM/tasks/TASM-1/comments/1", { author: null });

    expect(response.status).toBe(200);
    await expect(readFile(taskFile(root, "TASM", "TASM-1"), "utf8")).resolves.not.toContain("almaz");
  });

  it("deletes a comment and answers with the write receipt", async () => {
    const response = await send(server, "DELETE", "/projects/TASM/tasks/TASM-1/comments/1");

    expect(response.status).toBe(200);
    await expect(success<WriteResult>(response)).resolves.toMatchObject({ data: { id: "TASM-1", commentId: 1 } });
    await expect(readFile(taskFile(root, "TASM", "TASM-1"), "utf8")).resolves.not.toContain("Ünïcödé");
  });

  it("forwards a store refusal of a comment an add leaves a required field out of", async () => {
    const response = await send(server, "POST", "/projects/TASM/tasks/TASM-1/comments", { body: "text" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { kind: "store", code: "field-required" },
    });
  });

  it("forwards a store refusal of a comment an update finds no marker for", async () => {
    const response = await send(server, "PATCH", "/projects/TASM/tasks/TASM-1/comments/9", { title: "Renamed" });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { kind: "store", code: "comment-not-found" },
    });
  });

  it("forwards a store refusal of a comment the file does not hold", async () => {
    const response = await send(server, "DELETE", "/projects/TASM/tasks/TASM-1/comments/9");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { kind: "store", code: "comment-not-found" },
    });
  });

  it.each([
    ["a comment id that is no decimal integer", "/projects/TASM/tasks/TASM-1/comments/one"],
    ["a comment id outside the range a number carries exactly", "/projects/TASM/tasks/TASM-1/comments/9007199254740993"],
  ])("refuses %s", async (_name, path) => {
    const response = await send(server, "DELETE", path);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { kind: "daemon", code: "malformed-request" },
    });
  });

  it("refuses a body that is not an object", async () => {
    const response = await send(server, "POST", "/projects/TASM/tasks/TASM-1/comments", ["Third"]);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { kind: "daemon", code: "malformed-request" },
    });
  });

  it("refuses any query key at all on a comment write route", async () => {
    const response = await send(server, "PATCH", "/projects/TASM/tasks/TASM-1/comments/1?label=dev", {
      title: "Renamed",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { kind: "daemon", code: "malformed-request" },
    });
  });
});

describe("two comment writes that arrive at once", () => {
  it("gives two comments added at once an id each and keeps both", async () => {
    const root = await projectsRoot("TASM");
    await plant(taskFile(root, "TASM", "TASM-1"), taskText("TASM-1"));
    const server = await serving(root, taskRoutes);

    const responses = await Promise.all([
      send(server, "POST", "/projects/TASM/tasks/TASM-1/comments", { title: "First", body: "one" }),
      send(server, "POST", "/projects/TASM/tasks/TASM-1/comments", { title: "Second", body: "two" }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const receipts = await Promise.all(
      responses.map(async (response) => (await success<WriteResult>(response)).data.commentId),
    );
    expect(receipts).toHaveLength(2);
    expect(receipts).toEqual(expect.arrayContaining([1, 2]));
    const text = await readFile(taskFile(root, "TASM", "TASM-1"), "utf8");
    expect(text).toContain("one");
    expect(text).toContain("two");
  });
});
