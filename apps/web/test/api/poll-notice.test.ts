import { ProtocolError, TransportError } from "@tasma/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { usePollNotice, type NamedPollRead, type PollRead } from "../../src/api/poll-notice";
import { DAEMON_URL } from "../../src/api/transport";
import { useNoticeStore } from "../../src/store/notices";

const KEY = "board-poll:SAGA";

const TITLE = "The board is not up to date";

const REFUSED = new ProtocolError({ kind: "store", code: "project-not-found", message: "no project is tagged SAGA" }, 404);

const UNREADABLE = new TransportError("GET /projects/SAGA/tasks answered with no envelope", 502);

type Reads = [PollRead, PollRead];

function line(readAt: number): string {
  return `The last reads of SAGA failed. The board shows the tasks as they were at ${String(readAt)}.`;
}

function read(fields: Partial<PollRead> = {}): PollRead {
  return { dataUpdatedAt: 1_000, errorUpdateCount: 0, errorUpdatedAt: 0, error: null, ...fields };
}

/** One more failed poll of a read, at a later time. */
function failed(previous: PollRead, error: Error, at: number): PollRead {
  return { ...previous, errorUpdateCount: previous.errorUpdateCount + 1, errorUpdatedAt: at, error };
}

function succeeded(previous: PollRead, at: number): PollRead {
  return { ...previous, dataUpdatedAt: at, error: null };
}

function openKeys(): string[] {
  return useNoticeStore.getState().notices.map(({ key }) => key);
}

/** Names the reads by their place, for a list whose reads keep their places. */
function byPlace(reads: Reads): NamedPollRead[] {
  return reads.map((poll, index) => ({ name: `read-${String(index)}`, read: poll }));
}

function mountNamed(initial: readonly NamedPollRead[]) {
  const { rerender, unmount } = renderHook(({ reads, noticeKey }) => {
    usePollNotice(noticeKey, reads, { title: TITLE, line });
  }, { initialProps: { reads: initial, noticeKey: KEY } });

  /** Renders the reads as the last poll left them. */
  function pollNamed(reads: readonly NamedPollRead[], noticeKey = KEY): void {
    rerender({ reads, noticeKey });
  }

  function poll(reads: Reads, noticeKey = KEY): void {
    pollNamed(byPlace(reads), noticeKey);
  }

  return { poll, pollNamed, unmount };
}

function mount(initial: Reads) {
  return mountNamed(byPlace(initial));
}

beforeEach(() => {
  useNoticeStore.setState({ notices: [], dismissed: new Map() });
});

afterEach(() => {
  cleanup();
});

it("opens after two failed polls of a read in a row, not after one, with the words of its error", () => {
  const project = read();
  const listing = read();
  const { poll } = mount([listing, project]);

  const once = failed(listing, UNREADABLE, 2_000);
  poll([once, project]);
  expect(openKeys()).toEqual([]);

  poll([failed(once, UNREADABLE, 3_000), failed(project, REFUSED, 2_500)]);

  expect(useNoticeStore.getState().notices).toMatchObject([
    {
      key: KEY,
      form: "failure",
      title: TITLE,
      line: line(1_000),
      words: [`${DAEMON_URL} · HTTP 502 · GET /projects/SAGA/tasks answered with no envelope`],
    },
  ]);
});

it("takes the words of the first read in the list that failed twice, whichever read failed last", () => {
  const { poll } = mount([read(), read()]);
  let project = failed(read(), REFUSED, 2_100);
  let listing = failed(read(), UNREADABLE, 2_000);
  poll([project, listing]);

  project = failed(project, REFUSED, 3_000);
  listing = failed(listing, UNREADABLE, 3_100);
  poll([project, listing]);
  const [notice] = useNoticeStore.getState().notices;
  expect(notice?.words).toEqual(["store/project-not-found · no project is tagged SAGA"]);

  poll([failed(project, REFUSED, 4_100), failed(listing, UNREADABLE, 4_000)]);
  expect(useNoticeStore.getState().notices[0]).toBe(notice);
});

it("keeps the notice as it is while the polls of another read succeed, timed by the failing read's last success", () => {
  const { poll } = mount([read(), read()]);
  let project = failed(read(), REFUSED, 2_000);
  poll([succeeded(read(), 2_100), project]);
  project = failed(project, REFUSED, 3_000);
  poll([succeeded(read(), 3_100), project]);
  const [notice] = useNoticeStore.getState().notices;
  expect(notice?.line).toBe(line(1_000));

  poll([succeeded(read(), 4_100), failed(project, REFUSED, 4_000)]);

  expect(useNoticeStore.getState().notices).toHaveLength(1);
  expect(useNoticeStore.getState().notices[0]).toBe(notice);
});

it("counts again from a successful poll between two failures", () => {
  const { poll } = mount([read(), read()]);

  const once = failed(read(), UNREADABLE, 2_000);
  poll([read(), once]);
  const recovered = succeeded(once, 3_000);
  poll([read(), recovered]);
  poll([read(), failed(recovered, UNREADABLE, 4_000)]);

  expect(openKeys()).toEqual([]);
});

it("closes on the next successful poll of the failing read", () => {
  const { poll } = mount([read(), read()]);
  const twice = failed(failed(read(), UNREADABLE, 2_000), UNREADABLE, 3_000);
  poll([read(), failed(read(), UNREADABLE, 2_000)]);
  poll([read(), twice]);
  expect(openKeys()).toEqual([KEY]);

  poll([read(), succeeded(twice, 4_000)]);

  expect(openKeys()).toEqual([]);
});

it("stays closed after Dismiss while the polls keep failing, and opens after a success and two more failures", () => {
  const { poll } = mount([read(), read()]);
  let listing = failed(read(), UNREADABLE, 2_000);
  poll([read(), listing]);
  listing = failed(listing, UNREADABLE, 3_000);
  poll([read(), listing]);
  act(() => {
    useNoticeStore.getState().dismissNotice(KEY);
  });

  listing = failed(listing, REFUSED, 4_000);
  poll([read(), listing]);
  expect(openKeys()).toEqual([]);

  listing = succeeded(listing, 5_000);
  poll([read(), listing]);
  listing = failed(listing, UNREADABLE, 6_000);
  poll([read(), listing]);
  expect(openKeys()).toEqual([]);

  listing = failed(listing, UNREADABLE, 7_000);
  poll([read(), listing]);
  expect(openKeys()).toEqual([KEY]);
});

it("closes on a change of key, counts again for the new key, and closes on unmount", () => {
  const failing = failed(failed(read(), UNREADABLE, 2_000), UNREADABLE, 3_000);
  const { poll, unmount } = mount([read(), read()]);
  poll([read(), failed(read(), UNREADABLE, 2_000)]);
  poll([read(), failing]);
  expect(openKeys()).toEqual([KEY]);

  poll([read(), failing], "board-poll:DELTA");
  expect(openKeys()).toEqual([]);

  poll([read(), failed(failing, UNREADABLE, 4_000)], "board-poll:DELTA");
  poll([read(), failed(failed(failing, UNREADABLE, 4_000), UNREADABLE, 5_000)], "board-poll:DELTA");
  expect(openKeys()).toEqual(["board-poll:DELTA"]);

  unmount();
  expect(openKeys()).toEqual([]);
});

it("keeps the count of a read by its name when a read joins before it", () => {
  const once = failed(read(), UNREADABLE, 2_000);
  const twice = failed(once, UNREADABLE, 3_000);
  const { pollNamed } = mountNamed([{ name: "SAGA:tasks", read: read() }]);
  pollNamed([{ name: "SAGA:tasks", read: once }]);

  pollNamed([{ name: "DELTA:tasks", read: read() }, { name: "SAGA:tasks", read: twice }]);
  expect(openKeys()).toEqual([KEY]);

  pollNamed([{ name: "ALPHA:tasks", read: read() }, { name: "DELTA:tasks", read: read() }, { name: "SAGA:tasks", read: twice }]);
  expect(openKeys()).toEqual([KEY]);
});

it("does not open a dismissed notice again when a read joins before the failing read", () => {
  const twice = failed(failed(read(), UNREADABLE, 2_000), UNREADABLE, 3_000);
  const { pollNamed } = mountNamed([{ name: "SAGA:tasks", read: read() }]);
  pollNamed([{ name: "SAGA:tasks", read: failed(read(), UNREADABLE, 2_000) }]);
  pollNamed([{ name: "SAGA:tasks", read: twice }]);
  act(() => {
    useNoticeStore.getState().dismissNotice(KEY);
  });

  pollNamed([{ name: "DELTA:tasks", read: read() }, { name: "SAGA:tasks", read: twice }]);

  expect(openKeys()).toEqual([]);
});

it("counts from zero for a read that leaves and comes back", () => {
  const once = failed(read(), UNREADABLE, 2_000);
  const twice = failed(once, UNREADABLE, 3_000);
  const { pollNamed } = mountNamed([{ name: "SAGA:tasks", read: read() }]);
  pollNamed([{ name: "SAGA:tasks", read: once }]);
  pollNamed([]);

  pollNamed([{ name: "SAGA:tasks", read: twice }]);
  expect(openKeys()).toEqual([]);

  const thrice = failed(twice, UNREADABLE, 4_000);
  pollNamed([{ name: "SAGA:tasks", read: thrice }]);
  expect(openKeys()).toEqual([]);

  pollNamed([{ name: "SAGA:tasks", read: failed(thrice, UNREADABLE, 5_000) }]);
  expect(openKeys()).toEqual([KEY]);
});

it("takes a success and a failure seen at once as one failure when the failure is newer", () => {
  const { poll } = mount([read(), read()]);
  const once = failed(read(), UNREADABLE, 2_000);
  poll([read(), once]);

  poll([read(), failed(succeeded(once, 3_000), UNREADABLE, 4_000)]);
  expect(openKeys()).toEqual([]);

  const twice = failed(failed(succeeded(once, 3_000), UNREADABLE, 4_000), UNREADABLE, 5_000);
  poll([read(), twice]);
  expect(openKeys()).toEqual([KEY]);
});
