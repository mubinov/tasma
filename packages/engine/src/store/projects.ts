import { readdir } from "node:fs/promises";
import { entryAt } from "./atomic.js";
import { resolveProjectDeclaration } from "./config.js";
import { errnoOf, fail } from "./errors.js";
import { projectPaths, projectsDir, TAG_PATTERN } from "./paths.js";
import { openProjectDirectory } from "./store.js";
import type { ProjectDeclaration, ProjectOptions } from "./types.js";

/**
 * Every project of a tree, by tag, ascending.
 *
 * A project is a directory whose name is a tag, and nothing more: no
 * configuration file is required, so a directory a hand created is a project the
 * moment it exists. A `Dirent` reports the type of the entry itself, so a
 * symbolic link answers `isSymbolicLink()` and is dropped by the same test that
 * keeps a directory — the rule `openProjectDirectory` states, where a link is
 * refused as `project-invalid`.
 *
 * Nothing is reported about the entries left out. The answer states which
 * projects the tree holds, and a name that is no tag is not an anomaly of a
 * project but a directory that belongs to somebody else.
 *
 * A missing `projects/` is an empty tree rather than a fault, the rule
 * `scanTasks` applies to a missing `tasks/`: the directory is engine storage.
 * Every other fault of the read is thrown.
 *
 * The name itself is refused when a symbolic link holds it, the rule every
 * directory below it stands under: a link there takes every project of the tree
 * outside the root the caller named, and each entry it answers with really is a
 * directory at the target, so no check below this one can see it.
 */
export async function discoverProjects(root?: string): Promise<string[]> {
  const directory = projectsDir(root);
  if ((await entryAt(directory))?.isSymbolicLink() === true) {
    fail("project-invalid", "the projects directory of this tree is a symbolic link", directory);
  }
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return [];
    throw error;
  }
  const kept = entries.filter((entry) => entry.isDirectory() && TAG_PATTERN.test(entry.name));
  return kept.map((entry) => entry.name).sort();
}

/**
 * What one project of a tree states about itself, which is the read a listing
 * makes per project it discovered. Only the project's own file is read, because
 * only it can state either key.
 *
 * The project directory is checked first, the way every other operation checks
 * it, so a directory that a symbolic link replaced between the discovery and
 * this read is refused rather than followed out of the tree.
 */
export async function readProjectDeclaration(options: ProjectOptions): Promise<ProjectDeclaration> {
  const paths = projectPaths(options);
  await openProjectDirectory(paths);
  return resolveProjectDeclaration(paths);
}
