// A project and the configuration it resolved to.

export type Config = {
  statuses: string[];
  default_status: string;
  priorities: string[];
  /** The workflows a task of this project may name. Empty when the project declares none. */
  workflows: string[];
  /** The documents that apply to every task of this project, as resolved absolute paths. */
  instructions: string[];
};

export type Project = {
  /** The project tag, which is also the name of its directory and its path segment on every route. */
  tag: string;
  config: Config;
};
