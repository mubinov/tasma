// The user's configuration file, `~/.tasma/config.yml`, read on its own.

/**
 * One key of the user's configuration file: the value it takes, and whether the
 * file sets it (`true`) or the value is the built-in default (`false`).
 */
export type UserSetting<T> = { value: T; set: boolean };

/**
 * The user's configuration file, each key with the value a project that states
 * none takes. `workflows_path` is a resolved absolute path, the built-in
 * `<root>/workflows` where the file names none.
 */
export type UserConfig = {
  /** The absolute path of the file. */
  path: string;
  statuses: UserSetting<string[]>;
  default_status: UserSetting<string>;
  final_statuses: UserSetting<string[]>;
  priorities: UserSetting<string[]>;
  workflows_path: UserSetting<string>;
};

/**
 * One change of the user's configuration file. A key present with `null` clears
 * it, and the key then takes its built-in default; an absent key leaves it
 * alone. A list replaces the stored list. `workflows_path` is absolute or starts
 * with `~/`, names a directory, and is stored as given.
 *
 * The daemon checks the result before it writes, and a change it refuses writes
 * nothing: `default_status` and each final status must be among the statuses of
 * the file on its own, the change must not break a project that resolves today,
 * and each workflow a project lists must load from a new `workflows_path`.
 */
export type UserConfigChange = {
  statuses?: string[] | null;
  default_status?: string | null;
  final_statuses?: string[] | null;
  priorities?: string[] | null;
  workflows_path?: string | null;
};
