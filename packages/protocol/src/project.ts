// A project and the configuration it resolved to.

export type Config = {
  statuses: string[];
  default_status: string;
  /**
   * The statuses that end a task, always present: the last of `statuses` when no
   * configuration file states the key. It is what decides whether a blocker
   * still blocks.
   */
  final_statuses: string[];
  priorities: string[];
  /** The workflows a task of this project may name. Empty when the project declares none. */
  workflows: string[];
  /** The documents that apply to every task of this project, as resolved absolute paths. */
  instructions: string[];
  /**
   * The workflows directory the user named, as a resolved absolute path, and
   * absent when no file named one. It is user-level alone: the workflows tree is
   * one shared thing per machine.
   */
  workflows_path?: string;
};

/** One project of a listing: what identifies it, and what it calls itself. */
export type ProjectSummary = {
  /** The project tag, which is also the name of its directory and its path segment on every route. */
  tag: string;
  /** The project's display name. Absent when it declares none, or when its configuration cannot be read. */
  name?: string;
  /** The project's repository, as a resolved absolute path. Absent under the same two conditions as the name. */
  path?: string;
};

/**
 * What a create states. `path` is the repository the project stands for,
 * absolute or starting with `~/`; `name` defaults to the last folder name of the
 * path it resolves to. `tag` is used as given when present, and generated from
 * the same folder name otherwise.
 */
export type ProjectInput = { path: string; name?: string; tag?: string };

/**
 * One change of a project. A key present with `null` clears the field and an
 * absent key leaves it alone, so `{ name: null }` deletes the name and the
 * reader falls back to the tag. `path` cannot be cleared: every project states
 * one. `tag` is no field here.
 */
export type ProjectChange = { name?: string | null; path?: string };

/**
 * The whole body of a rename: the tag the project takes. It follows the rule a
 * create applies, and a tag already taken is refused rather than numbered, so a
 * caller is never given a tag it did not ask for. The answer is the project
 * under its new tag, which is how a caller holding the old one learns it.
 */
export type ProjectRename = { tag: string };

export type Project = ProjectSummary & {
  config: Config;
  /**
   * False when the index stopped following the disk, so what a listing of this
   * project answers may be older than the files under it. A read of the project
   * repairs the index, so the field states whether the repair worked.
   */
  live: boolean;
};
