import type { Comment, Diagnostic, Frontmatter, TaskEntry, TransportReply, Workflow } from "@tasma/protocol";
import { screen, within } from "@testing-library/react";
import { stubTransport, successReply } from "./helpers";

/** One task of one invented project, as the task page and its property controls both read it. */
const CONFIG = {
  statuses: ["Backlog", "In Progress", "Done"],
  default_status: "Backlog",
  final_statuses: ["Done"],
  priorities: ["high", "medium", "low"],
  workflows: ["dev"],
  instructions: [],
};

const PROJECT = { tag: "SAGA", name: "Saga", path: "/repos/saga", live: true, config: CONFIG };

export const WORKFLOW: Workflow = {
  name: "dev",
  file: "/w/dev/workflow.yml",
  instructions: [],
  steps: [
    { name: "research", file: "/w/dev/research.md", owner: "agent" },
    { name: "approve", file: "/w/dev/approve.md", owner: "human" },
  ],
};

export const TASK_PATH = "/projects/SAGA/tasks/SAGA-3";

export const LISTING_PATH = "/projects/SAGA/tasks";

export function frontmatter(fields: Partial<Frontmatter> = {}): Frontmatter {
  return {
    id: "SAGA-3",
    title: "Build the parser",
    status: "In Progress",
    created: "2026-09-01T10:00:00Z",
    updated: "2026-09-01T10:00:00Z",
    next_comment_id: 1,
    ...fields,
  };
}

export function comment(id: number, fields: Partial<Comment> = {}): Comment {
  return {
    id,
    title: `Note ${String(id)}`,
    created: "2026-09-02T10:00:00Z",
    body: `Body of note ${String(id)}.`,
    ...fields,
  };
}

type TaskParts = {
  fields?: Partial<Frontmatter>;
  body?: string;
  comments?: Comment[];
  diagnostics?: Diagnostic[];
};

export function task({ fields = {}, body = "", comments = [], diagnostics = [] }: TaskParts = {}): TransportReply {
  return successReply({ frontmatter: frontmatter(fields), body, comments }, diagnostics);
}

export function entry(id: string, status: string, title: string): TaskEntry {
  return { id, path: `/repos/saga/tasks/${id}.md`, blocked: false, frontmatter: frontmatter({ id, status, title }) };
}

export function listing(entries: TaskEntry[] = []): TransportReply {
  return successReply({ entries, excluded: [] });
}

export function daemon(replies: Record<string, TransportReply> = {}) {
  return stubTransport({
    "/projects": successReply([{ tag: "SAGA", name: "Saga", path: "/repos/saga" }]),
    "/projects/SAGA": successReply(PROJECT),
    "/workflows/dev": successReply(WORKFLOW),
    [TASK_PATH]: task(),
    [LISTING_PATH]: listing(),
    ...replies,
  });
}

export function metaLine(): HTMLElement {
  return screen.getByRole("heading", { level: 1 }).parentElement!.nextElementSibling as HTMLElement;
}

export function sidebar(): HTMLElement {
  return screen.getByRole("complementary", { name: "Task details" });
}

/** The value of a sidebar row. */
export function field(label: string): HTMLElement {
  return within(sidebar()).getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;
}

export function backLink(): HTMLElement {
  return within(screen.getByRole("main")).getByRole("link", { name: "Tasks" });
}

export function topBar(): HTMLElement {
  return backLink().parentElement!;
}

export function commentCard(title: string): HTMLElement {
  return screen.getByRole("article", { name: title });
}
