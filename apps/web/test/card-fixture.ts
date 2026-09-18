import type { Frontmatter, TaskEntry } from "@tasma/protocol";

/** One card of a task, as the board draws it and as a drag carries it. */
export function entry(fields: Partial<Frontmatter> = {}, blocked = false): TaskEntry {
  return {
    id: "SAGA-7",
    path: "/tasks/SAGA-7.md",
    blocked,
    frontmatter: {
      id: "SAGA-7",
      title: "Build the parser",
      status: "In Progress",
      created: "2026-09-01T10:00:00Z",
      updated: "2026-09-01T10:00:00Z",
      next_comment_id: 1,
      ...fields,
    },
  };
}
