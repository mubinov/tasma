import { MutationObserver, QueryClientProvider, QueryObserver, type QueryClient } from "@tanstack/react-query";
import {
  createClient,
  ProtocolError,
  type Client,
  type Diagnostic,
  type TransportReply,
  type TransportRequest,
} from "@tasma/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAppQueryClient } from "../../../src/api/client";
import {
  commentFailureKey,
  commentFailureTitle,
  commentWriteKey,
  commentWriteOptions,
  failureKind,
  taskWriteKey,
  taskWriteOptions,
  usePendingCollapsed,
  refusalWords,
  usePendingTaskWrites,
  WriteError,
  type CommentWrite,
} from "../../../src/api/mutations";
import { projectQuery, taskQuery, tasksQuery } from "../../../src/api/queries";
import { useNoticeStore } from "../../../src/store/notices";
import { heldBack, refusalReply, stubTransport, successReply } from "../../helpers";

const TAG = "NOTE";

const TASK = "NOTE-1";

const LISTING = "/projects/NOTE/tasks";

const TASK_PATH = "/projects/NOTE/tasks/NOTE-1";

const COMMENTS_PATH = `${TASK_PATH}/comments`;

function commentPath(commentId: number): string {
  return `${COMMENTS_PATH}/${String(commentId)}`;
}

function written(commentId?: number, diagnostics: Diagnostic[] = []): TransportReply {
  return successReply({ id: TASK, commentId }, diagnostics);
}

/** A sender's failure, whose line names the cause the factory handed it. */
function failureOf(title: string): CommentWrite["failure"] {
  return { title, line: (error) => `line of ${failureKind(error.cause)}` };
}

const ADD: CommentWrite = {
  id: TASK,
  failure: failureOf(`The new comment on ${TASK} was not added`),
  kind: "add",
  input: { title: "Review", body: "Looks right." },
};

const UPDATE: CommentWrite = {
  id: TASK,
  failure: failureOf(`Comment #3 of ${TASK} was not saved`),
  kind: "update",
  commentId: 3,
  change: { title: "Review", body: "Looks right." },
};

const DELETE: CommentWrite = {
  id: TASK,
  failure: failureOf(`Comment #3 of ${TASK} was not deleted`),
  kind: "delete",
  commentId: 3,
};

function flagWrite(commentId: number, collapsed: boolean): CommentWrite {
  return {
    id: TASK,
    failure: failureOf(`Comment #${String(commentId)} of ${TASK} was not changed`),
    kind: "update",
    commentId,
    change: { collapsed: collapsed ? true : null },
  };
}

function setup(replies: Record<string, TransportReply | Promise<TransportReply>> = {}) {
  const stub = stubTransport({ [LISTING]: successReply({ entries: [], excluded: [] }), ...replies });
  const client = createClient(stub.transport);
  const queryClient = createAppQueryClient();
  const observer = new MutationObserver(queryClient, commentWriteOptions(queryClient, client, TAG));

  return { ...stub, client, queryClient, observer };
}

/** An observed listing, so an invalidation refetches it. */
function watchListing(queryClient: QueryClient, client: Client): () => void {
  return new QueryObserver(queryClient, tasksQuery(client, TAG)).subscribe(() => {});
}

function writes(requests: readonly TransportRequest[]): TransportRequest[] {
  return requests.filter(({ method }) => method !== "GET");
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

describe("commentWriteOptions", () => {
  it("adds a comment through the add method and resolves with the id the daemon issued", async () => {
    const { observer, requests } = setup({ [`POST ${COMMENTS_PATH}`]: written(4) });

    const result = await observer.mutate(ADD);

    expect(writes(requests)).toEqual([
      { method: "POST", path: COMMENTS_PATH, body: { title: "Review", body: "Looks right." } },
    ]);
    expect(result).toEqual({ id: TASK, commentId: 4, diagnostics: [] });
  });

  it("changes a comment through the update method", async () => {
    const { observer, requests } = setup({ [`PATCH ${commentPath(3)}`]: written(3) });

    const result = await observer.mutate(UPDATE);

    expect(writes(requests)).toEqual([
      { method: "PATCH", path: commentPath(3), body: { title: "Review", body: "Looks right." } },
    ]);
    expect(result.commentId).toBe(3);
  });

  it("removes a comment through the delete method", async () => {
    const { observer, requests } = setup({ [`DELETE ${commentPath(3)}`]: written(3) });

    await observer.mutate(DELETE);

    expect(writes(requests).map(({ method, path }) => [method, path])).toEqual([["DELETE", commentPath(3)]]);
  });

  it("writes null for a flag turned off, which the daemon reads as a removal", async () => {
    const { observer, requests } = setup({ [`PATCH ${commentPath(3)}`]: written(3) });

    await observer.mutate(flagWrite(3, false));

    expect(writes(requests)[0]?.body).toEqual({ collapsed: null });
  });

  it("carries its own key, so a pending comment write is no card write", async () => {
    const held = heldBack();
    const { queryClient, client } = setup({ [`PATCH ${commentPath(3)}`]: held.reply });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const { result } = renderHook(() => usePendingTaskWrites(TAG), { wrapper });

    expect(commentWriteKey(TAG)).not.toEqual(taskWriteKey(TAG));

    let done: Promise<unknown> = Promise.resolve();
    await act(async () => {
      done = new MutationObserver(queryClient, commentWriteOptions(queryClient, client, TAG)).mutate(UPDATE);
      await Promise.resolve();
    });

    expect(result.current.writes).toEqual([]);

    held.answer(written(3));
    await act(async () => {
      await done;
    });
  });

  it("shares the write queue of the project's task writes", async () => {
    const write = heldBack();
    const { queryClient, client, requests } = setup({
      [`PATCH ${commentPath(3)}`]: write.reply,
      [`PATCH ${TASK_PATH}`]: successReply({ id: TASK }),
    });
    const comment = new MutationObserver(queryClient, commentWriteOptions(queryClient, client, TAG));
    const task = new MutationObserver(queryClient, taskWriteOptions(queryClient, client, TAG));

    const first = comment.mutate(UPDATE);
    const second = task.mutate({
      id: TASK,
      writes: [{ id: TASK, change: { title: "Renamed" } }],
      failure: { title: `${TASK} was not saved`, line: () => "not saved" },
    });
    await Promise.resolve();

    expect(writes(requests).map(({ path }) => path)).toEqual([commentPath(3)]);

    write.answer(written(3));
    await first;
    await second;

    expect(writes(requests).map(({ path }) => path)).toEqual([commentPath(3), TASK_PATH]);
  });

  it("stays pending after the answer until the task is read again", async () => {
    const listing = heldBack();
    const { observer, replies, queryClient, client } = setup({ [`PATCH ${commentPath(3)}`]: written(3) });
    const stop = watchListing(queryClient, client);
    await queryClient.query(tasksQuery(client, TAG));
    replies[LISTING] = listing.reply;

    const done = observer.mutate(UPDATE);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(observer.getCurrentResult().status).toBe("pending");

    listing.answer(successReply({ entries: [], excluded: [] }));
    await done;

    expect(observer.getCurrentResult().status).toBe("success");
    stop();
  });
});

describe("the notice of a refused comment write", () => {
  const REFUSAL = refusalReply(422, { kind: "store", code: "comment-not-found", message: "comment 3 is not in the file" });

  it("names the comment in its key, so two failing editors keep their own notices", async () => {
    const { observer } = setup({ [`PATCH ${commentPath(3)}`]: REFUSAL, [`POST ${COMMENTS_PATH}`]: REFUSAL });

    await expect(observer.mutate(UPDATE)).rejects.toThrow("is not in the file");
    await expect(observer.mutate(ADD)).rejects.toThrow("is not in the file");

    expect(notices().map(({ key, title }) => [key, title])).toEqual([
      [`comment-write-failure:${TASK}#3`, UPDATE.failure.title],
      [`comment-write-failure:${TASK}#new`, ADD.failure.title],
    ]);
    expect(commentFailureKey(DELETE)).toBe(`comment-write-failure:${TASK}#3`);
  });

  it("opens the sender's title and the line it builds from the error, with the daemon's words", async () => {
    const { observer } = setup({ [`PATCH ${commentPath(3)}`]: REFUSAL });

    await expect(observer.mutate(UPDATE)).rejects.toThrow("is not in the file");

    expect(notices()).toMatchObject([{
      form: "failure",
      title: `Comment #3 of ${TASK} was not saved`,
      line: "line of refused",
      words: ["store/comment-not-found · comment 3 is not in the file"],
    }]);
  });
});

describe("refusalWords", () => {
  it("reads the daemon's words through a write's own error as readily as from the refusal", () => {
    const refusal = new ProtocolError({ kind: "store", code: "comment-not-found", message: "comment 3 is gone" }, 422);

    expect(refusalWords(new WriteError(refusal))).toBe("store/comment-not-found · comment 3 is gone");
    expect(refusalWords(refusal)).toBe("store/comment-not-found · comment 3 is gone");
  });
});

describe("what a successful comment write closes and opens", () => {
  const REFUSAL = refusalReply(422, { kind: "store", code: "comment-not-found", message: "comment 3 is not in the file" });

  it("closes the notice of its own comment and leaves another comment's standing", async () => {
    const { observer, replies } = setup({
      [`PATCH ${commentPath(3)}`]: REFUSAL,
      [`PATCH ${commentPath(5)}`]: REFUSAL,
    });
    await expect(observer.mutate(UPDATE)).rejects.toThrow("is not in the file");
    await expect(observer.mutate({ ...UPDATE, commentId: 5, failure: failureOf("Comment #5 was not saved") }))
      .rejects.toThrow("is not in the file");
    expect(notices()).toHaveLength(2);

    replies[`PATCH ${commentPath(3)}`] = written(3);
    await observer.mutate(UPDATE);

    expect(notices().map(({ key }) => key)).toEqual([`comment-write-failure:${TASK}#5`]);
  });

  it("opens a warning notice for the diagnostics the task read does not already show", async () => {
    const known: Diagnostic = { code: "stale-next-comment-id", message: "next_comment_id is behind the file" };
    const fresh: Diagnostic = { code: "unterminated-fence", message: "a fence never closes" };
    const { observer, queryClient, client } = setup({
      [`PATCH ${commentPath(3)}`]: written(3, [known, fresh]),
      [TASK_PATH]: successReply({ frontmatter: { id: TASK }, body: "", comments: [] }, [known]),
      "/projects/NOTE": successReply({ tag: TAG, name: "Note", path: "/repos/note", live: true, config: {} }),
    });
    await queryClient.query(taskQuery(client, TAG, TASK));
    await queryClient.query(projectQuery(client, TAG));

    await observer.mutate(UPDATE);

    expect(notices().map(({ key, words }) => [key, words])).toEqual([
      [`task-write-warnings:${TASK}`, ["unterminated-fence · a fence never closes"]],
    ]);
  });
});

describe("usePendingCollapsed", () => {
  function renderFlag(
    commentId: number,
    onDisk: boolean,
    replies: Record<string, TransportReply | Promise<TransportReply>>,
  ) {
    const { queryClient, client } = setup(replies);
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const rendered = renderHook(() => usePendingCollapsed(TAG, TASK, commentId, onDisk), { wrapper });

    async function send(...sent: CommentWrite[]): Promise<Promise<unknown>[]> {
      let done: Promise<unknown>[] = [];
      await act(async () => {
        done = sent.map((variables) =>
          new MutationObserver(queryClient, commentWriteOptions(queryClient, client, TAG)).mutate(variables));
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      return done;
    }

    return { ...rendered, send };
  }

  it("reads the file value while nothing is in flight", () => {
    const { result } = renderFlag(3, true, {});

    expect(result.current).toBe(true);
  });

  it("shows a flag turned on before the read lands", async () => {
    const held = heldBack();
    const { result, send } = renderFlag(3, false, { [`PATCH ${commentPath(3)}`]: held.reply });

    const done = await send(flagWrite(3, true));

    expect(result.current).toBe(true);

    held.answer(written(3));
    await act(async () => {
      await Promise.all(done);
    });
  });

  it("shows a flag turned off, whose write carries null, before the read lands", async () => {
    const held = heldBack();
    const { result, send } = renderFlag(3, true, { [`PATCH ${commentPath(3)}`]: held.reply });

    const done = await send(flagWrite(3, false));

    expect(result.current).toBe(false);

    held.answer(written(3));
    await act(async () => {
      await Promise.all(done);
    });
  });

  it("takes the last of two quick toggles, not the first", async () => {
    const held = heldBack();
    const { result, send } = renderFlag(3, false, { [`PATCH ${commentPath(3)}`]: held.reply });

    const done = await send(flagWrite(3, true), flagWrite(3, false));

    expect(result.current).toBe(false);

    held.answer(written(3));
    await act(async () => {
      await Promise.all(done);
    });
  });

  it("reads neither another comment's flag nor a save of its own text", async () => {
    const held = heldBack();
    const { result, send } = renderFlag(3, false, {
      [`PATCH ${commentPath(3)}`]: held.reply,
      [`PATCH ${commentPath(5)}`]: held.reply,
    });

    const done = await send(flagWrite(5, true), UPDATE);

    expect(result.current).toBe(false);

    held.answer(written(3));
    await act(async () => {
      await Promise.all(done);
    });
  });
});

describe("commentFailureTitle", () => {
  it("names the comment and the verb of the write, the add form included", () => {
    expect(commentFailureTitle(TASK, 3, "changed")).toBe(`Comment #3 of ${TASK} was not changed`);
    expect(commentFailureTitle(TASK, "new", "added")).toBe(`The new comment on ${TASK} was not added`);
  });
});
