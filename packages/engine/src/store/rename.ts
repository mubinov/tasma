import type { Dirent, Stats } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseTask, serializeTask, TaskFormatError } from "../format/index.js";
import type { Frontmatter, Task } from "../format/index.js";
import { FRONTMATTER } from "../format/schema.js";
import {
  carriedMode,
  copyEntry,
  createExclusive,
  createExclusiveDirectory,
  discardDirectory,
  entryAt,
  type FileIdentity,
  makeDirectory,
  moveEntry,
  readRegularFile,
  readWithIdentity,
  removeFile,
  removeTree,
  replaceFile,
  syncDirectory,
} from "./atomic.js";
import { causeOf, errnoOf, fail } from "./errors.js";
import { pathsUnder, type ProjectPaths, projectPaths, type Scan, scanTasks, taskNumber, tempPath } from "./paths.js";
import { checkedProjectsDirectory, readProjectDeclaration } from "./projects.js";
import { openProjectDirectory } from "./store.js";
import { checkedTag } from "./tag.js";
import type { ProjectInfo, ProjectOptions, RenameProjectInput, StoreDiagnostic } from "./types.js";
import { checkedKeys } from "./validate.js";

/** The one key a rename states. The engine takes the whole body, so the daemon holds no rule of its own. */
const RENAME_KEYS = new Set(["tag"]);

/** What the publish reports when an entry took the target name while the copy ran. */
const TAKEN = new Set(["EEXIST", "ENOTEMPTY", "ENOTDIR"]);

/**
 * The frontmatter fields that hold task ids, read off the one statement of the
 * schema rather than listed here: a field added to the format carrying an id is
 * then relabelled by the mark it declares instead of being left behind.
 */
const ID_FIELDS = Object.entries(FRONTMATTER)
  .filter(([, spec]) => spec.ids !== undefined)
  .map(([key, spec]) => ({ key, many: spec.ids === "list" }));

/**
 * A task id of one project, whole: the tag, a dash, digits, and nothing else. A
 * tag holds none of the characters a pattern reads, so it is written into one as
 * it stands.
 */
function idPattern(tag: string): RegExp {
  return new RegExp(`^${tag}-(\\d+)$`);
}

/** The name a file of the old project stands under in the new one, digits verbatim. */
function renamedFile(oldTag: string, newTag: string, name: string): string {
  return `${newTag}${name.slice(oldTag.length)}`;
}

/**
 * One task file under the new tag: the same file with every field that holds a
 * task id relabelled where it names the old project.
 *
 * The rule is textual and exact, so an id that names another project is left as
 * it stands and reported instead. `updated`, `created` and `next_comment_id` do
 * not move: a rename is a relabel by the store, not an edit by a person. Nothing
 * else is read — not `custom`, not the body, not a comment — because no program
 * parses an id out of free text.
 */
function rewriteTask(
  text: string,
  oldTag: string,
  newTag: string,
  filename: string,
): { text: string; foreignId: string | undefined } {
  const { task } = parseTask(text, { filename });
  const pattern = idPattern(oldTag);
  const relabel = (id: string): string => id.replace(pattern, `${newTag}-$1`);

  const carried = task.frontmatter.id;
  const fields: Record<string, unknown> = { ...task.frontmatter };
  for (const field of ID_FIELDS) {
    const value = fields[field.key];
    if (value === undefined) continue;
    fields[field.key] = field.many ? (value as string[]).map(relabel) : relabel(value as string);
  }

  // The spread carries the snapshot, so every region the rewrite left alone —
  // the body, each comment, and every frontmatter key it did not touch — is
  // written back from the bytes that were read.
  const next: Task = { ...task, frontmatter: fields as Frontmatter };
  return { text: serializeTask(next, { filename }), foreignId: pattern.test(carried) ? undefined : carried };
}

function foreignFinding(id: string, project: string, path: string): StoreDiagnostic {
  return {
    code: "task-file-foreign",
    message: `the id "${id}" names no task of project ${project}, so the rename left it as it stands`,
    path,
  };
}

/** Every entry of a tasks directory, or none where the project never had one. */
async function listTaskDirectory(paths: ProjectPaths): Promise<Dirent[]> {
  try {
    return await readdir(paths.tasks, { withFileTypes: true });
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return [];
    throw error;
  }
}

/** Whether the bytes behind a name are still the ones a read recorded. */
function unchanged(recorded: FileIdentity, entry: Stats): boolean {
  return entry.ino === recorded.ino && entry.size === recorded.size && entry.mtimeMs === recorded.mtimeMs;
}

/** Takes a file away, tolerating one another writer already removed. */
async function removeIfPresent(path: string): Promise<void> {
  try {
    await removeFile(path);
  } catch (error) {
    if (errnoOf(error) !== "ENOENT") throw error;
  }
}

/**
 * Copies one entry the rename carries as it stands. An entry the listing named
 * and the copy no longer finds is passed over: it went away while the copy ran,
 * the window a task file answers with its own skip.
 */
async function carryEntry(from: string, to: string): Promise<void> {
  try {
    await copyEntry(from, to);
  } catch (error) {
    if (errnoOf(error) !== "ENOENT") throw error;
  }
}

/** Copies one file of the frozen project over the published one, leaving an absent file absent. */
async function copyBack(from: string, to: string): Promise<void> {
  const read = await readRegularFile(from);
  if (typeof read === "string") return;
  await replaceFile(to, read.text);
}

/**
 * Brings the published project up to what the frozen one holds, which is every
 * write that landed on the old project while the copy ran.
 *
 * `findings` is keyed by the name each file now stands under, so a file this
 * pass rewrites replaces whatever the copy reported about it instead of being
 * reported twice.
 *
 * A file that no longer parses is carried as it stands and reported: the window
 * in which a rename could still refuse closed at the publish, and leaving the
 * copy would lose the write.
 */
export async function reconcile(
  frozen: ProjectPaths,
  renamed: ProjectPaths,
  identities: ReadonlyMap<string, FileIdentity>,
  findings: Map<string, StoreDiagnostic>,
): Promise<void> {
  const scan = await scanTasks(frozen);
  const listed = new Set<string>();
  for (const entry of scan.entries) {
    const name = `${entry.id}.md`;
    listed.add(name);
    const recorded = identities.get(name);
    const current = await entryAt(entry.path);
    if (recorded !== undefined && current !== undefined && unchanged(recorded, current)) continue;
    const read = await readWithIdentity(entry.path);
    if (typeof read === "string") continue;

    const newName = renamedFile(frozen.project, renamed.project, name);
    const path = join(renamed.tasks, newName);
    findings.delete(newName);
    try {
      const rewritten = rewriteTask(read.text, frozen.project, renamed.project, path);
      await replaceFile(path, rewritten.text);
      if (rewritten.foreignId !== undefined) {
        findings.set(newName, foreignFinding(rewritten.foreignId, frozen.project, path));
      }
    } catch (error) {
      if (!(error instanceof TaskFormatError)) throw error;
      await replaceFile(path, read.text);
      findings.set(newName, {
        code: "task-file-unreadable",
        message: `this file broke while the rename ran and was carried as it stands: ${causeOf(error)}`,
        path,
        line: error.line,
      });
    }
  }

  for (const name of identities.keys()) {
    if (listed.has(name)) continue;
    const newName = renamedFile(frozen.project, renamed.project, name);
    findings.delete(newName);
    await removeIfPresent(join(renamed.tasks, newName));
  }

  await copyBack(frozen.projectConfig, renamed.projectConfig);
  await copyBack(frozen.state, renamed.state);
}

/**
 * Everything of the project directory but `tasks/`, under the staging name.
 *
 * The two files this layer writes itself are read and written again rather than
 * copied: `cp` flushes nothing it writes, and a crash after the publish would
 * leave the new project with a truncated declaration or counter while the old
 * one is gone. Writing them again is what makes their mode this layer's to set,
 * so each takes the mode it stood under — `cp` carries the mode of every other
 * entry, and a rename that widened these two alone would be the one write of
 * this layer that loosens what a hand restricted. A link under either name is
 * the user's own structure and is carried as the link it is, as every other
 * entry of the directory is.
 */
async function stageDirectory(source: ProjectPaths, staging: ProjectPaths): Promise<void> {
  for (const entry of await readdir(source.directory, { withFileTypes: true })) {
    if (entry.name === basename(source.tasks)) continue;
    const from = join(source.directory, entry.name);
    const to = join(staging.directory, entry.name);
    if (from !== source.projectConfig && from !== source.state) {
      await carryEntry(from, to);
      continue;
    }
    const read = await readRegularFile(from);
    if (typeof read === "string") {
      await carryEntry(from, to);
      continue;
    }
    await createExclusive(to, read.text, await carriedMode(from));
  }
}

/** The project the copy reads, the tree it writes, and the two readings it works from. */
type Copy = {
  source: ProjectPaths;
  staging: ProjectPaths;
  /** Where the staging directory will stand once it is published, which every finding names. */
  renamed: ProjectPaths;
  listing: Dirent[];
  scan: Scan;
};

/** What the copy leaves the steps after the publish: what it read, and what it found. */
type Staged = {
  /**
   * The identity of each task file read, by the name it was read under, so the
   * reconcile can tell which of them another writer has touched since.
   */
  identities: Map<string, FileIdentity>;
  /** The findings of the copy, by the name each file now stands under. */
  findings: Map<string, StoreDiagnostic>;
};

/**
 * Builds the whole new project under a hidden name beside the old one: every
 * file of the project directory but `tasks/` carried as it stands, every task
 * file rewritten under its new name, and every other entry of `tasks/` carried
 * under its own.
 *
 * A fault takes the staging directory with it, so the old project is left as it
 * was and the tree holds nothing half made.
 *
 * Both directories are flushed before the copy is handed on: a create flushes
 * the directory holding the file it wrote, so nothing else forces out the entry
 * that names `tasks/` or the entries `cp` installed, and a crash after the
 * publish would leave the new project short of what the old one is no longer
 * there to hold.
 */
async function stage(copy: Copy): Promise<Staged> {
  const { source, staging, renamed, listing, scan } = copy;
  const identities = new Map<string, FileIdentity>();
  const findings = new Map<string, StoreDiagnostic>();
  await createExclusiveDirectory(staging.directory);
  try {
    await stageDirectory(source, staging);
    await makeDirectory(staging.tasks);

    const tasks = new Set(scan.entries.map((entry) => `${entry.id}.md`));
    for (const entry of listing) {
      const from = join(source.tasks, entry.name);
      if (!tasks.has(entry.name)) {
        await carryEntry(from, join(staging.tasks, entry.name));
        continue;
      }
      const read = await readWithIdentity(from);
      // Reachable only where the file went away or became a link between the
      // scan and the open. A name that reappears is picked up by the reconcile.
      if (typeof read === "string") continue;
      const newName = renamedFile(source.project, staging.project, entry.name);
      const rewritten = rewriteTask(read.text, source.project, staging.project, from);
      await createExclusive(join(staging.tasks, newName), rewritten.text);
      identities.set(entry.name, read.identity);
      if (rewritten.foreignId !== undefined) {
        findings.set(newName, foreignFinding(rewritten.foreignId, source.project, join(renamed.tasks, newName)));
      }
    }
    await syncDirectory(staging.tasks);
    await syncDirectory(staging.directory);
  } catch (error) {
    await removeTree(staging.directory);
    throw error;
  }
  return { identities, findings };
}

/**
 * Installs the staged copy under the new tag.
 *
 * The name is claimed with an exclusive create first, and the copy is moved onto
 * the directory that claim owns: `rename(2)` replaces an empty directory, so a
 * publish straight onto the name would take over the directory of a create that
 * had not yet written its declaration, and that create would then write its own
 * name and path into the renamed project and answer success for a project it
 * never made. A create and a rename reaching for one name contend on this one
 * exclusive create instead.
 *
 * A fault takes the staged copy with it and gives the claim back, so neither a
 * hidden tree nor an empty directory every listing reports as a project is left
 * behind. The claim goes first: it is the one of the two a reader can see.
 */
export async function publish(staging: ProjectPaths, renamed: ProjectPaths): Promise<void> {
  let claimed = false;
  try {
    await createExclusiveDirectory(renamed.directory);
    claimed = true;
    await moveEntry(staging.directory, renamed.directory);
  } catch (error) {
    if (claimed) await discardDirectory(renamed.directory);
    await removeTree(staging.directory);
    const code = errnoOf(error);
    if (code !== undefined && TAKEN.has(code)) {
      fail("project-exists", "a project already stands here", renamed.directory, error);
    }
    throw error;
  }
}

/**
 * The tag a rename states, under the rule a create applies. The whole body is
 * checked here: the engine takes it as the caller sent it, so no layer above
 * holds a field rule of its own.
 */
function checkedTarget(input: RenameProjectInput): string {
  checkedKeys(input, RENAME_KEYS, "is not a key a rename of a project states");
  // Presence, not value: a body carrying `null` arrives as a key holding
  // `undefined`, and a cleared tag is no tag.
  if (input.tag === undefined) {
    fail("field-required", '"tag" is the one field a rename states, so it cannot be left out');
  }
  return checkedTag(input.tag);
}

/**
 * Refuses an entry of the old tasks directory that is named after a task of the
 * new project, whatever form the entry takes. Such an entry would either collide
 * with the rewritten task file of that number or be adopted as a task of the new
 * project by the name rule alone; the caller renames or removes it and runs the
 * rename again.
 */
function assertNoTargetTaskName(listing: Dirent[], source: ProjectPaths, target: string): void {
  for (const entry of listing) {
    if (taskNumber(target, entry.name) === undefined) continue;
    fail("task-exists", `this entry is named after a task of project ${target}`, join(source.tasks, entry.name));
  }
}

/**
 * Takes the old project out of the tree in one step, so a task write still in
 * flight against its paths fails rather than landing on a project nothing
 * serves. Answers whether the project was still standing: a hand that took it
 * away between the two directory renames leaves nothing to reconcile and
 * nothing to remove.
 */
async function freeze(source: ProjectPaths, frozen: ProjectPaths): Promise<boolean> {
  try {
    await moveEntry(source.directory, frozen.directory);
    return true;
  } catch (error) {
    if (errnoOf(error) !== "ENOENT") throw error;
    return false;
  }
}

/**
 * Builds the new project beside the old one, then installs it under the new tag
 * and takes the old tag out of the tree. Each install is a single `rename(2)`
 * inside `projects/`, so a reader sees the old project or the new one and never
 * a mix, and a task write still in flight against the old paths fails rather
 * than landing on a project nothing serves.
 *
 * An interruption leaves a directory under a hidden name, which no listing
 * reports and nothing here deletes — the rule this layer applies to a temp file.
 * One interrupted between the claim of the new name and the move onto it leaves
 * that name holding an empty directory too, which a person removes.
 *
 * No index is consulted: the engine keeps no registry of open ones, so a caller
 * holding an index of either tag closes it itself.
 */
export async function renameProject(
  options: ProjectOptions,
  input: RenameProjectInput,
): Promise<ProjectInfo> {
  const target = checkedTarget(input);
  const source = projectPaths(options);
  if (target === source.project) {
    fail("project-exists", "a project already stands here", source.directory);
  }
  const projects = await checkedProjectsDirectory(options.root);
  await openProjectDirectory(source);

  const root = source.root;
  const renamed = pathsUnder({ project: target, root, directory: join(projects, target) });
  // Whatever holds the name, and whether or not a listing reports it. The claim
  // the publish makes is the guard a racing writer meets; this one keeps a whole
  // copy from being made for a name that is taken already.
  if ((await entryAt(renamed.directory)) !== undefined) {
    fail("project-exists", "a project already stands here", renamed.directory);
  }
  const staging = pathsUnder({ project: target, root, directory: tempPath(renamed.directory) });

  const listing = await listTaskDirectory(source);
  const scan = await scanTasks(source);
  assertNoTargetTaskName(listing, source, target);

  const { identities, findings } = await stage({ source, staging, renamed, listing, scan });
  await publish(staging, renamed);

  const frozen = pathsUnder({ project: source.project, root, directory: tempPath(source.directory) });
  if (await freeze(source, frozen)) {
    await reconcile(frozen, renamed, identities, findings);
    await removeTree(frozen.directory);
  }

  const diagnostics: StoreDiagnostic[] = scan.diagnostics.map((finding) => ({
    ...finding,
    // Where a reader finds the entry now; the old location is gone.
    path: join(renamed.tasks, basename(finding.path)),
  }));
  diagnostics.push(...findings.values());

  // The findings of the read are dropped by that call's own rule: a finding
  // about one project's configuration belongs on the read of that project.
  const declaration = await readProjectDeclaration({ project: target, root: options.root });
  return { tag: target, ...declaration, diagnostics };
}
