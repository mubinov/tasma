import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isTimestamp } from "../format/schema.js";
import { isRecord, stringRecord } from "../format/values.js";
import {
  createExclusive,
  createExclusiveDirectory,
  entryAt,
  makeDirectory,
  readRegularFile,
  replaceFile,
} from "./atomic.js";
import { causeOf, errnoOf, fail, pathOf, TaskStoreError } from "./errors.js";
import { type ProjectPaths, projectPaths, taskChatsPath, taskNumber } from "./paths.js";
import { checkChatDirectories, checkChatsDirectory, checkTaskFile, now, openProjectDirectory } from "./store.js";
import type { ProjectOptions, StoreDiagnostic } from "./types.js";

export type ChatAgent = "claude" | "codex";

const AGENTS = {
  claude: true,
  codex: true,
} satisfies Record<ChatAgent, true>;

/**
 * One chat of a task. `task` and `chat` come from the path, so a rename of the
 * project rewrites nothing in the chat files.
 */
export type ChatRecord = {
  task: string;
  chat: number;
  step: string;
  agent: ChatAgent;
  /** The folder the agent works in. */
  folder: string;
  created: string;
  /** The session id of the agent, once the agent gives one. */
  session?: string;
  /** The last value picked in this chat for each config option of the agent, by option id. */
  options?: Record<string, string>;
};

export type ChatInput = { step: string; agent: ChatAgent; folder: string };

/** A change of one field keeps the other. */
export type ChatChange = { session?: string; options?: Record<string, string> };

export type ChatList = { chats: ChatRecord[]; diagnostics: StoreDiagnostic[] };

const RECORD_FILE = "chat.json";

export const LOG_FILE = "events.jsonl";

/** A chat number as a directory name: decimal with no leading zero. */
const CHAT_NAME = /^[1-9]\d*$/;

function chatNumber(name: string): number | undefined {
  if (!CHAT_NAME.test(name)) return undefined;
  const number = Number(name);
  return Number.isSafeInteger(number) ? number : undefined;
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/** What keeps the fields a create states from making a record, or `undefined` when they make one. */
function inputFault(value: Record<string, unknown>): string | undefined {
  if (!isText(value.step)) return '"step" must be a non-empty string';
  if (typeof value.agent !== "string" || !Object.hasOwn(AGENTS, value.agent)) {
    return `"agent" must be one of ${Object.keys(AGENTS).join(", ")}`;
  }
  if (!isText(value.folder)) return '"folder" must be a non-empty string';
  return undefined;
}

function recordFault(value: unknown): string | undefined {
  if (!isRecord(value)) return "the record of this chat is not a JSON object";
  const fault = inputFault(value);
  if (fault !== undefined) return fault;
  if (!isTimestamp(value.created)) return '"created" must be an ISO 8601 timestamp with a UTC offset';
  if (value.session !== undefined && !isText(value.session)) return '"session" must be a non-empty string';
  return undefined;
}

function recordOf(task: string, chat: number, stored: Record<string, unknown>): ChatRecord {
  const record: ChatRecord = {
    task,
    chat,
    step: stored.step as string,
    agent: stored.agent as ChatAgent,
    folder: stored.folder as string,
    created: stored.created as string,
  };
  if (stored.session !== undefined) record.session = stored.session as string;
  const options = stringRecord(stored.options);
  if (options !== undefined) record.options = options;
  return record;
}

function recordText(stored: Record<string, unknown>): string {
  return `${JSON.stringify(stored, null, 2)}\n`;
}

/** The project and the chats directory of one of its tasks, after the checks every chat call makes. */
export async function openTaskChats(
  options: ProjectOptions,
  task: string,
): Promise<{ paths: ProjectPaths; taskChats: string; exists: boolean }> {
  const paths = projectPaths(options);
  await openProjectDirectory(paths);
  const taskChats = taskChatsPath(paths, task);
  await checkTaskFile(paths, task);
  return { paths, taskChats, exists: await checkChatDirectories(paths, taskChats) };
}

/** The directory of one chat. A number that no chat directory can carry names no chat. */
export function chatDirectory(taskChats: string, chat: number): string {
  if (!Number.isSafeInteger(chat) || chat < 1) fail("chat-not-found", `${chat} is not a chat number`, taskChats);
  return join(taskChats, String(chat));
}

/** The directory of one chat of a task, which a finding about that chat names. */
export function chatPath(options: ProjectOptions, task: string, chat: number): string {
  return chatDirectory(taskChatsPath(projectPaths(options), task), chat);
}

/** The record file of one chat, which a finding about its record names. */
export function chatRecordPath(options: ProjectOptions, task: string, chat: number): string {
  return join(chatPath(options, task, chat), RECORD_FILE);
}

/**
 * The record of one chat as the file holds it, unknown keys included. A
 * directory with no record is what an interrupted create leaves, so it is no
 * chat.
 */
export async function readRecord(directory: string): Promise<Record<string, unknown>> {
  const entry = await entryAt(directory);
  if (entry === undefined) fail("chat-not-found", "there is no chat here", directory);
  if (!entry.isDirectory()) fail("chat-unreadable", "the name of this chat holds no directory", directory);
  const path = join(directory, RECORD_FILE);
  const read = await readRegularFile(path);
  if (read === "absent") fail("chat-not-found", "this chat has no record", path);
  if (read === "irregular") fail("chat-unreadable", "the record of this chat is not a regular file", path);
  let stored: unknown;
  try {
    stored = JSON.parse(read.text);
  } catch (error) {
    fail("chat-unreadable", `the record of this chat is not JSON: ${causeOf(error)}`, path, error);
  }
  const fault = recordFault(stored);
  if (fault !== undefined) fail("chat-unreadable", fault, path);
  return stored as Record<string, unknown>;
}

/** The highest chat number one directory holds, 0 for none. Every name counts, a broken chat's too. */
async function highestChat(taskChats: string): Promise<number> {
  let highest = 0;
  for (const name of await readdir(taskChats)) highest = Math.max(highest, chatNumber(name) ?? 0);
  return highest;
}

/**
 * Claims the directory of the next chat of a task. A name taken between the
 * read and the create means another writer claimed it, so the read runs again
 * once, and a second collision reaches the caller.
 */
export async function claimChat(taskChats: string, readHighest = highestChat): Promise<number> {
  for (let attempt = 0; ; attempt += 1) {
    const chat = (await readHighest(taskChats)) + 1;
    try {
      await createExclusiveDirectory(join(taskChats, String(chat)));
      return chat;
    } catch (error) {
      if (errnoOf(error) !== "EEXIST" || attempt > 0) throw error;
    }
  }
}

/**
 * Creates the next chat of a task. The empty log is written before the record,
 * so every record has a log.
 */
export async function createChat(options: ProjectOptions, task: string, input: ChatInput): Promise<ChatRecord> {
  const { paths, taskChats } = await openTaskChats(options, task);
  const fault = inputFault(input);
  if (fault !== undefined) fail("field-required", fault);
  // Each directory is checked before the next one is made under it, so a link
  // put in its place never takes the create out of the tree.
  await makeDirectory(paths.chats);
  await checkChatDirectories(paths, taskChats);
  await makeDirectory(taskChats);
  await checkChatDirectories(paths, taskChats);
  const chat = await claimChat(taskChats);
  const directory = join(taskChats, String(chat));
  const stored = { step: input.step, agent: input.agent, folder: input.folder, created: now() };
  await createExclusive(join(directory, LOG_FILE), "");
  await createExclusive(join(directory, RECORD_FILE), recordText(stored));
  return { task, chat, ...stored };
}

export async function readChat(options: ProjectOptions, task: string, chat: number): Promise<ChatRecord> {
  const { taskChats } = await openTaskChats(options, task);
  return recordOf(task, chat, await readRecord(chatDirectory(taskChats, chat)));
}

/** One chat as `listChats` gives it. A chat the list leaves out is refused as its finding states. */
export async function readListedChat(options: ProjectOptions, task: string, chat: number): Promise<ChatRecord> {
  const { taskChats } = await openTaskChats(options, task);
  return readListed(chatDirectory(taskChats, chat), task, chat);
}

async function readListed(directory: string, task: string, chat: number): Promise<ChatRecord> {
  const record = recordOf(task, chat, await readRecord(directory));
  const log = join(directory, LOG_FILE);
  const entry = await entryAt(log);
  if (entry?.isFile() !== true || entry.nlink !== 1) {
    fail("chat-unreadable", "the event log of this chat is missing, or is not a regular file with one name", log);
  }
  return record;
}

/** The finding that leaves one chat out of a list, for a refusal and for a fault of the filesystem alike. */
export function chatFinding(error: unknown, directory: string): StoreDiagnostic {
  const message = error instanceof TaskStoreError ? error.description : `this chat cannot be read: ${causeOf(error)}`;
  return { code: "chat-file-unreadable", message, path: pathOf(error) ?? directory };
}

/**
 * Every chat of a task, in chat number order. A chat that `readChat` or
 * `openChatLog` would refuse is left out and reported, so one broken chat never
 * fails the list of its task.
 */
export async function listChats(options: ProjectOptions, task: string): Promise<ChatList> {
  const { taskChats, exists } = await openTaskChats(options, task);
  return exists ? readChats(taskChats, task) : { chats: [], diagnostics: [] };
}

/**
 * Every chat of every task of a project, under the rules of `listChats`, the
 * tasks in no fixed order. No task file is read, so a chat whose task is gone
 * is listed too. A directory of the chats of one task that cannot be read is
 * left out and reported, as one broken chat is.
 */
export async function listProjectChats(options: ProjectOptions): Promise<ChatList> {
  const paths = projectPaths(options);
  await openProjectDirectory(paths);
  const list: ChatList = { chats: [], diagnostics: [] };
  if (!(await checkChatsDirectory(paths))) return list;
  for (const name of await readdir(paths.chats)) {
    const task = `${paths.project}-${name}`;
    if (taskNumber(paths.project, `${task}.md`) === undefined) continue;
    const found = await readOrReportTaskChats(join(paths.chats, name), task);
    list.chats.push(...found.chats);
    list.diagnostics.push(...found.diagnostics);
  }
  return list;
}

async function readOrReportTaskChats(taskChats: string, task: string): Promise<ChatList> {
  let message;
  try {
    if ((await entryAt(taskChats))?.isDirectory() === true) return await readChats(taskChats, task);
    message = "the name of the chats of this task holds no directory";
  } catch (error) {
    message = `the chats of this task cannot be read: ${causeOf(error)}`;
  }
  return { chats: [], diagnostics: [{ code: "chat-file-unreadable", message, path: taskChats }] };
}

async function readChats(taskChats: string, task: string): Promise<ChatList> {
  const list: ChatList = { chats: [], diagnostics: [] };
  const numbers = (await readdir(taskChats)).map(chatNumber).filter((chat) => chat !== undefined);
  for (const chat of numbers.sort((a, b) => a - b)) {
    const directory = join(taskChats, String(chat));
    try {
      list.chats.push(await readListed(directory, task, chat));
    } catch (error) {
      list.diagnostics.push(chatFinding(error, directory));
    }
  }
  return list;
}

export async function updateChat(
  options: ProjectOptions,
  task: string,
  chat: number,
  change: ChatChange,
): Promise<ChatRecord> {
  const { taskChats } = await openTaskChats(options, task);
  if (change.session !== undefined && !isText(change.session)) {
    fail("field-required", '"session" must be a non-empty string');
  }
  const changedOptions = change.options === undefined ? undefined : stringRecord(change.options);
  if (change.options !== undefined && changedOptions === undefined) fail("field-required", '"options" must be an object');
  const directory = chatDirectory(taskChats, chat);
  const stored = await readRecord(directory);
  if (change.session !== undefined) stored.session = change.session;
  if (changedOptions !== undefined) stored.options = changedOptions;
  await replaceFile(join(directory, RECORD_FILE), recordText(stored));
  return recordOf(task, chat, stored);
}
