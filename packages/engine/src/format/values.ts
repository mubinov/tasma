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

/**
 * The dotted path of the first value at which `a` differs from `b`, under the
 * rules `deepEqual` compares them by. A list position is named `tags[1]`. The
 * caller has established that the two differ, so the walk always names a value:
 * it descends into the child that carries the difference, and reports the path
 * it stands on when no child does.
 */
export function differencePath(a: unknown, b: unknown, path: string): string {
  // `b` is read by name alone. `Object` turns a value of any other shape, and
  // the absence of one, into something that answers every name with `undefined`,
  // so the walk stops there instead of reaching into nothing.
  const other = Object(b) as Record<PropertyKey, unknown>;
  if (Array.isArray(a)) {
    for (const [index, item] of a.entries()) {
      if (deepEqual(item, other[index])) continue;
      return differencePath(item, other[index], `${path}[${index}]`);
    }
  } else if (isPlainMapping(a)) {
    // `deepEqual` counts the keys of both sides, so the difference it found can
    // sit on a key `b` names and `a` does not. Walking `a` alone would step over
    // that key and report the mapping itself, which at the root has no name.
    for (const key of new Set([...namedKeys(a), ...Object.keys(other)])) {
      if (deepEqual(a[key], other[key])) continue;
      return differencePath(a[key], other[key], path === "" ? key : `${path}.${key}`);
    }
  }
  return path;
}
