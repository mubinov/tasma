import { describe, expect, it } from "vitest";
import { buildPath, routes } from "@tasma/protocol";
import type { Route, TaskFilter } from "@tasma/protocol";

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
    expect(buildPath(routes.readTask, { project: "a b", id: "x/y" })).toBe("/projects/a%20b/tasks/x%2Fy");
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
