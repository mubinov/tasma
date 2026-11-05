import { join } from "node:path";
import { entryAt } from "./atomic.js";
import {
  applyChange,
  type ChatAgent,
  type ChatChange,
  chatDirectory,
  checkChange,
  checkListedLog,
  type InputRule,
  isText,
  makeChatDirectories,
  readChats,
  readRecord,
  RECORD_FILE,
  type SharedFields,
  sharedFieldsOf,
  sharedInputFault,
  writeNewChat,
} from "./chat.js";
import { causeOf, fail } from "./errors.js";
import { type ProjectPaths, projectChatsPath, projectPaths } from "./paths.js";
import { checkChatDirectories, checkChatsDirectory, now, openProjectDirectory } from "./store.js";
import type { ProjectOptions, StoreDiagnostic } from "./types.js";

/**
 * One chat of a project that belongs to no task. `chat` comes from the path and
 * the record holds no tag, so a rename of the project rewrites nothing in the
 * chat files.
 */
export type ProjectChatRecord = { chat: number; title: string } & SharedFields;

export type ProjectChatInput = { title: string; agent: ChatAgent; folder: string };

export type ProjectChatList = { chats: ProjectChatRecord[]; diagnostics: StoreDiagnostic[] };

const SUBJECT = "the project chats directory of this project";

export const projectInputFault: InputRule = (value) => {
  if (!isText(value.title)) return '"title" must be a non-empty string';
  return sharedInputFault(value);
};

function recordOf(chat: number, stored: Record<string, unknown>): ProjectChatRecord {
  return { chat, title: stored.title as string, ...sharedFieldsOf(stored) };
}

/** The project and the directory of its project chats, after the checks every project chat call makes. */
export async function openProjectChats(
  options: ProjectOptions,
): Promise<{ paths: ProjectPaths; projectChats: string }> {
  const paths = projectPaths(options);
  await openProjectDirectory(paths);
  const projectChats = projectChatsPath(paths);
  await checkChatDirectories(paths, projectChats, SUBJECT);
  return { paths, projectChats };
}

/** The directory of one project chat, which a finding about that chat names. */
export function projectChatPath(options: ProjectOptions, chat: number): string {
  return chatDirectory(projectChatsPath(projectPaths(options)), chat);
}

/** The record file of one project chat, which a finding about its record names. */
export function projectChatRecordPath(options: ProjectOptions, chat: number): string {
  return join(projectChatPath(options, chat), RECORD_FILE);
}

/** Creates the next chat of a project. Its number counts apart from the chats of the tasks. */
export async function createProjectChat(options: ProjectOptions, input: ProjectChatInput): Promise<ProjectChatRecord> {
  const { paths, projectChats } = await openProjectChats(options);
  const fault = projectInputFault(input);
  if (fault !== undefined) fail("field-required", fault);
  await makeChatDirectories(paths, projectChats, SUBJECT);
  const stored = { title: input.title, agent: input.agent, folder: input.folder, created: now() };
  return { chat: await writeNewChat(projectChats, stored), ...stored };
}

export async function readProjectChat(options: ProjectOptions, chat: number): Promise<ProjectChatRecord> {
  const { projectChats } = await openProjectChats(options);
  return recordOf(chat, await readRecord(chatDirectory(projectChats, chat), projectInputFault));
}

/** One chat as `listProjectChats` gives it. A chat the list leaves out is refused as its finding states. */
export async function readListedProjectChat(options: ProjectOptions, chat: number): Promise<ProjectChatRecord> {
  const { projectChats } = await openProjectChats(options);
  return readListed(chatDirectory(projectChats, chat), chat);
}

async function readListed(directory: string, chat: number): Promise<ProjectChatRecord> {
  const record = recordOf(chat, await readRecord(directory, projectInputFault));
  await checkListedLog(directory);
  return record;
}

/**
 * Every chat of a project that belongs to no task, in chat number order, under
 * the rules of `listChats`. A `chats/project` that is no directory or cannot be
 * read is left out and reported, as `listAllTaskChats` reports the chats of one
 * task, so a caller keeps the chats of the tasks.
 */
export async function listProjectChats(options: ProjectOptions): Promise<ProjectChatList> {
  const paths = projectPaths(options);
  await openProjectDirectory(paths);
  if (!(await checkChatsDirectory(paths))) return { chats: [], diagnostics: [] };
  const projectChats = projectChatsPath(paths);
  const entry = await entryAt(projectChats);
  if (entry === undefined) return { chats: [], diagnostics: [] };
  let message;
  if (entry.isDirectory()) {
    try {
      return await readChats(projectChats, readListed);
    } catch (error) {
      message = `the project chats of this project cannot be read: ${causeOf(error)}`;
    }
  } else {
    message = "the name of the project chats of this project holds no directory";
  }
  return { chats: [], diagnostics: [{ code: "chat-file-unreadable", message, path: projectChats }] };
}

export async function updateProjectChat(
  options: ProjectOptions,
  chat: number,
  change: ChatChange,
): Promise<ProjectChatRecord> {
  const { projectChats } = await openProjectChats(options);
  const checked = checkChange(change);
  return recordOf(chat, await applyChange(chatDirectory(projectChats, chat), checked, projectInputFault));
}
