// Which handler a request belongs to, decided from the route table both sides
// read. A pure function: it touches no socket and assigns no status.

import { UNSAFE_IN_SEGMENT } from "@tasma/protocol";
import type { DaemonErrorCode, Method, Route, Success } from "@tasma/protocol";

/** What a handler is given: the path params, the query, and the parsed body. */
export type HandlerRequest = {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
};

/**
 * One route's implementation. It resolves to the data and the diagnostics of a
 * success and throws to refuse, so no handler builds an envelope or picks a
 * status.
 */
export type Handler = (request: HandlerRequest) => Promise<Success<unknown>>;

export type RouteEntry = { route: Route; handler: Handler };

export type Match
  = | { ok: true; entry: RouteEntry; params: Record<string, string>; query: URLSearchParams }
    | { ok: false; code: DaemonErrorCode; message: string; allow?: Method[] };

/** Matching reads no host, so any address resolves the target the same way. */
const BASE = "http://127.0.0.1";

const PLACEHOLDER = /^\{(\w+)\}$/;

/**
 * Whether a decoded segment is something other than one path component.
 *
 * The character class is the reachable case: `%2F` survives resolution as one
 * segment and decodes to a separator here, forging a path component the caller
 * was never given a route to. `URL` resolves a dot segment away before the
 * router sees it, in every spelling, so those two comparisons are defence
 * against a change of parsing rather than a live path.
 */
function isUnsafe(segment: string): boolean {
  return UNSAFE_IN_SEGMENT.test(segment) || segment === "." || segment === "..";
}

/**
 * The path as decoded components, or `undefined` where one of them cannot be
 * read or cannot be used as a path component.
 *
 * Each segment is decoded on its own, after the split. Decoding the whole path
 * first would let `%2F` inside a value forge a separator, and every value a
 * client sends is percent-encoded into a segment on the way out. A malformed
 * escape makes that decoding throw, which is a segment that cannot be read.
 */
function segmentsOf(pathname: string): string[] | undefined {
  let segments: string[];

  try {
    segments = pathname.split("/").slice(1).map(decodeURIComponent);
  } catch {
    return undefined;
  }

  return segments.some(isUnsafe) ? undefined : segments;
}

/**
 * The params this template takes from this path, or `undefined` where the
 * template does not describe the path at all.
 */
function capture(template: string[], segments: string[]): Record<string, string> | undefined {
  if (template.length !== segments.length) return undefined;

  const params: Record<string, string> = {};

  for (const [index, part] of template.entries()) {
    const segment = segments[index] ?? "";
    const name = PLACEHOLDER.exec(part)?.[1];

    if (name === undefined) {
      if (part !== segment) return undefined;
      continue;
    }
    // An empty segment fills no param, so a trailing or a doubled slash matches
    // no template rather than reading as the path without it.
    if (segment === "") return undefined;
    params[name] = segment;
  }

  return params;
}

/**
 * The entry a request belongs to, or the reason it belongs to none.
 *
 * A refusal names a `DaemonErrorCode` and leaves the status to the mapping
 * table, so every status the daemon sends is decided in one place.
 *
 * A target that could not be read is refused without being quoted back: it is
 * the caller's own text and repeating it explains nothing. A target that was
 * read is named, as the decoded path alone, in the two refusals matching itself
 * produces — that is what tells one of them from another.
 */
export function match(method: string, target: string, entries: RouteEntry[]): Match {
  let url: URL;

  try {
    url = new URL(target, BASE);
  } catch {
    return { ok: false, code: "malformed-request", message: `${method} names a target no URL can be read from` };
  }

  const query = url.searchParams;
  const segments = segmentsOf(url.pathname);

  if (segments === undefined) {
    return { ok: false, code: "malformed-request", message: `${method} names a path component that is not one` };
  }

  const path = `/${segments.join("/")}`;
  const onPath: { entry: RouteEntry; params: Record<string, string> }[] = [];

  for (const entry of entries) {
    const params = capture(entry.route.template.split("/").slice(1), segments);
    if (params !== undefined) onPath.push({ entry, params });
  }

  if (onPath.length === 0) {
    return { ok: false, code: "route-not-found", message: `no route serves ${method} ${path}` };
  }

  const found = onPath.find((candidate) => candidate.entry.route.method === method);
  if (found === undefined) {
    // A method is named once however many entries carry the route it belongs to.
    const allow = [...new Set(onPath.map((candidate) => candidate.entry.route.method))];
    return {
      ok: false,
      code: "method-not-allowed",
      message: `${path} serves ${allow.join(", ")}, not ${method}`,
      allow,
    };
  }

  return { ok: true, entry: found.entry, params: found.params, query };
}
