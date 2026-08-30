import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { onTestFinished } from "vitest";
import { openProject, type Project, type StoreDiagnostic, TaskStoreError } from "@tasma/engine";

export const PROJECT = "TASM";

export const TIMESTAMP = "2026-01-01T00:00:00+03:00";

/** A temp `<root>` with no project directory in it, removed when the test ends. */
export async function bareRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tasma-store-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** The same, holding the `projects/<PROJ>/` directory every operation needs. */
export async function tempRoot(project: string = PROJECT): Promise<string> {
  const root = await bareRoot();
  await mkdir(join(root, "projects", project), { recursive: true });
  return root;
}

export function projectDir(root: string, project: string = PROJECT): string {
  return join(root, "projects", project);
}

export function tasksDir(root: string, project: string = PROJECT): string {
  return join(projectDir(root, project), "tasks");
}

export function userConfig(root: string): string {
  return join(root, "config.yml");
}

export function projectConfig(root: string, project: string = PROJECT): string {
  return join(projectDir(root, project), "config.yml");
}

export function statePath(root: string, project: string = PROJECT): string {
  return join(projectDir(root, project), "state.yml");
}

/** The name one task file stands under in a temp tree. */
export function taskFile(root: string, id: string, project: string = PROJECT): string {
  return join(tasksDir(root, project), `${id}.md`);
}

/** A handle on the temp project, which is what almost every test calls through. */
export function project(root: string): Project {
  return openProject({ project: PROJECT, root });
}

/** Writes a file, creating the directories above it. */
export async function plant(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

export function read(path: string): Promise<string> {
  return readFile(path, "utf8");
}

/** A task file as a hand edit or an earlier write leaves it. `extra` holds further frontmatter lines. */
export function taskText(id: string, extra = ""): string {
  return `---
id: ${id}
title: Planted
status: To Do
created: "${TIMESTAMP}"
updated: "${TIMESTAMP}"
next_comment_id: 1
${extra}---

Body.
`;
}

/** Runs a call and returns the `TaskStoreError` it must reject with. */
export async function storeError(call: Promise<unknown>): Promise<TaskStoreError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof TaskStoreError) return error;
    throw error;
  }
  throw new Error("the call did not reject");
}

/** The same for a call that throws as it stands, rather than rejecting. */
export function storeFault(build: () => unknown): TaskStoreError {
  try {
    build();
  } catch (error) {
    if (error instanceof TaskStoreError) return error;
    throw error;
  }
  throw new Error("the call did not throw");
}

/** The codes of a diagnostic array, which is what a test asserts on. */
export function codes(diagnostics: StoreDiagnostic[]): string[] {
  return diagnostics.map((diagnostic) => diagnostic.code);
}
