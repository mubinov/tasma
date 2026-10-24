import type { ChatListItem, ChatStatus } from "@tasma/protocol";
import { describe, expect, it } from "vitest";
import { tagOf } from "../../src/lib/board";
import { chatListAnnouncements } from "../../src/lib/chat-list-announcements";

function item(task: string, chat: number, minute: number, status?: ChatStatus): ChatListItem {
  return {
    tag: tagOf(task),
    task,
    title: `Title of ${task}`,
    chat,
    step: "build",
    agent: "claude",
    created: new Date(Date.UTC(2026, 9, 1, 10, minute)).toISOString(),
    ...(status === undefined ? {} : { status }),
  };
}

const NEEDS_YOU: ChatStatus = { state: "needs-you" };
const FAILED: ChatStatus = { state: "failed" };
const WORKING: ChatStatus = { state: "working" };

describe("chatListAnnouncements", () => {
  it("announces an item whose state is now Needs you or Failed", () => {
    const before = [item("SAGA-3", 1, 5, WORKING), item("SAGA-2", 1, 4, WORKING), item("ACME-1", 2, 3)];
    const after = [item("SAGA-3", 1, 5, NEEDS_YOU), item("SAGA-2", 1, 4, FAILED), item("ACME-1", 2, 3, FAILED)];

    expect(chatListAnnouncements(before, after, undefined)).toEqual(["SAGA-3 needs you", "SAGA-2 failed", "ACME-1 failed"]);
  });

  it("announces nothing for an item that keeps its state, or that changes to another state", () => {
    const before = [item("SAGA-3", 1, 5, NEEDS_YOU), item("SAGA-2", 1, 4, FAILED)];
    const after = [
      item("SAGA-3", 1, 5, NEEDS_YOU),
      item("SAGA-2", 1, 4, { state: "continued-outside", where: "terminal" }),
    ];

    expect(chatListAnnouncements(before, after, undefined)).toEqual([]);
  });

  it("announces a new item at the top, and not a new item below the newest item of the last result", () => {
    const before = [item("SAGA-2", 1, 4), item("SAGA-1", 1, 2)];
    const after = [item("SAGA-4", 1, 6, FAILED), item("SAGA-2", 1, 4), item("SAGA-9", 1, 3, NEEDS_YOU), item("SAGA-1", 1, 2)];

    expect(chatListAnnouncements(before, after, undefined)).toEqual(["SAGA-4 failed"]);
  });

  it("finds a new item by the order of the daemon also when the newest item of the last result is gone", () => {
    const before = [item("SAGA-2", 1, 4), item("SAGA-1", 1, 2)];
    const after = [item("SAGA-5", 1, 4, NEEDS_YOU), item("SAGA-3", 1, 3, NEEDS_YOU), item("SAGA-1", 1, 2)];

    expect(chatListAnnouncements(before, after, undefined)).toEqual(["SAGA-5 needs you"]);
  });

  it.each<[string, ChatListItem, ChatListItem]>([
    ["a later time", item("SAGA-1", 1, 5), item("SAGA-2", 1, 4)],
    ["the same time and an earlier tag", item("ACME-1", 1, 4), item("SAGA-1", 1, 4)],
    ["the same tag and a higher task number", item("SAGA-10", 1, 4), item("SAGA-9", 1, 4)],
    ["the same task and a higher chat number", item("SAGA-1", 3, 4), item("SAGA-1", 2, 4)],
  ])("counts an item with %s as newer", (_name, newer, older) => {
    const after = [{ ...newer, status: NEEDS_YOU }, older];

    expect(chatListAnnouncements([older], after, undefined)).toEqual([`${newer.task} needs you`]);
    expect(chatListAnnouncements([newer], [newer, { ...older, status: NEEDS_YOU }], undefined)).toEqual([]);
  });

  it("counts a task id that differs in the text alone by the text, A first", () => {
    const zero = item("SAGA-01", 1, 4);
    const one = item("SAGA-1", 1, 4);

    expect(chatListAnnouncements([one], [{ ...zero, status: FAILED }, one], undefined)).toEqual(["SAGA-01 failed"]);
  });

  it("counts every item of a result as new when the last result had no items", () => {
    const after = [item("SAGA-2", 1, 4, NEEDS_YOU), item("SAGA-1", 1, 2, FAILED)];

    expect(chatListAnnouncements([], after, undefined)).toEqual(["SAGA-2 needs you", "SAGA-1 failed"]);
  });

  it("announces nothing for the open chat", () => {
    const before = [item("SAGA-3", 2, 5, WORKING), item("SAGA-3", 1, 4)];
    const after = [item("SAGA-3", 2, 5, NEEDS_YOU), item("SAGA-3", 1, 4, FAILED)];

    expect(chatListAnnouncements(before, after, { task: "SAGA-3", chat: 2 })).toEqual(["SAGA-3 failed"]);
  });

  it("announces nothing for the items of an older page", () => {
    const before = [item("SAGA-3", 1, 5)];
    const after = [item("SAGA-3", 1, 5), item("SAGA-2", 1, 4, NEEDS_YOU), item("SAGA-1", 1, 3, FAILED)];

    expect(chatListAnnouncements(before, after, undefined)).toEqual([]);
  });

  it("gives the counts in place of more than 3 announcements", () => {
    const after = [
      item("SAGA-5", 1, 9, NEEDS_YOU),
      item("SAGA-4", 1, 8, FAILED),
      item("SAGA-3", 1, 7, NEEDS_YOU),
      item("SAGA-2", 1, 6, NEEDS_YOU),
    ];

    expect(chatListAnnouncements([], after, undefined)).toEqual(["3 chats need you", "1 chat failed"]);
    expect(chatListAnnouncements([], [...after, item("SAGA-1", 1, 5, FAILED)], undefined)).toEqual([
      "3 chats need you",
      "2 chats failed",
    ]);
  });

  it("gives one count when all of more than 3 announcements are of one state", () => {
    const failed = [1, 2, 3, 4].map((number) => item(`SAGA-${String(number)}`, 1, number, FAILED));
    const needsYou = [1, 2, 3, 4].map((number) => item(`SAGA-${String(number)}`, 1, number, NEEDS_YOU));

    expect(chatListAnnouncements([], failed, undefined)).toEqual(["4 chats failed"]);
    expect(chatListAnnouncements([], [...needsYou, item("ACME-1", 1, 0, NEEDS_YOU)], undefined)).toEqual([
      "5 chats need you",
    ]);
  });

  it("gives 3 announcements one by one", () => {
    const after = [item("SAGA-3", 1, 7, NEEDS_YOU), item("SAGA-2", 1, 6, FAILED), item("SAGA-1", 1, 5, NEEDS_YOU)];

    expect(chatListAnnouncements([], after, undefined)).toEqual(["SAGA-3 needs you", "SAGA-2 failed", "SAGA-1 needs you"]);
  });

  it("gives the count of one state as 1 chat needs you", () => {
    const after = [
      item("SAGA-5", 1, 9, FAILED),
      item("SAGA-4", 1, 8, FAILED),
      item("SAGA-3", 1, 7, FAILED),
      item("SAGA-2", 1, 6, NEEDS_YOU),
    ];

    expect(chatListAnnouncements([], after, undefined)).toEqual(["1 chat needs you", "3 chats failed"]);
  });
});
