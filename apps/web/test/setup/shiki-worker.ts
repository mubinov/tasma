import { beforeEach, vi } from "vitest";
import type { TokenizeReply, TokenizeRequest } from "../../src/lib/shiki-tokenize";

/**
 * jsdom has no `Worker`. This one runs the tokenizer of the highlighter worker
 * in the test thread, and copies each message as a worker does.
 */
class InProcessWorker {
  onmessage: ((event: MessageEvent<TokenizeReply>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly #tokenize = import("../../src/lib/shiki-tokenize").then(({ createTokenizer }) => createTokenizer());
  #terminated = false;

  postMessage(request: TokenizeRequest): void {
    void this.#tokenize.then(async (tokenize) => {
      const reply = await tokenize(structuredClone(request));
      if (!this.#terminated) this.onmessage?.(new MessageEvent("message", { data: structuredClone(reply) }));
    });
  }

  terminate(): void {
    this.#terminated = true;
  }
}

// Before each test, because a test can remove all stubbed globals after it.
beforeEach(() => {
  vi.stubGlobal("Worker", InProcessWorker);
});
