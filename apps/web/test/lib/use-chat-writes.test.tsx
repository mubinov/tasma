import { isMessageNotSentError } from "@assistant-ui/react";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import type { TransportReply } from "@tasma/protocol";
import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { RouterContext } from "../../src/routes";
import { useChatWrites } from "../../src/lib/use-chat-writes";
import { chatDraft, useChatDraftStore } from "../../src/store/chat-drafts";
import { refusalReply, stubTransport, successReply, testContext } from "../helpers";

const PLACE = { tag: "SAGA", task: "SAGA-3", chat: 2 };

const CHAT_PATH = "/projects/SAGA/tasks/SAGA-3/chats/2";

const REFUSED = refusalReply(400, { kind: "daemon", code: "malformed-request", message: "bad body" });

beforeEach(() => {
  useChatDraftStore.setState({ drafts: new Map() });
});

afterEach(() => {
  cleanup();
});

/** The writes of chat 2 of SAGA-3, under a router over the stub daemon. */
function renderWrites(replies: Record<string, TransportReply> = {}) {
  const stub = stubTransport(replies);
  const router = createRouter({
    routeTree: createRootRouteWithContext<RouterContext>()(),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    context: testContext(stub.transport),
  });
  const { result } = renderHook(() => useChatWrites(PLACE), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <RouterContextProvider router={router}>{children}</RouterContextProvider>
    ),
  });

  return { ...stub, writes: result.current };
}

it("rejects an answer to a request that is not in the chat, and writes nothing", async () => {
  const { writes, requests } = renderWrites();

  await expect(writes.answer(undefined, { approvalId: "r9", approved: true, optionId: "allow" })).rejects.toThrow(
    "The request is not in the chat.",
  );
  expect(requests.filter(({ method }) => method === "POST")).toEqual([]);
});

it("puts a refused message in front of the draft of the chat, and rejects with an error the kit does not put back", async () => {
  const { writes } = renderWrites({ [`POST ${CHAT_PATH}/messages`]: REFUSED });
  useChatDraftStore.getState().setDraft(PLACE, "Then test it.");

  const error = await writes.send("Build.").catch((caught: unknown) => caught);

  expect(chatDraft(PLACE)).toBe("Build.\nThen test it.");
  expect(error).toBeInstanceOf(Error);
  expect(isMessageNotSentError(error)).toBe(false);
});

it("resolves a message that the daemon takes, and leaves the draft", async () => {
  const { writes } = renderWrites({ [`POST ${CHAT_PATH}/messages`]: successReply({}) });

  await writes.send("Build.");

  expect(chatDraft(PLACE)).toBe("");
});

it("resolves a refused cancel", async () => {
  const { writes } = renderWrites({ [`POST ${CHAT_PATH}/cancel`]: REFUSED });

  await expect(writes.cancel()).resolves.toBeUndefined();
});

it("resolves an answer that the daemon refuses with already-answered", async () => {
  const { writes } = renderWrites({
    [`POST ${CHAT_PATH}/questions/r2`]: refusalReply(409, { kind: "daemon", code: "already-answered", message: "closed" }),
  });
  const question = { request: "r2", message: "Which name?", fields: [], state: "open" } as const;

  await expect(writes.answer({ kind: "question", question }, { approvalId: "r2", approved: false })).resolves.toBeUndefined();
});

it("resolves an answer that the daemon takes", async () => {
  const { writes, requests } = renderWrites({ [`POST ${CHAT_PATH}/permissions/r1`]: successReply({}) });
  const permission = { request: "r1", options: [{ id: "allow", name: "Yes", kind: "allow_once" }], state: "open" } as const;

  await writes.answer({ kind: "permission", permission }, { approvalId: "r1", approved: true, optionId: "allow" });

  expect(requests.filter(({ method }) => method === "POST").map(({ path }) => path)).toEqual([`${CHAT_PATH}/permissions/r1`]);
});
