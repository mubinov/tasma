import type { Hast, TokenizeReply, TokenizeRequest } from "./shiki-tokenize";

export type ShikiClient = {
  /** The HAST of `code` in Shiki colours, or `undefined` when the block stays plain. */
  highlight: (code: string, language: string) => Promise<Hast | undefined>;
};

type Job = TokenizeRequest & { key: string; resolve: (hast: Hast | undefined) => void };

/**
 * Tokenizes in a worker, one block at a time, and stops the worker when a block
 * passes `deadlineMs`: one regular expression match can run for minutes, and
 * nothing else stops it. A block that passes the deadline or fails stays plain
 * for the life of the client. A worker that fails leaves every block plain.
 */
export function createShikiClient(createWorker: () => Worker, deadlineMs: number): ShikiClient {
  const waiting = new Map<string, Promise<Hast | undefined>>();
  const plain = new Set<string>();
  const queue: Job[] = [];
  let worker: Worker | undefined;
  let busy = false;
  let failed = false;
  let lastId = 0;

  function settle(job: Job, hast: Hast | undefined): void {
    waiting.delete(job.key);
    if (!hast) plain.add(job.key);
    job.resolve(hast);
  }

  function failAll(): void {
    failed = true;
    for (const job of queue.splice(0)) settle(job, undefined);
  }

  function next(): void {
    const job = queue.shift();
    busy = job !== undefined;
    if (!job) {
      if (worker) {
        worker.onmessage = null;
        worker.onerror = null;
      }
      return;
    }
    let target: Worker;
    try {
      target = worker ??= createWorker();
    } catch {
      settle(job, undefined);
      failAll();
      return;
    }
    const timer = setTimeout(() => {
      stop();
      settle(job, undefined);
      next();
    }, deadlineMs);
    function stop(): void {
      clearTimeout(timer);
      target.onmessage = null;
      target.onerror = null;
      target.terminate();
      worker = undefined;
    }
    target.onmessage = (event: MessageEvent<TokenizeReply>) => {
      // A worker whose entry module runs two times replies two times to one request.
      if (event.data.id !== job.id) return;
      clearTimeout(timer);
      settle(job, event.data.hast);
      next();
    };
    target.onerror = () => {
      stop();
      settle(job, undefined);
      failAll();
    };
    target.postMessage({ id: job.id, code: job.code, language: job.language } satisfies TokenizeRequest);
  }

  return {
    highlight(code, language) {
      const key = `${language}\n${code}`;
      if (failed || plain.has(key)) return Promise.resolve(undefined);
      const existing = waiting.get(key);
      if (existing) return existing;
      const promise = new Promise<Hast | undefined>((resolve) => {
        queue.push({ id: ++lastId, code, language, key, resolve });
      });
      waiting.set(key, promise);
      if (!busy) next();
      return promise;
    },
  };
}

// The first block of a large grammar, which compiles the grammar, takes about a second in WebKit.
const DEADLINE_MS = 5_000;

export const shikiClient = createShikiClient(
  () => new Worker(new URL("./shiki-tokenize.worker.ts", import.meta.url), { type: "module" }),
  DEADLINE_MS,
);
