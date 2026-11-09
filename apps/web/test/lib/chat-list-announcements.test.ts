import type { AnyChatListItem, ChatListItem, ChatStatus, ProjectChatListItem } from "@tasma/protocol";
import { describe, expect, it } from "vitest";
import { tagOf } from "../../src/lib/board";
import { chatKey, chatListAnnouncements, chatListItems, knownChats, resultCountWords, sameChat } from "../../src/lib/chat-list-announcements";

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

function projectItem(tag: string, chat: number, minute: number, status?: ChatStatus): ProjectChatListItem {
  return {
    tag,
    title: `Question ${String(chat)} about ${tag}`,
    chat,
    agent: "claude",
    created: new Date(Date.UTC(2026, 9, 1, 10, minute)).toISOString(),
    ...(status === undefined ? {} : { status }),
  };
}

function renamed(one: ChatListItem): ChatListItem {
  return { ...one, tag: "ACME", task: one.task.replace("DUNE", "ACME") };
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

  it("announces nothing for an item whose mark goes away, and announces the mark when it comes back", () => {
    const marked = [item("SAGA-3", 1, 5, NEEDS_YOU)];
    const seen = [item("SAGA-3", 1, 5)];

    expect(chatListAnnouncements(marked, seen, undefined)).toEqual([]);
    expect(chatListAnnouncements(seen, marked, undefined)).toEqual(["SAGA-3 needs you"]);
  });

  it("announces an item that the last result did not hold above the newest item of a result of active items alone, and not one below it", () => {
    const before = [item("SAGA-5", 1, 5, WORKING), item("SAGA-2", 1, 4, WORKING)];
    const after = [
      item("SAGA-4", 1, 6, FAILED),
      item("SAGA-5", 1, 5, WORKING),
      item("SAGA-2", 1, 4, WORKING),
      item("SAGA-9", 1, 3, NEEDS_YOU),
      item("SAGA-1", 1, 2, FAILED),
    ];

    expect(chatListAnnouncements(before, after, undefined)).toEqual(["SAGA-4 failed"]);
  });

  it("finds an item that the last result did not hold by the order of the daemon, also when the newest item of that result is gone", () => {
    const before = [item("SAGA-2", 1, 4, WORKING), item("SAGA-1", 1, 2, WORKING)];
    const after = [item("SAGA-5", 1, 4, FAILED), item("SAGA-3", 1, 3, FAILED), item("SAGA-1", 1, 2, WORKING)];

    expect(chatListAnnouncements(before, after, undefined)).toEqual(["SAGA-5 failed"]);
  });

  it.each<[string, ChatListItem, ChatListItem]>([
    ["a later time", item("SAGA-1", 1, 5), item("SAGA-2", 1, 4)],
    ["the same time and an earlier tag", item("ACME-1", 1, 4), item("SAGA-1", 1, 4)],
    ["the same tag and a higher task number", item("SAGA-10", 1, 4), item("SAGA-9", 1, 4)],
    ["the same task and a higher chat number", item("SAGA-1", 3, 4), item("SAGA-1", 2, 4)],
  ])("counts an item with %s as newer", (_name, newer, older) => {
    const working = (one: ChatListItem): ChatListItem => ({ ...one, status: WORKING });
    const failed = (one: ChatListItem): ChatListItem => ({ ...one, status: FAILED });

    expect(chatListAnnouncements([working(older)], [failed(newer), older], undefined)).toEqual([`${newer.task} failed`]);
    expect(chatListAnnouncements([working(newer)], [working(newer), failed(older)], undefined)).toEqual([]);
  });

  it("announces a Needs you or Failed item of any time when the last result holds no active item", () => {
    const before = [item("SAGA-5", 1, 9), item("SAGA-4", 1, 8, { state: "continued-outside", where: "vscode" })];
    const after = [item("SAGA-2", 1, 2, FAILED), item("SAGA-1", 1, 1, NEEDS_YOU), ...before];

    expect(chatListAnnouncements(before, after, undefined)).toEqual(["SAGA-2 failed", "SAGA-1 needs you"]);
  });

  it.each<[string, ChatStatus | undefined]>([
    ["no mark", undefined],
    ["the mark continued-outside", { state: "continued-outside", where: "terminal" }],
  ])("announces an item that the last result did not hold, older than the newest active item, when that result holds an item with %s", (_name, status) => {
    const before = [item("SAGA-6", 1, 8, WORKING), item("SAGA-3", 1, 5, status)];
    const after = [
      item("SAGA-6", 1, 8, WORKING),
      item("SAGA-4", 1, 6, NEEDS_YOU),
      item("SAGA-1", 1, 3, FAILED),
      item("SAGA-3", 1, 5, status),
    ];

    expect(chatListAnnouncements(before, after, undefined)).toEqual(["SAGA-4 needs you", "SAGA-1 failed"]);
  });

  it("counts a task id that differs in the text alone by the text, A first", () => {
    const zero = item("SAGA-01", 1, 4);
    const one = item("SAGA-1", 1, 4, WORKING);

    expect(chatListAnnouncements([one], [{ ...zero, status: FAILED }, one], undefined)).toEqual(["SAGA-01 failed"]);
  });

  it("announces every marked item of a result when the last result had no items", () => {
    const after = [item("SAGA-2", 1, 4, NEEDS_YOU), item("SAGA-1", 1, 2, FAILED)];

    expect(chatListAnnouncements([], after, undefined)).toEqual(["SAGA-2 needs you", "SAGA-1 failed"]);
  });

  it("announces nothing for the open chat", () => {
    const before = [item("SAGA-3", 2, 5, WORKING), item("SAGA-3", 1, 4)];
    const after = [item("SAGA-3", 2, 5, NEEDS_YOU), item("SAGA-3", 1, 4, FAILED)];

    expect(chatListAnnouncements(before, after, { task: "SAGA-3", chat: 2 })).toEqual(["SAGA-3 failed"]);
  });

  it("announces nothing for the items of an older page, older than the newest item of a last result of active items alone", () => {
    const before = [item("SAGA-6", 1, 8, WORKING), item("SAGA-5", 1, 7, NEEDS_YOU)];
    const after = [
      ...before,
      item("SAGA-4", 1, 6, NEEDS_YOU),
      item("SAGA-1", 1, 3, FAILED),
      item("SAGA-3", 1, 5),
    ];

    expect(chatListAnnouncements(before, after, undefined)).toEqual([]);
  });

  it.each<[string, ChatListItem[]]>([
    ["a last result with an item outside Active", [item("SAGA-3", 1, 3)]],
    ["a last result of active items alone", []],
  ])("announces nothing for a chat that a rename of its project gives a new id, after %s", (_name, rest) => {
    const failed = item("DUNE-2", 1, 5, FAILED);
    const needsYou = item("DUNE-1", 1, 4, NEEDS_YOU);
    const after = [renamed(failed), renamed(needsYou), ...rest];

    expect(chatListAnnouncements([failed, needsYou, ...rest], after, undefined)).toEqual([]);
  });

  it("announces a chat that a rename of its project gives a new id, when its state changed too", () => {
    const working = item("DUNE-2", 1, 5, WORKING);
    const other = item("SAGA-3", 1, 3);

    expect(chatListAnnouncements([working, other], [{ ...renamed(working), status: FAILED }, other], undefined)).toEqual(["ACME-2 failed"]);
  });

  it("keeps the states of two chats of two projects with the same number, chat, time and title apart", () => {
    const title = "Build the parser";
    const before = [{ ...item("ACME-1", 1, 5, FAILED), title }, { ...item("SAGA-1", 1, 5, WORKING), title }, item("SAGA-3", 1, 3)];

    expect(chatListAnnouncements(before, before, undefined)).toEqual([]);
  });

  it("announces a failed chat one time over a rename of its project there and back", () => {
    const working = item("DUNE-2", 1, 5, WORKING);
    const failed: ChatListItem = { ...working, status: FAILED };
    const other = item("SAGA-3", 1, 3);
    const first = [working, other];
    const second = [renamed(failed), other];
    const known = knownChats(second, knownChats(first));

    expect(chatListAnnouncements(first, second, undefined)).toEqual(["ACME-2 failed"]);
    expect(chatListAnnouncements(second, [failed, other], undefined, known)).toEqual([]);
  });

  it("announces a failed chat of a new project that takes the tag of a renamed project", () => {
    const failed = item("DUNE-2", 1, 5, FAILED);
    const other = item("SAGA-3", 1, 3);
    const moved = [renamed(failed), other];
    const known = knownChats(moved, knownChats([failed, other]));

    expect(chatListAnnouncements(moved, [item("DUNE-2", 1, 6, FAILED), ...moved], undefined, known)).toEqual(["DUNE-2 failed"]);
  });

  it("announces a failed chat of a new project that takes the tag of a deleted project", () => {
    const failed = item("DUNE-2", 1, 5, FAILED);
    const other = item("SAGA-3", 1, 3);
    const known = knownChats([other], knownChats([failed, other]));

    expect(chatListAnnouncements([other], [item("DUNE-2", 1, 6, FAILED), other], undefined, known)).toEqual(["DUNE-2 failed"]);
  });

  it("forgets the state of a chat under its old title", () => {
    const failed = item("DUNE-2", 1, 5, FAILED);
    const other = item("SAGA-3", 1, 3);
    const retitled = [{ ...failed, title: "Another title", status: WORKING }, other];
    const known = knownChats(retitled, knownChats([failed, other]));

    expect(chatListAnnouncements(retitled, [renamed(failed), other], undefined, known)).toEqual(["ACME-2 failed"]);
  });

  it("keeps the state of a chat when a chat of another project with the same number, chat, time and title joins the result", () => {
    const title = "Build the parser";
    const failed = { ...item("ACME-1", 1, 5, FAILED), title };
    const other = item("SAGA-3", 1, 3);
    const joined = [failed, { ...item("SAGA-1", 1, 5, WORKING), title }, other];
    const known = knownChats(joined, knownChats([failed, other]));

    expect(chatListAnnouncements(joined, joined, undefined, known)).toEqual([]);
  });

  it("announces nothing for a chat that comes back after a result left it out, with its last state", () => {
    const failed = item("ACME-2", 1, 5, FAILED);
    const other = item("SAGA-3", 1, 3);
    const known = knownChats([other], knownChats([failed, other]));

    expect(chatListAnnouncements([other], [failed, other], undefined, known)).toEqual([]);
  });

  it("announces a chat that comes back after a result left it out, with another state than its last one", () => {
    const failed = item("ACME-2", 1, 5, FAILED);
    const other = item("SAGA-3", 1, 3);
    const known = knownChats([other], knownChats([item("ACME-2", 1, 5), other], knownChats([failed, other])));

    expect(chatListAnnouncements([other], [failed, other], undefined, known)).toEqual(["ACME-2 failed"]);
  });

  it("gives the counts in place of more than 3 announcements", () => {
    const after = [
      item("SAGA-5", 1, 9, NEEDS_YOU),
      item("SAGA-3", 1, 7, NEEDS_YOU),
      item("SAGA-2", 1, 6, NEEDS_YOU),
      item("SAGA-4", 1, 8, FAILED),
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
    const after = [item("SAGA-3", 1, 7, NEEDS_YOU), item("SAGA-1", 1, 5, NEEDS_YOU), item("SAGA-2", 1, 6, FAILED)];

    expect(chatListAnnouncements([], after, undefined)).toEqual(["SAGA-3 needs you", "SAGA-1 needs you", "SAGA-2 failed"]);
  });

  it("gives the count of one state as 1 chat needs you", () => {
    const after = [
      item("SAGA-2", 1, 6, NEEDS_YOU),
      item("SAGA-5", 1, 9, FAILED),
      item("SAGA-4", 1, 8, FAILED),
      item("SAGA-3", 1, 7, FAILED),
    ];

    expect(chatListAnnouncements([], after, undefined)).toEqual(["1 chat needs you", "3 chats failed"]);
  });
});

describe("chatListAnnouncements of a chat of a project", () => {
  const other = item("ACME-3", 1, 1);

  it("names the chat by its number and its tag", () => {
    const before = [projectItem("SAGA", 2, 5, WORKING), projectItem("SAGA", 1, 4, WORKING), other];
    const after = [projectItem("SAGA", 2, 5, NEEDS_YOU), projectItem("SAGA", 1, 4, FAILED), other];

    expect(chatListAnnouncements(before, after, undefined)).toEqual(["Chat 2 of SAGA needs you", "Chat 1 of SAGA failed"]);
  });

  it("announces nothing for the open chat of a project", () => {
    const before = [projectItem("SAGA", 2, 5, WORKING), other];
    const after = [projectItem("SAGA", 2, 5, FAILED), other];

    expect(chatListAnnouncements(before, after, { tag: "SAGA", chat: 2 })).toEqual([]);
  });

  it("does not take a chat of a task with the same number for the open chat, in either direction", () => {
    const before = [projectItem("SAGA", 2, 5, WORKING), item("SAGA-3", 2, 4, WORKING), other];
    const after = [projectItem("SAGA", 2, 5, FAILED), item("SAGA-3", 2, 4, NEEDS_YOU), other];

    expect(chatListAnnouncements(before, after, { task: "SAGA-3", chat: 2 })).toEqual(["Chat 2 of SAGA failed"]);
    expect(chatListAnnouncements(before, after, { tag: "SAGA", chat: 2 })).toEqual(["SAGA-3 needs you"]);
  });

  it.each<[string, AnyChatListItem, AnyChatListItem, string]>([
    ["a chat of a task with its time and tag", projectItem("SAGA", 1, 4), item("SAGA-9", 9, 4), "Chat 1 of SAGA failed"],
    ["a chat of the project with a lower number", projectItem("SAGA", 3, 4), projectItem("SAGA", 2, 4), "Chat 3 of SAGA failed"],
  ])("counts a chat of a project as newer than %s", (_name, newer, older, words) => {
    const working = { ...newer, status: WORKING };
    const failed = { ...newer, status: FAILED };

    expect(chatListAnnouncements([{ ...older, status: WORKING }], [failed, older], undefined)).toEqual([words]);
    expect(chatListAnnouncements([working], [working, { ...older, status: FAILED }], undefined)).toEqual([]);
  });

  it("announces nothing for a chat that a rename of its project gives a new tag", () => {
    const failed = projectItem("DUNE", 2, 5, FAILED);

    expect(chatListAnnouncements([failed, other], [{ ...failed, tag: "ACME" }, other], undefined)).toEqual([]);
  });

  it("keeps the state of a chat of a project apart from a chat of a task with the same number, time and title", () => {
    const failed = projectItem("DUNE", 2, 5, FAILED);
    const task = { ...item("DUNE-3", 2, 5, WORKING), title: failed.title };
    const known = knownChats([failed, task, other]);

    expect(chatListAnnouncements([failed, task, other], [failed, task, other], undefined, known)).toEqual([]);
  });
});

describe("chatKey", () => {
  it("gives the task and the number for a chat of a task, and the tag and the number for a chat of a project", () => {
    expect(chatKey({ task: "SAGA-3", chat: 2 })).toBe("SAGA-3/2");
    expect(chatKey({ tag: "SAGA", chat: 2 })).toBe("SAGA/2");
  });
});

describe("sameChat", () => {
  it("tells a chat of a project from a chat of a task with the same number", () => {
    expect(sameChat({ tag: "SAGA", chat: 2 }, projectItem("SAGA", 2, 5))).toBe(true);
    expect(sameChat({ task: "SAGA-3", chat: 2 }, item("SAGA-3", 2, 5))).toBe(true);
    expect(sameChat({ tag: "SAGA", chat: 2 }, item("SAGA-3", 2, 5))).toBe(false);
    expect(sameChat({ tag: "SAGA", chat: 2 }, projectItem("SAGA", 1, 5))).toBe(false);
  });
});

describe("chatListItems", () => {
  it("keeps a chat of a project and a chat of a task with the same number as two items", () => {
    const project = projectItem("SAGA", 2, 5);
    const task = item("SAGA-3", 2, 4);

    expect(chatListItems([{ data: { items: [project, task], total: 2, active: 0 } }])).toEqual([project, task]);
  });

  it("gives the items of all pages in order, each chat one time at its first place", () => {
    const moved = item("SAGA-3", 1, 5, NEEDS_YOU);
    const pages = [
      { data: { items: [moved, item("SAGA-2", 1, 4, WORKING)], total: 4, active: 2, next: "next" } },
      { data: { items: [item("SAGA-4", 1, 6), { ...moved, status: FAILED }, item("SAGA-1", 1, 3)], total: 4, active: 1 } },
    ];

    expect(chatListItems(pages)).toEqual([moved, item("SAGA-2", 1, 4, WORKING), item("SAGA-4", 1, 6), item("SAGA-1", 1, 3)]);
  });
});

describe("resultCountWords", () => {
  it("says the number of chats of a result", () => {
    expect(resultCountWords(0)).toBe("No chats");
    expect(resultCountWords(1)).toBe("1 chat");
    expect(resultCountWords(12)).toBe("12 chats");
  });
});
