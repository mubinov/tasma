import { expect, it, vi } from "vitest";
import type { TokenizeReply } from "../../src/lib/shiki-tokenize";
import { SHIKI_LOAD } from "../kit/shiki";

it("answers each message with the reply of the tokenizer", async () => {
  const post = vi.spyOn(globalThis, "postMessage").mockImplementation(() => undefined);
  await import("../../src/lib/shiki-tokenize.worker");

  globalThis.dispatchEvent(new MessageEvent("message", { data: { id: 3, code: "const a = 1;", language: "ts" } }));

  await vi.waitFor(() => expect(post).toHaveBeenCalledOnce(), SHIKI_LOAD);
  const [reply] = post.mock.calls[0]! as [TokenizeReply];
  expect(reply.id).toBe(3);
  expect(reply.hast?.type).toBe("root");
});
