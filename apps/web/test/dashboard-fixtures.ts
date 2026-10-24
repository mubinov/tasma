import {
  buildPath,
  routes,
  type ChatListItem,
  type ChatListPage,
  type FeedEvent,
  type ProjectSummary,
  type Transport,
  type TransportReply,
} from "@tasma/protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { expect, vi } from "vitest";
import { FeedSubscriber } from "../src/components/feed-subscriber";
import { tagOf } from "../src/lib/board";
import { chatPath, chatRecord, stubChatLog } from "./chat-daemon";
import { heldBack, renderWithRouter, successReply } from "./helpers";
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

export function pageReply(items: readonly ChatListItem[], next?: string, total = items.length): TransportReply {
  const page: ChatListPage = { items: [...items], total, ...(next === undefined ? {} : { next }) };
  return successReply(page);
}

/** SAGA-3, chat 2: the chat that the record and the log of `stubChatLog` answer for. */
export const OPEN = listItem("SAGA-3", 2, 5, { title: "Build the parser", step: "dev:review", status: { state: "needs-you" } });

/** Three chats of two projects, newest first. */
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
 * the record of the open chat with a held log, and a feed that answers the
 * first read with the cursor `c0` and holds each read after it until the test
 * sends events. The first page of a filter that has no reply of its own holds
 * the items of `ITEMS` that the filter keeps.
 */
export function stubDashboard(replies: Record<string, TransportReply | Promise<TransportReply>> = {}) {
  const log = stubChatLog({
    ...daemon().replies,
    "/projects": successReply(PROJECTS),
    "/chats": pageReply(ITEMS),
    [chatPath()]: successReply(chatRecord({ step: "dev:review" })),
    "/events": successReply({ cursor: "c0", events: [] }),
    ...replies,
  });
  const transport: Transport = (request) => {
    const url = new URL(request.path, "http://stub");
    const filter = Object.fromEntries(url.searchParams) as Filter & { after?: string };
    if (url.pathname === "/chats" && url.search !== "" && filter.after === undefined && !(request.path in log.replies)) {
      log.replies[request.path] = pageReply(filterItems(ITEMS, filter));
    }
    return log.transport(request);
  };
  let count = 0;
  let held = hold(0);

  function hold(index: number): (reply: TransportReply) => void {
    const { reply, answer } = heldBack();
    log.replies[`/events?after=c${String(index)}`] = reply;
    return answer;
  }

  return {
    ...log,
    transport,
    /** Answers the held read of the feed with the events, and waits for the read after it. */
    async send(events: FeedEvent[]): Promise<void> {
      const current = held;
      count += 1;
      held = hold(count);
      await act(async () => {
        current(successReply({ cursor: `c${String(count)}`, events }));
        await vi.waitFor(() => {
          expect(log.paths).toContain(`/events?after=c${String(count)}`);
        });
      });
    },
  };
}

export type DashboardStub = ReturnType<typeof stubDashboard>;

/** The app at `path`, with the feed subscriber that main.tsx mounts beside it. */
export async function renderDashboard(stub: DashboardStub, path = "/") {
  const router = await renderWithRouter(path, stub.transport);
  const { queryClient, client } = router.options.context;
  render(createElement(FeedSubscriber, { queryClient, client }));
  await waitFor(() => {
    expect(stub.paths).toContain("/events?after=c0");
  });
  return router;
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
