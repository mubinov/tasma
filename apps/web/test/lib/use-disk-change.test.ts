import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Draft } from "../../src/lib/text-draft";
import type { EditorSubject } from "../../src/lib/editor-subject";
import { useDiskChange, type DiskChangeOptions } from "../../src/lib/use-disk-change";
import { useNoticeStore } from "../../src/store/notices";
import { frame } from "../setup/notice-store";

const START: Draft = { title: "Build the parser", body: "First line.\n" };

const TASK: EditorSubject = { kind: "task" };

const FIRST = "2026-09-01T11:20:00Z";

const LATER = "2026-09-01T12:30:00Z";

function minutes(stamp: string): string {
  return new Date(stamp).toTimeString().slice(0, 5);
}

function mount(initial: Partial<DiskChangeOptions> = {}) {
  const props: DiskChangeOptions = {
    subject: TASK,
    start: START,
    draft: { ...START },
    disk: { ...START },
    saving: false,
    updated: "2026-09-01T10:15:00Z",
    ...initial,
  };

  return renderHook((options: DiskChangeOptions) => useDiskChange(options), { initialProps: props });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("holds the time of the read that first differed across a later read", () => {
  const { result, rerender } = mount();

  rerender({
    subject: TASK,
    start: START,
    draft: { ...START },
    disk: { ...START, title: "Renamed" },
    saving: false,
    updated: FIRST,
  });

  expect(result.current).toEqual({ showing: true, at: minutes(FIRST) });

  rerender({
    subject: TASK,
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
    subject: TASK,
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
    subject: TASK,
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
    subject: TASK,
    start: START,
    draft: { ...START },
    disk: { ...START, title: "Renamed" },
    saving: false,
    updated: FIRST,
  };

  rerender(changed);
  await frame();

  expect(useNoticeStore.getState().announced.map(({ words }) => words))
    .toEqual([`The task text changed on disk at ${minutes(FIRST)}. Saving overwrites that change.`]);

  rerender({ ...changed, disk: { ...START, title: "Renamed twice" }, updated: LATER });
  await frame();

  expect(useNoticeStore.getState().announced).toHaveLength(1);
});

it("keeps the time and says nothing more when a refused save brings the same line back", async () => {
  const { result, rerender } = mount();
  const changed: DiskChangeOptions = {
    subject: TASK,
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
  expect(useNoticeStore.getState().announced).toHaveLength(1);
});

it("names the comment a card's line belongs to, so two cards speak two sentences", async () => {
  mount({ subject: { kind: "comment", id: 3 }, disk: { ...START, title: "Renamed" }, updated: FIRST });
  await frame();

  expect(useNoticeStore.getState().announced.map(({ words }) => words))
    .toEqual([`Comment #3 changed on disk at ${minutes(FIRST)}. Saving overwrites that change.`]);
});

it("says the line once where StrictMode runs its effect twice on mount", async () => {
  renderHook((options: DiskChangeOptions) => useDiskChange(options), {
    initialProps: {
      subject: TASK,
      start: START,
      draft: { ...START },
      disk: { ...START, title: "Renamed" },
      saving: false,
      updated: FIRST,
    },
    reactStrictMode: true,
  });
  await frame();

  expect(useNoticeStore.getState().announced).toHaveLength(1);
});
