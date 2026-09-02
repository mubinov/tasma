// A project and the configuration it resolved to.

export type Config = {
  statuses: string[];
  default_status: string;
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

export type Project = ProjectSummary & {
  config: Config;
  /**
   * False when the index stopped following the disk, so what a listing of this
   * project answers may be older than the files under it. A read of the project
   * repairs the index, so the field states whether the repair worked.
   */
  live: boolean;
};
