/** Helpers over the values a YAML mapping can hold. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether the value is a mapping whose entries `Object.entries` reports. A YAML
 * tag resolves to other shapes, such as `!!omap` to a `Map` and `!!set` to a
 * `Set`, and a walk over the entries of one of those sees nothing.
 */
export function isPlainMapping(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Whether the value is a list that names a value at every position. A position
 * a list carries no entry for and a position whose entry names no value read
 * the same way, and neither can be written: a list method such as `every` or
 * `map` steps over the first, so a walk reads fewer values than a writer writes
 * out, and the writer turns the second into a null the caller never supplied.
 */
export function isDenseList(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === undefined) return false;
  }
  return true;
}

/**
 * The keys of a mapping that name a value. A key whose value is `undefined`
 * names none: no reader produces one, and the writer drops it. It is how a
 * caller clears a key, at every level of a mapping, so a comparison that
 * counted it would read a cleared key the file never held as a change.
 */
function namedKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).filter((key) => value[key] !== undefined);
}

/** A deep copy of the values a YAML mapping can hold. */
export function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clone) as T;
  if (isPlainMapping(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) as T;
  }
  return value;
}

/** Structural equality over the values a YAML mapping can hold. */
export function deepEqual(a: unknown, b: unknown): boolean {
  // Both tests are needed. `===` reads two zeros of opposite sign as equal,
  // `Object.is` reads two not-a-number values as equal, and YAML 1.2 writes
  // both of those values. A value that reads as changed rewrites its region,
  // which drops the YAML comments the region carried.
  if (a === b || Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainMapping(a) && isPlainMapping(b)) {
    const keys = namedKeys(a);
    return keys.length === namedKeys(b).length && keys.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}
