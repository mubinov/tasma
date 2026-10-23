import { afterEach, expect, it, vi } from "vitest";
import { createShikiClient } from "../../src/lib/shiki-client";
import type { Hast, TokenizeReply, TokenizeRequest } from "../../src/lib/shiki-tokenize";

class FakeWorker {
  onmessage: ((event: MessageEvent<TokenizeReply>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly requests: TokenizeRequest[] = [];
  terminated = false;

  postMessage(request: TokenizeRequest): void {
    this.requests.push(request);
  }

  get blocks(): Omit<TokenizeRequest, "id">[] {
    return this.requests.map(({ code, language }) => ({ code, language }));
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(hast?: Hast, id = this.requests.at(-1)!.id): void {
    this.onmessage?.(new MessageEvent("message", { data: { id, hast } satisfies TokenizeReply }));
  }

  fail(): void {
    this.onerror?.(new Event("error"));
  }
}

const DEADLINE = 1000;

function setUp(): { client: ReturnType<typeof createShikiClient>; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const client = createShikiClient(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  }, DEADLINE);
  return { client, workers };
}

function hastOf(text: string): Hast {
  return { type: "root", children: [{ type: "text", value: text }] };
}

afterEach(() => {
  vi.useRealTimers();
});

it("starts no worker before the first block", () => {
  const { client, workers } = setUp();
  expect(workers).toEqual([]);

  void client.highlight("const a = 1;", "ts");

  expect(workers).toHaveLength(1);
  expect(workers[0]!.blocks).toEqual([{ code: "const a = 1;", language: "ts" }]);
});

it("sends one block at a time, in order, and gives each block its HAST", async () => {
  const { client, workers } = setUp();
  const first = client.highlight("a", "ts");
  const second = client.highlight("b", "py");
  const worker = workers[0]!;
  expect(worker.blocks).toEqual([{ code: "a", language: "ts" }]);

  worker.reply(hastOf("a"));
  expect(await first).toEqual(hastOf("a"));
  expect(worker.blocks).toEqual([{ code: "a", language: "ts" }, { code: "b", language: "py" }]);

  worker.reply(hastOf("b"));
  expect(await second).toEqual(hastOf("b"));
  expect(workers).toHaveLength(1);
});

it("takes only the reply to the block that the worker has, so more replies to an earlier block change nothing", async () => {
  const { client, workers } = setUp();
  const first = client.highlight("a", "ts");
  const second = client.highlight("b", "ts");
  const worker = workers[0]!;
  const toFirst = worker.requests[0]!.id;
  let secondDone = false;
  void second.then(() => {
    secondDone = true;
  });

  worker.reply(hastOf("a"), toFirst);
  worker.reply(undefined, toFirst);
  worker.reply(hastOf("a"), toFirst);

  expect(await first).toEqual(hastOf("a"));
  await Promise.resolve();
  expect(secondDone).toBe(false);
  worker.reply(hastOf("b"));
  expect(await second).toEqual(hastOf("b"));
  void client.highlight("a", "ts");
  expect(worker.blocks).toEqual([{ code: "a", language: "ts" }, { code: "b", language: "ts" }, { code: "a", language: "ts" }]);
});

it("removes its handlers from the worker while no block waits, and sets them again for the next block", async () => {
  const { client, workers } = setUp();
  const first = client.highlight("a", "ts");
  const worker = workers[0]!;
  worker.reply(hastOf("a"));
  await first;

  expect(worker.onmessage).toBeNull();
  expect(worker.onerror).toBeNull();

  const next = client.highlight("b", "ts");
  worker.reply(hastOf("b"));
  expect(await next).toEqual(hastOf("b"));
  expect(workers).toHaveLength(1);
});

it("sends a block that already waits for its HAST only once", async () => {
  const { client, workers } = setUp();
  const first = client.highlight("a", "ts");
  const again = client.highlight("a", "ts");

  workers[0]!.reply(hastOf("a"));

  expect(await again).toEqual(hastOf("a"));
  expect(await first).toEqual(hastOf("a"));
  expect(workers[0]!.requests).toHaveLength(1);
});

it("sends a block again after its HAST came, because the client keeps no HAST", async () => {
  const { client, workers } = setUp();
  const first = client.highlight("a", "ts");
  workers[0]!.reply(hastOf("a"));
  await first;

  void client.highlight("a", "ts");

  expect(workers[0]!.requests).toHaveLength(2);
});

it("keeps a block plain after a reply with no HAST, and sends the same code in another language", async () => {
  const { client, workers } = setUp();
  const first = client.highlight("a", "ts");
  workers[0]!.reply();
  expect(await first).toBeUndefined();

  expect(await client.highlight("a", "ts")).toBeUndefined();
  expect(workers[0]!.requests).toHaveLength(1);

  void client.highlight("a", "py");
  expect(workers[0]!.blocks).toEqual([{ code: "a", language: "ts" }, { code: "a", language: "py" }]);
});

it("stops the worker at the deadline, keeps the block plain, and sends the next block to a new worker", async () => {
  vi.useFakeTimers();
  const { client, workers } = setUp();
  const slow = client.highlight("slow", "cpp");
  const next = client.highlight("b", "ts");
  const first = workers[0]!;

  vi.advanceTimersByTime(DEADLINE - 1);
  expect(first.terminated).toBe(false);
  vi.advanceTimersByTime(1);

  expect(await slow).toBeUndefined();
  expect(first.terminated).toBe(true);
  expect(first.onmessage).toBeNull();
  expect(first.onerror).toBeNull();
  expect(workers).toHaveLength(2);
  expect(workers[1]!.blocks).toEqual([{ code: "b", language: "ts" }]);

  workers[1]!.reply(hastOf("b"));
  expect(await next).toEqual(hastOf("b"));
  expect(await client.highlight("slow", "cpp")).toBeUndefined();
  expect(workers).toHaveLength(2);
  expect(workers[1]!.requests).toHaveLength(1);
});

it("starts a new worker for a block that comes after a deadline", async () => {
  vi.useFakeTimers();
  const { client, workers } = setUp();
  const slow = client.highlight("slow", "cpp");
  vi.advanceTimersByTime(DEADLINE);
  expect(await slow).toBeUndefined();
  expect(workers[0]!.terminated).toBe(true);

  const next = client.highlight("b", "ts");

  expect(workers).toHaveLength(2);
  workers[1]!.reply(hastOf("b"));
  expect(await next).toEqual(hastOf("b"));
});

it("gives each block its own deadline, from the time the worker gets it", async () => {
  vi.useFakeTimers();
  const { client, workers } = setUp();
  const first = client.highlight("a", "ts");
  const second = client.highlight("b", "ts");
  const worker = workers[0]!;

  vi.advanceTimersByTime(DEADLINE - 1);
  worker.reply(hastOf("a"));
  expect(await first).toEqual(hastOf("a"));
  vi.advanceTimersByTime(DEADLINE - 1);
  worker.reply(hastOf("b"));

  expect(await second).toEqual(hastOf("b"));
  vi.advanceTimersByTime(DEADLINE);
  expect(worker.terminated).toBe(false);
  expect(workers).toHaveLength(1);
});

it("keeps every block plain when the worker fails, and starts no other worker", async () => {
  vi.useFakeTimers();
  const { client, workers } = setUp();
  const first = client.highlight("a", "ts");
  const second = client.highlight("b", "ts");

  workers[0]!.fail();

  expect(await first).toBeUndefined();
  expect(await second).toBeUndefined();
  expect(workers[0]!.terminated).toBe(true);
  expect(await client.highlight("c", "ts")).toBeUndefined();
  vi.advanceTimersByTime(DEADLINE);
  expect(workers).toHaveLength(1);
  expect(workers[0]!.requests).toHaveLength(1);
});

it("keeps every block plain when no worker can be made", async () => {
  const createWorker = vi.fn((): Worker => {
    throw new DOMException("blocked", "SecurityError");
  });
  const client = createShikiClient(createWorker, DEADLINE);

  expect(await client.highlight("a", "ts")).toBeUndefined();
  expect(await client.highlight("b", "ts")).toBeUndefined();
  expect(createWorker).toHaveBeenCalledOnce();
});
