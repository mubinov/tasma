import type { Frontmatter } from "../format/index.js";
// A public name of the store layer comes from the barrel the package publishes;
// a name it does not export comes from the file that holds it.
import type { Project, StoreDiagnostic } from "../store/index.js";

export type IndexOptions = {
  /**
   * Every anomaly the index observes, from the first build onward. The watcher
   * is the first source in this engine with no call to return a finding from, so
   * a finding is handed over as it occurs rather than held for the next query.
   * What the listener throws is caught and dropped, and nothing reaches it once
   * `close()` has returned.
   *
   * `message` is the index's own text: whatever it quotes of a file, or of a
   * fault raised over one, is cut to a length the index chose and stripped of
   * the characters that drive a terminal.
   *
   * `path` is the path the file stands under, so a listener can open what a
   * finding names. A path ends in a directory entry, which carries whatever name
   * its writer chose, so a listener that renders one bounds its length and
   * strips what would drive a terminal — the same rule the paths of the
   * diagnostics a store call returns stand under.
   */
  onDiagnostic?: (diagnostic: StoreDiagnostic) => void;
};

/**
 * One task as the index holds it: the frontmatter alone, never the body.
 *
 * `id` and `frontmatter.id` are equal by construction — a file whose id
 * disagrees with its name is excluded rather than indexed — and both are kept,
 * because `id` is the key a caller hands back to the store while
 * `frontmatter.id` is what the file states.
 *
 * The entry and its frontmatter are frozen: a query hands out the values the
 * index holds rather than a copy of them.
 */
export type IndexEntry = {
  id: string;
  path: string;
  frontmatter: Frontmatter;
};

/** Why a file named as a task file of this project holds no entry. */
export type ExclusionCode
  = | "task-file-unreadable"
    | "task-file-foreign"
    | "task-file-misnamed";

export type ExcludedFile = {
  path: string;
  code: ExclusionCode;
  message: string;
};

/**
 * Every task the index holds, and the files that failed to become one.
 *
 * An excluded file has no entry and can never match a filter, so it is not a
 * missing result but a caveat on the completeness of this one, and it arrives
 * with the answer it qualifies. It is a lower bound on what is wrong in the
 * project, never a complete one: a fault under the frontmatter is invisible to
 * the index and appears only when `readTask` parses the whole file.
 *
 * `entries` is ordered by file number ascending and `excluded` by path
 * ascending. Ordering by `order`, and the column order of a board, belong to the
 * caller.
 */
export type QueryResult = {
  entries: IndexEntry[];
  excluded: ExcludedFile[];
};

/**
 * A project whose frontmatter is held in memory. It is a `Project`, so a write
 * made through it updates the index before the call returns and the next query
 * sees it; a caller that keeps the bare `Project` takes the path the watcher
 * covers instead.
 */
export type IndexedProject = Project & {
  query(): QueryResult;
  rescan(): Promise<void>;
  close(): Promise<void>;
};
