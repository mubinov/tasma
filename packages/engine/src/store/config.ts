import { dirname } from "node:path";
import { parse } from "yaml";
import { isPlainMapping, isStringList } from "../format/values.js";
import { readRegularFile } from "./atomic.js";
import { fail } from "./errors.js";
import { type ProjectPaths, resolveAgainst } from "./paths.js";
import type { ResolvedConfig, StoreDiagnostic } from "./types.js";

/**
 * The lists the engine uses when no file declares them. A default is a per-key
 * fallback, not a third level of configuration.
 */
const BUILT_IN_STATUSES = ["Backlog", "To Do", "In Progress", "Done"];
const BUILT_IN_PRIORITIES = ["high", "medium", "low"];

const ENGINE_KEYS = ["statuses", "default_status", "priorities"];

/**
 * The keys each level recognizes, whether or not this layer reads them; a later
 * component adds its own here. A key outside the set is reported, which is what
 * catches a key the user misspelled.
 *
 * `workflows` and `instructions` are project-level alone, the same class as
 * `name` and `path`: a workflow is selected per project, and an instruction
 * document a user file stated would apply to every project of the machine with
 * no way to say which one it describes.
 */
const USER_KEYS = new Set(ENGINE_KEYS);
const PROJECT_KEYS = new Set([...ENGINE_KEYS, "name", "path", "workflows", "instructions"]);

/** The name a message gives the level a value came from. */
const BUILT_IN = "the built-in defaults";

/** The recognized keys one configuration file declares. */
type Level = { path: string; values: Record<string, unknown> };

/** One resolved value with the file it came from, or the built-in defaults. */
type Sourced = { value: unknown; from: string };

/**
 * Reads one level. An absent file declares no keys; a file the engine cannot
 * read throws, because configuration is human intent and guessing at it means
 * validating writes against a list the user did not choose. A symbolic link is
 * followed here alone: the user places both configuration files, and this layer
 * writes neither.
 */
async function readLevel(path: string, known: Set<string>, diagnostics: StoreDiagnostic[]): Promise<Level> {
  const read = await readRegularFile(path, true);
  if (read === "absent") return { path, values: {} };
  if (read === "irregular") fail("config-invalid", "this name holds no regular file", path);
  let content: unknown;
  try {
    content = parse(read.text);
  } catch (error) {
    // The position alone, never the message of the parser: `yaml` appends a
    // frame of the source lines it failed on, and this read follows a link
    // anywhere. A fault it reports no position for leaves the file name alone.
    const at = (error as { linePos?: { line: number }[] }).linePos?.[0];
    fail("config-invalid", `the file is not valid YAML${at === undefined ? "" : ` at line ${at.line}`}`, path);
  }
  // A file that holds nothing, or nothing but YAML comments, declares no key.
  if (content === null || content === undefined) return { path, values: {} };
  // A plain mapping, not merely an object: a YAML tag resolves to a `Set`, a
  // `Map` or a `Date`, none of which reports its content as entries.
  if (!isPlainMapping(content)) fail("config-invalid", "the file must hold a YAML mapping", path);
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(content)) {
    if (known.has(key)) values[key] = value;
    else {
      diagnostics.push({
        code: "config-key-unknown",
        message: `"${key}" is not a configuration key this engine knows, so its value is not read`,
        path,
      });
    }
  }
  return { path, values };
}

/**
 * The value of one key, from the first level that declares it. A key written
 * with no value is read as absent, the way the task file format reads one.
 */
function pick(key: string, levels: Level[]): Sourced | undefined {
  for (const level of levels) {
    const value = level.values[key];
    if (value !== undefined && value !== null) return { value, from: level.path };
  }
  return undefined;
}

/** A declared list of strings. An empty list is a statement about the key, not a fault. */
function stringList(key: string, sourced: Sourced): string[] {
  const value = sourced.value;
  if (!isStringList(value)) fail("config-invalid", `"${key}" must be a list of strings`, sourced.from);
  return value;
}

/**
 * The same for statuses and priorities, where an empty list is type-correct but
 * leaves no value any write could pass, so it is refused.
 */
function nonEmptyStringList(key: string, sourced: Sourced): string[] {
  const value = stringList(key, sourced);
  if (value.length === 0) fail("config-invalid", `"${key}" must hold at least one entry`, sourced.from);
  return value;
}

/**
 * A list of strings a project declares, empty when it declares none. An empty
 * list means what an absent key means: a project that runs no workflow and
 * carries no instruction document is an ordinary project.
 */
function declaredList(key: string, levels: Level[]): string[] {
  const sourced = pick(key, levels);
  return sourced === undefined ? [] : stringList(key, sourced);
}

/**
 * The same, as paths against the directory holding the file that stated them,
 * which is the rule the format states for every path a user file carries. The
 * level is read from the value rather than assumed, so a key that later joins a
 * second level resolves against its own file.
 */
function declaredPaths(key: string, levels: Level[]): string[] {
  const sourced = pick(key, levels);
  if (sourced === undefined) return [];
  const base = dirname(sourced.from);
  return stringList(key, sourced).map((entry) => resolveAgainst(base, entry));
}

/**
 * The configuration of one project: per key, the project value, else the user
 * value, else the built-in fallback. Nothing is merged, because merging two
 * ordered lists has no correct answer, and nothing is cached, because a hand
 * edit would leave a cached list stale with nothing to invalidate it.
 */
export async function resolveConfig(paths: ProjectPaths, diagnostics: StoreDiagnostic[]): Promise<ResolvedConfig> {
  const levels = [
    await readLevel(paths.projectConfig, PROJECT_KEYS, diagnostics),
    await readLevel(paths.userConfig, USER_KEYS, diagnostics),
  ];

  const declaredStatuses = pick("statuses", levels);
  const statuses
    = declaredStatuses === undefined ? BUILT_IN_STATUSES : nonEmptyStringList("statuses", declaredStatuses);
  const declaredPriorities = pick("priorities", levels);
  const priorities
    = declaredPriorities === undefined ? BUILT_IN_PRIORITIES : nonEmptyStringList("priorities", declaredPriorities);

  const workflows = declaredList("workflows", levels);
  const instructions = declaredPaths("instructions", levels);

  const stated = pick("default_status", levels);
  if (stated === undefined) {
    // The first entry of the resolved list, which holds at least one.
    return { statuses, default_status: statuses[0]!, priorities, workflows, instructions };
  }
  if (typeof stated.value !== "string") fail("config-invalid", '"default_status" must be a string', stated.from);
  // The check runs on the resolved pair rather than on one file: the two halves
  // can come from different levels, and a per-file check would accept a pair
  // that leaves every create writing an undeclared status.
  if (!statuses.includes(stated.value)) {
    const source = declaredStatuses === undefined ? BUILT_IN : declaredStatuses.from;
    fail(
      "config-invalid",
      `default_status "${stated.value}" is not one of the statuses declared in ${source}`,
      stated.from,
    );
  }
  return { statuses, default_status: stated.value, priorities, workflows, instructions };
}
