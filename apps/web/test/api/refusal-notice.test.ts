import { QueryClientProvider, type QueryClient, type QueryKey, type QueryState } from "@tanstack/react-query";
import { ProtocolError, TransportError } from "@tasma/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createAppQueryClient } from "../../src/api/client";
import { daemonKeys } from "../../src/api/queries";
import { isRefused, useRefusalNotice, type RefusalRead } from "../../src/api/refusal-notice";
import { useNoticeStore } from "../../src/store/notices";
import { frame } from "../setup/notice-store";

const KEY = "board-refusal:SAGA";

const TITLE = "The board is not up to date";

const UP_TO_DATE = "The board is up to date.";

const LISTING = daemonKeys.tasks("SAGA");

const PROJECT = daemonKeys.project("SAGA");

const GONE = new ProtocolError({ kind: "store", code: "project-not-found", message: "no project is tagged SAGA" }, 404);

const INVALID = new ProtocolError({ kind: "store", code: "config-invalid", message: "statuses is empty" }, 422);

const UNREADABLE = new TransportError("GET /projects/SAGA/tasks answered with no envelope", 502);

const UNREACHED = new TransportError("GET /projects/SAGA/tasks reached no daemon");

const GONE_WORDS = "store/project-not-found · no project is tagged SAGA";

let queryClient: QueryClient;

function line(refusedAt: number): string {
  return `The daemon refused a read of SAGA. The board shows the tasks as they were before ${String(refusedAt)}.`;
}

/** Leaves the query of `queryKey` as its newest read leaves it, and gives the read as its observer shows it. */
function settle(queryKey: QueryKey, state: Partial<QueryState>): RefusalRead {
  queryClient.getQueryCache().build(queryClient, { queryKey }).setState(state);
  const { status, error, errorUpdatedAt } = queryClient.getQueryState(queryKey)!;
  return { queryKey, result: { status, error, errorUpdatedAt } };
}

function read(queryKey: QueryKey): RefusalRead {
  return settle(queryKey, { status: "success", data: {}, error: null });
}

function failed(queryKey: QueryKey, error: Error, errorUpdatedAt = 1_000): RefusalRead {
  return settle(queryKey, { status: "error", error, errorUpdatedAt });
}

function openKeys(): string[] {
  return useNoticeStore.getState().notices.map(({ key }) => key);
}

function openLine(): string | undefined {
  return useNoticeStore.getState().notices[0]?.line;
}

async function spoken(): Promise<string[]> {
  await frame();
  return useNoticeStore.getState().announced.map(({ words }) => words);
}

function mount(initial: readonly RefusalRead[]) {
  const { rerender, unmount } = renderHook(({ reads, noticeKey }) => {
    useRefusalNotice(noticeKey, reads, { title: TITLE, line, upToDate: UP_TO_DATE });
  }, {
    initialProps: { reads: initial, noticeKey: KEY },
    wrapper: ({ children }: { children: ReactNode }) => (
      createElement(QueryClientProvider, { client: queryClient }, children)
    ),
  });

  /** Renders the reads as the newest read of each left them. */
  function show(reads: readonly RefusalRead[], noticeKey = KEY): void {
    rerender({ reads, noticeKey });
  }

  return { show, unmount };
}

beforeEach(() => {
  queryClient = createAppQueryClient();
});

afterEach(() => {
  cleanup();
});

it("opens on one refused read, with the time and the words of the refusal", async () => {
  const { show } = mount([read(LISTING), read(PROJECT)]);

  show([read(LISTING), failed(PROJECT, GONE, 2_000)]);

  expect(useNoticeStore.getState().notices).toMatchObject([
    { key: KEY, form: "failure", title: TITLE, line: line(2_000), words: [GONE_WORDS] },
  ]);
  expect(await spoken()).toEqual([`${TITLE}. ${line(2_000)} ${GONE_WORDS}.`]);
});

it("opens nothing on a failure that is not a refusal", async () => {
  const { show } = mount([read(LISTING), read(PROJECT)]);

  show([failed(LISTING, UNREADABLE), read(PROJECT)]);
  show([failed(LISTING, UNREACHED), failed(PROJECT, UNREADABLE)]);

  expect(openKeys()).toEqual([]);
  expect(await spoken()).toEqual([]);
});

it("takes the time of the refusal, not of a failure that is not a refusal before it", () => {
  const { show } = mount([read(LISTING), read(PROJECT)]);
  show([read(LISTING), failed(PROJECT, UNREACHED, 2_000)]);

  show([read(LISTING), failed(PROJECT, GONE, 3_000)]);

  expect(openLine()).toBe(line(3_000));
});

it("takes the words of the first refused read in the list, and the time of the read refused first", () => {
  const { show } = mount([read(LISTING), read(PROJECT)]);
  show([read(LISTING), failed(PROJECT, INVALID, 2_000)]);
  expect(useNoticeStore.getState().notices[0]?.words).toEqual(["store/config-invalid · statuses is empty"]);

  show([failed(LISTING, GONE, 3_000), failed(PROJECT, INVALID, 3_000)]);

  expect(useNoticeStore.getState().notices).toMatchObject([{ line: line(2_000), words: [GONE_WORDS] }]);
});

it("keeps the time of the first refusal while the reads are refused again, and takes a new time after the read succeeds", async () => {
  const { show } = mount([read(LISTING), read(PROJECT)]);
  show([read(LISTING), failed(PROJECT, GONE, 2_000)]);
  const [notice] = useNoticeStore.getState().notices;

  show([read(LISTING), failed(PROJECT, GONE, 5_000)]);
  show([read(LISTING), failed(PROJECT, UNREACHED, 6_000)]);
  show([failed(LISTING, GONE, 7_000), failed(PROJECT, GONE, 7_000)]);

  expect(useNoticeStore.getState().notices).toEqual([notice]);
  expect(notice?.line).toBe(line(2_000));
  expect(await spoken()).toHaveLength(1);

  show([read(LISTING), read(PROJECT)]);
  show([read(LISTING), failed(PROJECT, GONE, 9_000)]);

  expect(openLine()).toBe(line(9_000));
});

it("keeps the time of the first refusal when it mounts again, and takes a new time after a success that no notice showed", () => {
  mount([read(LISTING), failed(PROJECT, GONE, 2_000)]).unmount();
  failed(PROJECT, GONE, 5_000);

  const again = mount([read(LISTING), failed(PROJECT, GONE, 8_000)]);
  expect(openLine()).toBe(line(2_000));

  again.unmount();
  read(PROJECT);
  mount([read(LISTING), failed(PROJECT, GONE, 9_000)]);

  expect(openLine()).toBe(line(9_000));
});

it("keeps the same notice while the read stays refused and the other reads succeed", async () => {
  const { show } = mount([read(LISTING), read(PROJECT)]);
  show([read(LISTING), failed(PROJECT, GONE)]);
  const [notice] = useNoticeStore.getState().notices;

  show([read(LISTING), failed(PROJECT, GONE)]);
  show([read(LISTING), failed(PROJECT, GONE)]);

  expect(useNoticeStore.getState().notices).toHaveLength(1);
  expect(useNoticeStore.getState().notices[0]).toBe(notice);
  expect(await spoken()).toHaveLength(1);
});

it("keeps the notice as it is, with nothing said, on a transport failure after a refusal and on the refusal after it", async () => {
  const { show } = mount([read(LISTING), read(PROJECT)]);
  show([read(LISTING), failed(PROJECT, GONE)]);
  const [notice] = useNoticeStore.getState().notices;
  await frame();

  show([read(LISTING), failed(PROJECT, UNREACHED)]);
  expect(useNoticeStore.getState().notices[0]).toBe(notice);

  show([read(LISTING), failed(PROJECT, GONE)]);
  expect(useNoticeStore.getState().notices[0]).toBe(notice);
  expect(await spoken()).toHaveLength(1);
});

it("closes when every read succeeds and says the up-to-date line once", async () => {
  const { show } = mount([read(LISTING), read(PROJECT)]);
  show([read(LISTING), failed(PROJECT, GONE)]);
  await frame();

  show([read(LISTING), read(PROJECT)]);
  show([read(LISTING), read(PROJECT)]);

  expect(openKeys()).toEqual([]);
  expect((await spoken()).slice(1)).toEqual([UP_TO_DATE]);
});

it("stays closed after Dismiss while the read fails, ends the dismissal when every read succeeds, and opens on a new refusal", async () => {
  const { show } = mount([read(LISTING), read(PROJECT)]);
  show([read(LISTING), failed(PROJECT, GONE)]);
  await frame();
  act(() => {
    useNoticeStore.getState().dismissNotice(KEY);
  });

  show([read(LISTING), failed(PROJECT, UNREACHED)]);
  show([read(LISTING), failed(PROJECT, GONE)]);
  expect(openKeys()).toEqual([]);

  show([read(LISTING), read(PROJECT)]);
  expect(useNoticeStore.getState().dismissed.has(KEY)).toBe(false);
  expect((await spoken()).slice(1)).toEqual([UP_TO_DATE]);

  show([read(LISTING), failed(PROJECT, GONE, 2_000)]);
  expect(openKeys()).toEqual([KEY]);
});

it("closes on a change of key and on unmount, and says nothing", async () => {
  const { show, unmount } = mount([read(LISTING), read(PROJECT)]);
  show([read(LISTING), failed(PROJECT, GONE)]);
  await frame();

  show([read(daemonKeys.tasks("DELTA")), failed(daemonKeys.project("DELTA"), GONE, 3_000)], "board-refusal:DELTA");
  expect(openKeys()).toEqual(["board-refusal:DELTA"]);
  expect(openLine()).toBe(line(3_000));

  show([read(LISTING), read(PROJECT)], "board-refusal:SAGA");
  expect(openKeys()).toEqual([]);
  await frame();

  show([read(LISTING), failed(PROJECT, GONE)]);
  unmount();
  expect(openKeys()).toEqual([]);
  expect(await spoken()).not.toContain(UP_TO_DATE);
});

it("says no up-to-date line when every read succeeds after a transport failure that opened nothing", async () => {
  const { show } = mount([read(LISTING), read(PROJECT)]);

  show([read(LISTING), failed(PROJECT, UNREACHED)]);
  show([read(LISTING), read(PROJECT)]);

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
