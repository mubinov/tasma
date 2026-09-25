import { dirname } from "node:path";
import { parse } from "yaml";
import { isPlainMapping, isStringList } from "../format/values.js";
import { readRegularFile } from "./atomic.js";
import { fail } from "./errors.js";
import { type ProjectPaths, resolveAgainst } from "./paths.js";
import type { ProjectDeclaration, ResolvedConfig, StoreDiagnostic } from "./types.js";

/**
 * The lists the engine uses when no file declares them. A default is a per-key
 * fallback, not a third level of configuration.
 */
const BUILT_IN_STATUSES = ["Backlog", "To Do", "In Progress", "Done"];
const BUILT_IN_PRIORITIES = ["high", "medium", "low"];

const ENGINE_KEYS = ["statuses", "default_status", "priorities", "final_statuses"];

/**
 * The keys each level recognizes, whether or not this layer reads them; a later
 * component adds its own here. A key outside the set is reported, which is what
 * catches a key the user misspelled.
 *
 * `workflows` and `instructions` are project-level alone, the same class as
 * `name` and `path`: a workflow is selected per project, and an instruction
 * document a user file stated would apply to every project of the machine with
 * no way to say which one it describes.
 *
 * `workflows_path` is user-level alone, for the converse reason: the workflows
 * tree is one shared thing per machine, and a project already chooses which of
 * its workflows its tasks may name through `workflows`.
 */
const USER_KEYS = new Set([...ENGINE_KEYS, "workflows_path"]);
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
 * followed here alone: the user places both configuration files, so a link on
 * one leads where the user pointed it.
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
  return levelOf(path, content, known, diagnostics);
}

/** The recognized keys of one mapping a file at `path` holds, reporting every other key. */
function levelOf(
  path: string,
  content: Record<string, unknown>,
  known: Set<string>,
  diagnostics: StoreDiagnostic[],
): Level {
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
 * The check both keys that name a status run: the value is one of the resolved
 * statuses, else the key is refused, naming the file that declared them.
 *
 * The check runs on the resolved pair rather than on one file, because the two
 * halves can come from different levels and a per-file check would accept a pair
 * that leaves every create writing an undeclared status. The comparison is exact
 * rather than case-insensitive: these are the strings the user declared, so a
 * near miss is a typing error rather than a spelling the engine may correct.
 *
 * Both parameters that name a file are read for a message alone: `from` is the
 * file that stated the checked value, `declaredStatuses` is read for the name of
 * the file behind `statuses` and for nothing else.
 *
 * A conflict that involves a key of a write is the fault of that write; any
 * other is a fault of the files on disk.
 */
function checkDeclaredStatus(
  key: string,
  value: string,
  statuses: string[],
  declaredStatuses: Sourced | undefined,
  from: string,
  changed: ReadonlySet<string>,
): void {
  if (statuses.includes(value)) return;
  const source = declaredStatuses === undefined ? BUILT_IN : declaredStatuses.from;
  const code = changed.has(key) || changed.has("statuses") ? "config-change-invalid" : "config-invalid";
  fail(code, `${key} "${value}" is not one of the statuses declared in ${source}`, from);
}

/**
 * The statuses that end a task, from the first level that states them, and the
 * last of the resolved statuses when no level does. Nothing downstream needs to
 * know which of the two it got, so the default is applied here rather than left
 * to a caller.
 *
 * The empty list is refused rather than read as a statement about the key: it
 * would mean no status ever ends a task, so every open blocker would block
 * forever — the reasoning that already refuses an empty `statuses`.
 */
function resolveFinalStatuses(
  levels: Level[],
  statuses: string[],
  declaredStatuses: Sourced | undefined,
  changed: ReadonlySet<string>,
): string[] {
  const stated = pick("final_statuses", levels);
  // The resolved list holds at least one entry, so its last one is a status.
  if (stated === undefined) return [statuses.at(-1)!];
  const final = nonEmptyStringList("final_statuses", stated);
  for (const entry of final) {
    checkDeclaredStatus("final_statuses", entry, statuses, declaredStatuses, stated.from, changed);
  }
  return final;
}

type StatusAndPriorityConfig = Pick<ResolvedConfig, "statuses" | "default_status" | "final_statuses" | "priorities">;

/**
 * The statuses and the priorities the levels resolve to, under every rule the
 * reader applies to them. `changed` names the keys a write sets or clears, and
 * decides which code a conflict is refused with; a read passes none.
 *
 * A type fault is always `config-invalid`: a write checks every value it gives
 * before this runs, so a value that fails here came from a file on disk.
 */
function resolveStatusesAndPriorities(levels: Level[], changed: ReadonlySet<string>): StatusAndPriorityConfig {
  const declaredStatuses = pick("statuses", levels);
  const statuses
    = declaredStatuses === undefined ? BUILT_IN_STATUSES : nonEmptyStringList("statuses", declaredStatuses);
  const declaredPriorities = pick("priorities", levels);
  const priorities
    = declaredPriorities === undefined ? BUILT_IN_PRIORITIES : nonEmptyStringList("priorities", declaredPriorities);
  const finalStatuses = resolveFinalStatuses(levels, statuses, declaredStatuses, changed);

  const stated = pick("default_status", levels);
  // The first entry of the resolved list, which holds at least one.
  if (stated === undefined) {
    return { statuses, default_status: statuses[0]!, final_statuses: finalStatuses, priorities };
  }
  if (typeof stated.value !== "string") fail("config-invalid", '"default_status" must be a string', stated.from);
  checkDeclaredStatus("default_status", stated.value, statuses, declaredStatuses, stated.from, changed);
  return { statuses, default_status: stated.value, final_statuses: finalStatuses, priorities };
}

/**
 * Refuses a write of a project's own file whose statuses or priorities the
 * reader would refuse.
 * `values` is the whole mapping the file holds once the write is applied, and
 * the user's file is read as it stands, so a write can repair a broken project
 * file and a broken user value it hides does not refuse it.
 */
export async function checkStatusAndPriorityChange(
  paths: ProjectPaths,
  values: Record<string, unknown>,
  changed: ReadonlySet<string>,
): Promise<void> {
  const levels = [
    levelOf(paths.projectConfig, values, PROJECT_KEYS, []),
    await readLevel(paths.userConfig, USER_KEYS, []),
  ];
  resolveStatusesAndPriorities(levels, changed);
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
 * The check `declaredString` and `declaredPath` below share: a string, and never
 * the empty one. An empty value is type-correct and states nothing — an empty path
 * would resolve to the directory holding the file itself, and an empty name
 * would reach a reader as a blank label where an absent key reads as the tag.
 */
function stringValue(key: string, sourced: Sourced): string {
  const value = sourced.value;
  if (typeof value !== "string") fail("config-invalid", `"${key}" must be a string`, sourced.from);
  if (value === "") fail("config-invalid", `"${key}" must not be empty`, sourced.from);
  return value;
}

/** One string a file states, absent when no level states it. */
function declaredString(key: string, levels: Level[]): string | undefined {
  const sourced = pick(key, levels);
  return sourced === undefined ? undefined : stringValue(key, sourced);
}

/** One path a file states, resolved against the directory holding that file. */
function declaredPath(key: string, levels: Level[]): string | undefined {
  const sourced = pick(key, levels);
  if (sourced === undefined) return undefined;
  return resolveAgainst(dirname(sourced.from), stringValue(key, sourced));
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

  const resolved = resolveStatusesAndPriorities(levels, new Set());
  return {
    ...resolved,
    workflows: declaredList("workflows", levels),
    instructions: declaredPaths("instructions", levels),
    name: declaredString("name", levels),
    path: declaredPath("path", levels),
    // Left absent when no file named one, rather than defaulted here: whether the
    // directory was configured decides what the loader reports about it, and a
    // default applied at this layer would throw that away.
    workflows_path: declaredPath("workflows_path", levels),
  };
}

/**
 * What one project's own file states about the project itself, read on its own.
 * `name` and `path` are project-level alone, so a caller that needs nothing else
 * of the configuration asks the one file that can state them: the shared user
 * file contributes neither value, while reading it would refuse every project of
 * a tree over one malformed shared file and would cost a read of it per project.
 *
 * Where the findings of the read go is the caller's to decide: a finding about
 * one project's configuration belongs on that project's own resource, where it
 * names one file, and never in a listing of a whole tree.
 */
export async function resolveProjectDeclaration(
  paths: ProjectPaths,
  diagnostics: StoreDiagnostic[],
): Promise<ProjectDeclaration> {
  const levels = [await readLevel(paths.projectConfig, PROJECT_KEYS, diagnostics)];
  return { name: declaredString("name", levels), path: declaredPath("path", levels) };
}

/**
 * The workflows directory the user's file names, read on its own. `workflows_path`
 * is user-level alone, so a caller that needs nothing else of the configuration
 * asks the one file that can state it: a project file this engine cannot read
 * says nothing about where the workflows tree stands, and resolving both levels
 * would let it move a read onto the wrong tree.
 *
 * Where the findings of the read go is the caller's to decide: a caller
 * reporting on one task drops them, since a finding about the shared file would
 * otherwise arrive once per task read, while a caller whose whole subject is
 * that file carries them.
 *
 * It takes the path of that file rather than a project's paths, because the
 * workflows tree is one shared thing per machine and a caller with no project in
 * scope resolves it too.
 */
export async function resolveWorkflowsPath(
  userConfig: string,
  diagnostics: StoreDiagnostic[],
): Promise<string | undefined> {
  return declaredPath("workflows_path", [await readLevel(userConfig, USER_KEYS, diagnostics)]);
}
