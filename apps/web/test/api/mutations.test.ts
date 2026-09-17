import { MutationObserver, onlineManager, QueryClientProvider, QueryObserver, type QueryClient } from "@tanstack/react-query";
import {
  createClient,
  type Client,
  type Diagnostic,
  type Transport,
  type TransportReply,
  type TransportRequest,
} from "@tasma/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppQueryClient } from "../../src/api/client";
import { taskWriteKey, taskWriteOptions, usePendingTaskWrites, type TaskWrites } from "../../src/api/mutations";
import { projectQuery, tasksQuery } from "../../src/api/queries";
import { DAEMON_URL } from "../../src/api/transport";
import { useNoticeStore } from "../../src/store/notices";
import { heldBack, refusalReply, stubTransport, successReply } from "../helpers";

const TAG = "NOTE";

const LISTING = "/projects/NOTE/tasks";

function taskPath(id: string): string {
  return `/projects/NOTE/tasks/${id}`;
}

function written(id: string, diagnostics: Diagnostic[] = []): TransportReply {
  return successReply({ id }, diagnostics);
}

function moveOf(first: string, ...others: string[]): TaskWrites {
  const write = (id: string, order: number) => ({ id, change: { status: "Done", order } });

  return {
    writes: [write(first, 0), ...others.map((id, index) => write(id, index + 1))],
    title: `${others.at(-1) ?? first} was not moved`,
  };
}

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
  it("sends each change as a PATCH of its task, in order, and resolves with the diagnostics of all of them", async () => {
    const found: Diagnostic = { code: "status-case-corrected", message: "status \"done\" was written as \"Done\"" };
    const { observer, requests } = setup({
      [`PATCH ${taskPath("NOTE-1")}`]: written("NOTE-1", [found]),
      [`PATCH ${taskPath("NOTE-2")}`]: written("NOTE-2"),
    });

    const diagnostics = await observer.mutate(moveOf("NOTE-1", "NOTE-2"));

    expect(writes(requests)).toEqual([
      { method: "PATCH", path: taskPath("NOTE-1"), body: { status: "Done", order: 0 } },
      { method: "PATCH", path: taskPath("NOTE-2"), body: { status: "Done", order: 1 } },
    ]);
    expect(diagnostics).toEqual([found]);
  });

  it("stops at the first failure, and does not try the write again", async () => {
    const refusal = refusalReply(422, { kind: "store", code: "status-unknown", message: "status \"Gone\" is not configured" });
    const { observer, requests } = setup({
      [`PATCH ${taskPath("NOTE-1")}`]: refusal,
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

describe("the failure notice", () => {
  it.each<{ kind: string; reply: TransportReply | null; id?: string; line: string; words: string }>([
    {
      kind: "a refusal",
      reply: refusalReply(422, { kind: "store", code: "status-unknown", message: "status \"Gone\" is not configured" }),
      line: "The daemon refused the write, and the task is back where it was. Its own words are below.",
      words: "store/status-unknown · status \"Gone\" is not configured",
    },
    {
      kind: "no answer",
      reply: null,
      line: "No daemon answered, so nothing was written.",
      words: DAEMON_URL,
    },
    {
      kind: "an answer that is not the daemon's",
      reply: { status: 502 },
      line: "The daemon did not answer through the address below. Start the daemon there if it is not running. "
        + "The board shows the task where the daemon holds it after the next read.",
      words: `${DAEMON_URL} · HTTP 502 · PATCH ${taskPath("NOTE-1")} answered with no envelope`,
    },
    {
      kind: "a write that could not start",
      reply: null,
      id: "..",
      line: "The write did not start, and the task is back where it was.",
      words: "/projects/{project}/tasks/{id} cannot take \"..\" as the path parameter \"id\": it is not one path component",
    },
  ])("says what happened for $kind, with the given title", async ({ reply, id = "NOTE-1", line, words }) => {
    const { transport: answering } = stubTransport(reply === null ? {} : { [`PATCH ${taskPath(id)}`]: reply });
    const transport: Transport = (request) =>
      reply === null && request.method === "PATCH" ? Promise.reject(new Error("connection refused")) : answering(request);
    const { observer } = setup({}, transport);

    await expect(observer.mutate(moveOf(id))).rejects.toThrow();

    expect(notices()).toMatchObject([
      { key: `task-write-failure:${id}`, form: "failure", title: `${id} was not moved`, line, words: [words] },
    ]);
  });

  it("opens the notice about the same task anew for each failure with the same words, dismissed or not, and keeps the notice about another task", async () => {
    const refusal = refusalReply(422, { kind: "store", code: "status-unknown", message: "status \"Gone\" is not configured" });
    const { observer } = setup({ [`PATCH ${taskPath("NOTE-1")}`]: refusal, [`PATCH ${taskPath("NOTE-2")}`]: refusal });
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
    const refusal = refusalReply(422, { kind: "store", code: "status-unknown", message: "status \"Gone\" is not configured" });
    const { observer } = setup({
      [`PATCH ${taskPath("NOTE-1")}`]: refusal,
      [`PATCH ${taskPath("NOTE-2")}`]: refusal,
      [`PATCH ${taskPath("NOTE-3")}`]: written("NOTE-3"),
    });
    useNoticeStore.getState().showNotice({ key: "task-read:NOTE-9", form: "warning", title: "1 warning about NOTE-9", words: ["a"] });

    await expect(observer.mutate(moveOf("NOTE-1"))).rejects.toThrow();
    await expect(observer.mutate(moveOf("NOTE-2"))).rejects.toThrow();
    await observer.mutate(moveOf("NOTE-3"));

    expect(notices().map(({ key }) => key)).toEqual(["task-read:NOTE-9"]);
  });
});

describe("the warning notice of a write", () => {
  const KNOWN: Diagnostic = { code: "config-key-unknown", message: "unknown key: colour", path: "/p/config.yml", line: 2 };
  const LISTED: Diagnostic = { code: "blocked-by-unresolved", message: "NOTE-9 names no task", path: "/p/NOTE-4.md" };
  const FRESH: Diagnostic = { code: "label-case-converted", message: "label \"Web\" was converted to \"web\"" };

  it("lists the diagnostics the board does not already show, about the last task written", async () => {
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
  const ELSE_WRITE: TaskWrites = { writes: [{ id: "ELSE-1", change: { order: 1 } }], title: "ELSE-1 was not moved" };

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

    expect(result.current.map(({ id, change }) => [id, change])).toEqual([
      ["NOTE-1", { status: "Done", order: 0 }],
      ["NOTE-2", { status: "Done", order: 0 }],
      ["NOTE-3", { status: "Done", order: 1 }],
    ]);
    expect(result.current.every(({ submittedAt }) => submittedAt > 0)).toBe(true);

    await act(async () => {
      first.answer(written("NOTE-1"));
      other.answer(successReply({ id: "ELSE-1" }));
      await Promise.all(done);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(result.current).toEqual([]);
  });

  it("gives the writes of the project it is asked for at each render, with no new write in between", async () => {
    const first = heldBack();
    const other = heldBack();
    const { result, rerender, send } = renderPending({
      [`PATCH ${taskPath("NOTE-1")}`]: first.reply,
      "PATCH /projects/ELSE/tasks/ELSE-1": other.reply,
    });
    const done = await send([TAG, moveOf("NOTE-1")], ["ELSE", ELSE_WRITE]);
    const ids = () => result.current.map(({ id }) => id);
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
