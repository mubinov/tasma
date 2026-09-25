import { openWorkflows } from "../workflow/index.js";
import { makeDirectory, replaceFile } from "./atomic.js";
import {
  checkStatusAndPriorityChange,
  checkUserConfigChange,
  declaredWorkflows,
  declaredWorkflowsPath,
  type Level,
  readDeclared,
  resolveUserConfig,
  STATUS_AND_PRIORITY_KEYS,
} from "./config.js";
import {
  appliedValues,
  applyWrites,
  checkAnchor,
  checkedDefaultStatus,
  checkedList,
  cleared,
  openDeclaration,
  storedValues,
} from "./declaration.js";
import { asStoreRefusal, errnoOf, fail, TaskStoreError } from "./errors.js";
import { checkedDirectoryPath, expandRoot, projectPaths, userConfigPath } from "./paths.js";
import { discoverProjects } from "./projects.js";
import type { StoreDiagnostic, UserConfigChange, UserConfigInfo } from "./types.js";
import { checkedKeys } from "./validate.js";
import { openWorkflowsForRead, readDeclaredWorkflow } from "./workflow.js";

/**
 * The keys of a project file that a write of the user's file checks. A write of
 * the project file that states one checks it against the user's file in turn.
 */
export const USER_CONFIG_LINKED_KEYS: ReadonlySet<string> = new Set([...STATUS_AND_PRIORITY_KEYS, "workflows"]);

/** One project of the tree, with the level its own file declares. */
type ProjectLevel = { tag: string; level: Level };

/**
 * The user's configuration file of a tree, read on its own: each key with the
 * value it takes and whether the file sets it. A file the reader refuses is
 * refused here too.
 */
export async function readUserConfig(root?: string): Promise<UserConfigInfo> {
  const expanded = expandRoot(root);
  const path = userConfigPath(expanded);
  const diagnostics: StoreDiagnostic[] = [];
  const settings = await resolveUserConfig(path, expanded, diagnostics);
  return { path, ...settings, diagnostics };
}

/**
 * The workflows directory a caller stated, stored as given. A relative value is
 * refused by the path check: the reader would resolve it against the root,
 * which is not what a caller means.
 */
async function checkedWorkflowsPath(stated: unknown): Promise<string> {
  if (typeof stated !== "string" || stated === "") {
    fail("config-change-invalid", '"workflows_path" must be a string that is not empty');
  }
  await checkedDirectoryPath(stated, "workflows_path");
  return stated;
}

/** The check of the value each writable key of the user's file sets, on its own. */
const VALUE_CHECKS: { [Key in keyof UserConfigChange]-?: (stated: unknown) => unknown } = {
  statuses: (stated) => checkedList("statuses", stated, false),
  default_status: checkedDefaultStatus,
  final_statuses: (stated) => checkedList("final_statuses", stated, false),
  priorities: (stated) => checkedList("priorities", stated, false),
  workflows_path: checkedWorkflowsPath,
};

const USER_WRITABLE = new Set(Object.keys(VALUE_CHECKS));

/**
 * The level each project of the tree declares. A project whose file the reader
 * refuses or the process cannot open is left out: it does not work today, so no
 * change can break it.
 */
async function readableProjects(root: string): Promise<ProjectLevel[]> {
  const projects: ProjectLevel[] = [];
  for (const tag of await discoverProjects(root)) {
    try {
      projects.push({ tag, level: await readDeclared(projectPaths({ project: tag, root }).projectConfig, "project") });
    } catch (error) {
      if (!(error instanceof TaskStoreError) && errnoOf(error) === undefined) throw error;
    }
  }
  return projects;
}

/** Whether `check` passes, where a store refusal is a failure rather than a fault. */
async function passes(check: () => unknown): Promise<boolean> {
  try {
    await check();
    return true;
  } catch (error) {
    asStoreRefusal(error);
    return false;
  }
}

/**
 * Refuses a change that breaks the statuses or the priorities of a project that
 * resolves today. A project that fails with the current user file is passed
 * over, so a change that repairs the user file is not held back by the
 * projects that inherit the broken value.
 */
async function checkProjects(
  projects: ProjectLevel[],
  current: Level,
  next: Level,
  changed: ReadonlySet<string>,
): Promise<void> {
  for (const { tag, level } of projects) {
    if (!(await passes(() => checkStatusAndPriorityChange([level, current], new Set())))) continue;
    try {
      checkStatusAndPriorityChange([level, next], changed);
    } catch (error) {
      const fault = asStoreRefusal(error);
      fail("config-change-invalid", `project ${tag}: ${fault.description}`, fault.path, fault);
    }
  }
}

/**
 * Refuses a new workflows directory from which a workflow a project lists does
 * not load, where it loads from the current one. A workflow that does not load
 * today is passed over, and a stored directory the reader refuses leaves the
 * built-in one current, as it does for a read of a task.
 */
async function checkWorkflows(projects: ProjectLevel[], root: string, current: Level, next: Level): Promise<void> {
  const before = await openWorkflowsForRead(root, () => Promise.resolve(declaredWorkflowsPath(current)), []);
  const after = openWorkflows({ root, path: declaredWorkflowsPath(next) });
  for (const { tag, level } of projects) {
    let names: string[];
    try {
      names = declaredWorkflows(level);
    } catch (error) {
      asStoreRefusal(error);
      continue;
    }
    for (const name of names) {
      if (!(await passes(() => before.read(name)))) continue;
      try {
        await readDeclaredWorkflow(after, names, name, []);
      } catch (error) {
        const fault = asStoreRefusal(error);
        fail(fault.code, `project ${tag}, workflow "${name}": ${fault.description}`, fault.path, fault);
      }
    }
  }
}

/**
 * Sets and clears the keys of one change, leaving every other key and every
 * comment of the file alone. Every check runs before the file is touched, and a
 * change that sets and clears nothing writes nothing.
 */
async function writeUserConfig(root: string, change: UserConfigChange): Promise<void> {
  // The value each key of the change sets, `undefined` for a key it clears.
  const writes = new Map<string, unknown>();
  for (const [key, stated] of Object.entries(change)) {
    writes.set(key, cleared(stated) ? undefined : await VALUE_CHECKS[key as keyof UserConfigChange](stated));
  }
  const path = userConfigPath(root);
  const doc = await openDeclaration(path);
  const current = { path, values: storedValues(doc) };
  const next = { path, values: appliedValues(doc, writes) };
  const changed = new Set(writes.keys());
  const statuses = [...changed].some((key) => STATUS_AND_PRIORITY_KEYS.has(key));
  const workflowsPath = changed.has("workflows_path");

  checkUserConfigChange(next, changed);
  const projects = await readableProjects(root);
  if (statuses) await checkProjects(projects, current, next, changed);
  if (workflowsPath) await checkWorkflows(projects, root, current, next);
  for (const [key, value] of writes) checkAnchor(doc, key, value === undefined, path);

  if (!applyWrites(doc, writes)) return;
  await makeDirectory(root);
  await replaceFile(path, doc.toString());
}

/**
 * Sets and clears keys of the user's configuration file, then reads it back. A
 * change that would break a project that resolves today is refused, and a
 * refused change writes nothing.
 */
export async function updateUserConfig(root: string | undefined, change: UserConfigChange): Promise<UserConfigInfo> {
  const keys = checkedKeys(change, USER_WRITABLE, "is not a key of the user's configuration a write sets");
  if (keys.length > 0) await writeUserConfig(expandRoot(root), change);
  return readUserConfig(root);
}
