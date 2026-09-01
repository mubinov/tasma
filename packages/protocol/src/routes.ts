// Every route the daemon serves, as data both sides read: the client fills a
// template and the daemon's router registers a handler against the same entry,
// so a path is written once.

export type Method = "GET" | "POST" | "PATCH" | "DELETE";

export type Route = {
  method: Method;
  /** The path, with each value the caller supplies written as `{name}`. */
  template: string;
};

export const routes = {
  health: { method: "GET", template: "/health" },
  listProjects: { method: "GET", template: "/projects" },
  readProject: { method: "GET", template: "/projects/{project}" },
  listTasks: { method: "GET", template: "/projects/{project}/tasks" },
  createTask: { method: "POST", template: "/projects/{project}/tasks" },
  readTask: { method: "GET", template: "/projects/{project}/tasks/{id}" },
  updateTask: { method: "PATCH", template: "/projects/{project}/tasks/{id}" },
  deleteTask: { method: "DELETE", template: "/projects/{project}/tasks/{id}" },
  addComment: { method: "POST", template: "/projects/{project}/tasks/{id}/comments" },
  updateComment: { method: "PATCH", template: "/projects/{project}/tasks/{id}/comments/{commentId}" },
  deleteComment: { method: "DELETE", template: "/projects/{project}/tasks/{id}/comments/{commentId}" },
} as const satisfies Record<string, Route>;

/**
 * Which tasks a listing returns. The daemon applies the filter, so a caller
 * receives the matching entries rather than all of them.
 *
 * `status` and `priority` compare case-insensitively, because the store corrects
 * the case of both on write and a stored value is always one of the configured
 * spellings. `label` is repeatable and conjunctive — an entry matches only if it
 * carries every label listed — and each value is lowercased before comparing,
 * the rule the store applies when it stores a label. `parent` and `step` compare
 * exactly. An absent key is not a filter, and an empty `label` array is the same
 * as an absent one.
 *
 * A type alias rather than an interface: only an alias carries an implicit index
 * signature, which `buildPath`'s `query` parameter requires.
 */
export type TaskFilter = {
  status?: string;
  priority?: string;
  label?: string[];
  parent?: string;
  step?: string;
};

const PLACEHOLDER = /\{(\w+)\}/g;

/** Segments a URL resolver removes or climbs out of, so none may reach a path. */
const UNUSABLE_SEGMENTS = ["", ".", ".."];

/**
 * The characters no single path component may hold: the two separators, and the
 * terminator that ends a path for the calls below the store. Percent-encoding
 * hides all three inside a segment, so both ends of the contract test for them —
 * the client before it writes a segment, the daemon after it decodes one.
 */
export const UNSAFE_IN_SEGMENT = /[/\\\0]/;

/**
 * The path of one call: the template with every placeholder filled, and the
 * query appended when any key survives.
 *
 * Written by hand rather than with `URLSearchParams`, which is declared by the
 * DOM library and by the Node types, and this package compiles with neither.
 * `encodeURIComponent` belongs to the ES library, so it is reachable, and every
 * filled segment, every query key and every query value passes through it.
 *
 * Encoding alone does not make a segment safe, in either direction. `.`, `..`
 * and the empty string survive it unchanged, and a URL resolves them away before
 * the request is sent, which retargets the call at another route. A separator is
 * the opposite: encoding hides it inside the segment, where the daemon decodes
 * it and refuses the path component it forges. Both are tested against the raw
 * value, so a call the daemon cannot serve fails where it is written.
 */
export function buildPath(
  route: Route,
  params: Record<string, string | number>,
  query?: Record<string, string | string[] | undefined>,
): string {
  const path = route.template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = Object.hasOwn(params, name) ? params[name] : undefined;
    if (value === undefined) {
      throw new Error(`${route.template} has no value for the path parameter "${name}"`);
    }

    const segment = String(value);
    if (UNUSABLE_SEGMENTS.includes(segment) || UNSAFE_IN_SEGMENT.test(segment)) {
      throw new Error(
        `${route.template} cannot take "${segment}" as the path parameter "${name}": it is not one path component`,
      );
    }
    return encodeURIComponent(segment);
  });

  const pairs = Object.entries(query ?? {}).flatMap(([key, value]) => {
    if (value === undefined) return [];
    const values = typeof value === "string" ? [value] : value;
    return values.map((entry) => `${encodeURIComponent(key)}=${encodeURIComponent(entry)}`);
  });

  return pairs.length === 0 ? path : `${path}?${pairs.join("&")}`;
}
