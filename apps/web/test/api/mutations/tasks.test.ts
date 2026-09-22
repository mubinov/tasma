import { MutationObserver, onlineManager, QueryClientProvider, QueryObserver, type QueryClient } from "@tanstack/react-query";
import {
  createClient,
  ProtocolError,
  TransportError,
  type Client,
  type Diagnostic,
  type SerializeErrorCode,
  type Transport,
  type TransportReply,
  type TransportRequest,
} from "@tasma/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppQueryClient } from "../../../src/api/client";
import {
  createRefusal,
  openCreateWarnings,
  taskCreateOptions,
  TaskWriteError,
  taskWriteKey,
  taskWriteOptions,
  usePendingTaskWrites,
  type TaskWrites,
} from "../../../src/api/mutations";
import { WriteError } from "../../../src/api/mutations/notices";
import { projectQuery, taskQuery, tasksQuery } from "../../../src/api/queries";
import { DAEMON_URL } from "../../../src/api/transport";
import { useNoticeStore } from "../../../src/store/notices";
import { heldBack, refusalReply, stubTransport, successReply } from "../../helpers";

const TAG = "NOTE";

const LISTING = "/projects/NOTE/tasks";

function taskPath(id: string): string {
  return `/projects/NOTE/tasks/${id}`;
}

function written(id: string, diagnostics: Diagnostic[] = []): TransportReply {
  return successReply({ id }, diagnostics);
}

/** A move of the last task named, which writes the tasks before it first. */
function moveOf(first: string, ...others: string[]): TaskWrites {
  const write = (id: string, order: number) => ({ id, change: { status: "Done", order } });
  const moved = others.at(-1) ?? first;

  return {
    id: moved,
    writes: [write(first, 0), ...others.map((id, index) => write(id, index + 1))],
    title: `${moved} was not moved`,
    place: "board",
  };
}

/** The one write a task page sends: the title and the body of the task it shows. */
function pageSave(id: string, change: { title?: string; body?: string } = { title: "Renamed" }): TaskWrites {
  return { id, writes: [{ id, change }], title: `${id} was not saved`, place: "task page" };
}

/** The status pick of a task page, which places the card at the top of its new column. */
function pagePlace(id: string): TaskWrites {
  return {
    id,
    writes: [{ id, change: { status: "Done", order: -1000 } }],
    title: `${id} was not changed`,
    place: "task page",
    property: "Status",
  };
}

/** A move of NOTE-1 that writes only the task below it. */
const BELOW_ONLY: TaskWrites = {
  id: "NOTE-1",
  writes: [{ id: "NOTE-2", change: { order: 0 } }],
  title: "NOTE-1 was not moved",
  place: "board",
};

const REFUSAL = refusalReply(422, { kind: "store", code: "status-unknown", message: "status \"Gone\" is not configured" });

function setup(replies: Record<string, TransportReply | Promise<TransportReply>> = {}, transport?: Transport) {
  const stub = stubTransport({ [LISTING]: successReply({ entries: [], excluded: [] }), ...replies });
  const client = createClient(transport ?? stub.transport);
  const queryClient = createAppQueryClient();
  const observer = new MutationObserver(queryClient, taskWriteOptions(queryClient, client, TAG));

  return { ...stub, client, queryClient, observer };
}

/** An observed listing, so an invalidation refetches it. */
function watchListing(queryClient: QueryClient, client: Client): () => void {
  return new QueryObserver(queryClient, tasksQuery(client, TAG)).subscribe(() => {});
}

function writes(requests: readonly TransportRequest[]): TransportRequest[] {
  return requests.filter(({ method }) => method === "PATCH");
}

function notices() {
  return useNoticeStore.getState().notices;
}

beforeEach(() => {
  useNoticeStore.setState({ notices: [], dismissed: new Map() });
});

afterEach(() => {
  cleanup();
});

describe("taskWriteOptions", () => {
  it("sends each change as a PATCH of its task, in order, and resolves with the diagnostics beside their task", async () => {
    const found: Diagnostic = { code: "status-case-corrected", message: "status \"done\" was written as \"Done\"" };
    const { observer, requests } = setup({
      [`PATCH ${taskPath("NOTE-1")}`]: written("NOTE-1", [found]),
      [`PATCH ${taskPath("NOTE-2")}`]: written("NOTE-2"),
    });

    const results = await observer.mutate(moveOf("NOTE-1", "NOTE-2"));

    expect(writes(requests)).toEqual([
      { method: "PATCH", path: taskPath("NOTE-1"), body: { status: "Done", order: 0 } },
      { method: "PATCH", path: taskPath("NOTE-2"), body: { status: "Done", order: 1 } },
    ]);
    expect(results).toEqual([
      { id: "NOTE-1", diagnostics: [found] },
      { id: "NOTE-2", diagnostics: [] },
    ]);
  });

  it("stops at the first failure, and does not try the write again", async () => {
    const { observer, requests } = setup({
      [`PATCH ${taskPath("NOTE-1")}`]: REFUSAL,
      [`PATCH ${taskPath("NOTE-2")}`]: written("NOTE-2"),
    });

    await expect(observer.mutate(moveOf("NOTE-1", "NOTE-2"))).rejects.toThrow("is not configured");

    expect(writes(requests).map(({ path }) => path)).toEqual([taskPath("NOTE-1")]);
  });

  it("stays pending after the answer until the listing is read again", async () => {
    const listing = heldBack();
    const { observer, replies, queryClient, client } = setup({ [`PATCH ${taskPath("NOTE-1")}`]: written("NOTE-1") });
    const stop = watchListing(queryClient, client);
    await queryClient.query(tasksQuery(client, TAG));
    replies[LISTING] = listing.reply;

    const done = observer.mutate(moveOf("NOTE-1"));
    await vi.waitFor(() => {
      expect(queryClient.getQueryState(tasksQuery(client, TAG).queryKey)?.fetchStatus).toBe("fetching");
    });

    expect(observer.getCurrentResult().status).toBe("pending");

    listing.answer(successReply({ entries: [], excluded: [] }));
    await done;

    expect(observer.getCurrentResult().status).toBe("success");
    stop();
  });

  it("settles a failure at once, and still reads the listing again", async () => {
    const listing = heldBack();
    const { observer, replies, queryClient, client, paths } = setup({ [`PATCH ${taskPath("NOTE-1")}`]: { status: 502 } });
    const stop = watchListing(queryClient, client);
    await queryClient.query(tasksQuery(client, TAG));
    replies[LISTING] = listing.reply;
    paths.length = 0;

    await expect(observer.mutate(moveOf("NOTE-1"))).rejects.toThrow("answered with no envelope");

    expect(observer.getCurrentResult().status).toBe("error");
    expect(paths).toEqual([taskPath("NOTE-1"), LISTING]);
    listing.answer(successReply({ entries: [], excluded: [] }));
    stop();
  });

  it("runs the writes of one project one after another", async () => {
    const first = heldBack();
    const { observer, queryClient, client, requests } = setup({
      [`PATCH ${taskPath("NOTE-1")}`]: first.reply,
      [`PATCH ${taskPath("NOTE-2")}`]: written("NOTE-2"),
    });
    const second = new MutationObserver(queryClient, taskWriteOptions(queryClient, client, TAG));

    const done = [observer.mutate(moveOf("NOTE-1")), second.mutate(moveOf("NOTE-2"))];
    await vi.waitFor(() => {
      expect(writes(requests)).toHaveLength(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(writes(requests).map(({ path }) => path)).toEqual([taskPath("NOTE-1")]);

    first.answer(written("NOTE-1"));
    await Promise.all(done);

    expect(writes(requests).map(({ path }) => path)).toEqual([taskPath("NOTE-1"), taskPath("NOTE-2")]);
  });

  it("drops the writes queued behind a failed write, keeps its notice, and sends a write started after it", async () => {
    const first = heldBack();
    const { observer, queryClient, client, requests } = setup({
      [`PATCH ${taskPath("NOTE-1")}`]: first.reply,
      [`PATCH ${taskPath("NOTE-2")}`]: written("NOTE-2"),
      [`PATCH ${taskPath("NOTE-3")}`]: written("NOTE-3"),
    });
    const another = () => new MutationObserver(queryClient, taskWriteOptions(queryClient, client, TAG));

    const done = [observer.mutate(moveOf("NOTE-1")), another().mutate(moveOf("NOTE-2")), another().mutate(moveOf("NOTE-3"))]
      .map((sent) => sent.catch((error: unknown) => error));
    await vi.waitFor(() => {
      expect(writes(requests)).toHaveLength(1);
    });
    first.answer(REFUSAL);
    const errors = await Promise.all(done);

    expect(writes(requests).map(({ path }) => path)).toEqual([taskPath("NOTE-1")]);
    expect(errors.map((error) => error instanceof TaskWriteError && error.completed)).toEqual([0, 0, 0]);
    expect(notices()).toMatchObject([
      { key: "task-write-failure:NOTE-1", words: ["store/status-unknown · status \"Gone\" is not configured"] },
    ]);

    await another().mutate(moveOf("NOTE-2"));

    expect(writes(requests).map(({ path }) => path)).toEqual([taskPath("NOTE-1"), taskPath("NOTE-2")]);
  });

  it("sends a page save queued behind a failed board write, and opens its own notice", async () => {
    const first = heldBack();
    const { observer, queryClient, client, requests } = setup({
      [`PATCH ${taskPath("NOTE-1")}`]: first.reply,
      [`PATCH ${taskPath("NOTE-2")}`]: REFUSAL,
    });
    const another = () => new MutationObserver(queryClient, taskWriteOptions(queryClient, client, TAG));

    const done = [observer.mutate(moveOf("NOTE-1")), another().mutate(pageSave("NOTE-2"))]
      .map((sent) => sent.catch((error: unknown) => error));
    await vi.waitFor(() => {
      expect(writes(requests)).toHaveLength(1);
    });
    first.answer(REFUSAL);
    await Promise.all(done);

    expect(writes(requests).map(({ path }) => path)).toEqual([taskPath("NOTE-1"), taskPath("NOTE-2")]);
    expect(notices().map(({ key }) => key))
      .toEqual(["task-write-failure:NOTE-1", "task-write-failure:NOTE-2"]);
  });

  it("drops no board write behind a failed page save", async () => {
    const first = heldBack();
    const { observer, queryClient, client, requests } = setup({
      [`PATCH ${taskPath("NOTE-1")}`]: first.reply,
      [`PATCH ${taskPath("NOTE-2")}`]: written("NOTE-2"),
    });
    const another = () => new MutationObserver(queryClient, taskWriteOptions(queryClient, client, TAG));

    const done = [observer.mutate(pageSave("NOTE-1")), another().mutate(moveOf("NOTE-2"))]
      .map((sent) => sent.catch((error: unknown) => error));
    await vi.waitFor(() => {
      expect(writes(requests)).toHaveLength(1);
    });
    first.answer(REFUSAL);
    await Promise.all(done);

    expect(writes(requests).map(({ path }) => path)).toEqual([taskPath("NOTE-1"), taskPath("NOTE-2")]);
  });

  // The page's status pick reads the same board the move did, so it carries an
  // order the failure never produced.
  it("drops a page write that places a card behind a failed board write", async () => {
    const first = heldBack();
    const { observer, queryClient, client, requests } = setup({
      [`PATCH ${taskPath("NOTE-1")}`]: first.reply,
      [`PATCH ${taskPath("NOTE-2")}`]: written("NOTE-2"),
    });
    const another = () => new MutationObserver(queryClient, taskWriteOptions(queryClient, client, TAG));

    const done = [observer.mutate(moveOf("NOTE-1")), another().mutate(pagePlace("NOTE-2"))]
      .map((sent) => sent.catch((error: unknown) => error));
    await vi.waitFor(() => {
      expect(writes(requests)).toHaveLength(1);
    });
    first.answer(REFUSAL);
    await Promise.all(done);

    expect(writes(requests).map(({ path }) => path)).toEqual([taskPath("NOTE-1")]);
    expect(notices().map(({ key }) => key)).toEqual(["task-write-failure:NOTE-1"]);
  });

  it("drops a board write behind a failed page write that places a card", async () => {
    const first = heldBack();
    const { observer, queryClient, client, requests } = setup({
      [`PATCH ${taskPath("NOTE-1")}`]: first.reply,
      [`PATCH ${taskPath("NOTE-2")}`]: written("NOTE-2"),
    });
    const another = () => new MutationObserver(queryClient, taskWriteOptions(queryClient, client, TAG));

    const done = [observer.mutate(pagePlace("NOTE-1")), another().mutate(moveOf("NOTE-2"))]
      .map((sent) => sent.catch((error: unknown) => error));
    await vi.waitFor(() => {
      expect(writes(requests)).toHaveLength(1);
    });
    first.answer(REFUSAL);
    await Promise.all(done);

    expect(writes(requests).map(({ path }) => path)).toEqual([taskPath("NOTE-1")]);
  });

  it("sends the write while the browser reports offline, because the daemon is on this machine", async () => {
    const { observer, requests } = setup({ [`PATCH ${taskPath("NOTE-1")}`]: written("NOTE-1") });
    onlineManager.setOnline(false);

    try {
      const done = observer.mutate(moveOf("NOTE-1"));

      await vi.waitFor(() => {
        expect(writes(requests)).toHaveLength(1);
      });
      await done;
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it("keys the writes of a project under its tasks", () => {
    expect(taskWriteKey(TAG)).toEqual(["daemon", "projects", TAG, "tasks", "write"]);
  });
});

describe("the error of a write", () => {
  it("holds the failure and the count of the writes that succeeded before it", async () => {
    const { observer } = setup({ [`PATCH ${taskPath("NOTE-1")}`]: written("NOTE-1"), [`PATCH ${taskPath("NOTE-2")}`]: REFUSAL });

    const partial = await observer.mutate(moveOf("NOTE-1", "NOTE-2")).catch((error: unknown) => error);
    const first = await observer.mutate(moveOf("NOTE-2", "NOTE-1")).catch((error: unknown) => error);

    expect(partial).toBeInstanceOf(TaskWriteError);
    expect(partial).toMatchObject({ completed: 1, message: "status \"Gone\" is not configured" });
    expect((partial as TaskWriteError).cause).toBeInstanceOf(ProtocolError);
    expect(first).toMatchObject({ completed: 0 });
  });

  it("takes the words of a thrown value that is not an Error", async () => {
    const { queryClient } = setup();
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a thrown value need not be an Error
    const client = { updateTask: () => Promise.reject("socket closed") } as unknown as Client;
    const observer = new MutationObserver(queryClient, taskWriteOptions(queryClient, client, TAG));

    const error = await observer.mutate(moveOf("NOTE-1")).catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({ completed: 0, message: "socket closed", cause: "socket closed" });
  });
});

describe("the failure notice", () => {
  const FAILURES: {
    kind: string;
    reply: TransportReply | null;
    id?: string;
    line: string;
    /** The line when a write before the failed one succeeded. */
    partial: string;
    words: string;
  }[] = [
    {
      kind: "a refusal",
      reply: REFUSAL,
      line: "The daemon refused the write, and the task is back where it was. Its own words are below.",
      partial: "The daemon refused a write, and the move did not complete. The board shows what the daemon holds. "
        + "Its own words are below.",
      words: "store/status-unknown · status \"Gone\" is not configured",
    },
    {
      kind: "no answer",
      reply: null,
      line: "No daemon answered, so nothing was written.",
      partial: "The daemon stopped answering, and the move did not complete. "
        + "The board shows what the daemon holds after the next read.",
      words: DAEMON_URL,
    },
    {
      kind: "an answer that is not the daemon's",
      reply: { status: 502 },
      line: "The daemon did not answer through the address below. Start the daemon there if it is not running. "
        + "The board shows the task where the daemon holds it after the next read.",
      partial: "The daemon did not answer through the address below, and the move did not complete. "
        + "Start the daemon there if it is not running. The board shows what the daemon holds after the next read.",
      words: `${DAEMON_URL} · HTTP 502 · PATCH ${taskPath("NOTE-1")} answered with no envelope`,
    },
    {
      kind: "a write that could not start",
      reply: null,
      id: "..",
      line: "The write did not start, and the task is back where it was.",
      partial: "A write did not start, and the move did not complete. The board shows what the daemon holds.",
      words: "/projects/{project}/tasks/{id} cannot take \"..\" as the path parameter \"id\": it is not one path component",
    },
  ];

  /** A daemon that answers the write of NOTE-2 and fails the write of `id` as `reply` says. */
  function failing(reply: TransportReply | null, id: string): Transport {
    const { transport: answering } = stubTransport({
      [`PATCH ${taskPath("NOTE-2")}`]: written("NOTE-2"),
      ...(reply === null ? {} : { [`PATCH ${taskPath(id)}`]: reply }),
    });

    return (request) =>
      reply === null && request.path === taskPath(id) ? Promise.reject(new Error("connection refused")) : answering(request);
  }

  it.each(FAILURES)("says what happened for $kind, with the given title", async ({ reply, id = "NOTE-1", line, words }) => {
    const { observer } = setup({}, failing(reply, id));

    await expect(observer.mutate(moveOf(id))).rejects.toThrow();

    expect(notices()).toMatchObject([
      { key: `task-write-failure:${id}`, form: "failure", title: `${id} was not moved`, line, words: [words] },
    ]);
  });

  it.each(FAILURES)("says the move did not complete for $kind after a write that succeeded", async ({
    reply,
    id = "NOTE-1",
    partial,
    words,
  }) => {
    const { observer } = setup({}, failing(reply, id));

    await expect(observer.mutate(moveOf("NOTE-2", id))).rejects.toThrow();

    expect(notices()).toMatchObject([
      { key: `task-write-failure:${id}`, form: "failure", title: `${id} was not moved`, line: partial, words: [words] },
    ]);
  });

  it("is about the task the writes move, whichever task the failed write is to", async () => {
    const { observer } = setup({ [`PATCH ${taskPath("NOTE-2")}`]: REFUSAL });

    await expect(observer.mutate(BELOW_ONLY)).rejects.toThrow();

    expect(notices()).toMatchObject([{ key: "task-write-failure:NOTE-1", title: "NOTE-1 was not moved" }]);
  });

  it("opens the notice about the same task anew for each failure with the same words, dismissed or not, and keeps the notice about another task", async () => {
    const { observer } = setup({ [`PATCH ${taskPath("NOTE-1")}`]: REFUSAL, [`PATCH ${taskPath("NOTE-2")}`]: REFUSAL });
    const serials: number[] = [];
    const failOne = async () => {
      await expect(observer.mutate(moveOf("NOTE-1"))).rejects.toThrow();
      serials.push(notices().find(({ key }) => key === "task-write-failure:NOTE-1")!.serial);
    };

    await failOne();
    await expect(observer.mutate(moveOf("NOTE-2"))).rejects.toThrow();
    await failOne();
    act(() => {
      useNoticeStore.getState().dismissNotice("task-write-failure:NOTE-1");
    });
    await failOne();

    expect(notices().map(({ key }) => key)).toEqual(["task-write-failure:NOTE-2", "task-write-failure:NOTE-1"]);
    expect(new Set(serials).size).toBe(3);
  });

  it("closes every write failure notice when a write succeeds, and leaves other notices open", async () => {
    const { observer } = setup({
      [`PATCH ${taskPath("NOTE-1")}`]: REFUSAL,
      [`PATCH ${taskPath("NOTE-2")}`]: REFUSAL,
      [`PATCH ${taskPath("NOTE-3")}`]: written("NOTE-3"),
    });
    useNoticeStore.getState().showNotice({ key: "task-read:NOTE-9", form: "warning", title: "1 warning about NOTE-9", words: ["a"] });

    await expect(observer.mutate(moveOf("NOTE-1"))).rejects.toThrow();
    await expect(observer.mutate(moveOf("NOTE-2"))).rejects.toThrow();
    await observer.mutate(moveOf("NOTE-3"));

    expect(notices().map(({ key }) => key)).toEqual(["task-read:NOTE-9"]);
  });

  it("leaves the write failure notices open when it carries no write", async () => {
    const { observer, requests } = setup({ [`PATCH ${taskPath("NOTE-1")}`]: REFUSAL });

    await expect(observer.mutate(moveOf("NOTE-1"))).rejects.toThrow();
    await observer.mutate({ id: "NOTE-1", writes: [], title: "NOTE-1 was not moved", place: "board" });

    expect(writes(requests).map(({ path }) => path)).toEqual([taskPath("NOTE-1")]);
    expect(notices().map(({ key }) => key)).toEqual(["task-write-failure:NOTE-1"]);
  });
});

describe("the failure notice of a task page write", () => {
  const PAGE_FAILURES: { kind: string; reply: TransportReply | null; id?: string; line: string }[] = [
    {
      kind: "a refusal",
      reply: REFUSAL,
      line: "The daemon refused the write, so nothing changed on disk. Its own words are below.",
    },
    { kind: "no answer", reply: null, line: "No daemon answered, so nothing was written." },
    {
      kind: "an answer that is not the daemon's",
      reply: { status: 502 },
      line: "The daemon did not answer through the address below. Start the daemon there if it is not running. "
        + "The page shows the task as the daemon holds it after the next read.",
    },
    {
      kind: "a write that could not start",
      reply: null,
      id: "..",
      line: "The write did not start, so nothing changed on disk.",
    },
  ];

  function failing(reply: TransportReply | null, id: string): Transport {
    const { transport: answering } = stubTransport(reply === null ? {} : { [`PATCH ${taskPath(id)}`]: reply });

    return (request) =>
      reply === null && request.path === taskPath(id) ? Promise.reject(new Error("connection refused")) : answering(request);
  }

  it.each(PAGE_FAILURES)("says nothing changed on disk for $kind", async ({ reply, id = "NOTE-1", line }) => {
    const { observer } = setup({}, failing(reply, id));

    await expect(observer.mutate(pageSave(id))).rejects.toThrow();

    expect(notices()).toMatchObject([
      { key: `task-write-failure:${id}`, form: "failure", title: `${id} was not saved`, line },
    ]);
  });

  const BODY_REFUSALS: { code: SerializeErrorCode; message: string; correction: string }[] = [
    {
      code: "marker-collision",
      message: "line 4 would be read as a comment marker",
      correction: "The body starts a line with a comment marker. Indent that line, or change its first characters.",
    },
    {
      code: "fence-unterminated",
      message: "the fence opened on line 6 is not closed",
      correction: "The body opens a code fence that never closes. Close the fence.",
    },
  ];

  it.each(BODY_REFUSALS)("names the correction for $code at the end of its line", async ({ code, message, correction }) => {
    const { observer } = setup({
      [`PATCH ${taskPath("NOTE-1")}`]: refusalReply(422, { kind: "serialize", code, message, line: 4 }),
    });

    await expect(observer.mutate(pageSave("NOTE-1", { body: "text" }))).rejects.toThrow();

    expect(notices()).toMatchObject([
      {
        line: `The daemon refused the write, so nothing changed on disk. Its own words are below. ${correction}`,
        words: [`serialize/${code} · ${message}`],
      },
    ]);
  });

  it("names no correction for a refusal that ties to no field", async () => {
    const { observer } = setup({ [`PATCH ${taskPath("NOTE-1")}`]: REFUSAL });

    await expect(observer.mutate(pageSave("NOTE-1"))).rejects.toThrow();

    expect(notices()).toMatchObject([
      { line: "The daemon refused the write, so nothing changed on disk. Its own words are below." },
    ]);
  });

  it("names the property in front of the line, so the reader is told which control refused", async () => {
    const { observer } = setup({ [`PATCH ${taskPath("NOTE-1")}`]: REFUSAL });
    const write: TaskWrites = {
      id: "NOTE-1",
      writes: [{ id: "NOTE-1", change: { status: "Gone" } }],
      title: "NOTE-1 was not changed",
      place: "task page",
      property: "Status",
    };

    await expect(observer.mutate(write)).rejects.toThrow();

    expect(notices()).toMatchObject([
      {
        title: "NOTE-1 was not changed",
        line: "Status. The daemon refused the write, so nothing changed on disk. Its own words are below.",
      },
    ]);
  });

  it("leaves the Save line as it is for a write that names no property", async () => {
    const { observer } = setup({ [`PATCH ${taskPath("NOTE-1")}`]: REFUSAL });

    await expect(observer.mutate(pageSave("NOTE-1"))).rejects.toThrow();

    expect(notices()[0]?.line?.startsWith("The daemon refused")).toBe(true);
  });

  it("leaves a board line as it is", async () => {
    const { observer } = setup({ [`PATCH ${taskPath("NOTE-1")}`]: REFUSAL });

    await expect(observer.mutate(moveOf("NOTE-1"))).rejects.toThrow();

    expect(notices()).toMatchObject([
      { line: "The daemon refused the write, and the task is back where it was. Its own words are below." },
    ]);
  });
});

describe("the warning notice of a write", () => {
  const KNOWN: Diagnostic = { code: "config-key-unknown", message: "unknown key: colour", path: "/p/config.yml", line: 2 };
  const LISTED: Diagnostic = { code: "blocked-by-unresolved", message: "NOTE-9 names no task", path: "/p/NOTE-4.md" };
  const FRESH: Diagnostic = { code: "label-case-converted", message: "label \"Web\" was converted to \"web\"" };

  it("is about the task of the write, not the task the writes move", async () => {
    const { observer } = setup({ [`PATCH ${taskPath("NOTE-2")}`]: written("NOTE-2", [FRESH]) });

    await observer.mutate(BELOW_ONLY);

    expect(notices()).toMatchObject([{ key: "task-write-warnings:NOTE-2", title: "1 warning about NOTE-2" }]);
  });

  it("opens one notice per task a sequence warns about", async () => {
    const other: Diagnostic = { code: "status-case-corrected", message: "status \"done\" was written as \"Done\"" };
    const { observer } = setup({
      [`PATCH ${taskPath("NOTE-1")}`]: written("NOTE-1", [FRESH]),
      [`PATCH ${taskPath("NOTE-2")}`]: written("NOTE-2", [FRESH, other]),
    });

    await observer.mutate(moveOf("NOTE-1", "NOTE-2"));

    expect(notices()).toMatchObject([
      { key: "task-write-warnings:NOTE-1", title: "1 warning about NOTE-1" },
      { key: "task-write-warnings:NOTE-2", title: "2 warnings about NOTE-2" },
    ]);
  });

  it("lists the diagnostics the board does not already show, about the task of the write", async () => {
    const { observer, queryClient, client } = setup({
      "/projects/NOTE": successReply({ tag: TAG }, [KNOWN]),
      [LISTING]: successReply({ entries: [], excluded: [] }, [LISTED]),
      [`PATCH ${taskPath("NOTE-1")}`]: written("NOTE-1", [{ ...KNOWN, path: undefined, line: undefined }]),
      [`PATCH ${taskPath("NOTE-2")}`]: written("NOTE-2", [FRESH, { ...LISTED }, FRESH]),
    });
    await queryClient.query(projectQuery(client, TAG));
    await queryClient.query(tasksQuery(client, TAG));

    await observer.mutate(moveOf("NOTE-1", "NOTE-2"));

    expect(notices()).toMatchObject([
      {
        key: "task-write-warnings:NOTE-2",
        form: "warning",
        title: "2 warnings about NOTE-2",
        words: ["label-case-converted · label \"Web\" was converted to \"web\"", "label-case-converted · label \"Web\" was converted to \"web\""],
      },
    ]);
  });

  it("opens nothing when every diagnostic is already on the board, or there is none", async () => {
    const { observer, queryClient, client } = setup({
      [LISTING]: successReply({ entries: [], excluded: [] }, [LISTED]),
      [`PATCH ${taskPath("NOTE-1")}`]: written("NOTE-1", [LISTED]),
      [`PATCH ${taskPath("NOTE-2")}`]: written("NOTE-2"),
    });
    await queryClient.query(tasksQuery(client, TAG));

    await observer.mutate(moveOf("NOTE-1"));
    await observer.mutate(moveOf("NOTE-2"));

    expect(notices()).toEqual([]);
  });

  it("leaves out what the cached task read of the written task already shows", async () => {
    const { observer, queryClient, client } = setup({
      [taskPath("NOTE-1")]: successReply({ frontmatter: {}, body: "", comments: [] }, [KNOWN]),
      [`PATCH ${taskPath("NOTE-1")}`]: written("NOTE-1", [KNOWN, FRESH]),
    });
    await queryClient.query(taskQuery(client, TAG, "NOTE-1"));

    await observer.mutate(pageSave("NOTE-1"));

    expect(notices()).toMatchObject([
      { key: "task-write-warnings:NOTE-1", title: "1 warning about NOTE-1", words: [`${FRESH.code} · ${FRESH.message}`] },
    ]);
  });

  it("counts the task read of the written task alone, not of another task", async () => {
    const { observer, queryClient, client } = setup({
      [taskPath("NOTE-2")]: successReply({ frontmatter: {}, body: "", comments: [] }, [KNOWN]),
      [`PATCH ${taskPath("NOTE-1")}`]: written("NOTE-1", [KNOWN]),
    });
    await queryClient.query(taskQuery(client, TAG, "NOTE-2"));

    await observer.mutate(pageSave("NOTE-1"));

    expect(notices()).toMatchObject([{ key: "task-write-warnings:NOTE-1", title: "1 warning about NOTE-1" }]);
  });

  it("opens again for a later write after Dismiss", async () => {
    const { observer } = setup({ [`PATCH ${taskPath("NOTE-1")}`]: written("NOTE-1", [FRESH]) });

    await observer.mutate(moveOf("NOTE-1"));
    act(() => {
      useNoticeStore.getState().dismissNotice("task-write-warnings:NOTE-1");
    });
    await observer.mutate(moveOf("NOTE-1"));

    expect(notices().map(({ title }) => title)).toEqual(["1 warning about NOTE-1"]);
  });
});

describe("usePendingTaskWrites", () => {
  const ELSE_WRITE: TaskWrites = {
    id: "ELSE-1",
    writes: [{ id: "ELSE-1", change: { order: 1 } }],
    title: "ELSE-1 was not moved",
    place: "board",
  };

  function renderPending(replies: Record<string, TransportReply | Promise<TransportReply>>) {
    const { queryClient, client } = setup(replies);
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const rendered = renderHook(({ tag }) => usePendingTaskWrites(tag), { wrapper, initialProps: { tag: TAG } });

    /** Starts the writes and waits until they are sent or queued. */
    async function send(...sent: [string, TaskWrites][]): Promise<Promise<unknown>[]> {
      let done: Promise<unknown>[] = [];
      await act(async () => {
        done = sent.map(([tag, variables]) =>
          new MutationObserver(queryClient, taskWriteOptions(queryClient, client, tag)).mutate(variables));
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      return done;
    }

    return { ...rendered, send };
  }

  it("gives the writes of the running and the queued writes of the project, in the order they were sent", async () => {
    const first = heldBack();
    const other = heldBack();
    const { result, send } = renderPending({
      [`PATCH ${taskPath("NOTE-1")}`]: first.reply,
      [`PATCH ${taskPath("NOTE-2")}`]: written("NOTE-2"),
      [`PATCH ${taskPath("NOTE-3")}`]: written("NOTE-3"),
      "PATCH /projects/ELSE/tasks/ELSE-1": other.reply,
    });

    const done = await send([TAG, moveOf("NOTE-1")], ["ELSE", ELSE_WRITE], [TAG, moveOf("NOTE-2", "NOTE-3")]);

    expect(result.current.writes.map(({ id, change }) => [id, change])).toEqual([
      ["NOTE-1", { status: "Done", order: 0 }],
      ["NOTE-2", { status: "Done", order: 0 }],
      ["NOTE-3", { status: "Done", order: 1 }],
    ]);
    expect(result.current.writes.every(({ submittedAt }) => submittedAt > 0)).toBe(true);

    await act(async () => {
      first.answer(written("NOTE-1"));
      other.answer(successReply({ id: "ELSE-1" }));
      await Promise.all(done);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(result.current.writes).toEqual([]);
  });

  it("gives the task each write moves, which is neither every task it writes nor always one of them", async () => {
    const first = heldBack();
    const below = heldBack();
    const { result, send } = renderPending({
      [`PATCH ${taskPath("NOTE-1")}`]: first.reply,
      [`PATCH ${taskPath("NOTE-2")}`]: below.reply,
    });

    const done = await send([TAG, moveOf("NOTE-1", "NOTE-2")], [TAG, BELOW_ONLY]);

    expect(result.current.writes.map(({ id }) => id)).toEqual(["NOTE-1", "NOTE-2", "NOTE-2"]);
    expect([...result.current.movedIds]).toEqual(["NOTE-2", "NOTE-1"]);

    await act(async () => {
      first.answer(written("NOTE-1"));
      below.answer(written("NOTE-2"));
      await Promise.all(done);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect([...result.current.movedIds]).toEqual([]);
  });

  it("gives the writes of the project it is asked for at each render, with no new write in between", async () => {
    const first = heldBack();
    const other = heldBack();
    const { result, rerender, send } = renderPending({
      [`PATCH ${taskPath("NOTE-1")}`]: first.reply,
      "PATCH /projects/ELSE/tasks/ELSE-1": other.reply,
    });
    const done = await send([TAG, moveOf("NOTE-1")], ["ELSE", ELSE_WRITE]);
    const ids = () => result.current.writes.map(({ id }) => id);
    expect(ids()).toEqual(["NOTE-1"]);

    rerender({ tag: "ELSE" });
    expect(ids()).toEqual(["ELSE-1"]);

    rerender({ tag: TAG });
    expect(ids()).toEqual(["NOTE-1"]);

    await act(async () => {
      first.answer(written("NOTE-1"));
      other.answer(successReply({ id: "ELSE-1" }));
      await Promise.all(done);
    });
  });
});

describe("taskCreateOptions", () => {
  const CREATE = `POST ${LISTING}`;
  const INPUT = { title: "Draw the map", status: "To Do", labels: ["web"] };
  const FRESH: Diagnostic = { code: "label-case-converted", message: "label \"Web\" was converted to \"web\"" };

  function createSetup(replies: Record<string, TransportReply | Promise<TransportReply>> = {}) {
    const context = setup(replies);
    const { queryClient, client } = context;
    const creator = new MutationObserver(queryClient, taskCreateOptions(queryClient, client, TAG));

    return { ...context, creator };
  }

  function creates(requests: readonly TransportRequest[]): TransportRequest[] {
    return requests.filter(({ method }) => method === "POST");
  }

  it("sends one POST with the input, and resolves with the id, the stored status and the diagnostics", async () => {
    const { creator, requests } = createSetup({ [CREATE]: successReply({ id: "NOTE-7", status: "To Do" }, [FRESH]) });

    const created = await creator.mutate({ input: INPUT });

    expect(creates(requests)).toEqual([{ method: "POST", path: LISTING, body: INPUT }]);
    expect(created).toEqual({ id: "NOTE-7", status: "To Do", diagnostics: [FRESH] });
  });

  it("takes the status of the input when the receipt names none", async () => {
    const { creator } = createSetup({ [CREATE]: successReply({ id: "NOTE-7" }) });

    await expect(creator.mutate({ input: INPUT })).resolves.toEqual({ id: "NOTE-7", status: "To Do", diagnostics: [] });
  });

  it("stays pending after the answer until the listing is read again", async () => {
    const listing = heldBack();
    const { creator, replies, queryClient, client } = createSetup({ [CREATE]: successReply({ id: "NOTE-7", status: "To Do" }) });
    const stop = watchListing(queryClient, client);
    await queryClient.query(tasksQuery(client, TAG));
    replies[LISTING] = listing.reply;

    const done = creator.mutate({ input: INPUT });
    await vi.waitFor(() => {
      expect(queryClient.getQueryState(tasksQuery(client, TAG).queryKey)?.fetchStatus).toBe("fetching");
    });

    expect(creator.getCurrentResult().status).toBe("pending");

    listing.answer(successReply({ entries: [], excluded: [] }));
    await done;

    expect(creator.getCurrentResult().status).toBe("success");
    stop();
  });

  it("closes every write failure notice on success, leaves other notices open, and opens no warning notice", async () => {
    const { observer, creator } = createSetup({
      [`PATCH ${taskPath("NOTE-1")}`]: REFUSAL,
      [CREATE]: successReply({ id: "NOTE-7", status: "To Do" }, [FRESH]),
    });
    useNoticeStore.getState().showNotice({ key: "task-read:NOTE-9", form: "warning", title: "1 warning about NOTE-9", words: ["a"] });
    await expect(observer.mutate(moveOf("NOTE-1"))).rejects.toThrow();

    await creator.mutate({ input: INPUT });

    expect(notices().map(({ key }) => key)).toEqual(["task-read:NOTE-9"]);
  });

  it("rejects a refusal with the shared write error, opens no notice, and still reads the listing again", async () => {
    const { creator, queryClient, client, requests } = createSetup({ [CREATE]: REFUSAL });
    const stop = watchListing(queryClient, client);
    await queryClient.query(tasksQuery(client, TAG));
    requests.length = 0;

    const error = await creator.mutate({ input: INPUT }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(WriteError);
    expect((error as WriteError).cause).toBeInstanceOf(ProtocolError);
    expect(notices()).toEqual([]);
    await vi.waitFor(() => {
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([CREATE, `GET ${LISTING}`]);
    });
    stop();
  });

  it("does not try a create again", async () => {
    const { creator, requests } = createSetup({ [CREATE]: { status: 502 } });

    await expect(creator.mutate({ input: INPUT })).rejects.toThrow();

    expect(creates(requests)).toHaveLength(1);
  });

  it("waits for a write in flight in the same project", async () => {
    const first = heldBack();
    const { observer, creator, requests } = createSetup({
      [`PATCH ${taskPath("NOTE-1")}`]: first.reply,
      [CREATE]: successReply({ id: "NOTE-7", status: "To Do" }),
    });

    const done = [observer.mutate(moveOf("NOTE-1")), creator.mutate({ input: INPUT })];
    await vi.waitFor(() => {
      expect(requests.filter(({ method }) => method !== "GET")).toHaveLength(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(creates(requests)).toEqual([]);

    first.answer(written("NOTE-1"));
    await Promise.all(done);

    expect(requests.filter(({ method }) => method !== "GET").map(({ method }) => method)).toEqual(["PATCH", "POST"]);
  });

  it("is keyed under the tasks of its project, apart from the writes the board lays over its cards", async () => {
    const held = heldBack();
    const { queryClient, client } = createSetup({ [CREATE]: held.reply });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const { result } = renderHook(() => usePendingTaskWrites(TAG), { wrapper });
    const options = taskCreateOptions(queryClient, client, TAG);
    let done: Promise<unknown> = Promise.resolve();

    await act(async () => {
      done = new MutationObserver(queryClient, options).mutate({ input: INPUT });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(options.mutationKey).toEqual(["daemon", "projects", TAG, "tasks", "create"]);
    expect(result.current.writes).toEqual([]);
    expect([...result.current.movedIds]).toEqual([]);

    await act(async () => {
      held.answer(successReply({ id: "NOTE-7", status: "To Do" }));
      await done;
    });
  });
});

describe("openCreateWarnings", () => {
  const KNOWN: Diagnostic = { code: "config-key-unknown", message: "unknown key: colour" };
  const FRESH: Diagnostic = { code: "label-case-converted", message: "label \"Web\" was converted to \"web\"" };

  it("opens the warning notice under the new id for the diagnostics the board does not show", () => {
    openCreateWarnings({ id: "NOTE-7", status: "To Do", diagnostics: [KNOWN, FRESH] }, [KNOWN]);

    expect(notices()).toMatchObject([
      {
        key: "task-write-warnings:NOTE-7",
        form: "warning",
        title: "1 warning about NOTE-7",
        words: [`${FRESH.code} · ${FRESH.message}`],
      },
    ]);
  });

  it("opens nothing when the board already shows every diagnostic, or there is none", () => {
    openCreateWarnings({ id: "NOTE-7", status: "To Do", diagnostics: [KNOWN] }, [KNOWN]);
    openCreateWarnings({ id: "NOTE-8", status: "To Do", diagnostics: [] }, []);

    expect(notices()).toEqual([]);
  });
});

describe("createRefusal", () => {
  const CASES: { kind: string; cause: unknown; line: string; words: string }[] = [
    {
      kind: "a refusal",
      cause: new ProtocolError({ kind: "store", code: "status-unknown", message: "status \"Gone\" is not configured" }, 422),
      line: "The daemon refused the write, so no task was created. Its own words are below.",
      words: "store/status-unknown · status \"Gone\" is not configured",
    },
    {
      kind: "no answer",
      cause: new TransportError("connection refused"),
      line: "No daemon answered, so no task was created.",
      words: DAEMON_URL,
    },
    {
      kind: "an answer that is not the daemon's",
      cause: new TransportError(`POST ${LISTING} answered with no envelope`, 502),
      line: "The daemon did not answer through the address below. Start the daemon there if it is not running.",
      words: `${DAEMON_URL} · HTTP 502 · POST ${LISTING} answered with no envelope`,
    },
    {
      kind: "a create that could not start",
      cause: new Error("the path parameter cannot be empty"),
      line: "The create did not start, so no task was created.",
      words: "the path parameter cannot be empty",
    },
  ];

  it.each(CASES)("names what happened for $kind, from the write error", ({ cause, line, words }) => {
    expect(createRefusal(new WriteError(cause))).toEqual({ line, words });
  });

  it.each(CASES)("names what happened for $kind, from the bare cause", ({ cause, line, words }) => {
    expect(createRefusal(cause)).toEqual({ line, words });
  });
});
