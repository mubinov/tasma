import { ProtocolError, TransportError } from "@tasma/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { isRefused, useRefusalNotice, type RefusalRead } from "../../src/api/refusal-notice";
import { useNoticeStore } from "../../src/store/notices";
import { frame } from "../setup/notice-store";

const KEY = "board-refusal:SAGA";

const TITLE = "The board is not up to date";

const UP_TO_DATE = "The board is up to date.";

const GONE = new ProtocolError({ kind: "store", code: "project-not-found", message: "no project is tagged SAGA" }, 404);

const INVALID = new ProtocolError({ kind: "store", code: "config-invalid", message: "statuses is empty" }, 422);

const UNREADABLE = new TransportError("GET /projects/SAGA/tasks answered with no envelope", 502);

const UNREACHED = new TransportError("GET /projects/SAGA/tasks reached no daemon");

const GONE_WORDS = "store/project-not-found · no project is tagged SAGA";

function line(readAt: number): string {
  return `The daemon refused a read of SAGA. The board shows the tasks as they were at ${String(readAt)}.`;
}

function read(dataUpdatedAt = 1_000): RefusalRead {
  return { status: "success", error: null, dataUpdatedAt };
}

function failed(error: Error, dataUpdatedAt = 1_000): RefusalRead {
  return { status: "error", error, dataUpdatedAt };
}

function openKeys(): string[] {
  return useNoticeStore.getState().notices.map(({ key }) => key);
}

async function spoken(): Promise<string[]> {
  await frame();
  return useNoticeStore.getState().announced.map(({ words }) => words);
}

function mount(initial: readonly RefusalRead[]) {
  const { rerender, unmount } = renderHook(({ reads, noticeKey }) => {
    useRefusalNotice(noticeKey, reads, { title: TITLE, line, upToDate: UP_TO_DATE });
  }, { initialProps: { reads: initial, noticeKey: KEY } });

  /** Renders the reads as the newest read of each left them. */
  function show(reads: readonly RefusalRead[], noticeKey = KEY): void {
    rerender({ reads, noticeKey });
  }

  return { show, unmount };
}

afterEach(() => {
  cleanup();
});

it("opens on one refused read, with the time of that read's last success and the words of the refusal", async () => {
  const { show } = mount([read(), read()]);

  show([read(3_000), failed(GONE, 2_000)]);

  expect(useNoticeStore.getState().notices).toMatchObject([
    { key: KEY, form: "failure", title: TITLE, line: line(2_000), words: [GONE_WORDS] },
  ]);
  expect(await spoken()).toEqual([`${TITLE}. ${line(2_000)} ${GONE_WORDS}.`]);
});

it("opens nothing on a failure that is not a refusal", async () => {
  const { show } = mount([read(), read()]);

  show([failed(UNREADABLE), read()]);
  show([failed(UNREACHED), failed(UNREADABLE)]);

  expect(openKeys()).toEqual([]);
  expect(await spoken()).toEqual([]);
});

it("takes the words of the first refused read in the list, whichever read was refused last", () => {
  const { show } = mount([read(), read()]);
  show([read(), failed(INVALID)]);
  expect(useNoticeStore.getState().notices[0]?.words).toEqual(["store/config-invalid · statuses is empty"]);

  show([failed(GONE), failed(INVALID)]);

  expect(useNoticeStore.getState().notices[0]?.words).toEqual([GONE_WORDS]);
});

it("keeps the same notice while the read stays refused and the other reads succeed", async () => {
  const { show } = mount([read(), read()]);
  show([read(2_000), failed(GONE)]);
  const [notice] = useNoticeStore.getState().notices;

  show([read(3_000), failed(GONE)]);
  show([read(4_000), failed(GONE)]);

  expect(useNoticeStore.getState().notices).toHaveLength(1);
  expect(useNoticeStore.getState().notices[0]).toBe(notice);
  expect(await spoken()).toHaveLength(1);
});

it("keeps the notice as it is, with nothing said, on a transport failure after a refusal and on the refusal after it", async () => {
  const { show } = mount([read(), read()]);
  show([read(), failed(GONE)]);
  const [notice] = useNoticeStore.getState().notices;
  await frame();

  show([read(), failed(UNREACHED)]);
  expect(useNoticeStore.getState().notices[0]).toBe(notice);

  show([read(), failed(GONE)]);
  expect(useNoticeStore.getState().notices[0]).toBe(notice);
  expect(await spoken()).toHaveLength(1);
});

it("closes when every read succeeds and says the up-to-date line once", async () => {
  const { show } = mount([read(), read()]);
  show([read(), failed(GONE)]);
  await frame();

  show([read(), read(2_000)]);
  show([read(3_000), read(3_000)]);

  expect(openKeys()).toEqual([]);
  expect((await spoken()).slice(1)).toEqual([UP_TO_DATE]);
});

it("stays closed after Dismiss while the read fails, ends the dismissal when every read succeeds, and opens on a new refusal", async () => {
  const { show } = mount([read(), read()]);
  show([read(), failed(GONE)]);
  await frame();
  act(() => {
    useNoticeStore.getState().dismissNotice(KEY);
  });

  show([read(), failed(UNREACHED)]);
  show([read(), failed(GONE)]);
  expect(openKeys()).toEqual([]);

  show([read(), read(2_000)]);
  expect(useNoticeStore.getState().dismissed.has(KEY)).toBe(false);
  expect((await spoken()).slice(1)).toEqual([UP_TO_DATE]);

  show([read(), failed(GONE, 2_000)]);
  expect(openKeys()).toEqual([KEY]);
});

it("closes on a change of key and on unmount, and says nothing", async () => {
  const { show, unmount } = mount([read(), read()]);
  show([read(), failed(GONE)]);
  await frame();

  show([read(), failed(GONE)], "board-refusal:DELTA");
  expect(openKeys()).toEqual(["board-refusal:DELTA"]);

  show([read(), read()], "board-refusal:SAGA");
  expect(openKeys()).toEqual([]);
  await frame();

  show([read(), failed(GONE)]);
  unmount();
  expect(openKeys()).toEqual([]);
  expect(await spoken()).not.toContain(UP_TO_DATE);
});

it("says no up-to-date line when every read succeeds after a transport failure that opened nothing", async () => {
  const { show } = mount([read(), read()]);

  show([read(), failed(UNREACHED)]);
  show([read(), read(2_000)]);

  expect(await spoken()).toEqual([]);
});

it.each([
  { name: "a refusal", result: { status: "error", error: GONE }, refused: true },
  { name: "a transport failure", result: { status: "error", error: UNREADABLE }, refused: false },
  { name: "a success after a refusal", result: { status: "success", error: GONE }, refused: false },
  { name: "a success", result: { status: "success", error: null }, refused: false },
])("tells $name as refused: $refused", ({ result, refused }) => {
  expect(isRefused(result)).toBe(refused);
});
