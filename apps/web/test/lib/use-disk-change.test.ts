import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Draft } from "../../src/lib/text-draft";
import { useDiskChange, type DiskChangeOptions } from "../../src/lib/use-disk-change";
import { useNoticeStore } from "../../src/store/notices";

const START: Draft = { title: "Build the parser", body: "First line.\n" };

const FIRST = "2026-09-01T11:20:00Z";

const LATER = "2026-09-01T12:30:00Z";

function minutes(stamp: string): string {
  return new Date(stamp).toTimeString().slice(0, 5);
}

function mount(initial: Partial<DiskChangeOptions> = {}) {
  const props: DiskChangeOptions = {
    start: START,
    draft: { ...START },
    disk: { ...START },
    saving: false,
    updated: "2026-09-01T10:15:00Z",
    ...initial,
  };

  return renderHook((options: DiskChangeOptions) => useDiskChange(options), { initialProps: props });
}

/** The frame the announcement waits for. */
async function frame(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => {
      requestAnimationFrame(resolve);
    });
  });
}

beforeEach(() => {
  useNoticeStore.setState({ notices: [], dismissed: new Map(), spoken: [], held: [], modalDialogs: 0 });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("holds the time of the read that first differed across a later read", () => {
  const { result, rerender } = mount();

  rerender({
    start: START,
    draft: { ...START },
    disk: { ...START, title: "Renamed" },
    saving: false,
    updated: FIRST,
  });

  expect(result.current).toEqual({ showing: true, at: minutes(FIRST) });

  rerender({
    start: START,
    draft: { ...START },
    disk: { ...START, title: "Renamed twice" },
    saving: false,
    updated: LATER,
  });

  expect(result.current.at).toBe(minutes(FIRST));
});

it("takes the time of the next read that differs once the line has gone", () => {
  const { result, rerender } = mount();
  const changed: DiskChangeOptions = {
    start: START,
    draft: { ...START },
    disk: { ...START, title: "Renamed" },
    saving: false,
    updated: FIRST,
  };

  rerender(changed);
  rerender({ ...changed, disk: { ...START }, updated: FIRST });

  expect(result.current.showing).toBe(false);

  rerender({ ...changed, updated: LATER });

  expect(result.current).toEqual({ showing: true, at: minutes(LATER) });
});

it("shows nothing while a save runs", () => {
  const { result, rerender } = mount();

  rerender({
    start: START,
    draft: { ...START },
    disk: { ...START, title: "Renamed" },
    saving: true,
    updated: FIRST,
  });

  expect(result.current.showing).toBe(false);
});

it("says the line one frame after it appears, and says nothing more for a later read", async () => {
  const { rerender } = mount();
  const changed: DiskChangeOptions = {
    start: START,
    draft: { ...START },
    disk: { ...START, title: "Renamed" },
    saving: false,
    updated: FIRST,
  };

  rerender(changed);
  await frame();

  expect(useNoticeStore.getState().spoken.map(({ words }) => words))
    .toEqual([`Changed on disk at ${minutes(FIRST)}. Saving overwrites that change.`]);

  rerender({ ...changed, disk: { ...START, title: "Renamed twice" }, updated: LATER });
  await frame();

  expect(useNoticeStore.getState().spoken).toHaveLength(1);
});

it("says nothing for a line that goes before its frame runs", async () => {
  const { rerender } = mount();
  const changed: DiskChangeOptions = {
    start: START,
    draft: { ...START },
    disk: { ...START, title: "Renamed" },
    saving: false,
    updated: FIRST,
  };

  rerender(changed);
  rerender({ ...changed, disk: { ...START } });
  await frame();

  expect(useNoticeStore.getState().spoken).toEqual([]);
});

it("keeps the time and says nothing more when a refused save brings the same line back", async () => {
  const { result, rerender } = mount();
  const changed: DiskChangeOptions = {
    start: START,
    draft: { ...START },
    disk: { ...START, title: "Renamed" },
    saving: false,
    updated: FIRST,
  };

  rerender(changed);
  await frame();

  rerender({ ...changed, saving: true, updated: LATER });
  rerender({ ...changed, updated: LATER });
  await frame();

  expect(result.current).toEqual({ showing: true, at: minutes(FIRST) });
  expect(useNoticeStore.getState().spoken).toHaveLength(1);
});

it("withdraws the words a dialog holds when the line goes before the dialog closes", async () => {
  const { rerender } = mount();
  const changed: DiskChangeOptions = {
    start: START,
    draft: { ...START },
    disk: { ...START, title: "Renamed" },
    saving: false,
    updated: FIRST,
  };

  act(() => {
    useNoticeStore.getState().openModalDialog();
  });
  rerender(changed);
  await frame();

  expect(useNoticeStore.getState().held).toHaveLength(1);

  rerender({ ...changed, disk: { ...START } });
  act(() => {
    useNoticeStore.getState().closeModalDialog();
  });

  expect(useNoticeStore.getState().spoken).toEqual([]);
});
