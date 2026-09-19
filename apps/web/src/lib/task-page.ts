import type { Frontmatter, TaskEntry } from "@tasma/protocol";
import { isFinalStatus } from "./board";

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function minutes(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `HH:mm` in the browser's time zone. A value that is no date is returned as written. */
export function formatMinutes(iso: string): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  return minutes(date);
}

/** `YYYY-MM-DD HH:mm` in the browser's time zone. A value that is no date is returned as written. */
export function formatStamp(iso: string): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  const day = `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

  return `${day} ${minutes(date)}`;
}

export type RelationRow = { id: string; state: "blocking" | "resolved" | "neutral" } & (
  | { status: string; title: string }
  | { status?: never; title?: never }
);

export type Relations = { blockers: readonly RelationRow[]; parent: RelationRow | null };

function toRow(id: string, state: RelationRow["state"], listed: Frontmatter | undefined): RelationRow {
  return listed === undefined ? { id, state } : { id, state, status: listed.status, title: listed.title };
}

/** A blocker the listing holds no task for keeps blocking, as it does for the daemon's `blocked`. */
export function relationRows(
  frontmatter: Frontmatter,
  entries: readonly TaskEntry[],
  finalStatuses: readonly string[],
): Relations {
  const byId = new Map(entries.map((entry) => [entry.id, entry.frontmatter]));
  const { blocked_by: blockedBy = [], parent } = frontmatter;

  const blockers = blockedBy.map((id) => {
    const blocker = byId.get(id);
    const resolved = blocker !== undefined && isFinalStatus(blocker.status, finalStatuses);

    return toRow(id, resolved ? "resolved" : "blocking", blocker);
  });

  return { blockers, parent: parent === undefined ? null : toRow(parent, "neutral", byId.get(parent)) };
}

export function blockingRows(rows: readonly RelationRow[]): RelationRow[] {
  return rows.filter((row) => row.state === "blocking");
}

export function customLines(custom: Record<string, unknown>): string[] {
  return Object.entries(custom).map(([key, value]) => {
    const text = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);

    return `${key}: ${text}`;
  });
}
