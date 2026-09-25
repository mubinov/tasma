import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { Document } from "yaml";
import {
  createExclusive,
  createExclusiveDirectory,
  makeDirectory,
  removeTree,
  replaceFile,
} from "./atomic.js";
import {
  checkStatusAndPriorityChange,
  readDeclared,
  resolveProjectDeclaration,
  STATUS_AND_PRIORITY_KEYS,
} from "./config.js";
import {
  appliedValues,
  applyWrites,
  checkAnchor,
  checkedDefaultStatus,
  checkedList,
  cleared,
  openDeclaration,
} from "./declaration.js";
import { errnoOf, fail } from "./errors.js";
import { pathHolder } from "./locate.js";
import { checkedDirectoryPath, checkedFilePath, type ProjectPaths, projectPaths } from "./paths.js";
import { checkedProjectsDirectory, discoverProjects } from "./projects.js";
import { checkProjectDirectory, openProjectDirectory } from "./store.js";
import { checkedTag, generateTag, uniqueTag } from "./tag.js";
import { checkedKeys } from "./validate.js";
import { checkDeclaredWorkflows } from "./workflow.js";
import type {
  CreateProjectInput,
  ProjectChange,
  ProjectInfo,
  ProjectOptions,
  StoreDiagnostic,
} from "./types.js";

/** The keys a create states: the fields it writes, and the tree it writes them in. */
const CREATE_KEYS = new Set(["root", "path", "name", "tag"]);

/**
 * The finding a read adds when the folder a project stands for is gone, or
 * nothing when it is there. The link is followed, as it is for a path a caller
 * states.
 *
 * Every fault is an answer here. A read of a project reports on that folder and
 * repairs nothing, so one this account may not stat is reported as gone rather
 * than taking the whole read of the project with it.
 */
export async function pathMissing(path: string): Promise<StoreDiagnostic | undefined> {
  try {
    if ((await stat(path)).isDirectory()) return undefined;
  } catch {
    // Swallowed on purpose, so a stat that failed reads as a folder that is gone.
  }
  return { code: "path-missing", message: "the project path does not name a directory", path };
}

/**
 * The absolute path of the folder a project stands for, under the rule every
 * directory a caller states stands.
 *
 * `path` is the one field with a code of its own, so every unusable value of it
 * is refused under that code, the wrong type among them. The type is the one
 * check that is this side's alone: it comes out of a file the user wrote, where
 * the shared rule takes a value the caller holds as text already.
 */
async function checkedPath(stated: unknown): Promise<string> {
  if (typeof stated !== "string") {
    fail("path-invalid", `a project path must be text, and ${String(stated)} is not`);
  }
  return checkedDirectoryPath(stated, "a project path");
}

/** Refuses a checked path that another project of the tree stands at. */
async function checkPathFree(path: string, root: string | undefined, except?: string): Promise<void> {
  const holder = await pathHolder(path, root, except);
  if (holder !== undefined) fail("path-taken", `project ${holder} holds this directory`, path);
}

/**
 * The name a caller stated, which is text and never the empty string. It is
 * checked before any write: the file is read back on every later call, and a
 * value the reader refuses would leave the project unusable from then on.
 */
function checkedName(stated: unknown): string {
  if (typeof stated !== "string") {
    fail("field-required", `a project name must be text, and ${String(stated)} is not`);
  }
  if (stated === "") fail("field-required", '"name" must not be empty');
  return stated;
}

/** A fresh `config.yml`: the two keys a project states about itself, in that order. */
function declarationText(name: string | undefined, path: string): string {
  const doc = new Document({});
  if (name !== undefined) doc.set("name", name);
  doc.set("path", path);
  return doc.toString();
}

/**
 * Registers a project: a directory named by its tag, holding the one file that
 * states what the project stands for. Nothing else is written — `tasks/` and
 * `state.yml` are engine storage the store creates before the first task.
 *
 * The tag is the caller's when it gives one, and otherwise the tag the folder
 * the path resolves to gives, numbered until it is free. The exclusive create of
 * the directory is the collision guard rather than the discovery that preceded
 * it, so two creates racing on one tag settle on two directories.
 *
 * A path another project stands at is refused before anything is written. That
 * check has no such guard: two creates racing on one path both pass it unless
 * the caller orders them.
 */
export async function createProject(input: CreateProjectInput): Promise<ProjectInfo> {
  checkedKeys(input, CREATE_KEYS, "is not a key a create of a project states");
  const explicit = input.tag === undefined ? undefined : checkedTag(input.tag);
  const statedName = input.name === undefined ? undefined : checkedName(input.name);
  // The path is checked before it is read for a tag: a create stating none must
  // be refused for the path rather than for the tag no path can give.
  const path = await checkedPath(input.path);
  // A path that names no folder at all, the root of a filesystem, leaves the
  // project with no name of its own.
  const folder = basename(path);
  const name = statedName ?? (folder === "" ? undefined : folder);
  const projects = await checkedProjectsDirectory(input.root);
  await checkPathFree(path, input.root);
  // The tag the create starts from. Only a generated one is counted up from it:
  // a stated tag is the one the caller asked for or nothing.
  const start = explicit ?? generateTag(path);
  const taken = new Set(explicit === undefined ? await discoverProjects(input.root) : []);
  let tag = explicit ?? uniqueTag(start, taken);
  let paths = projectPaths({ project: tag, root: input.root });

  await makeDirectory(paths.root);
  await makeDirectory(projects);
  while (true) {
    try {
      await createExclusiveDirectory(paths.directory);
      break;
    } catch (error) {
      if (errnoOf(error) !== "EEXIST") throw error;
      if (explicit !== undefined) fail("project-exists", "a project already stands here", paths.directory);
      taken.add(tag);
      tag = uniqueTag(start, taken);
      paths = projectPaths({ project: tag, root: input.root });
    }
  }

  const text = declarationText(name, path);
  try {
    await createExclusive(paths.projectConfig, text);
  } catch (error) {
    // The directory on its own is a project that states nothing, which the tree
    // would go on holding after the caller was told the create failed.
    await removeTree(paths.directory);
    throw error;
  }
  return { tag, name, path, diagnostics: [] };
}

/**
 * What one project states about itself, the findings of that read, and the one
 * finding this read adds on top: the folder the project stands for is gone. The
 * project stays usable and nothing is repaired — the folder may be a disk that
 * is not mounted right now.
 *
 * `readProjectDeclaration` neither makes that check nor reports a finding. A
 * listing calls it once per project, and a check of a path on an unmounted
 * network disk can hang, which would leave one project holding up the whole list.
 */
export async function readProject(options: ProjectOptions): Promise<ProjectInfo> {
  const paths = projectPaths(options);
  await checkedProjectsDirectory(options.root);
  await openProjectDirectory(paths);
  const diagnostics: StoreDiagnostic[] = [];
  const declaration = await resolveProjectDeclaration(paths, diagnostics);
  const missing = declaration.path === undefined ? undefined : await pathMissing(declaration.path);
  if (missing !== undefined) diagnostics.push(missing);
  return { tag: paths.project, ...declaration, diagnostics };
}

/** The check of the value each writable key of a project sets, on its own. `tag` is not among them. */
const VALUE_CHECKS: { [Key in keyof ProjectChange]-?: (stated: unknown) => unknown } = {
  name: checkedName,
  path: checkedPath,
  statuses: (stated) => checkedList("statuses", stated, false),
  default_status: checkedDefaultStatus,
  final_statuses: (stated) => checkedList("final_statuses", stated, false),
  priorities: (stated) => checkedList("priorities", stated, false),
  workflows: (stated) => checkedList("workflows", stated, true),
  instructions: (stated) => checkedList("instructions", stated, true),
};

const PROJECT_WRITABLE = new Set(Object.keys(VALUE_CHECKS));

/**
 * Refuses a change whose result the reader or a later read would refuse. Each
 * check runs only where the change states one of the keys it reads, so a change
 * does not fail on a value it leaves alone.
 */
async function checkChange(paths: ProjectPaths, doc: Document, writes: Map<string, unknown>): Promise<void> {
  if ([...writes.keys()].some((key) => STATUS_AND_PRIORITY_KEYS.has(key))) {
    const project = { path: paths.projectConfig, values: appliedValues(doc, writes) };
    const user = await readDeclared(paths.userConfig, "user");
    checkStatusAndPriorityChange([project, user], new Set(writes.keys()));
  }
  const workflows = writes.get("workflows") as string[] | undefined;
  if (workflows !== undefined) await checkDeclaredWorkflows(paths, workflows);
  const instructions = writes.get("instructions") as string[] | undefined;
  for (const entry of instructions ?? []) await checkedFilePath(entry, "an instruction document");
  for (const [key, value] of writes) checkAnchor(doc, key, value === undefined, paths.projectConfig);
}

/**
 * Sets and clears the keys of one change, leaving every other key and every
 * comment of the file alone. Every check runs before the file is touched.
 */
async function writeDeclaration(options: ProjectOptions, paths: ProjectPaths, change: ProjectChange): Promise<void> {
  if (Object.hasOwn(change, "path") && cleared(change.path)) {
    fail("field-required", '"path" is a field every project states, so it cannot be cleared');
  }
  // The value each key of the change sets, `undefined` for a key it clears.
  const writes = new Map<string, unknown>();
  for (const [key, stated] of Object.entries(change)) {
    writes.set(key, cleared(stated) ? undefined : await VALUE_CHECKS[key as keyof ProjectChange](stated));
  }
  const path = writes.get("path") as string | undefined;
  // Also for the path the project already states: a hand edit can have put
  // another project there.
  if (path !== undefined) await checkPathFree(path, options.root, options.project);

  const doc = await openDeclaration(paths.projectConfig);
  await checkChange(paths, doc, writes);
  // A change that took no key off the file and put none on it leaves the file as
  // it stands, and installs none where a hand-made project never had one.
  if (!applyWrites(doc, writes)) return;
  await replaceFile(paths.projectConfig, doc.toString());
}

/**
 * Sets what a project states about itself, then reads it back. A change naming
 * no key writes nothing. The read is what every call answers with, so a rename
 * of a project whose folder is gone still reports `path-missing`.
 */
export async function updateProject(options: ProjectOptions, change: ProjectChange): Promise<ProjectInfo> {
  const keys = checkedKeys(change, PROJECT_WRITABLE, "is not a field of a project a write sets");
  if (keys.length > 0) {
    const paths = projectPaths(options);
    await checkedProjectsDirectory(options.root);
    await openProjectDirectory(paths);
    await writeDeclaration(options, paths, change);
  }
  return readProject(options);
}

/**
 * Deletes a project directory and everything in it: its file, its state and its
 * tasks. Nothing guards what it holds, and the folder the project stands for is
 * left alone.
 *
 * The two directory checks keep the recursive delete inside the root the caller
 * named: a symbolic link at either level is refused rather than followed out of
 * the tree. Each checks a name, not a handle the delete then reuses, so a link
 * put there afterwards is walked.
 */
export async function removeProject(options: ProjectOptions): Promise<void> {
  const paths = projectPaths(options);
  await checkedProjectsDirectory(options.root);
  await checkProjectDirectory(paths);
  await removeTree(paths.directory);
}
