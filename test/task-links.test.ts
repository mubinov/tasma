import { DEFAULT_DAEMON_URL } from "@tasma/protocol";
import { describe, expect, it } from "vitest";
import { SERVED_HOSTS } from "../apps/daemon/src/http/server.js";
import { taskIdOf, taskLinkSegment } from "../apps/daemon/src/http/task-link.js";
import { DAEMON_HOSTS, linkKind } from "../apps/web/src/lib/link-kind.js";

/** Segments in the grammar of the daemon page and around its limits. */
const SEGMENTS = [
  "AB-1",
  "ab-12",
  "Ab7-9999",
  "A1-1",
  "ABCDEFGH-1",
  "ABCDEFGHI-1",
  "A-1",
  "-1",
  "1AB-1",
  "AB",
  "AB-",
  "AB--1",
  "AB-1a",
  "AB-+1",
  "AB_C-1",
  "AB%2D1",
  "SAG%C3%80-1",
  "%C5%BFaga-1",
  "ſaga-1",
];

/** Request targets around the path of the daemon page. */
const TARGETS = [
  ...SEGMENTS.map((segment) => `/task/${segment}`),
  "/task/AB-1/",
  "/task/AB-1//",
  "/task//AB-1",
  "/task/AB-1/x",
  "/task/AB-1?chat=2",
  "/task/",
  "/task",
  "/tasks/AB-1",
  "/TASK/AB-1",
  "/x/task/AB-1",
];

function daemonIdOf(target: string): string | undefined {
  const segment = taskLinkSegment("GET", target);
  return segment === undefined ? undefined : taskIdOf(segment);
}

function boardIdOf(target: string): string | undefined {
  const kind = linkKind(`${DEFAULT_DAEMON_URL}${target}`);
  return kind?.kind === "task" ? kind.id : undefined;
}

describe("a task link of the http form", () => {
  it.each(TARGETS)("names the same task on the board as on the daemon page: %s", (target) => {
    expect(boardIdOf(target)).toBe(daemonIdOf(target));
  });

  it("is tested with targets both readers accept and targets both refuse", () => {
    const ids = TARGETS.map(daemonIdOf);

    expect(ids.filter((id) => id !== undefined)).toEqual([
      "AB-1",
      "AB-12",
      "AB7-9999",
      "A1-1",
      "ABCDEFGH-1",
      "AB-1",
      "AB-1",
    ]);
    expect(ids).toContain(undefined);
  });

  it("reads the same host names as the daemon", () => {
    expect([...DAEMON_HOSTS].toSorted()).toEqual([...SERVED_HOSTS].toSorted());
  });
});
