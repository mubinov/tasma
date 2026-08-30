import { parse } from "yaml";
import { isPlainMapping } from "../format/values.js";
import { readRegularFile } from "./atomic.js";
import { fail } from "./errors.js";
import type { ProjectPaths } from "./paths.js";
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
 */
const USER_KEYS = new Set(ENGINE_KEYS);
const PROJECT_KEYS = new Set([...ENGINE_KEYS, "name", "path"]);

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

/**
 * A declared list of statuses or priorities. An empty list is type-correct but
 * leaves no value any write could pass, so it is refused.
 */
function stringList(key: string, sourced: Sourced): string[] {
  const value = sourced.value;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    fail("config-invalid", `"${key}" must be a list of strings`, sourced.from);
  }
  if (value.length === 0) fail("config-invalid", `"${key}" must hold at least one entry`, sourced.from);
  return value;
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
  const statuses = declaredStatuses === undefined ? BUILT_IN_STATUSES : stringList("statuses", declaredStatuses);
  const declaredPriorities = pick("priorities", levels);
  const priorities
    = declaredPriorities === undefined ? BUILT_IN_PRIORITIES : stringList("priorities", declaredPriorities);

  const stated = pick("default_status", levels);
  if (stated === undefined) {
    // The first entry of the resolved list, which holds at least one.
    return { statuses, default_status: statuses[0]!, priorities };
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
  return { statuses, default_status: stated.value, priorities };
}
