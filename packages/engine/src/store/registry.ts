import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { Document, parseDocument } from "yaml";
import { anchorIsRead, anchorsOf, type UnaddressableKey, unaddressableKey } from "../format/anchors.js";
import { isPlainMapping } from "../format/values.js";
import {
  createExclusive,
  createExclusiveDirectory,
  makeDirectory,
  readRegularFile,
  removeTree,
  replaceFile,
} from "./atomic.js";
import { resolveProjectDeclaration } from "./config.js";
import { errnoOf, fail } from "./errors.js";
import { checkedDirectoryPath, type ProjectPaths, projectPaths } from "./paths.js";
import { checkedProjectsDirectory, discoverProjects } from "./projects.js";
import { checkProjectDirectory, openProjectDirectory } from "./store.js";
import { checkedTag, generateTag, uniqueTag } from "./tag.js";
import { checkedKeys } from "./validate.js";
import type {
  CreateProjectInput,
  ProjectChange,
  ProjectInfo,
  ProjectOptions,
  StoreDiagnostic,
} from "./types.js";

/** The fields of a project one write sets. `tag` is not among them. */
const PROJECT_WRITABLE = new Set(["name", "path"]);

/** The keys a create states: the fields it writes, and the tree it writes them in. */
const CREATE_KEYS = new Set(["root", "path", "name", "tag"]);

/** What a refusal states about a file whose key no write reaches by its name. */
const UNADDRESSABLE: Record<UnaddressableKey, string> = {
  "merge-key": "the file resolves a YAML merge key, so a key of it cannot be written",
  "key-unaddressable": "the file carries a key written as an alias, so a key of it cannot be written",
};

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

/**
 * The project's own file as a document this layer can write back, or an empty
 * one where the file is absent, which is how a directory a hand created takes
 * its first key.
 *
 * A symbolic link is refused although the reader follows one on purpose: this
 * write installs the new text by rename, which would replace the link with a
 * plain file and leave the linked file stale. A file the parser refuses is
 * refused for the same reason — the rename would take it with it.
 */
async function openDeclaration(paths: ProjectPaths): Promise<Document> {
  const read = await readRegularFile(paths.projectConfig);
  if (read === "absent") return new Document({});
  if (read === "irregular") {
    fail("config-invalid", "this name holds no regular file this layer can write", paths.projectConfig);
  }
  const doc = parseDocument(read.text);
  if (doc.errors.length > 0) fail("config-invalid", "the file is not valid YAML", paths.projectConfig);
  // Both tests are needed. The node says whether the document holds anything at
  // all: a file holding nothing, or nothing but comments, carries none and takes
  // its first key. The value it resolves to says whether a write reaches a key:
  // an explicit null and a `!!set` each carry a node no key can be set on, and
  // both resolve to something `isPlainMapping` refuses.
  if (doc.contents !== null && !isPlainMapping(resolvedValue(doc, paths.projectConfig))) {
    fail("config-invalid", "the file must hold a YAML mapping", paths.projectConfig);
  }
  // The reader resolves a name such a file gives while no key of it carries that
  // text, so a write here would state the key a second time, or take nothing
  // away and report that it did.
  const unaddressable = unaddressableKey(doc);
  if (unaddressable !== undefined) fail("config-invalid", UNADDRESSABLE[unaddressable], paths.projectConfig);
  return doc;
}

/**
 * The value a document resolves to. An alias reading an anchor the file never
 * sets is accepted by the parser and resolved by nothing, so the fault it raises
 * is about the file rather than about this call — the shape `readLevel` answers
 * a parse fault of the same file in.
 */
function resolvedValue(doc: Document, filename: string): unknown {
  try {
    return doc.toJS();
  } catch (error) {
    fail("config-invalid", "this file holds an alias that resolves to no anchor", filename, error);
  }
}

/**
 * Refuses a key whose write would change a value the change never named. An
 * anchor another value of the file reads stands on the node a write replaces, so
 * setting the key rewrites what those aliases read and clearing it leaves them
 * resolving to nothing. It is the condition the task writer refuses as
 * `anchor-aliased`.
 */
function checkAnchor(doc: Document, key: string, removing: boolean, filename: string): void {
  if (!anchorIsRead(doc, key, anchorsOf(doc), removing)) return;
  const description = `the key "${key}" carries a YAML anchor another value points at, so it cannot be changed`;
  fail("config-invalid", description, filename);
}

/** The value of a key that clears its field: none at all, or `null`. */
function cleared(value: unknown): boolean {
  return value === undefined || value === null;
}

/** Sets the keys of one change, leaving every other key and every comment of the file alone. */
async function writeDeclaration(paths: ProjectPaths, change: ProjectChange): Promise<void> {
  const statesName = Object.hasOwn(change, "name");
  const statesPath = Object.hasOwn(change, "path");
  const clearsName = statesName && cleared(change.name);
  if (statesPath && cleared(change.path)) {
    fail("field-required", '"path" is a field every project states, so it cannot be cleared');
  }
  const name = statesName && !clearsName ? checkedName(change.name) : undefined;
  const path = statesPath ? await checkedPath(change.path) : undefined;

  const doc = await openDeclaration(paths);
  let written = false;
  // A document that holds no collection — an empty file, or one carrying nothing
  // but comments — has no key to take away, and `delete` refuses it outright.
  if (clearsName && doc.contents !== null) {
    checkAnchor(doc, "name", true, paths.projectConfig);
    written = doc.delete("name");
  }
  if (name !== undefined) {
    checkAnchor(doc, "name", false, paths.projectConfig);
    doc.set("name", name);
    written = true;
  }
  if (path !== undefined) {
    checkAnchor(doc, "path", false, paths.projectConfig);
    doc.set("path", path);
    written = true;
  }
  // A change that took no key off the file and put none on it leaves the file as
  // it stands, and installs none where a hand-made project never had one.
  if (!written) return;
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
    await writeDeclaration(paths, change);
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
