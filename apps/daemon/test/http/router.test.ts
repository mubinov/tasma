import { describe, expect, it } from "vitest";
import { buildPath, routes } from "@tasma/protocol";
import type { Route } from "@tasma/protocol";
import { match } from "../../src/http/router.js";
import type { Match, RouteEntry } from "../../src/http/router.js";

const handler = () => Promise.resolve({ data: null, diagnostics: [] });

const entries: RouteEntry[] = Object.values(routes).map((route) => ({ route, handler }));

/** A value for every placeholder any template names, so one call builds every path. */
const SAMPLE = { project: "TASM", id: "TASM-3", commentId: 7 };

function refusal(found: Match): { code: string; allow?: string[] } {
  if (found.ok) throw new Error("the router matched a route where the test expected a refusal");
  return { code: found.code, allow: found.allow };
}

function messageOf(found: Match): string {
  if (found.ok) throw new Error("the router matched a route where the test expected a refusal");
  return found.message;
}

describe("the router", () => {
  it.each(Object.entries(routes) as [string, Route][])("matches the path %s builds", (_name, route) => {
    const found = match(route.method, buildPath(route, SAMPLE), entries);

    expect(found.ok && found.entry.route).toBe(route);
  });

  it("captures every param of the path it matched", () => {
    const found = match("PATCH", "/projects/TASM/tasks/TASM-3/comments/7", entries);

    expect(found.ok && found.params).toEqual({ project: "TASM", id: "TASM-3", commentId: "7" });
  });

  it("takes a route without params as one carrying none", () => {
    const found = match("GET", "/health", entries);

    expect(found.ok && found.params).toEqual({});
  });

  it("splits the query off before matching, and hands it to the handler", () => {
    const found = match("GET", "/projects/TASM/tasks?status=To%20Do&label=dev&label=ops", entries);

    expect(found.ok && found.entry.route).toBe(routes.listTasks);
    expect(found.ok && found.query.get("status")).toBe("To Do");
    expect(found.ok && found.query.getAll("label")).toEqual(["dev", "ops"]);
  });

  it("leaves the query empty where the path carries none", () => {
    const found = match("GET", "/projects/TASM", entries);

    expect(found.ok && [...found.query]).toEqual([]);
  });

  it("decodes a param exactly once", () => {
    const found = match("GET", "/projects/TASM/tasks/TASM%252D3", entries);

    expect(found.ok && found.params.id).toBe("TASM%2D3");
  });

  it("refuses a segment holding an encoded separator rather than splitting the path on it", () => {
    expect(refusal(match("GET", "/projects/TASM%2Ftasks", entries)).code).toBe("malformed-request");
  });

  it("refuses a segment holding an encoded backslash", () => {
    expect(refusal(match("GET", "/projects/TASM%5Ctasks", entries)).code).toBe("malformed-request");
  });

  it("refuses a segment holding a NUL", () => {
    expect(refusal(match("GET", "/projects/TASM%00", entries)).code).toBe("malformed-request");
  });

  it("refuses a segment that decodes to a path climbing out of the project", () => {
    expect(refusal(match("GET", "/projects/%2E%2E%2F%2E%2E", entries)).code).toBe("malformed-request");
  });

  it("lands an encoded dot segment on the path a URL resolves it to", () => {
    // `..` is resolved away before matching, so the target reads as `/projects/TASM/`.
    expect(refusal(match("GET", "/projects/TASM/tasks/%2E%2E", entries)).code).toBe("route-not-found");
  });

  it("refuses a malformed escape", () => {
    expect(refusal(match("GET", "/projects/%zz", entries)).code).toBe("malformed-request");
  });

  it("refuses a target no URL can be built from", () => {
    expect(refusal(match("GET", "http://[", entries)).code).toBe("malformed-request");
  });

  it("refuses a target it could not read without quoting it back", () => {
    const targets = ["/projects/%2E%2E%2F%2E%2E<script>", "/projects/%zz<script>", "http://[<script>"];

    for (const target of targets) {
      expect(messageOf(match("GET", target, entries))).not.toContain("<script>");
    }
  });

  it("names the decoded path in each refusal matching itself produced", () => {
    expect(messageOf(match("GET", "/projects/TASM/notes", entries))).toContain("/projects/TASM/notes");
    expect(messageOf(match("DELETE", "/projects/TASM/tasks", entries))).toContain("/projects/TASM/tasks");
  });

  it("refuses a path no template matches", () => {
    expect(refusal(match("GET", "/projects/TASM/notes", entries)).code).toBe("route-not-found");
  });

  it("refuses a trailing slash rather than reading it as the path without one", () => {
    expect(refusal(match("GET", "/projects/", entries)).code).toBe("route-not-found");
  });

  it("refuses an empty segment inside the path", () => {
    expect(refusal(match("GET", "/projects//tasks", entries)).code).toBe("route-not-found");
  });

  it("names the methods a template does serve when the one asked for is not among them", () => {
    expect(refusal(match("DELETE", "/projects/TASM/tasks", entries))).toEqual({
      code: "method-not-allowed",
      allow: ["GET", "POST"],
    });
  });

  it("names a method once where two entries carry the same route", () => {
    const twice: RouteEntry[] = [
      { route: routes.health, handler },
      { route: routes.health, handler },
    ];

    expect(refusal(match("DELETE", "/health", twice))).toEqual({ code: "method-not-allowed", allow: ["GET"] });
  });

  it("refuses HEAD, which no route declares", () => {
    expect(refusal(match("HEAD", "/health", entries))).toEqual({ code: "method-not-allowed", allow: ["GET"] });
  });

  it("matches against the entries it is given rather than the whole table", () => {
    const only: RouteEntry[] = [{ route: routes.health, handler }];

    expect(refusal(match("GET", "/projects", only)).code).toBe("route-not-found");
  });
});
