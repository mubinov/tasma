import { MutationObserver, QueryObserver, type QueryClient } from "@tanstack/react-query";
import { createClient, ProtocolError, TransportError, type Client, type SkillInstall, type TransportReply } from "@tasma/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { createAppQueryClient } from "../../../src/api/client";
import {
  addWorkflowOptions,
  closeSkillInstallFailure,
  createProjectOptions,
  failureKind,
  installSkillOptions,
  projectGone,
  WriteError,
  type SkillInstallWrite,
} from "../../../src/api/mutations";
import { daemonKeys, setupQuery } from "../../../src/api/queries";
import { useNoticeStore } from "../../../src/store/notices";
import { heldBack, refusalReply, setupStatus, stubTransport, successReply } from "../../helpers";

const INSTALL = "POST /setup/skill-install";

const INSTALL_PATH = "/setup/skill-install";

const FULL = "/setup?mode=full";

const WRITE: SkillInstallWrite = {
  failure: { title: "The install failed", line: (error) => `line of ${failureKind(error.cause)}` },
  offered: () => true,
};

const REFUSED = refusalReply(500, { kind: "daemon", code: "internal", message: "the action broke" });

function answer(result: SkillInstall): TransportReply {
  return successReply(result);
}

function setup(replies: Record<string, TransportReply | Promise<TransportReply>> = {}) {
  const stub = stubTransport({ [FULL]: successReply(setupStatus({}, { skill: "fail" })), ...replies });
  const client = createClient(stub.transport);
  const queryClient = createAppQueryClient();
  const observer = new MutationObserver(queryClient, installSkillOptions(queryClient, client));

  return { ...stub, client, queryClient, observer };
}

function bodies(stub: ReturnType<typeof setup>): unknown[] {
  return stub.requests.filter(({ path }) => path === INSTALL_PATH).map(({ body }) => body);
}

function notices() {
  return useNoticeStore.getState().notices;
}

beforeEach(() => {
  useNoticeStore.setState({ notices: [], dismissed: new Map() });
});

describe("installSkillOptions", () => {
  it("sends one request with no run, and gives a result that is not running", async () => {
    const stub = setup({ [INSTALL]: answer({ result: "installed" }) });

    await expect(stub.observer.mutate(WRITE)).resolves.toEqual({ result: "installed" });

    expect(bodies(stub)).toEqual([{}]);
  });

  it("repeats the request with the run id while the answer is running", async () => {
    const first = heldBack();
    const second = heldBack();
    const third = heldBack();
    const stub = setup({ [INSTALL]: first.reply });
    const write = stub.observer.mutate(WRITE);

    await expect.poll(() => bodies(stub)).toEqual([{}]);

    stub.replies[INSTALL] = second.reply;
    first.answer(answer({ result: "running", run: "run-1" }));
    await expect.poll(() => bodies(stub)).toEqual([{}, { run: "run-1" }]);

    stub.replies[INSTALL] = third.reply;
    second.answer(answer({ result: "running", run: "run-1" }));
    await expect.poll(() => bodies(stub)).toEqual([{}, { run: "run-1" }, { run: "run-1" }]);

    third.answer(answer({ result: "failed", output: "no network" }));

    await expect(write).resolves.toEqual({ result: "failed", output: "no network" });
  });

  it.each([
    ["npx-missing", { result: "npx-missing" }],
    ["failed", { result: "failed", output: "no network" }],
  ] as const)("gives %s as an answer, with no notice", async (_name, result) => {
    const stub = setup({ [INSTALL]: answer(result) });

    await expect(stub.observer.mutate(WRITE)).resolves.toEqual(result);

    expect(notices()).toEqual([]);
  });

  it("stays pending until the status read after the result has ended", async () => {
    const held = heldBack();
    const stub = setup({ [INSTALL]: answer({ result: "installed" }) });
    const unsubscribe = new QueryObserver(stub.queryClient, setupQuery(stub.client, { mode: "full" })).subscribe(() => {});

    await expect.poll(() => stub.paths.filter((path) => path === FULL).length).toBe(1);
    stub.replies[FULL] = held.reply;

    const write = stub.observer.mutate(WRITE);

    await expect.poll(() => stub.paths.filter((path) => path === FULL).length).toBe(2);
    expect(stub.observer.getCurrentResult().isPending).toBe(true);

    held.answer(successReply(setupStatus()));
    await write;

    expect(stub.observer.getCurrentResult().isSuccess).toBe(true);
    unsubscribe();
  });

  it("opens the notice of the failure with the words of the daemon, and sends no retry", async () => {
    const stub = setup({ [INSTALL]: REFUSED });

    await expect(stub.observer.mutate(WRITE)).rejects.toThrow("the action broke");

    expect(bodies(stub)).toEqual([{}]);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ form: "failure", title: "The install failed", line: "line of refused" });
    expect(notices()[0]!.words.join()).toContain("the action broke");
  });

  it("ends the loop on a failure after a running answer", async () => {
    const first = heldBack();
    const stub = setup({ [INSTALL]: first.reply });
    const write = stub.observer.mutate(WRITE);

    await expect.poll(() => bodies(stub)).toEqual([{}]);
    stub.replies[INSTALL] = REFUSED;
    first.answer(answer({ result: "running", run: "run-1" }));

    await expect(write).rejects.toThrow("the action broke");
    expect(bodies(stub)).toEqual([{}, { run: "run-1" }]);
    expect(notices()).toHaveLength(1);
  });

  it("closes the notice of an earlier failure when a write succeeds", async () => {
    const stub = setup({ [INSTALL]: REFUSED });

    await expect(stub.observer.mutate(WRITE)).rejects.toThrow();
    expect(notices()).toHaveLength(1);

    stub.replies[INSTALL] = answer({ result: "failed", output: "no network" });
    await stub.observer.mutate(WRITE);

    expect(notices()).toEqual([]);
  });

  it("keeps one notice after two failures", async () => {
    const stub = setup({ [INSTALL]: REFUSED });

    await expect(stub.observer.mutate(WRITE)).rejects.toThrow();
    await expect(stub.observer.mutate(WRITE)).rejects.toThrow();

    expect(notices()).toHaveLength(1);
  });

  it("opens no notice when the screen no longer offers the install", async () => {
    const stub = setup({ [INSTALL]: REFUSED });

    await expect(stub.observer.mutate({ ...WRITE, offered: () => false })).rejects.toThrow("the action broke");

    expect(notices()).toEqual([]);
  });
});

const PROJECT = { tag: "ORBI", name: "orbit-notes", path: "/Users/sample/code/orbit-notes", config: {}, live: true };

const CREATE = "POST /projects";

const INSTALL_DEV = "POST /workflows/dev/install";

const EDIT = "PATCH /projects/ORBI";

function sent(stub: ReturnType<typeof stubTransport>): { key: string; body: unknown }[] {
  return stub.requests
    .filter(({ method }) => method !== "GET")
    .map(({ method, path, body }) => ({ key: `${method} ${path}`, body }));
}

function writeSetup<T>(
  replies: Record<string, TransportReply | Promise<TransportReply>>,
  options: (queryClient: QueryClient, client: Client) => T,
) {
  const stub = stubTransport({ [FULL]: successReply(setupStatus({ project: "fail", workflow: "fail" })), ...replies });
  const client = createClient(stub.transport);
  const queryClient = createAppQueryClient();

  return { stub, client, queryClient, options: options(queryClient, client) };
}

/** Puts an answer under each key, so a test can see which keys a write marks stale. */
function seed(queryClient: QueryClient, keys: readonly (readonly unknown[])[]): void {
  for (const key of keys) {
    queryClient.setQueryData(key, successReply([]));
  }
}

function invalidated(queryClient: QueryClient, key: readonly unknown[]): boolean | undefined {
  return queryClient.getQueryState(key)?.isInvalidated;
}

describe("createProjectOptions", () => {
  const NO_TAG = refusalReply(422, { kind: "store", code: "tag-not-generated", message: "the folder name gives no tag" });

  function create(replies: Record<string, TransportReply | Promise<TransportReply>>) {
    const setup = writeSetup(replies, createProjectOptions);

    return { ...setup, observer: new MutationObserver(setup.queryClient, setup.options) };
  }

  it("sends the path alone, and gives the project", async () => {
    const { stub, observer } = create({ [CREATE]: successReply(PROJECT) });

    await expect(observer.mutate({ path: PROJECT.path })).resolves.toEqual(PROJECT);

    expect(sent(stub)).toEqual([{ key: CREATE, body: { path: PROJECT.path } }]);
  });

  it("sends the tag PROJ one time after tag-not-generated", async () => {
    const first = heldBack();
    const { stub, observer } = create({ [CREATE]: first.reply });
    const write = observer.mutate({ path: "/Users/sample/code/日記" });

    await expect.poll(() => sent(stub)).toHaveLength(1);
    stub.replies[CREATE] = successReply({ ...PROJECT, tag: "PROJ", name: "日記" });
    first.answer(NO_TAG);

    await expect(write).resolves.toMatchObject({ tag: "PROJ", name: "日記" });
    expect(sent(stub).map(({ body }) => body)).toEqual([
      { path: "/Users/sample/code/日記" },
      { path: "/Users/sample/code/日記", tag: "PROJ" },
    ]);
  });

  it("fails with the refusal of the request with PROJ", async () => {
    const first = heldBack();
    const { stub, observer } = create({ [CREATE]: first.reply });
    const write = observer.mutate({ path: "/" });

    await expect.poll(() => sent(stub)).toHaveLength(1);
    stub.replies[CREATE] = refusalReply(409, { kind: "store", code: "project-exists", message: "PROJ exists" });
    first.answer(NO_TAG);

    await expect(write).rejects.toThrow("PROJ exists");
    expect(sent(stub)).toHaveLength(2);
  });

  it.each([
    ["another refusal", refusalReply(422, { kind: "store", code: "path-invalid", message: "this path names no directory" })],
    ["no daemon envelope", { status: 502 }],
  ] as const)("sends no second request after %s, and fails with a WriteError", async (_name, reply) => {
    const { stub, observer } = create({ [CREATE]: reply });

    await expect(observer.mutate({ path: PROJECT.path })).rejects.toBeInstanceOf(WriteError);

    expect(sent(stub)).toHaveLength(1);
  });

  it("invalidates the setup and the projects, and does not wait for the status read", async () => {
    const held = heldBack();
    const { stub, client, queryClient, observer } = create({ [CREATE]: successReply(PROJECT) });
    const unsubscribe = new QueryObserver(queryClient, setupQuery(client, { mode: "full" })).subscribe(() => {});

    seed(queryClient, [daemonKeys.projects()]);
    await expect.poll(() => stub.paths.filter((path) => path === FULL).length).toBe(1);
    stub.replies[FULL] = held.reply;

    await observer.mutate({ path: PROJECT.path });

    await expect.poll(() => stub.paths.filter((path) => path === FULL).length).toBe(2);
    expect(invalidated(queryClient, daemonKeys.projects())).toBe(true);
    held.answer(successReply(setupStatus({ workflow: "fail" })));
    unsubscribe();
  });
});

describe("addWorkflowOptions", () => {
  function add(replies: Record<string, TransportReply | Promise<TransportReply>>) {
    const setup = writeSetup(replies, addWorkflowOptions);

    return { ...setup, observer: new MutationObserver(setup.queryClient, setup.options) };
  }

  it.each([
    ["installed", { result: "installed", folder: "/Users/sample/tasma-workflows/dev" }],
    ["exists", { result: "exists" }],
  ] as const)("installs dev and then lists dev on the project, after %s", async (_name, result) => {
    const { stub, observer } = add({ [INSTALL_DEV]: successReply(result), [EDIT]: successReply(PROJECT) });

    await observer.mutate({ tag: "ORBI" });

    expect(sent(stub)).toEqual([
      { key: INSTALL_DEV, body: {} },
      { key: EDIT, body: { workflows: ["dev"] } },
    ]);
  });

  it("sends no edit after a failed install", async () => {
    const refused = refusalReply(409, { kind: "store", code: "path-taken", message: "not free", path: "/Users/sample/tasma-workflows/dev" });
    const { stub, observer } = add({ [INSTALL_DEV]: refused });

    await expect(observer.mutate({ tag: "ORBI" })).rejects.toBeInstanceOf(WriteError);

    expect(sent(stub).map(({ key }) => key)).toEqual([INSTALL_DEV]);
  });

  it("fails when the edit after the install fails, and sends nothing more", async () => {
    const { stub, observer } = add({
      [INSTALL_DEV]: successReply({ result: "installed", folder: "/Users/sample/tasma-workflows/dev" }),
      [EDIT]: refusalReply(422, { kind: "store", code: "workflow-invalid", message: "dev does not load" }),
    });

    await expect(observer.mutate({ tag: "ORBI" })).rejects.toThrow("dev does not load");

    expect(sent(stub).map(({ key }) => key)).toEqual([INSTALL_DEV, EDIT]);
  });

  it("invalidates the projects and the workflows, and stays pending until the status read has ended", async () => {
    const held = heldBack();
    const { stub, client, queryClient, observer } = add({ [INSTALL_DEV]: successReply({ result: "exists" }), [EDIT]: successReply(PROJECT) });
    const unsubscribe = new QueryObserver(queryClient, setupQuery(client, { mode: "full" })).subscribe(() => {});

    seed(queryClient, [daemonKeys.projects(), daemonKeys.workflows(), daemonKeys.workflowList()]);
    await expect.poll(() => stub.paths.filter((path) => path === FULL).length).toBe(1);
    stub.replies[FULL] = held.reply;

    const write = observer.mutate({ tag: "ORBI" });

    await expect.poll(() => stub.paths.filter((path) => path === FULL).length).toBe(2);
    expect(observer.getCurrentResult().isPending).toBe(true);
    expect(invalidated(queryClient, daemonKeys.projects())).toBe(true);
    expect(invalidated(queryClient, daemonKeys.workflows())).toBe(true);
    expect(invalidated(queryClient, daemonKeys.workflowList())).toBe(true);

    held.answer(successReply(setupStatus()));
    await write;

    expect(observer.getCurrentResult().isSuccess).toBe(true);
    unsubscribe();
  });

  it("invalidates the projects after project-not-found, and after no other refusal", async () => {
    const gone = add({
      [INSTALL_DEV]: successReply({ result: "exists" }),
      [EDIT]: refusalReply(404, { kind: "store", code: "project-not-found", message: "no project ORBI" }),
    });
    const invalid = add({
      [INSTALL_DEV]: successReply({ result: "exists" }),
      [EDIT]: refusalReply(422, { kind: "store", code: "workflow-invalid", message: "dev does not load" }),
    });

    seed(gone.queryClient, [daemonKeys.projects()]);
    seed(invalid.queryClient, [daemonKeys.projects()]);
    await expect(gone.observer.mutate({ tag: "ORBI" })).rejects.toBeInstanceOf(WriteError);
    await expect(invalid.observer.mutate({ tag: "ORBI" })).rejects.toBeInstanceOf(WriteError);

    expect(invalidated(gone.queryClient, daemonKeys.projects())).toBe(true);
    expect(invalidated(invalid.queryClient, daemonKeys.projects())).toBe(false);
  });
});

describe("projectGone", () => {
  it("is true only for a refusal with project-not-found", () => {
    const refusal = (code: "project-not-found" | "path-taken") =>
      new WriteError(new ProtocolError({ kind: "store", code, message: code }, 404));

    expect(projectGone(refusal("project-not-found"))).toBe(true);
    expect(projectGone(refusal("path-taken"))).toBe(false);
    expect(projectGone(new WriteError(new TransportError("reached no daemon")))).toBe(false);
  });
});

describe("closeSkillInstallFailure", () => {
  it("closes the notice of a failed install, also a dismissed one", async () => {
    const stub = setup({ [INSTALL]: REFUSED });

    await expect(stub.observer.mutate(WRITE)).rejects.toThrow();
    useNoticeStore.getState().dismissNotice(notices()[0]!.key);

    closeSkillInstallFailure();

    expect(notices()).toEqual([]);
    expect(useNoticeStore.getState().dismissed.size).toBe(0);
  });
});
