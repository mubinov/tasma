import { MutationObserver } from "@tanstack/react-query";
import { createClient, TransportError, type TransportReply, type TransportRequest } from "@tasma/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { createAppQueryClient } from "../../../src/api/client";
import {
  CHAT_CLIENT,
  chatFailureKey,
  chatRefusalCode,
  chatWriteKey,
  chatWriteOptions,
  failureKind,
  WriteError,
  type ChatWrite,
} from "../../../src/api/mutations";
import { useNoticeStore } from "../../../src/store/notices";
import { refusalReply, stubTransport, successReply } from "../../helpers";

const PLACE = { tag: "SAGA", task: "SAGA-3", chat: 2 };

const CHAT_PATH = "/projects/SAGA/tasks/SAGA-3/chats/2";

const RECORD = successReply({ task: "SAGA-3", chat: 2, step: "build", agent: "claude", folder: "/work/saga", seq: 4 });

const FAILURE = { title: "The write failed.", line: (error: WriteError) => `line of ${failureKind(error.cause)}` };

const CLOSED = { title: "The answer was not used.", line: "The request was already closed." };

const MESSAGE: ChatWrite = { kind: "message", text: "Build the app.", failure: FAILURE };

const CANCEL: ChatWrite = { kind: "cancel", failure: FAILURE };

const PERMISSION: ChatWrite = { kind: "permission", request: "r1", optionId: "allow-once", failure: FAILURE, closed: CLOSED };

const QUESTION: ChatWrite = {
  kind: "question",
  request: "r2",
  answer: { action: "accept", content: { question_0: "lexer" } },
  failure: FAILURE,
  closed: CLOSED,
};

const DECLINE: ChatWrite = { kind: "question", request: "r2", answer: { action: "decline" }, failure: FAILURE, closed: CLOSED };

function setup(replies: Record<string, TransportReply | Promise<TransportReply>> = {}) {
  const stub = stubTransport(replies);
  const queryClient = createAppQueryClient();
  const observer = new MutationObserver(queryClient, chatWriteOptions(createClient(stub.transport), PLACE));

  return { ...stub, observer };
}

function writes(requests: readonly TransportRequest[]): TransportRequest[] {
  return requests.filter(({ method }) => method !== "GET");
}

function notices() {
  return useNoticeStore.getState().notices;
}

function refused(code: "turn-running" | "already-answered" | "malformed-request"): TransportReply {
  return refusalReply(409, { kind: "daemon", code, message: `refused: ${code}` });
}

beforeEach(() => {
  useNoticeStore.setState({ notices: [], dismissed: new Map() });
});

describe("CHAT_CLIENT", () => {
  it("is app- and 8 hex digits", () => {
    expect(CHAT_CLIENT).toMatch(/^app-[0-9a-f]{8}$/);
  });
});

describe("chatWriteOptions", () => {
  it.each<[string, ChatWrite, string, unknown]>([
    ["a message", MESSAGE, `${CHAT_PATH}/messages`, { text: "Build the app.", client: CHAT_CLIENT }],
    ["a cancel", CANCEL, `${CHAT_PATH}/cancel`, { client: CHAT_CLIENT }],
    ["a permission answer", PERMISSION, `${CHAT_PATH}/permissions/r1`, { optionId: "allow-once", client: CHAT_CLIENT }],
    [
      "a question answer",
      QUESTION,
      `${CHAT_PATH}/questions/r2`,
      { action: "accept", content: { question_0: "lexer" }, client: CHAT_CLIENT },
    ],
    ["a question decline", DECLINE, `${CHAT_PATH}/questions/r2`, { action: "decline", client: CHAT_CLIENT }],
  ])("posts %s to its route with the client of the window", async (_name, write, path, body) => {
    const { observer, requests } = setup({ [`POST ${path}`]: RECORD });

    await observer.mutate(write);

    expect(writes(requests)).toEqual([{ method: "POST", path, body }]);
  });

  it("keys the writes under the chat", () => {
    expect(chatWriteOptions(createClient(stubTransport().transport), PLACE).mutationKey).toEqual(
      chatWriteKey(PLACE),
    );
    expect(chatWriteKey(PLACE)).toEqual(["daemon", "projects", "SAGA", "tasks", "SAGA-3", "chats", 2, "write"]);
  });

  it("opens a failure notice for a refusal, with its title, its line and the words of the daemon", async () => {
    const { observer } = setup({ [`POST ${CHAT_PATH}/messages`]: refused("turn-running") });

    await expect(observer.mutate(MESSAGE)).rejects.toBeInstanceOf(WriteError);

    expect(notices()).toEqual([
      expect.objectContaining({
        key: chatFailureKey(PLACE, "message"),
        form: "failure",
        title: "The write failed.",
        line: "line of refused",
        words: ["daemon/turn-running · refused: turn-running"],
      }),
    ]);
  });

  it("closes the failure notice of the same kind when a later write succeeds, and leaves the notice of another kind", async () => {
    const { observer, replies } = setup({
      [`POST ${CHAT_PATH}/messages`]: refused("turn-running"),
      [`POST ${CHAT_PATH}/cancel`]: refused("malformed-request"),
    });
    await expect(observer.mutate(MESSAGE)).rejects.toBeInstanceOf(WriteError);
    await expect(observer.mutate(CANCEL)).rejects.toBeInstanceOf(WriteError);
    replies[`POST ${CHAT_PATH}/messages`] = RECORD;

    await observer.mutate(MESSAGE);

    expect(notices().map(({ key }) => key)).toEqual([chatFailureKey(PLACE, "cancel")]);
  });

  it.each([PERMISSION, QUESTION])("opens a warning notice with the closed texts for already-answered", async (write) => {
    const path = write.kind === "permission" ? `${CHAT_PATH}/permissions/r1` : `${CHAT_PATH}/questions/r2`;
    const { observer } = setup({ [`POST ${path}`]: refused("already-answered") });

    const error = await observer.mutate(write).catch((caught: unknown) => caught);

    expect(chatRefusalCode(error)).toBe("already-answered");
    expect(notices()).toEqual([
      expect.objectContaining({
        key: chatFailureKey(PLACE, write.kind),
        form: "warning",
        title: "The answer was not used.",
        line: "The request was already closed.",
        words: ["daemon/already-answered · refused: already-answered"],
      }),
    ]);
  });

  it("opens a failure notice for another refusal of an answer", async () => {
    const { observer } = setup({ [`POST ${CHAT_PATH}/permissions/r1`]: refused("malformed-request") });

    await expect(observer.mutate(PERMISSION)).rejects.toBeInstanceOf(WriteError);

    expect(notices()).toEqual([expect.objectContaining({ form: "failure", title: "The write failed." })]);
  });

  it("does not send a write again when its answer is lost", async () => {
    const lost = Promise.reject(new TransportError("POST reached no daemon"));
    lost.catch(() => {});
    const { observer, requests } = setup({ [`POST ${CHAT_PATH}/messages`]: lost });

    await expect(observer.mutate(MESSAGE)).rejects.toBeInstanceOf(WriteError);

    expect(writes(requests)).toHaveLength(1);
    expect(notices()).toEqual([expect.objectContaining({ line: "line of unanswered" })]);
  });
});

describe("chatRefusalCode", () => {
  it("gives the code of a refusal inside a write error, and nothing for another error", () => {
    expect(chatRefusalCode(new WriteError(new TransportError("lost")))).toBeUndefined();
    expect(chatRefusalCode(new Error("boom"))).toBeUndefined();
  });
});
