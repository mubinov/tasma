import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { errnoOf } from "../store/errors.js";
import { projectPaths, projectsDir, userConfigPath } from "../store/paths.js";
import { discoverProjects } from "../store/projects.js";
import { openTreeWorkflows } from "../store/workflow.js";
import { openWorkflows, type Workflows } from "../workflow/index.js";
import { workflowEntryKind } from "../workflow/load.js";

/**
 * One change of the tree that the board reads. The arms have the shape of the
 * `config`, `project` and `workflow` arms of the daemon's change feed, so the
 * daemon publishes a change as it stands.
 */
export type TreeChange
  = | { kind: "config" }
    | { kind: "project"; tag: string; change: "created" | "changed" | "deleted" }
    | { kind: "workflow"; name: string; change: "created" | "changed" | "deleted" };

/** The part of the tree one read covers. */
export type TreeArea
  = | { kind: "all" }
    | { kind: "projects" }
    | { kind: "project"; tag: string }
    | { kind: "workflows" }
    | { kind: "workflow"; name: string };

export const WHOLE_TREE: TreeArea = { kind: "all" };

/**
 * A short string that changes when the thing it describes changes: `absent`,
 * `fault:<code>`, or the stat fields that a hand edit changes. `mode` carries
 * the type of the entry.
 */
type Mark = string;

/** What one file name holds, and whether it is a regular file. */
type FileMark = { mark: Mark; isFile: boolean };

/** What one folder name holds, and the identity of the folder for a name that holds one. */
type FolderMark = { mark: Mark; identity: string | undefined };

/**
 * The marks of one project. The folder marks hold no times: the times of a
 * project folder change at each task create and the times of `tasks/` at each
 * task write, which the index of the project already reports.
 */
type ProjectState = { folder: FolderMark; config: Mark; tasks: Mark };

/** A workflow folder, which the listing names only while its `workflow.yml` is a regular file. */
type WorkflowState = { identity: string | undefined; file: FileMark };

export type TreeState = {
  readonly rootIdentity: string | undefined;
  readonly config: Mark;
  readonly projects: {
    readonly identity: string | undefined;
    readonly tags: ReadonlyMap<string, ProjectState>;
  };
  readonly workflows: {
    readonly directory: string;
    readonly identity: string | undefined;
    readonly names: ReadonlyMap<string, WorkflowState>;
  };
};

/** A read of one area over the last state, or of the whole tree when there is none. */
export type ReadTree = (root: string, area: TreeArea, last: TreeState | undefined) => Promise<TreeState>;

/** One folder the tree watches, and the area that an event of it reads again. */
export type WatchedFolder = { identity: string; area: TreeArea };

type Change = "created" | "changed" | "deleted";

/** How many entries of one list are read at a time, as the other folder reads of the tree do. */
const READ_LIMIT = 8;

function faultMark(error: unknown): Mark {
  const code = errnoOf(error);
  return code === "ENOENT" ? "absent" : `fault:${String(code)}`;
}

/** Links are followed, as the readers of these files follow them. */
async function fileThrough(path: string): Promise<FileMark> {
  let entry: Stats;
  try {
    entry = await stat(path);
  } catch (error) {
    return { mark: faultMark(error), isFile: false };
  }
  const mark = [entry.dev, entry.ino, entry.size, entry.mtimeMs, entry.ctimeMs, entry.mode].join(":");
  return { mark, isFile: entry.isFile() };
}

async function folderOf(path: string, read: (path: string) => Promise<Stats>): Promise<FolderMark> {
  let entry: Stats;
  try {
    entry = await read(path);
  } catch (error) {
    return { mark: faultMark(error), identity: undefined };
  }
  const mark = [entry.dev, entry.ino, entry.mode, entry.uid, entry.gid].join(":");
  return { mark, identity: entry.isDirectory() ? `${entry.dev}:${entry.ino}` : undefined };
}

/** A link is taken as a link, as the readers of projects take it. */
function folderAt(path: string): Promise<FolderMark> {
  return folderOf(path, lstat);
}

/** Links are followed, as the readers of the tree root and of workflows follow them. */
function folderThrough(path: string): Promise<FolderMark> {
  return folderOf(path, stat);
}

/** `work` over each item, at most `READ_LIMIT` at a time, with the answers in the order of the items. */
async function mapLimited<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const answers: R[] = [];
  const pending = items.entries();
  const workers = Array.from({ length: READ_LIMIT }, async () => {
    for (const [at, item] of pending) answers[at] = await work(item);
  });
  await Promise.all(workers);
  return answers;
}

async function readProject(root: string, tag: string): Promise<ProjectState> {
  const paths = projectPaths({ project: tag, root });
  const [folder, config, tasks] = await Promise.all([
    folderAt(paths.directory),
    fileThrough(paths.projectConfig),
    folderAt(paths.tasks),
  ]);
  return { folder, config: config.mark, tasks: tasks.mark };
}

/** A fault of the listing lists no project, as the listing of the daemon refuses then. */
async function readProjects(root: string): Promise<TreeState["projects"]> {
  const folder = await folderAt(projectsDir(root));
  let found: string[];
  try {
    found = await discoverProjects(root);
  } catch {
    found = [];
  }
  const tags = new Map(await mapLimited(found, async (tag) => [tag, await readProject(root, tag)] as const));
  return { identity: folder.identity, tags };
}

async function readWorkflow(workflows: Workflows, name: string): Promise<WorkflowState> {
  const paths = workflows.pathsOf(name);
  const [folder, file] = await Promise.all([folderThrough(paths.directory), fileThrough(paths.file)]);
  return { identity: folder.identity, file };
}

/**
 * Every workflow folder, also one that holds no `workflow.yml` yet: a flat watch
 * on the workflows folder hears nothing of a file saved inside one of them.
 */
async function readWorkflows(root: string): Promise<TreeState["workflows"]> {
  const { workflows } = await openTreeWorkflows(root);
  const { directory } = workflows;
  const folder = await folderThrough(directory);
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return { directory, identity: folder.identity, names: new Map() };
  }
  const read = await mapLimited(entries, async (entry) => {
    if ((await workflowEntryKind(join(directory, entry.name), entry)) !== "workflow") return undefined;
    return [entry.name, await readWorkflow(workflows, entry.name)] as const;
  });
  return { directory, identity: folder.identity, names: new Map(read.filter((item) => item !== undefined)) };
}

async function readAll(root: string): Promise<TreeState> {
  const [folder, config, projects, workflows] = await Promise.all([
    folderThrough(root),
    fileThrough(userConfigPath(root)),
    readProjects(root),
    readWorkflows(root),
  ]);
  return { rootIdentity: folder.identity, config: config.mark, projects, workflows };
}

/**
 * Reads one area of the tree again, over the state the last read left, or the
 * whole tree when there is no last state. It never throws: a fault of a read
 * becomes a mark, and a fault of a listing an empty list.
 *
 * A project or a workflow whose folder is gone, or is no longer a folder, reads
 * its list instead, so a removal is a delete and never a change first.
 */
export async function readTree(root: string, area: TreeArea = WHOLE_TREE, last?: TreeState): Promise<TreeState> {
  if (last === undefined) return readAll(root);
  switch (area.kind) {
    case "all":
      return readAll(root);
    case "projects":
      return { ...last, projects: await readProjects(root) };
    case "project": {
      const project = await readProject(root, area.tag);
      if (project.folder.identity === undefined) return { ...last, projects: await readProjects(root) };
      const tags = new Map(last.projects.tags).set(area.tag, project);
      return { ...last, projects: { ...last.projects, tags } };
    }
    case "workflows":
      return { ...last, workflows: await readWorkflows(root) };
    case "workflow": {
      const workflow = await readWorkflow(openWorkflows({ root, path: last.workflows.directory }), area.name);
      if (workflow.identity === undefined) return { ...last, workflows: await readWorkflows(root) };
      const names = new Map(last.workflows.names).set(area.name, workflow);
      return { ...last, workflows: { ...last.workflows, names } };
    }
  }
}

function* compare<T>(
  before: ReadonlyMap<string, T>,
  after: ReadonlyMap<string, T>,
  same: (a: T, b: T) => boolean,
): Generator<[string, Change]> {
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const was = before.get(key);
    const now = after.get(key);
    if (was === undefined) yield [key, "created"];
    else if (now === undefined) yield [key, "deleted"];
    else if (!same(was, now)) yield [key, "changed"];
  }
}

function sameProject(a: ProjectState, b: ProjectState): boolean {
  return a.folder.mark === b.folder.mark && a.config === b.config && a.tasks === b.tasks;
}

function listed(state: TreeState): Map<string, WorkflowState> {
  return new Map([...state.workflows.names].filter(([, workflow]) => workflow.file.isFile));
}

/** The changes from one state to the next: the config, then the projects by tag, then the workflows by name. */
export function diffTree(before: TreeState, after: TreeState): TreeChange[] {
  const changes: TreeChange[] = [];
  if (before.config !== after.config) changes.push({ kind: "config" });
  for (const [tag, change] of compare(before.projects.tags, after.projects.tags, sameProject)) {
    changes.push({ kind: "project", tag, change });
  }
  for (const [name, change] of compare(listed(before), listed(after), (a, b) => a.file.mark === b.file.mark)) {
    changes.push({ kind: "workflow", name, change });
  }
  return changes;
}

/**
 * The folders the tree watches in one state, by path: the tree root, `projects/`
 * and the workflows folder first, then the projects by tag, then the workflow
 * folders by name.
 */
export function watchedFolders(root: string, state: TreeState): Map<string, WatchedFolder> {
  const folders = new Map<string, WatchedFolder>();
  const add = (path: string, identity: string | undefined, area: TreeArea): void => {
    if (identity === undefined) return;
    // A `workflows_path` can name a folder that the tree watches already.
    folders.set(path, { identity, area: folders.has(path) ? WHOLE_TREE : area });
  };
  const { directory } = state.workflows;
  add(root, state.rootIdentity, WHOLE_TREE);
  add(projectsDir(root), state.projects.identity, { kind: "projects" });
  add(directory, state.workflows.identity, { kind: "workflows" });
  const { tags } = state.projects;
  for (const tag of [...tags.keys()].sort()) {
    add(projectPaths({ project: tag, root }).directory, tags.get(tag)?.folder.identity, { kind: "project", tag });
  }
  const { names } = state.workflows;
  for (const name of [...names.keys()].sort()) add(join(directory, name), names.get(name)?.identity, { kind: "workflow", name });
  return folders;
}
