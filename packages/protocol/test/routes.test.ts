import { describe, expect, it } from "vitest";
import { buildPath, routes } from "@tasma/protocol";
import type { Route, TaskFilter, TaskReadOptions } from "@tasma/protocol";

/** The placeholder names the client fills, which is every name a template may use. */
const SUPPLIED_PLACEHOLDERS = ["project", "id", "commentId"];

function placeholdersOf(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!);
}

const routeEntries = Object.entries(routes) as [string, Route][];

describe("the route table", () => {
  it("declares a distinct template for every route", () => {
    const signatures = routeEntries.map(([, route]) => `${route.method} ${route.template}`);
    expect(new Set(signatures).size).toBe(signatures.length);
  });

  it("uses only placeholders the client supplies", () => {
    for (const [name, route] of routeEntries) {
      for (const placeholder of placeholdersOf(route.template)) {
        expect(SUPPLIED_PLACEHOLDERS, `${name} names a placeholder the client cannot fill`).toContain(placeholder);
      }
    }
  });

  it("carries one template under two methods where a route reads what another writes", () => {
    expect(routes.listComments.template).toBe(routes.addComment.template);
    expect(routes.listComments.method).not.toBe(routes.addComment.method);
  });
});

describe("buildPath", () => {
  it("fills every placeholder of a template", () => {
    expect(buildPath(routes.updateComment, { project: "TASM", id: "TASM-3", commentId: 7 })).toBe(
      "/projects/TASM/tasks/TASM-3/comments/7",
    );
  });

  it("leaves a template without placeholders alone", () => {
    expect(buildPath(routes.listProjects, {})).toBe("/projects");
  });

  it("percent-encodes every filled segment", () => {
    expect(buildPath(routes.readTask, { project: "a b", id: "x?y#z" })).toBe("/projects/a%20b/tasks/x%3Fy%23z");
  });

  it("refuses a placeholder no parameter fills", () => {
    expect(() => buildPath(routes.readTask, { project: "TASM" })).toThrow(/id/);
  });

  it("refuses a placeholder filled only by the prototype chain", () => {
    const route: Route = { method: "GET", template: "/projects/{toString}" };
    expect(() => buildPath(route, {})).toThrow(/toString/);
  });

  it.each([
    ["a segment a URL removes", "."],
    ["a segment a URL climbs out of", ".."],
    ["an empty segment", ""],
    ["a value carrying a separator", "x/y"],
    ["a value carrying a backslash", "x\\y"],
    ["a value carrying a terminator", "x\0y"],
  ])("refuses %s", (_description, id) => {
    expect(() => buildPath(routes.readTask, { project: "TASM", id })).toThrow(/id/);
  });

  it("percent-encodes every query key and value", () => {
    expect(buildPath(routes.listTasks, { project: "TASM" }, { "a b": "In Progress" })).toBe(
      "/projects/TASM/tasks?a%20b=In%20Progress",
    );
  });

  it("joins several query keys", () => {
    const filter: TaskFilter = { status: "To Do", priority: "high" };
    expect(buildPath(routes.listTasks, { project: "TASM" }, filter)).toBe(
      "/projects/TASM/tasks?status=To%20Do&priority=high",
    );
  });

  it("repeats a repeatable key once per entry", () => {
    const filter: TaskFilter = { label: ["dev", "ui"] };
    expect(buildPath(routes.listTasks, { project: "TASM" }, filter)).toBe("/projects/TASM/tasks?label=dev&label=ui");
  });

  it.each([true, false])("writes the boolean filter value %s out in full", (blocked) => {
    const filter: TaskFilter = { blocked };
    expect(buildPath(routes.listTasks, { project: "TASM" }, filter)).toBe(`/projects/TASM/tasks?blocked=${blocked}`);
  });

  it("omits the boolean filter the caller left absent", () => {
    const filter: TaskFilter = { blocked: undefined, status: "To Do" };
    expect(buildPath(routes.listTasks, { project: "TASM" }, filter)).toBe("/projects/TASM/tasks?status=To%20Do");
  });

  it("writes a read option out as a query key", () => {
    const options: TaskReadOptions = { comments: false };
    expect(buildPath(routes.readTask, { project: "TASM", id: "TASM-3" }, options)).toBe(
      "/projects/TASM/tasks/TASM-3?comments=false",
    );
  });

  it("omits a read option the caller left absent", () => {
    const options: TaskReadOptions = {};
    expect(buildPath(routes.readTask, { project: "TASM", id: "TASM-3" }, options)).toBe("/projects/TASM/tasks/TASM-3");
  });

  it("omits an absent key", () => {
    const filter: TaskFilter = { status: undefined, parent: "TASM-1" };
    expect(buildPath(routes.listTasks, { project: "TASM" }, filter)).toBe("/projects/TASM/tasks?parent=TASM-1");
  });

  it("omits an empty repeatable key", () => {
    const filter: TaskFilter = { label: [] };
    expect(buildPath(routes.listTasks, { project: "TASM" }, filter)).toBe("/projects/TASM/tasks");
  });

  it("omits the query altogether when no key survives", () => {
    expect(buildPath(routes.listTasks, { project: "TASM" }, {})).toBe("/projects/TASM/tasks");
    expect(buildPath(routes.listTasks, { project: "TASM" })).toBe("/projects/TASM/tasks");
  });
});
