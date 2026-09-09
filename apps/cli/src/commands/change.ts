// What every write family states about its own fields, the rules it applies to
// its own argv, and how a clear is written into the change it sends.
//
// Its own module because both families refuse the same faults with the same
// lines, and a second copy of a rule is what would let two of them drift apart.

import { reportUsage } from "../shell.js";
import type { Io } from "../types.js";
import { BODY_OPTIONS } from "./body.js";

/**
 * What one write family states about its own fields, so one rule reads either.
 * `keys` names only the flags spelled differently from the key they set.
 */
export type Fields = {
  flags: readonly string[];
  keys?: Record<string, string>;
  clearable: readonly string[];
};

/** The key a field flag sets. */
export function keyOf(fields: Fields, flag: string): string {
  return fields.keys?.[flag] ?? flag;
}

/**
 * Which flags state each field, so a clear beside one of them is reported in the
 * spelling that was typed.
 *
 * Derived from the family's own flags, plus the body's, which are the same for
 * every family and are read off the table that declares them, so no caller
 * states the map itself.
 */
function settersOf(fields: Fields): Map<string, string[]> {
  return new Map([
    ...fields.flags.map((flag): [string, string[]] => [keyOf(fields, flag), [`--${flag}`]]),
    ["body", Object.keys(BODY_OPTIONS).map((flag) => `--${flag}`)],
  ]);
}

/** The flags this invocation typed, in the spelling their table gives them. */
export function flagsGiven(values: Record<string, unknown>): Set<string> {
  return new Set(Object.keys(values).map((name) => `--${name}`));
}

/**
 * Whether a flag carried the empty value a write may not store. A value of any
 * other type carries none: a boolean flag takes no value at all.
 */
function isEmpty(value: unknown): boolean {
  if (typeof value === "string") return value === "";

  return Array.isArray(value) && value.includes("");
}

/**
 * The fault where a flag that states a field was given an empty value, or
 * nothing where every value stands.
 *
 * An empty value is refused rather than read as "not stated", which is the rule
 * a filter on a read applies: on a write an unset shell variable would otherwise
 * store an empty parent, and the caller would never learn of it. Where the field
 * can be removed and the verb accepts a clear, the line names the flag that
 * removes it.
 */
export function refuseEmpty(
  io: Io,
  fields: Fields,
  values: Record<string, unknown>,
  canClear: boolean,
): number | undefined {
  for (const flag of fields.flags) {
    if (!isEmpty(values[flag])) continue;

    const key = keyOf(fields, flag);
    const hint = canClear && fields.clearable.includes(key) ? `; --clear ${key} removes the field` : "";

    return reportUsage(io, `--${flag} needs a value${hint}`);
  }

  return undefined;
}

/**
 * The faults in `--clear`: a field it names that no write can remove, and a
 * field it removes that another flag sets in the same invocation.
 *
 * Three passes rather than one, so the same invocation reports the same line
 * however its flags were ordered on the command line.
 */
export function refuseClears(
  io: Io,
  fields: Fields,
  clears: readonly string[],
  given: Set<string>,
): number | undefined {
  if (clears.includes("")) return reportUsage(io, "--clear needs a field");

  const unknown = clears.find((field) => !fields.clearable.includes(field));

  if (unknown !== undefined) return reportUsage(io, `not a clearable field: ${unknown}`);

  for (const [field, flags] of settersOf(fields)) {
    if (!clears.includes(field)) continue;

    for (const flag of flags) {
      if (given.has(flag)) return reportUsage(io, `--clear ${field} and ${flag} exclude each other`);
    }
  }

  return undefined;
}

/**
 * The faults in `--append`: a body the same invocation removes, and an append
 * carrying no text to add at all.
 */
export function refuseAppend(
  io: Io,
  append: boolean,
  body: string | undefined,
  clears: readonly string[],
): number | undefined {
  if (!append) return undefined;
  if (clears.includes("body")) return reportUsage(io, "--append and --clear body exclude each other");

  return body === undefined ? reportUsage(io, "--append needs --body or --body-file") : undefined;
}

/**
 * Every clear written into the change, as the removal the wire spells `null`.
 *
 * The key is widened to write it: `{ body: null }` as a literal fails the
 * typecheck, and `undefined` in its place typechecks, is dropped by the
 * serializer and leaves the field as it stands.
 */
export function applyClears(change: Record<string, unknown>, clears: readonly string[]): void {
  for (const field of clears) change[field] = null;
}

/** The fault where an edit states no field, no clear and no body: nothing to send. */
export function refuseNoChange(
  io: Io,
  command: string,
  change: Record<string, unknown>,
  body: string | undefined,
): number | undefined {
  if (body !== undefined || Object.keys(change).length > 0) return undefined;

  return reportUsage(io, `${command} needs a change`);
}
