// The list of the chats of all projects in pages, the active chats first and each
// group newest first, and one item of that list. The records of the chats are
// read from disk at each request. The state of a chat comes from the chat
// registry, the source of the `chat` and `project-chat` events of the feed.

import { Buffer } from "node:buffer";
import {
  chatFinding,
  chatPath,
  listAllTaskChats,
  listChats,
  listProjectChats,
  openProject,
  openTreeWorkflows,
  projectChatPath,
  readLastProjectChatEntry,
  readListedChat,
  readListedProjectChat,
  TaskStoreError,
} from "@tasma/engine";
import type { ChatRecord, IndexEntry, ProjectChatRecord, TaskStoreErrorCode } from "@tasma/engine";
import {
  agentState,
  chatBusy,
  chatMark,
  currentStep,
  isActiveChat,
  projectChatMark,
  projectChatSettled,
  routes,
} from "@tasma/protocol";
import type {
  AgentStateReply,
  AnyChatListItem,
  ChatListItem,
  ChatListPage,
  Diagnostic,
  ProjectChatListItem,
  Success,
  Workflow,
} from "@tasma/protocol";
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

/** `kind` is 0 for a project chat and 1 for a task chat. A project chat has 0 as its number and `""` as its task. */
type SortKey = [group: 0 | 1, time: number, tag: string, kind: 0 | 1, number: number, task: string, chat: number];

type Frontmatter = IndexEntry["frontmatter"];

type TaskCandidate = { item: ChatListItem; text: string; stateful: boolean; frontmatter: Frontmatter };

type ProjectCandidate = { item: ProjectChatListItem; text: string; seen: number | undefined };

type Candidate = TaskCandidate | ProjectCandidate;

type Found<T> = { found: T; diagnostics: Diagnostic[] };

type Row = { item: AnyChatListItem; key: SortKey; diagnostics: Diagnostic[] };

type StatedChats = { listings: Found<Candidate[]>[]; stated: Found<AnyChatListItem>[] };

/** The reads of the workflows of one request, by workflow name. */
type WorkflowReads = Map<string, Promise<Pick<Workflow, "steps"> | null>>;

function byText(one: string, other: string): number {
  return Number(one > other) - Number(one < other);
}

/**
 * The order of the list:
 * - the active chats first, then newest first;
 * - the tag A to Z, and a project chat before a task chat;
 * - the task number high first, then the task id A to Z;
 * - the chat number high first.
 */
function compareKeys(one: SortKey, other: SortKey): number {
  return one[0] - other[0]
    || other[1] - one[1]
    || byText(one[2], other[2])
    || one[3] - other[3]
    || other[4] - one[4]
    || byText(one[5], other[5])
    || other[6] - one[6];
}

function isSortKey(value: unknown): value is SortKey {
  if (!Array.isArray(value) || value.length !== 7) return false;
  const [group, time, tag, kind, number, task, chat] = value as unknown[];
  return (group === 0 || group === 1)
    && Number.isFinite(time)
    && typeof tag === "string"
    && (kind === 0 || kind === 1)
    && Number.isSafeInteger(number)
    && typeof task === "string"
    && Number.isSafeInteger(chat);
}

function sortKeyOf(item: AnyChatListItem): SortKey {
  const { tag, chat, created, status } = item;
  const head = [isActiveChat(status) ? 0 : 1, Date.parse(created), tag] as const;
  if (!("task" in item)) return [...head, 0, 0, "", chat];
  return [...head, 1, Number(item.task.slice(tag.length + 1)), item.task, chat];
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

function candidateOf(tag: string, record: ChatRecord, entry: IndexEntry, stateful: boolean): TaskCandidate {
  const { chat, step, agent, created } = record;
  const item = { tag, task: entry.id, title: entry.frontmatter.title, chat, step, agent, created };
  const { frontmatter } = entry;
  return { item, text: `${item.task}\n${item.title}\n${item.step}`.toLowerCase(), stateful, frontmatter };
}

function projectCandidateOf(tag: string, record: ProjectChatRecord): ProjectCandidate {
  const { chat, title, agent, created, seen } = record;
  return { item: { tag, title, chat, agent, created }, text: `${tag}\n${title}`.toLowerCase(), seen };
}

function isGone(error: unknown): boolean {
  return error instanceof TaskStoreError && GONE.has(error.code);
}

function isOpen(entry: IndexEntry, finalStatuses: readonly string[]): boolean {
  const status = entry.frontmatter.status.toLowerCase();
  return !finalStatuses.some((final) => final.toLowerCase() === status);
}

export function chatListRoutes(options: { root?: string; host: ProjectHost; chats: ChatRegistry }): RouteEntry[] {
  const { root, host, chats } = options;

  function leftOut(tag: string, error: unknown, chatFindings: Diagnostic[] = []): Diagnostic[] {
    if (isGone(error)) return [];
    const path = openProject({ project: tag, root }).paths.directory;
    return [...chatFindings, { code: "project-unreadable", message: causeOf(error), path }];
  }

  async function readIndex(tag: string): Promise<{ entries: IndexEntry[]; finalStatuses: string[] }> {
    const { index } = await host.open(tag);
    const { entries } = index.query();
    return { entries, finalStatuses: (await index.config()).config.final_statuses };
  }

  async function candidatesOf(tag: string): Promise<Found<Candidate[]>> {
    const options = { project: tag, root };
    let taskListed;
    let projectListed;
    try {
      taskListed = await listAllTaskChats(options);
      projectListed = await listProjectChats(options);
    } catch (error) {
      return { found: [], diagnostics: leftOut(tag, error) };
    }
    const diagnostics = [...taskListed.diagnostics, ...projectListed.diagnostics];
    const projectFound = projectListed.chats.map((record) => projectCandidateOf(tag, record));
    if (taskListed.chats.length === 0) return { found: projectFound, diagnostics };
    let entries: IndexEntry[];
    let finalStatuses: string[];
    try {
      ({ entries, finalStatuses } = await readIndex(tag));
    } catch (error) {
      return { found: isGone(error) ? [] : projectFound, diagnostics: leftOut(tag, error, diagnostics) };
    }
    const tasks = new Map(entries.map((entry) => [entry.id, entry]));
    const joined = taskListed.chats.filter((record) => tasks.has(record.task));
    const latest = latestChats(joined);
    const taskFound = joined.map((record) => {
      const entry = tasks.get(record.task)!;
      const stateful = latest.get(record.task) === record.chat && isOpen(entry, finalStatuses);
      return candidateOf(tag, record, entry, stateful);
    });
    return { found: [...taskFound, ...projectFound], diagnostics };
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

  async function withState(candidate: TaskCandidate, reads: WorkflowReads): Promise<Found<ChatListItem>> {
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

  /**
   * A project chat that is not in memory has no agent process in this daemon,
   * so it is not busy. The list does not load a chat that has no mark by its
   * last entry, because a loaded chat stays in memory.
   */
  async function withProjectState({ item, seen }: ProjectCandidate): Promise<Found<ProjectChatListItem>> {
    const { tag, chat } = item;
    try {
      let live = chats.loadedProjectChat(tag, chat);
      if (live === undefined) {
        const onDisk = await readLastProjectChatEntry({ project: tag, root }, chat);
        if (projectChatSettled(seen, onDisk?.seq ?? 0, onDisk?.at ?? item.created, Date.now())) {
          return { found: item, diagnostics: [] };
        }
        live = await chats.getProjectChat(tag, chat);
      }
      // After the load, which can write `interrupted`.
      const last = (await live.read(live.chat.seq - 1)).at(-1);
      const status = projectChatMark(live.chat, chatBusy(live.fold), last?.at ?? live.chat.created, Date.now());
      return { found: status === undefined ? item : { ...item, status }, diagnostics: live.diagnostics };
    } catch (error) {
      return { found: item, diagnostics: [chatFinding(error, projectChatPath({ project: tag, root }, chat))] };
    }
  }

  /** The state is read only for the chats that `q` keeps. */
  async function statedChats(project?: string, q?: string): Promise<StatedChats> {
    const listings = await mapLimited(await host.tags(project), candidatesOf);
    const terms = words(q);
    const matched = listings
      .flatMap((listing) => listing.found)
      .filter((candidate) => terms.every((term) => candidate.text.includes(term)));
    const reads: WorkflowReads = new Map();
    const stated = await mapLimited(matched, (candidate): Promise<Found<AnyChatListItem>> =>
      "frontmatter" in candidate ? withState(candidate, reads) : withProjectState(candidate));
    return { listings, stated };
  }

  return [
    {
      route: routes.listAllChats,
      handler: async (request): Promise<Success<ChatListPage>> => {
        const query = readChatListQuery(request.query);
        const after = query.after === undefined ? undefined : keyOf(query.after);
        const { listings, stated } = await statedChats(query.project, query.q);
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
      route: routes.readAgentState,
      handler: async (request): Promise<Success<AgentStateReply>> => {
        assertNoQuery(request.query);
        const { listings, stated } = await statedChats();
        const state = agentState(stated.map(({ found }) => found.status));
        return { data: { state }, diagnostics: listings.flatMap((listing) => listing.diagnostics) };
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
    {
      route: routes.readProjectChatItem,
      handler: async (request): Promise<Success<ProjectChatListItem>> => {
        assertNoQuery(request.query);
        const tag = request.params.project!;
        const chat = chatOf(request.params.chat!);
        assertChatNumber(chat);
        const record = await readListedProjectChat({ project: tag, root }, chat);
        const { found, diagnostics } = await withProjectState(projectCandidateOf(tag, record));
        return { data: found, diagnostics };
      },
    },
  ];
}
