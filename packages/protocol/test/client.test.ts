import { describe, expect, it } from "vitest";
import { createClient, ProtocolError, TransportError } from "@tasma/protocol";
import type {
  Client,
  CommentHeader,
  Failure,
  Method,
  ProjectSummary,
  Transport,
  TransportReply,
  TransportRequest,
} from "@tasma/protocol";

function recorder(reply: TransportReply): { calls: TransportRequest[]; transport: Transport } {
  const calls: TransportRequest[] = [];
  return {
    calls,
    transport: async (request) => {
      calls.push(request);
      return reply;
    },
  };
}

function ok(data: unknown): TransportReply {
  return { status: 200, body: { ok: true, data, diagnostics: [] } };
}

/** One call per client method, with the request each one is required to send. */
type Invocation = {
  name: string;
  send: (client: Client) => Promise<unknown>;
  method: Method;
  path: string;
  body?: unknown;
};

const invocations: Invocation[] = [
  {
    name: "readHealth",
    send: (client) => client.readHealth(),
    method: "GET",
    path: "/health",
  },
  {
    name: "listProjects",
    send: (client) => client.listProjects(),
    method: "GET",
    path: "/projects",
  },
  {
    name: "readProject",
    send: (client) => client.readProject("TASM"),
    method: "GET",
    path: "/projects/TASM",
  },
  {
    name: "listTasks",
    send: (client) => client.listTasks("TASM", { status: "To Do", label: ["dev"] }),
    method: "GET",
    path: "/projects/TASM/tasks?status=To%20Do&label=dev",
  },
  {
    name: "createTask",
    send: (client) => client.createTask("TASM", { title: "Write it", body: "text" }),
    method: "POST",
    path: "/projects/TASM/tasks",
    body: { title: "Write it", body: "text" },
  },
  {
    name: "readTask",
    send: (client) => client.readTask("TASM", "TASM-3"),
    method: "GET",
    path: "/projects/TASM/tasks/TASM-3",
  },
  {
    name: "readTask without the comments",
    send: (client) => client.readTask("TASM", "TASM-3", { comments: false }),
    method: "GET",
    path: "/projects/TASM/tasks/TASM-3?comments=false",
  },
  {
    name: "updateTask",
    send: (client) => client.updateTask("TASM", "TASM-3", { status: "Done" }),
    method: "PATCH",
    path: "/projects/TASM/tasks/TASM-3",
    body: { status: "Done" },
  },
  {
    name: "deleteTask",
    send: (client) => client.deleteTask("TASM", "TASM-3"),
    method: "DELETE",
    path: "/projects/TASM/tasks/TASM-3",
  },
  {
    name: "listComments",
    send: (client) => client.listComments("TASM", "TASM-3"),
    method: "GET",
    path: "/projects/TASM/tasks/TASM-3/comments",
  },
  {
    name: "addComment",
    send: (client) => client.addComment("TASM", "TASM-3", { title: "Note", body: "text" }),
    method: "POST",
    path: "/projects/TASM/tasks/TASM-3/comments",
    body: { title: "Note", body: "text" },
  },
  {
    name: "updateComment",
    send: (client) => client.updateComment("TASM", "TASM-3", 7, { collapsed: true }),
    method: "PATCH",
    path: "/projects/TASM/tasks/TASM-3/comments/7",
    body: { collapsed: true },
  },
  {
    name: "deleteComment",
    send: (client) => client.deleteComment("TASM", "TASM-3", 7),
    method: "DELETE",
    path: "/projects/TASM/tasks/TASM-3/comments/7",
  },
];

describe("the client", () => {
  it.each(invocations)("sends the request $name declares", async (invocation) => {
    const { calls, transport } = recorder(ok(null));
    await invocation.send(createClient(transport));

    expect(calls).toEqual([{ method: invocation.method, path: invocation.path, body: invocation.body }]);
  });

  it("returns the data and the diagnostics of a success", async () => {
    const diagnostics = [{ code: "temp-file-left" as const, message: "a temporary file was left behind" }];
    const transport: Transport = async () => ({ status: 200, body: { ok: true, data: { id: "TASM-3" }, diagnostics } });

    await expect(createClient(transport).deleteTask("TASM", "TASM-3")).resolves.toEqual({
      data: { id: "TASM-3" },
      diagnostics,
    });
  });

  it("returns a project listing as the summaries it carries", async () => {
    const data: ProjectSummary[] = [{ tag: "CLIB" }, { tag: "TASM", name: "Tasma", path: "/srv/tasma" }];
    const transport: Transport = async () => ({ status: 200, body: { ok: true, data, diagnostics: [] } });

    await expect(createClient(transport).listProjects()).resolves.toEqual({ data, diagnostics: [] });
  });

  it("returns a comment map as the headers it carries", async () => {
    const data: CommentHeader[] = [
      { id: 1, title: "Note", created: "2026-01-01T00:00:00+03:00", collapsed: true, bytes: 12 },
    ];
    const transport: Transport = async () => ({ status: 200, body: { ok: true, data, diagnostics: [] } });

    await expect(createClient(transport).listComments("TASM", "TASM-3")).resolves.toEqual({ data, diagnostics: [] });
  });

  it("throws the whole failure of a refusal", async () => {
    const failure: Failure = { kind: "store", code: "task-not-found", message: "no such task", path: "/tmp/TASM-3.md" };
    const transport: Transport = async () => ({ status: 404, body: { ok: false, error: failure } });

    const error = await createClient(transport)
      .readTask("TASM", "TASM-3")
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ProtocolError);
    expect(error).toMatchObject({ failure, status: 404, message: "no such task" });
  });

  it("throws a transport fault when the transport rejects", async () => {
    const cause = new Error("connection refused");
    const transport: Transport = () => Promise.reject(cause);

    const error = await createClient(transport)
      .listProjects()
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({ status: undefined, cause });
  });

  const hostile = { toString: 1 };

  const unusable: [string, unknown][] = [
    ["a body that is not an object", "not an envelope"],
    ["a missing body", undefined],
    ["a null body", null],
    ["an ok that is not a boolean", { ok: "yes", data: null, diagnostics: [] }],
    ["a success with no data", { ok: true, diagnostics: [] }],
    ["a success with no diagnostics", { ok: true, data: null }],
    ["a success whose diagnostics are not a list", { ok: true, data: null, diagnostics: "none" }],
    ["a refusal with no error", { ok: false }],
    ["a refusal whose error is not an object", { ok: false, error: "task-not-found" }],
    ["a refusal whose error names no kind", { ok: false, error: { message: "later" } }],
    ["a refusal of a kind this client does not know", { ok: false, error: { kind: "quota", message: "later" } }],
    ["a refusal whose code is not a string", { ok: false, error: { kind: "store", code: 7, message: "later" } }],
    ["a message that refuses to coerce", { ok: false, error: { kind: "store", code: "c", message: hostile } }],
  ];

  it.each(unusable)("throws a transport fault, carrying the status, on %s", async (_description, body) => {
    const transport: Transport = async () => ({ status: 500, body });

    const error = await createClient(transport)
      .listProjects()
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({ status: 500 });
  });
});
