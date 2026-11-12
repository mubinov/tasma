import {
  buildPath,
  isActiveChat,
  routes,
  type AnyChatListItem,
  type ChatListItem,
  type ChatListPage,
  type ProjectChat,
  type ProjectChatListItem,
  type ProjectSummary,
  type Transport,
  type TransportReply,
} from "@tasma/protocol";
import { screen, within } from "@testing-library/react";
import { vi } from "vitest";
import { tagOf } from "../src/lib/board";
import { chatPath, chatRecord, projectChatPath, projectChatRecord, projectEventsPath, stubChatLog, type eventsPath } from "./chat-daemon";
import { chatEntries, userMessage } from "./chat-fixtures";
import { renderWithRouter, stubFeed, successReply } from "./helpers";
import { daemon } from "./task-screen-fixtures";

/** The time the tests take as now: 22 October 2026, 12:00 UTC. */
export const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);

/** The time `minutes` before now. */
export function minutesAgo(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

/** A chat of the list, created `minutes` before now. */
export function listItem(
  task: string,
  chat: number,
  minutes: number,
  fields: Partial<ChatListItem> = {},
): ChatListItem {
  return {
    tag: tagOf(task),
    task,
    title: `Title of ${task}`,
    chat,
    step: "build",
    agent: "claude",
    created: minutesAgo(minutes),
    ...fields,
  };
}

/** A chat of a project in the list, created `minutes` before now. */
export function projectItem(
  tag: string,
  chat: number,
  minutes: number,
  fields: Partial<ProjectChatListItem> = {},
): ProjectChatListItem {
  return {
    tag,
    title: `Question ${String(chat)} about ${tag}`,
    chat,
    agent: "claude",
    created: minutesAgo(minutes),
    ...fields,
  };
}

/** A page of the list. `active` counts the active items of this page by default. */
export function pageReply(
  items: readonly AnyChatListItem[],
  next?: string,
  total = items.length,
  active = items.filter((item) => isActiveChat(item.status)).length,
): TransportReply {
  const page: ChatListPage = { items: [...items], total, active, ...(next === undefined ? {} : { next }) };
  return successReply(page);
}

/** SAGA-3, chat 2: the chat that the record and the log of `stubChatLog` answer for. */
export const OPEN = listItem("SAGA-3", 2, 5, { title: "Build the parser", step: "dev:review", status: { state: "needs-you" } });

/** Three chats of two projects: two active chats, then one other chat, each group newest first. */
export const ITEMS: readonly ChatListItem[] = [
  listItem("ACME-7", 1, 2, { title: "Ship the release", step: "dev:test", status: { state: "working" } }),
  OPEN,
  listItem("SAGA-3", 1, 90, { title: "Build the parser", step: "dev:research" }),
];

/** The projects of the chats, and DUNE, which has no chats and no name. */
export const PROJECTS: readonly ProjectSummary[] = [
  { tag: "ACME", name: "Acme", path: "/repos/acme" },
  { tag: "SAGA", name: "Saga", path: "/repos/saga" },
  { tag: "DUNE" },
];

type Filter = { project?: string; q?: string };

/** The path of the first page of the chats of a filter, as the client asks for it. */
export function chatsPath(filter: Filter): string {
  return buildPath(routes.listAllChats, {}, filter);
}

/** The items of a filter, by the rule of the daemon. */
function filterItems(items: readonly ChatListItem[], { project, q }: Filter): ChatListItem[] {
  const words = q?.toLowerCase().split(/\s+/).filter((word) => word !== "") ?? [];

  return items.filter((item) => (project === undefined || item.tag === project)
    && words.every((word) => `${item.task}\n${item.title}\n${item.step}`.toLowerCase().includes(word)));
}

/**
 * The daemon of the dashboard: the projects, the list, the task page of SAGA-3,
 * the record of the open chat with a held log, and the feed of `stubFeed`. The
 * first page of a filter that has no reply of its own holds the items of
 * `ITEMS` that the filter keeps.
 */
export function stubDashboard(
  replies: Record<string, TransportReply | Promise<TransportReply>> = {},
  logPath?: typeof eventsPath,
) {
  const log = stubChatLog({
    ...daemon().replies,
    "/projects": successReply(PROJECTS),
    "/chats": pageReply(ITEMS),
    [chatPath()]: successReply(chatRecord({ step: "dev:review" })),
    ...replies,
  }, logPath);
  const feed = stubFeed(log);
  const transport: Transport = (request) => {
    const url = new URL(request.path, "http://stub");
    const filter = Object.fromEntries(url.searchParams) as Filter & { after?: string };
    if (url.pathname === "/chats" && url.search !== "" && filter.after === undefined && !(request.path in log.replies)) {
      log.replies[request.path] = pageReply(filterItems(ITEMS, filter));
    }
    return log.transport(request);
  };

  return { ...log, transport, mount: feed.mount, send: feed.send };
}

export type DashboardStub = ReturnType<typeof stubDashboard>;

/** The app at `path`, with the feed subscriber that main.tsx mounts beside it. */
export async function renderDashboard(stub: DashboardStub, path = "/", { strict = false } = {}) {
  const router = await renderWithRouter(path, stub.transport, { strict });
  await stub.mount(router);
  return router;
}

/** The start of a chat of SAGA from the New chat view. */
export const START_POST = "POST /projects/SAGA/chats";

/** Chat 5 of SAGA, which the start makes. */
export const START_RECORD: Partial<ProjectChat> = { chat: 5, title: "Plan the release", seq: 1 };

export const START_ANSWER = successReply({ chat: projectChatRecord(START_RECORD) });

/** The first log of chat 5 of SAGA. */
export const START_LOG = { cursor: 1, entries: chatEntries([userMessage("Plan the release")]) };

/** The daemon of the dashboard, which starts chat 5 of SAGA and holds its log. A reply can replace the answer. */
export function startDaemon(
  replies: Record<string, TransportReply | Promise<TransportReply>> = {},
): DashboardStub {
  const stub = stubDashboard({
    [START_POST]: START_ANSWER,
    [projectChatPath(5)]: successReply(projectChatRecord(START_RECORD)),
    ...replies,
  }, projectEventsPath);
  stub.hold(0, 5);
  return stub;
}

export function newChatButton(): HTMLElement {
  return screen.getByRole("button", { name: "New chat" });
}

/** The list of the chats, named by its hidden heading. */
export function chatList(): HTMLElement {
  return screen.getByRole("list", { name: "Chats" });
}

/** The links of the items in the order they show. */
export function itemLinks(): HTMLElement[] {
  return within(chatList()).getAllByRole("link");
}

export function itemLink(task: string, chat: number): HTMLElement {
  return chatList().querySelector<HTMLElement>(`[data-chat-key="${task}/${String(chat)}"]`)!;
}

/** The text of each item of a menu, in order. */
export function menuItemNames(menu: HTMLElement): string[] {
  return within(menu).getAllByRole("menuitem").map((item) => item.textContent);
}

/** The heading of the chat side. */
export function chatHeading(): HTMLElement {
  return screen.getByRole("heading", { level: 2, name: /^[A-Z0-9]+-\d+/ });
}

/**
 * jsdom has no layout: an item measures 79px, and every other element 600px,
 * which makes the scroll region of the list 600px tall.
 */
export function stubLayout(): void {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.tagName === "LI" ? 79 : 600;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
}
