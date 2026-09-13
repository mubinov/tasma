import type { Frontmatter } from "../format/index.js";
import { ID_FIELDS } from "../format/schema.js";

/** The fields through which one task names another: every id field but its own `id`. */
const REFERENCE_FIELDS = ID_FIELDS.filter((field) => field.key !== "id");

function holds(value: unknown, many: boolean, id: string): boolean {
  return many ? (value as string[] | undefined)?.includes(id) === true : value === id;
}

/** Whether a task names task `id` in a field that holds the id of another task. */
export function namesTask(frontmatter: Frontmatter, id: string): boolean {
  const fields = frontmatter as unknown as Record<string, unknown>;
  return REFERENCE_FIELDS.some(({ key, many }) => holds(fields[key], many, id));
}

/**
 * A copy of the frontmatter with every mention of task `id` taken out, or
 * `undefined` when it names none. A field left without an id is cleared, and a
 * field that does not name `id` is not assigned.
 */
export function withoutTask(frontmatter: Frontmatter, id: string): Record<string, unknown> | undefined {
  const fields: Record<string, unknown> = { ...frontmatter };
  let named = false;
  for (const { key, many } of REFERENCE_FIELDS) {
    const value = fields[key];
    if (!holds(value, many, id)) continue;
    const kept = many ? (value as string[]).filter((other) => other !== id) : [];
    fields[key] = kept.length === 0 ? undefined : kept;
    named = true;
  }
  return named ? fields : undefined;
}
