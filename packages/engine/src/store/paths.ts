import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { errnoOf, fail } from "./errors.js";
import type { ProjectOptions, StoreDiagnostic } from "./types.js";

/**
 * The form of a project tag this layer accepts. The tag becomes a directory
 * name, so this is a safety rule: it keeps a tag inside its directory, and
 * forbidding the dash keeps a task id unambiguous to split. The registry states
 * the narrower rule a project is created under.
 */
export const TAG_PATTERN = /^[A-Z0-9]+$/;

/** A leftover temp file of an interrupted write: `.<name>.<random>.tmp`. */
const TEMP_PATTERN = /^\..+\.tmp$/;

export type ProjectPaths = {
  project: string;
  root: string;
  userConfig: string;
  directory: string;
  projectConfig: string;
  state: string;
  tasks: string;
};

/** A leading `~/` is the home directory; every other path is left as it stands. */
function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice("~/".length)) : path;
}

/**
 * The tree the engine stores everything under, defaulting to `~/.tasma`. Every
 * path of this engine is built on it, so a caller that has no project tag —
 * and therefore cannot call `projectPaths` — expands the root through this.
 */
export function expandRoot(root?: string): string {
  return root === undefined ? join(homedir(), ".tasma") : resolve(expandHome(root));
}

/**
 * The directory every project of a tree stands under, from a root already
 * expanded. The one segment the layout is built on is written here alone.
 */
function projectsIn(root: string): string {
  return join(root, "projects");
}

/**
 * The same, for a caller that has no project tag and so no expanded root of its
 * own. It is how such a caller reads the tree.
 */
export function projectsDir(root?: string): string {
  return projectsIn(expandRoot(root));
}

/**
 * One path a file the user places states, against the directory holding that
 * file. An absolute path and a `~/` path each stand for themselves, which is
 * what lets an instruction document live in a repository outside the root.
 */
export function resolveAgainst(base: string, path: string): string {
  return resolve(base, expandHome(path));
}

/** Every path of one project. The root is expanded here and nowhere below this point. */
export function projectPaths(options: ProjectOptions): ProjectPaths {
  const project = options.project;
  if (!TAG_PATTERN.test(project)) {
    fail("project-invalid", `the project tag "${project}" must be uppercase ASCII letters or digits`);
  }
  const root = expandRoot(options.root);
  const directory = join(projectsIn(root), project);
  return {
    project,
    root,
    userConfig: join(root, "config.yml"),
    directory,
    projectConfig: join(directory, "config.yml"),
    state: join(directory, "state.yml"),
    tasks: join(directory, "tasks"),
  };
}

const DIGITS = /^\d+$/;

/**
 * The number a task file name carries, or `undefined` for a name that is not
 * one. A digit run past the safe integer range names no task file: `Number`
 * reads 240 nines as `1e+240`, and the name rebuilt from that is
 * `<PROJ>-1e+240`. Excluding it keeps the counter and the name rule agreeing on
 * which names a task file can carry.
 */
export function taskNumber(project: string, name: string): number | undefined {
  const prefix = `${project}-`;
  if (!name.startsWith(prefix) || !name.endsWith(".md")) return undefined;
  const digits = name.slice(prefix.length, -".md".length);
  if (!DIGITS.test(digits)) return undefined;
  const number = Number(digits);
  return Number.isSafeInteger(number) ? number : undefined;
}

/** The file of one task. An id that is no task id of this project names no file. */
export function taskPath(paths: ProjectPaths, id: string): string {
  if (taskNumber(paths.project, `${id}.md`) === undefined) {
    fail("task-not-found", `"${id}" is not a task id of project ${paths.project}`);
  }
  return join(paths.tasks, `${id}.md`);
}

/**
 * The temp file one write renames over `target`. It sits in the directory of the
 * target, so the rename stays on one filesystem, and its random component gives
 * each writer a file of its own: under a fixed name two concurrent writers would
 * interleave their writes and then rename a corrupted file into place.
 */
export function tempPath(target: string): string {
  return join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
}

export type TaskEntry = { id: string; number: number; path: string };

/**
 * The task file one name stands for, or `undefined` for a name that is no task
 * file of this project. Every reader of a name goes through this — the scan, the
 * watcher and the wrapper that reads back what it wrote — so how an id and a
 * path are derived from a name is stated in this module alone.
 */
export function taskEntryOf(paths: ProjectPaths, name: string): TaskEntry | undefined {
  const number = taskNumber(paths.project, name);
  if (number === undefined) return undefined;
  return { id: name.slice(0, -".md".length), number, path: join(paths.tasks, name) };
}

/** A finding of the scan, which always names the directory entry it found. */
export type ScanDiagnostic = StoreDiagnostic & { path: string };

export type Scan = { entries: TaskEntry[]; diagnostics: ScanDiagnostic[] };

/**
 * The task files of a project, by name alone. The name rule is the contract
 * between this scan and the watcher that later filters filesystem events with
 * it, not a private detail of either. A missing directory is an empty project:
 * `tasks/` is engine storage the store creates before the first write.
 */
export async function scanTasks(paths: ProjectPaths): Promise<Scan> {
  const entries: TaskEntry[] = [];
  const diagnostics: ScanDiagnostic[] = [];
  let names;
  try {
    names = await readdir(paths.tasks, { withFileTypes: true });
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return { entries, diagnostics };
    throw error;
  }
  for (const entry of names) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    const file = taskEntryOf(paths, name);
    if (file !== undefined) {
      entries.push(file);
      continue;
    }
    const path = join(paths.tasks, name);
    if (TEMP_PATTERN.test(name)) {
      // Never deleted: removing a file that was never verified is a worse
      // failure than naming it.
      diagnostics.push({ code: "temp-file-left", message: "a write did not remove this temp file", path });
    } else if (name.endsWith(".md")) {
      diagnostics.push({
        code: "task-file-unexpected",
        message: `the name of this file is not "${paths.project}-<number>.md", so it is not a task file`,
        path,
      });
    }
    // A name of any other form is not a task file and is passed over.
  }
  entries.sort((a, b) => a.number - b.number);
  return { entries, diagnostics };
}
