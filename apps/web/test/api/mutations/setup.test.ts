import { MutationObserver, QueryObserver } from "@tanstack/react-query";
import { createClient, type SkillInstall, type TransportReply } from "@tasma/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { createAppQueryClient } from "../../../src/api/client";
import { closeSkillInstallFailure, failureKind, installSkillOptions, type SkillInstallWrite } from "../../../src/api/mutations";
import { setupQuery } from "../../../src/api/queries";
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
