// The project of the tree that holds a directory. Every other call reads a
// project's path forwards, from the project to the folder it stands for; this
// one reads it backwards, so a caller standing somewhere on the disk learns
// which project it is in.

import { realpath } from "node:fs/promises";
import { sep } from "node:path";
import { causeOf, pathOf, TaskStoreError } from "./errors.js";
import { checkedDirectoryPath } from "./paths.js";
import { discoverProjects, readProjectDeclaration } from "./projects.js";
import type { ProjectDeclaration, StoreDiagnostic } from "./types.js";

/**
 * How many projects one resolution reads the declaration of at a time. A tree
 * holds however many projects a user made, and an unbounded read would hold a
 * descriptor per project.
 */
const READ_LIMIT = 8;

/** One project as a resolution answers with it: what it declares, under its tag. */
export type LocatedProject = { tag: string } & ProjectDeclaration;

export type LocateResult = {
  /** Absent where no project of the tree holds the directory, which is an answer rather than a fault. */
  project?: LocatedProject;
  diagnostics: StoreDiagnostic[];
};

/** One project the comparison keeps, and the canonical path it is compared by. */
type Candidate = { project: LocatedProject; canonicalPath: string };

/** What the comparison read of the tree: one entry per project, in the tree's order. */
type Read = { candidates: (Candidate | undefined)[]; findings: (StoreDiagnostic | undefined)[] };

/**
 * The path with every symbolic link above it resolved, or the path as it stands
 * where it cannot be resolved.
 *
 * The fallback cannot produce a wrong answer. A project whose folder does not
 * resolve holds no directory anybody can be standing in, and a project that
 * holds the stated directory resolves by definition, since the directory itself
 * does. So both sides of every real match are canonical, and the fallback only
 * ever keeps a project that was never going to match comparable by its declared
 * text.
 */
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * Whether a project standing at `path` holds `directory`. The separator is what
 * makes the prefix a segment boundary, so a project does not hold a directory
 * whose name merely begins with its own.
 */
function holds(path: string, directory: string): boolean {
  if (directory === path) return true;
  return directory.startsWith(path.endsWith(sep) ? path : `${path}${sep}`);
}

/**
 * The finding a project the comparison could not read adds. A file the read
 * refused parsed and was rejected; one it could not open never reached the
 * parser, and a reader looking at the message has to know which of the two
 * happened.
 *
 * The path is the one the fault itself names, the way `openWorkflowsForRead`
 * forwards its own. The read checks the project's directory and its `tasks/` as
 * well as the file, so naming `config.yml` for every fault would point at a file
 * that is perfectly healthy.
 */
function unreadable(tag: string, error: unknown): StoreDiagnostic {
  const reason = error instanceof TaskStoreError ? "was refused" : "could not be read";
  return {
    code: "config-unreadable",
    message: `project ${tag} ${reason}, so it was left out of the comparison: ${causeOf(error)}`,
    path: pathOf(error),
  };
}

/**
 * What every project of the tree declares, as many at a time as the read limit
 * allows. The workers share one iterator, so what is in flight is bounded by how
 * many of them there are rather than by how many projects the tree holds.
 *
 * Both arrays are written by the position of their project in the discovered
 * order, not pushed as each read finishes, so the answer carries its findings in
 * the tree's order however the parallel reads interleave.
 */
async function readAll(tags: string[], root: string | undefined): Promise<Read> {
  const candidates: (Candidate | undefined)[] = [];
  const findings: (StoreDiagnostic | undefined)[] = [];
  const pending = tags.entries();
  const workers = Array.from({ length: READ_LIMIT }, async () => {
    for (const [at, tag] of pending) {
      try {
        const declaration = await readProjectDeclaration({ project: tag, root });
        // A project declaring no path stands for no folder, so it holds nothing.
        if (declaration.path === undefined) continue;
        candidates[at] = { project: { tag, ...declaration }, canonicalPath: await canonical(declaration.path) };
      } catch (error) {
        findings[at] = unreadable(tag, error);
      }
    }
  });
  await Promise.all(workers);
  return { candidates, findings };
}

/**
 * The project of the tree that holds `directory`, with the findings of the
 * comparison. The tree is read per call and nothing is held, so a project
 * registered a moment ago is seen by the next one.
 *
 * Among the projects that hold the directory the longest path answers, so a
 * project nested inside another resolves to the inner one, and two projects
 * declaring one path are answered by the lower tag — both answers are correct,
 * and the rule only has to be the same every time it is asked.
 *
 * The directory must be there, which is what makes the canonicalization sound.
 * `realpath` resolves no path whose last component is absent, so a directory
 * that stands for nothing would be compared as plain text while every project
 * path around it had been canonicalized, and under a symbolic link above them
 * the two sides would then sit in different trees.
 *
 * The case a path is spelled in is kept: on Linux and on a case-sensitive
 * volume two spellings are two directories, so folding it would answer with a
 * project that holds neither.
 */
export async function locateProject(directory: string, root?: string): Promise<LocateResult> {
  const resolved = await canonical(await checkedDirectoryPath(directory, "a directory"));
  const { candidates, findings } = await readAll(await discoverProjects(root), root);

  let innermost: Candidate | undefined;
  for (const candidate of candidates) {
    if (candidate === undefined || !holds(candidate.canonicalPath, resolved)) continue;
    if (innermost === undefined || candidate.canonicalPath.length > innermost.canonicalPath.length) {
      innermost = candidate;
    }
  }
  return { project: innermost?.project, diagnostics: findings.filter((finding) => finding !== undefined) };
}
