import type { CommentFields, Frontmatter, TaskComment } from "./types.js";
import { isDenseList, isPlainMapping, isRecord } from "./values.js";

const TIMESTAMP_PATTERN =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.\d+)?(?:Z|[+-](?<offsetHour>\d{2}):(?<offsetMinute>\d{2}))$/;

function withinRange(part: string | undefined, limit: number): boolean {
  return part === undefined || Number(part) <= limit;
}

/** An ISO 8601 date and time with a UTC offset, on a day the calendar has. */
function isTimestamp(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const parts = TIMESTAMP_PATTERN.exec(value)?.groups;
  if (parts === undefined) return false;
  // The pattern accepts any two digits, so a day the month does not have is rejected here.
  if (new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`).getUTCDate() !== Number(parts.day)) return false;
  return (
    withinRange(parts.hour, 23) &&
    withinRange(parts.minute, 59) &&
    withinRange(parts.second, 59) &&
    withinRange(parts.offsetHour, 23) &&
    withinRange(parts.offsetMinute, 59)
  );
}

/** A test on one value, with the wording an error message appends to the key. */
export type Check = {
  holds: (value: unknown) => boolean;
  expectation: string;
};

const STRING: Check = {
  holds: (value) => typeof value === "string",
  expectation: "must be a string",
};

const INTEGER: Check = {
  holds: (value) => typeof value === "number" && Number.isInteger(value),
  expectation: "must be an integer",
};

const BOOLEAN: Check = {
  holds: (value) => typeof value === "boolean",
  expectation: "must be a boolean",
};

const STRING_LIST: Check = {
  holds: (value) => isDenseList(value) && value.every((item) => typeof item === "string"),
  expectation: "must be a list of strings that holds a value at every position",
};

/**
 * Keys that address `Object.prototype` when a caller merges the mapping into an
 * object of its own. No reader returns a mapping that carries one.
 */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * The deepest a mapping may nest. Every walk over a mapping is recursive, and a
 * YAML anchor or a caller-built object can nest one past what the stack holds.
 */
const MAX_DEPTH = 100;

/**
 * The most values one key may expand to. A value that several keys point at is
 * written out once per key, so a shape that shares one object between two keys
 * doubles the output at every level. The budget bounds both the walk below and
 * the text the writer produces from it.
 */
const MAX_NODES = 10_000;

/** How much of the node budget one walk has left. */
type Budget = { left: number };

/**
 * Whether a value is safe to hand to another component and safe to write: every
 * mapping in it is a plain mapping, every list holds a value at every position,
 * none carries a key that addresses the object model, none contains itself, none
 * nests deeper than `MAX_DEPTH`, and the whole value expands to at most
 * `MAX_NODES` values. `path` holds the values between the root and `value`, so a
 * value that appears twice side by side is legal and only a value that contains
 * itself is not.
 */
function isSafe(value: unknown, path: Set<unknown>, depth: number, budget: Budget): boolean {
  budget.left -= 1;
  if (budget.left < 0) return false;
  if (typeof value !== "object" || value === null) return true;
  if (depth > MAX_DEPTH || path.has(value)) return false;
  path.add(value);
  let safe: boolean;
  if (isDenseList(value)) safe = value.every((item) => isSafe(item, path, depth + 1, budget));
  else if (isPlainMapping(value)) {
    safe = Object.entries(value).every(
      ([key, nested]) => !UNSAFE_KEYS.has(key) && isSafe(nested, path, depth + 1, budget),
    );
  } else safe = false;
  path.delete(value);
  return safe;
}

function holdsSafely(value: unknown): boolean {
  return isSafe(value, new Set(), 1, { left: MAX_NODES });
}

const SAFE_EXPECTATION =
  'carries no "__proto__", "constructor" or "prototype" key, holds plain mappings only, ' +
  "holds a value at every position of every list, does not contain itself, " +
  `nests at most ${MAX_DEPTH} levels deep, and expands to at most ${MAX_NODES} values`;

/**
 * The rule `isSafe` states, as one region-wide check. Every key of a region is
 * checked against it, not only the keys this format defines: an unknown key is
 * retained and written back, so it reaches the writer the same way.
 */
export const WRITABLE: Check = {
  holds: holdsSafely,
  expectation: `must hold a value that ${SAFE_EXPECTATION}`,
};

const MAPPING: Check = {
  holds: (value) => isRecord(value) && holdsSafely(value),
  expectation: `must be a mapping that ${SAFE_EXPECTATION}`,
};

const TIMESTAMP: Check = {
  holds: isTimestamp,
  expectation: "must be an ISO 8601 timestamp with a UTC offset",
};

export type FieldSpec = {
  check: Check;
  required: boolean;
  /** Written with double quotes, so that no YAML library reads the value back as a native date. */
  quoted?: boolean;
};

/**
 * The one statement of the frontmatter schema, in the order a writer emits the
 * keys. The reader, the writer and the write-time validation all read it, so a
 * key is added to the format in one place.
 */
export const FRONTMATTER: Record<keyof Frontmatter, FieldSpec> = {
  id: { check: STRING, required: true },
  title: { check: STRING, required: true },
  status: { check: STRING, required: true },
  workflow: { check: STRING, required: false },
  step: { check: STRING, required: false },
  priority: { check: STRING, required: false },
  order: { check: INTEGER, required: false },
  labels: { check: STRING_LIST, required: false },
  parent: { check: STRING, required: false },
  created: { check: TIMESTAMP, required: true, quoted: true },
  updated: { check: TIMESTAMP, required: true, quoted: true },
  next_comment_id: { check: INTEGER, required: true },
  custom: { check: MAPPING, required: false },
};

/** The same statement for the marker schema. */
export const COMMENT: Record<keyof CommentFields, FieldSpec> = {
  id: { check: INTEGER, required: true },
  title: { check: STRING, required: true },
  created: { check: TIMESTAMP, required: true, quoted: true },
  updated: { check: TIMESTAMP, required: false, quoted: true },
  author: { check: STRING, required: false },
  collapsed: { check: BOOLEAN, required: false },
  custom: { check: MAPPING, required: false },
};

/** The marker fields of a comment, without its body and its parsed position. */
export function commentFields(comment: TaskComment): CommentFields {
  const held = comment as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  for (const key of Object.keys(COMMENT)) {
    if (held[key] !== undefined) fields[key] = held[key];
  }
  return fields as CommentFields;
}
