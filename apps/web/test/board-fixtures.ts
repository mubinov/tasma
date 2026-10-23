import type { Diagnostic, ExcludedFile, Frontmatter, TaskEntry, TransportReply } from "@tasma/protocol";
import { screen, within } from "@testing-library/react";
import { stubTransport, successReply } from "./helpers";

/** The board of one invented project, as the tasks screen and its drag both read it. */
export const CONFIG = {
  statuses: ["Backlog", "To Do", "In Progress", "Done"],
  default_status: "Backlog",
  final_statuses: ["Done"],
  priorities: ["high", "medium", "low"],
  workflows: ["dev"],
  instructions: [],
};

export const SAGA = { tag: "SAGA", name: "Saga", path: "/repos/saga" };

export const DELTA = { tag: "DELTA", name: "Delta", path: "/repos/delta" };

export const PROJECTS = [SAGA, DELTA];

export const WORKFLOW = {
  name: "dev",
  file: "/w/dev/workflow.yml",
  instructions: [],
  steps: [
    { name: "research", file: "/w/dev/research.md", owner: "agent" },
    { name: "approve", file: "/w/dev/approve.md", owner: "human" },
  ],
};

/** A second project's statuses: To Do and Done are also in `CONFIG`, Review is not. */
export const OTHER_CONFIG = { ...CONFIG, statuses: ["To Do", "Review", "Done"], default_status: "To Do" };

export function entry(number: number, fields: Partial<Frontmatter> = {}): TaskEntry {
  return taggedEntry("SAGA", number, fields);
}

export function taggedEntry(tag: string, number: number, fields: Partial<Frontmatter> = {}): TaskEntry {
  const id = `${tag}-${String(number)}`;

  return {
    id,
    path: `/repos/${tag.toLowerCase()}/tasks/${id}.md`,
    blocked: false,
    frontmatter: {
      id,
      title: `Task ${String(number)}`,
      status: "Backlog",
      created: "2026-09-01T10:00:00Z",
      updated: "2026-09-01T10:00:00Z",
      next_comment_id: 1,
      ...fields,
    },
  };
}

export function project(tag: string, fields: Record<string, unknown> = {}): TransportReply {
  const summary = PROJECTS.find((candidate) => candidate.tag === tag) ?? { tag };

  return successReply({ ...summary, live: true, config: CONFIG, ...fields });
}

export function listing(
  entries: TaskEntry[],
  excluded: ExcludedFile[] = [],
  diagnostics: Diagnostic[] = [],
): TransportReply {
  return successReply({ entries, excluded }, diagnostics);
}

/** A daemon whose replies a test can change between polls. */
export function daemon(replies: Record<string, TransportReply | Promise<TransportReply>> = {}) {
  return stubTransport({
    "/projects": successReply(PROJECTS),
    "/projects/SAGA": project("SAGA"),
    "/projects/SAGA/tasks": listing([]),
    "/projects/DELTA": project("DELTA"),
    "/projects/DELTA/tasks": listing([]),
    ...replies,
  });
}

/**
 * A daemon with SAGA and DELTA, which have different statuses, and the project
 * list sorted by tag as the daemon sends it.
 */
export function twoProjects(replies: Record<string, TransportReply | Promise<TransportReply>> = {}) {
  return daemon({
    "/projects": successReply([DELTA, SAGA]),
    "/projects/DELTA": project("DELTA", { config: OTHER_CONFIG }),
    ...replies,
  });
}

export function column(status: string): HTMLElement {
  return screen.getByRole("region", { name: status });
}

export function countOf(status: string): string | null | undefined {
  return within(column(status)).getByRole("heading", { level: 2 }).nextElementSibling?.textContent;
}

export function titlesIn(status: string): string[] {
  return within(column(status)).queryAllByText(/^Task \d+$/).map((title) => title.textContent);
}
