import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openWorkflows, type Workflows } from "@tasma/engine";
import { plant, userConfig } from "../store/helpers.js";

/** The three-way split the workflow fixtures stand under, as `test/fixtures/` uses it. */
export type Kind = "valid" | "warn" | "invalid";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "workflows");

/** The text of one workflow fixture, by kind and file name. */
function workflowFixture(kind: Kind, name: string): string {
  return readFileSync(join(FIXTURES, kind, name), "utf8");
}

/**
 * The tree the workflows of one test stand in: the directory `workflows_path`
 * names where a test states one, and the built-in default otherwise. Every
 * helper below takes it, so one test covers both trees with the same planting.
 */
export function workflowsDir(root: string, path?: string): string {
  return path ?? join(root, "workflows");
}

export function workflowDir(root: string, name: string, path?: string): string {
  return join(workflowsDir(root, path), name);
}

export function workflowFile(root: string, name: string, path?: string): string {
  return join(workflowDir(root, name, path), "workflow.yml");
}

/** Writes `workflow.yml` of one workflow, creating the directories above it. */
export async function plantWorkflow(root: string, name: string, text: string, path?: string): Promise<void> {
  await plant(workflowFile(root, name, path), text);
}

/** The same from a fixture file. */
export async function plantFixture(root: string, name: string, kind: Kind, file: string): Promise<void> {
  await plantWorkflow(root, name, workflowFixture(kind, file));
}

/**
 * The one directory outside the tree the root names that every test of a
 * configured `workflows_path` stands on, so that a report at either layer names
 * the same fixture.
 */
export function outsideWorkflows(root: string): string {
  return join(root, "elsewhere", "flows");
}

/** Names one directory as the workflows tree in the user's configuration file. */
export async function plantWorkflowsPath(root: string, path: string): Promise<void> {
  await plant(userConfig(root), `workflows_path: ${JSON.stringify(path)}\n`);
}

/** A workflow file declaring one step per name, each with a file beside it under `steps/`. */
export function stepsOnly(...names: string[]): string {
  const lines = names.map((name) => `  - {name: "${name}", file: steps/${name.replace(":", "-")}.md}`);
  return `steps:\n${lines.join("\n")}\n`;
}

/** The path the file of one step of `stepsOnly` stands under. */
export function stepFile(root: string, workflow: string, step: string, path?: string): string {
  return join(workflowDir(root, workflow, path), "steps", `${step.replace(":", "-")}.md`);
}

/**
 * A workflow whose steps each have a file on disk, which is what a caller that
 * asks for the text of a step needs.
 */
export async function plantSteps(root: string, name: string, ...steps: string[]): Promise<void> {
  await plantWorkflow(root, name, stepsOnly(...steps));
  for (const step of steps) await plant(stepFile(root, name, step), `Do ${step}.\n`);
}

export function workflows(root: string, path?: string): Workflows {
  return openWorkflows({ root, path });
}
