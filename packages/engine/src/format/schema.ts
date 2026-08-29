import type { TaskSerializeErrorCode } from "./errors.js";
import type { CommentFields, Frontmatter } from "./types.js";
import { isPlainMapping, isRecord } from "./values.js";

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

/** `WRITABLE` runs first on both paths, so a position that names no value is already rejected. */
const STRING_LIST: Check = {
  holds: (value) => Array.isArray(value) && value.every((item) => typeof item === "string"),
  expectation: "must be a list of strings",
};

/**
 * Keys that address `Object.prototype` when a caller merges the mapping into an
 * object of its own. No reader returns a mapping that carries one.
 */
const UNWRITABLE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

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
 * The scalar types a value may hold. Everything else a language offers — a big
 * integer, a symbol, a function — either reaches the YAML writer as text that
 * reads back as another value or as no value at all, so it is rejected before
 * any text exists. `undefined` names no value: a mapping key that holds it is an
 * absent key, at every level.
 */
const WRITABLE_TYPES = new Set(["string", "number", "boolean", "undefined"]);

/** What a walk returns for a value this format cannot write. */
export const UNWRITABLE: unique symbol = Symbol("tasma.format.unwritable");

/**
 * Walks one value under the rule `WRITABLE` states. `path` holds the values
 * between the root and `value`, so a value that appears twice side by side is
 * legal and only a value that contains itself is not.
 *
 * `copy` selects the mode. In copy mode the walk returns a deep copy, so that an
 * object which answers a second read with another value cannot be checked as one
 * value and written as another; in check mode it returns the value itself,
 * because the reader walks every key of every region it reads and has no use for
 * a copy. Either mode returns `UNWRITABLE` for a value this format cannot write.
 */
function walk(value: unknown, path: Set<unknown>, depth: number, budget: Budget, copy: boolean): unknown {
  budget.left -= 1;
  if (budget.left < 0) return UNWRITABLE;
  if (value === null) return null;
  if (typeof value !== "object") return WRITABLE_TYPES.has(typeof value) ? value : UNWRITABLE;
  if (depth > MAX_DEPTH || path.has(value)) return UNWRITABLE;
  path.add(value);
  const walked = walkInto(value, path, depth, budget, copy);
  path.delete(value);
  return walked;
}

/**
 * One collection of a walk, entry by entry. Every entry is read once: a second
 * read of the same position can answer with another value, which would let a
 * walk check one value and copy another.
 */
function walkInto(value: object, path: Set<unknown>, depth: number, budget: Budget, copy: boolean): unknown {
  if (Array.isArray(value)) {
    const items: unknown[] | undefined = copy ? [] : undefined;
    for (let index = 0; index < value.length; index += 1) {
      const item: unknown = value[index];
      // A position that names no value reads the same way as a position the
      // list carries no entry for, and neither can be written.
      if (item === undefined) return UNWRITABLE;
      const walked = walk(item, path, depth + 1, budget, copy);
      if (walked === UNWRITABLE) return UNWRITABLE;
      items?.push(walked);
    }
    return items ?? value;
  }
  if (!isPlainMapping(value)) return UNWRITABLE;
  // The copy holds no prototype, so no key name can reach a setter of the
  // object model instead of storing a value.
  const entries = copy ? (Object.create(null) as Record<string, unknown>) : undefined;
  for (const [key, nested] of Object.entries(value)) {
    if (UNWRITABLE_KEYS.has(key)) return UNWRITABLE;
    const walked = walk(nested, path, depth + 1, budget, copy);
    if (walked === UNWRITABLE) return UNWRITABLE;
    if (entries !== undefined) entries[key] = walked;
  }
  return entries ?? value;
}

/** Starts one walk, with the bounds each key of a region is given on its own. */
function walkRoot(value: unknown, copy: boolean): unknown {
  return walk(value, new Set(), 1, { left: MAX_NODES }, copy);
}

/** A deep copy of a value `WRITABLE` accepts, or `UNWRITABLE` for one it does not. */
export function writableCopy(value: unknown): unknown {
  return walkRoot(value, true);
}

const WRITABLE_EXPECTATION =
  "is built from strings, numbers, booleans, nulls, plain mappings and lists, " +
  'carries no "__proto__", "constructor" or "prototype" key, ' +
  "holds a value at every position of every list, does not contain itself, " +
  `nests at most ${MAX_DEPTH} levels deep, and expands to at most ${MAX_NODES} values`;

/**
 * The rule the walk states, as one region-wide check. Every key of a region is
 * checked against it, not only the keys this format defines: an unknown key is
 * retained and written back, so it reaches the writer the same way.
 */
export const WRITABLE: Check = {
  holds: (value) => walkRoot(value, false) !== UNWRITABLE,
  expectation: `must hold a value that ${WRITABLE_EXPECTATION}`,
};

/**
 * The shape of `custom` alone. What it may hold is `WRITABLE`, which the reader
 * runs over every key of a region and the writer over every value it copies out
 * of the caller, so running it again here would walk the same values twice.
 */
const MAPPING: Check = {
  holds: isRecord,
  expectation: "must be a mapping",
};

const TIMESTAMP: Check = {
  holds: isTimestamp,
  expectation: "must be an ISO 8601 timestamp with a UTC offset",
};

const LABEL_CHARACTER = /^[a-z0-9-]$/;

/**
 * What keeps a string from being a label, or `undefined` when it is one. A label
 * is one or more lowercase ASCII letters, digits or dashes, and carries a dash
 * at neither end.
 *
 * The rule binds a writer alone. A reader accepts a label of any form, so a file
 * a hand edit or another tool wrote still loads.
 */
export function labelFault(label: string): string | undefined {
  if (label === "") return "is empty";
  if (label.startsWith("-")) return 'starts with "-"';
  if (label.endsWith("-")) return 'ends with "-"';
  for (const character of label) {
    if (!LABEL_CHARACTER.test(character)) return `carries "${character}"`;
  }
  return undefined;
}

/**
 * A test the writer runs on a value a write sets, and the reader never runs. It
 * reports what is wrong with the value, so that the error names the part of it
 * that failed rather than the key alone.
 */
export type WriteCheck = {
  code: TaskSerializeErrorCode;
  fault: (value: unknown) => string | undefined;
};

/**
 * The form of a label, as a rule about the value a write states. The `check` of
 * the same key must not carry it: the reader runs `check` and accepts a label of
 * any form.
 */
const LABEL_FORM: WriteCheck = {
  code: "label-invalid",
  // The schema check on this key runs before any region is built, so the value
  // reaching here is a list of strings.
  fault: (value) => {
    for (const label of value as string[]) {
      const fault = labelFault(label);
      if (fault !== undefined) return `holds the label "${label}", which ${fault}`;
    }
    return undefined;
  },
};

export type FieldSpec = {
  check: Check;
  required: boolean;
  /** Written with double quotes, so that no YAML library reads the value back as a native date. */
  quoted?: boolean;
  /** Run on a value a write sets, never on one the writer carries over from the file. */
  writeCheck?: WriteCheck;
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
  labels: { check: STRING_LIST, required: false, writeCheck: LABEL_FORM },
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
