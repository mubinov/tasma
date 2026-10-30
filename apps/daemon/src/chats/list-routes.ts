// The list of the chats of all projects in pages, the active chats first and each
// group newest first, and one item of that list. The records of the chats are
// read from disk at each request. The state of a chat comes from the chat
// registry, the source of the `chat` events of the feed.

import { Buffer } from "node:buffer";
import {
  chatFinding,
  chatPath,
  listChats,
  listProjectChats,
  openProject,
  openTreeWorkflows,
  readListedChat,
  TaskStoreError,
} from "@tasma/engine";
import type { ChatRecord, IndexEntry, TaskStoreErrorCode } from "@tasma/engine";
import { chatMark, currentStep, isActiveChat, routes } from "@tasma/protocol";
import type { ChatListItem, ChatListPage, Diagnostic, Success, Workflow } from "@tasma/protocol";
import { causeOf, DaemonError } from "../http/failure.js";
import type { RouteEntry } from "../http/router.js";
import type { ProjectHost } from "../projects/host.js";
import { assertNoQuery, readChatListQuery } from "../tasks/filter.js";
import { words } from "../tasks/search.js";
import { assertChatNumber } from "./registry.js";
import type { ChatRegistry } from "./registry.js";
import { chatOf } from "./routes.js";

const PAGE_SIZE = 50;

/** How many projects, or chats, one request reads at a time. Each read holds descriptors. */
const READ_LIMIT = 8;

/** The refusals that mean a project went away during the read. */
const GONE: ReadonlySet<TaskStoreErrorCode> = new Set(["project-not-found", "index-closed"]);

type SortKey = [group: 0 | 1, time: number, tag: string, number: number, task: string, chat: number];

type Frontmatter = IndexEntry["frontmatter"];

type Candidate = { item: ChatListItem; text: string; stateful: boolean; frontmatter: Frontmatter };

type Found<T> = { found: T; diagnostics: Diagnostic[] };

type Row = { item: ChatListItem; key: SortKey; diagnostics: Diagnostic[] };

/** The reads of the workflows of one request, by workflow name. */
type WorkflowReads = Map<string, Promise<Pick<Workflow, "steps"> | null>>;

function byText(one: string, other: string): number {
  return Number(one > other) - Number(one < other);
}

/**
 * The active chats first, then newest first, the tag A to Z, the task number
 * high first, the task id A to Z, the chat number high first.
 */
function compareKeys(one: SortKey, other: SortKey): number {
  return one[0] - other[0]
    || other[1] - one[1]
    || byText(one[2], other[2])
    || other[3] - one[3]
    || byText(one[4], other[4])
    || other[5] - one[5];
}

function isSortKey(value: unknown): value is SortKey {
  if (!Array.isArray(value) || value.length !== 6) return false;
  const [group, time, tag, number, task, chat] = value as unknown[];
  return (group === 0 || group === 1)
    && Number.isFinite(time)
    && typeof tag === "string"
    && Number.isSafeInteger(number)
    && typeof task === "string"
    && Number.isSafeInteger(chat);
}

function sortKeyOf({ tag, task, chat, created, status }: ChatListItem): SortKey {
  return [isActiveChat(status) ? 0 : 1, Date.parse(created), tag, Number(task.slice(tag.length + 1)), task, chat];
}

function cursorOf(key: SortKey): string {
  return Buffer.from(JSON.stringify(key)).toString("base64url");
}

function keyOf(cursor: string): SortKey {
  let key: unknown;
  try {
    key = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    key = undefined;
  }
  if (!isSortKey(key)) throw new DaemonError("malformed-request", 'the query key "after" holds no cursor of this list');
  return key;
}

function firstAfter(sorted: readonly Row[], after: SortKey | undefined): number {
  if (after === undefined) return 0;
  const at = sorted.findIndex((row) => compareKeys(row.key, after) > 0);
  return at === -1 ? sorted.length : at;
}

async function mapLimited<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const answers: R[] = [];
  const pending = items.entries();
  const workers = Array.from({ length: READ_LIMIT }, async () => {
    for (const [at, item] of pending) answers[at] = await work(item);
  });
  await Promise.all(workers);
  return answers;
}

function latestChats(records: readonly ChatRecord[]): Map<string, number> {
  const latest = new Map<string, number>();
  for (const { task, chat } of records) latest.set(task, Math.max(latest.get(task) ?? 0, chat));
  return latest;
}

function candidateOf(tag: string, record: ChatRecord, entry: IndexEntry, stateful: boolean): Candidate {
  const { chat, step, agent, created } = record;
  const item = { tag, task: entry.id, title: entry.frontmatter.title, chat, step, agent, created };
  const { frontmatter } = entry;
  return { item, text: `${item.task}\n${item.title}\n${item.step}`.toLowerCase(), stateful, frontmatter };
}

function isOpen(entry: IndexEntry, finalStatuses: readonly string[]): boolean {
  const status = entry.frontmatter.status.toLowerCase();
  return !finalStatuses.some((final) => final.toLowerCase() === status);
}

export function chatListRoutes(options: { root?: string; host: ProjectHost; chats: ChatRegistry }): RouteEntry[] {
  const { root, host, chats } = options;

  function leftOut(tag: string, error: unknown, chatFindings: Diagnostic[] = []): Diagnostic[] {
    if (error instanceof TaskStoreError && GONE.has(error.code)) return [];
    const path = openProject({ project: tag, root }).paths.directory;
    return [...chatFindings, { code: "project-unreadable", message: causeOf(error), path }];
  }

  async function readIndex(tag: string): Promise<{ entries: IndexEntry[]; finalStatuses: string[] }> {
    const { index } = await host.open(tag);
    const { entries } = index.query();
    return { entries, finalStatuses: (await index.config()).config.final_statuses };
  }

  async function candidatesOf(tag: string): Promise<Found<Candidate[]>> {
    let listed;
    try {
      listed = await listProjectChats({ project: tag, root });
    } catch (error) {
      return { found: [], diagnostics: leftOut(tag, error) };
    }
    const { diagnostics } = listed;
    if (listed.chats.length === 0) return { found: [], diagnostics };
    let entries: IndexEntry[];
    let finalStatuses: string[];
    try {
      ({ entries, finalStatuses } = await readIndex(tag));
    } catch (error) {
      return { found: [], diagnostics: leftOut(tag, error, diagnostics) };
    }
    const tasks = new Map(entries.map((entry) => [entry.id, entry]));
    const joined = listed.chats.filter((record) => tasks.has(record.task));
    const latest = latestChats(joined);
    const found = joined.map((record) => {
      const entry = tasks.get(record.task)!;
      const stateful = latest.get(record.task) === record.chat && isOpen(entry, finalStatuses);
      return candidateOf(tag, record, entry, stateful);
    });
    return { found, diagnostics };
  }

  /**
   * `currentStep` of the task. The workflow is read only for a task with no
   * step, one time in `reads`, and a failed read gives no step.
   */
  async function stepOf(frontmatter: Frontmatter, reads: WorkflowReads): Promise<string | undefined> {
    const { workflow: name, step } = frontmatter;
    if (step !== undefined || name === undefined) return step;
    let read = reads.get(name);
    if (read === undefined) {
      read = openTreeWorkflows(root)
        .then(({ workflows }) => workflows.read(name))
        .then((found) => found.workflow, () => null);
      reads.set(name, read);
    }
    return currentStep(frontmatter, await read);
  }

  async function withState(candidate: Candidate, reads: WorkflowReads): Promise<Found<ChatListItem>> {
    const { item } = candidate;
    if (!candidate.stateful) return { found: item, diagnostics: [] };
    try {
      const live = await chats.get(item.tag, item.task, item.chat);
      const status = chatMark(live.chat, await stepOf(candidate.frontmatter, reads));
      return { found: status === undefined ? item : { ...item, status }, diagnostics: live.diagnostics };
    } catch (error) {
      const finding = chatFinding(error, chatPath({ project: item.tag, root }, item.task, item.chat));
      return { found: item, diagnostics: [finding] };
    }
  }

  return [
    {
      route: routes.listAllChats,
      handler: async (request): Promise<Success<ChatListPage>> => {
        const query = readChatListQuery(request.query);
        const after = query.after === undefined ? undefined : keyOf(query.after);
        const listings = await mapLimited(await host.tags(query.project), candidatesOf);
        const terms = words(query.q);
        const matched = listings
          .flatMap((listing) => listing.found)
          .filter((candidate) => terms.every((term) => candidate.text.includes(term)));
        const reads: WorkflowReads = new Map();
        const stated = await mapLimited(matched, (candidate) => withState(candidate, reads));
        const rows = stated
          .map(({ found, diagnostics }): Row => ({ item: found, key: sortKeyOf(found), diagnostics }))
          .sort((one, other) => compareKeys(one.key, other.key));
        const start = firstAfter(rows, after);
        const shown = rows.slice(start, start + PAGE_SIZE);
        const active = rows.filter((row) => isActiveChat(row.item.status)).length;
        const data: ChatListPage = { items: shown.map((row) => row.item), total: rows.length, active };
        if (start + PAGE_SIZE < rows.length) data.next = cursorOf(shown.at(-1)!.key);
        const diagnostics = [...listings, ...shown].flatMap((one) => one.diagnostics);
        return { data, diagnostics };
      },
    },
    {
      route: routes.readChatItem,
      handler: async (request): Promise<Success<ChatListItem>> => {
        assertNoQuery(request.query);
        const id = request.params.id!;
        const dash = id.indexOf("-");
        if (dash === -1) throw new TaskStoreError("task-not-found", `"${id}" is not a task id`);
        const tag = id.slice(0, dash);
        const { index } = await host.open(tag);
        const entry = index.query().entries.find((found) => found.id === id);
        if (entry === undefined) throw new TaskStoreError("task-not-found", `there is no task ${id}`);
        const chat = chatOf(request.params.chat!);
        assertChatNumber(chat);
        const options = { project: tag, root };
        const record = await readListedChat(options, id, chat);
        const listed = await listChats(options, id);
        const finalStatuses = (await index.config()).config.final_statuses;
        const stateful = latestChats(listed.chats).get(id) === record.chat && isOpen(entry, finalStatuses);
        const { found, diagnostics } = await withState(candidateOf(tag, record, entry, stateful), new Map());
        return { data: found, diagnostics: [...listed.diagnostics, ...diagnostics] };
      },
    },
  ];
}
