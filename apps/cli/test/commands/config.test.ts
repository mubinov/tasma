import { describe, expect, it } from "vitest";
// Relative: this package declares no exports, so its own name does not resolve.
import { config } from "../../src/commands/config.js";
import { HEALTH, HINT, ok, runCommand } from "../helpers.js";
import type { Ran } from "../helpers.js";

/** Runs a verb of this noun against a server answering the table, and reports what it wrote. */
function runConfig(args: string[], table: Record<string, unknown> = {}, options: { cwd?: string } = {}): Promise<Ran> {
  return runCommand(config, args, table, options);
}

/** Asserts that an invocation was refused from argv alone, with the line it names and no call made. */
async function refuses(args: string[], line: string, options: { cwd?: string } = {}): Promise<void> {
  const { code, out, err, seen } = await runConfig(args, {}, options);

  expect(code, args.join(" ")).toBe(2);
  expect(out, args.join(" ")).toBe("");
  expect(err, args.join(" ")).toBe(`tasma: ${line}\n${HINT}`);
  expect(seen, args.join(" ")).toEqual([]);
}

const READ = "GET /config";
const UPDATED = "PATCH /config";

const FILE = "/Users/x/.tasma/config.yml";

/** The user's file as the daemon answers it: statuses and workflows_path set, the rest built in. */
const ANSWER = {
  path: FILE,
  statuses: { value: ["New", "Doing", "Done"], set: true },
  default_status: { value: "New", set: false },
  final_statuses: { value: ["Done"], set: false },
  priorities: { value: ["high", "medium", "low"], set: false },
  workflows_path: { value: "/Users/x/flows", set: true },
};

/** The object the edit sent, which is the last call behind the probe that proved the address. */
async function sent(args: string[], options: { cwd?: string } = {}): Promise<unknown> {
  const { code, bodies } = await runConfig(args, { [UPDATED]: ok(ANSWER) }, options);

  expect(code, args.join(" ")).toBe(0);

  return bodies.at(-1);
}

describe("config view", () => {
  it("prints the file, then each key, marking a key the file does not set", async () => {
    const { code, out, err, seen } = await runConfig(["view"], { [READ]: ok(ANSWER) });

    expect(code).toBe(0);
    expect(out).toBe(
      [
        `file            ${FILE}`,
        "statuses        New",
        "                Doing",
        "                Done",
        "default_status  New   (built-in default)",
        "final_statuses  Done  (built-in default)",
        "priorities      high  (built-in default)",
        "                medium",
        "                low",
        "workflows_path  /Users/x/flows",
        "",
      ].join("\n"),
    );
    expect(err).toBe("");
    expect(seen).toEqual([READ]);
  });

  it("writes the notes of the read to stderr", async () => {
    const { out, err } = await runConfig(["view"], {
      [READ]: ok(ANSWER, [{ code: "config-key-unknown", message: "not a key", path: FILE }]),
    });

    expect(out).toContain("file");
    expect(err).toBe(`tasma: note: config-key-unknown: not a key (${FILE})\n`);
  });

  it("refuses an answer that is not a configuration", async () => {
    for (const data of ["x", null, { path: FILE }, { ...ANSWER, path: 3 }, { ...ANSWER, priorities: { value: [] } }]) {
      const { code, out, err } = await runConfig(["view"], { [READ]: ok(data) });

      expect(code, JSON.stringify(data)).toBe(3);
      expect(out, JSON.stringify(data)).toBe("");
      expect(err, JSON.stringify(data)).toContain("answered, but not with a configuration\n");
    }
  });

  it("takes no arguments", async () => {
    await refuses(["view", "extra"], "config view takes no arguments: extra");
  });

  it("prints its usage block for --help, reaching no daemon", async () => {
    const { code, out, seen } = await runConfig(["view", "--help"]);

    expect(code).toBe(0);
    expect(out).toBe("Usage: tasma config view\n\n  -h, --help  Print this help\n");
    expect(seen).toEqual([]);
  });
});

describe("config edit", () => {
  it.each<[string[], unknown]>([
    [["--status", "New"], { statuses: ["New"] }],
    [["--default-status", "New"], { default_status: "New" }],
    [["--final-status", "Done"], { final_statuses: ["Done"] }],
    [["--priority", "urgent"], { priorities: ["urgent"] }],
    [["--workflows-path", "/srv/flows"], { workflows_path: "/srv/flows" }],
  ])("sends %j as the key it sets", async (flags, body) => {
    expect(await sent(["edit", ...flags])).toEqual(body);
  });

  it("sends a repeated flag as a list, in the order typed", async () => {
    expect(await sent(["edit", "--status", "New", "--status", "Doing", "--status", "Done"]))
      .toEqual({ statuses: ["New", "Doing", "Done"] });
  });

  it("sends every flag of one invocation in one change, and prints the path of the file", async () => {
    const { code, out, err, seen, bodies } = await runConfig(
      ["edit", "--status", "New", "--status", "Done", "--default-status", "New", "--clear", "priorities"],
      { [UPDATED]: ok(ANSWER) },
    );

    expect(code).toBe(0);
    expect(out).toBe(`${FILE}\n`);
    expect(err).toBe("");
    expect(seen).toEqual([HEALTH, UPDATED]);
    expect(bodies.at(-1)).toEqual({ statuses: ["New", "Done"], default_status: "New", priorities: null });
  });

  it("sends a clear as null", async () => {
    expect(await sent(["edit", "--clear", "workflows_path", "--clear", "final_statuses"]))
      .toEqual({ workflows_path: null, final_statuses: null });
  });

  it("makes a relative --workflows-path absolute against the working directory", async () => {
    expect(await sent(["edit", "--workflows-path", "flows"], { cwd: "/srv/repo" }))
      .toEqual({ workflows_path: "/srv/repo/flows" });
  });

  it("sends a ~/ --workflows-path as typed", async () => {
    expect(await sent(["edit", "--workflows-path", "~/flows"], { cwd: "" })).toEqual({ workflows_path: "~/flows" });
  });

  it("refuses a relative --workflows-path where the working directory could not be read", async () => {
    await refuses(
      ["edit", "--workflows-path", "flows"],
      "the working directory could not be read; state --workflows-path as an absolute path",
      { cwd: "" },
    );
  });

  it("refuses a field no clear names", async () => {
    await refuses(["edit", "--clear", "workflows"], "not a clearable field: workflows");
  });

  it("refuses a clear beside a flag that sets the same field", async () => {
    await refuses(["edit", "--clear", "statuses", "--status", "New"], "--clear statuses and --status exclude each other");
  });

  it("refuses an empty value", async () => {
    await refuses(["edit", "--default-status", ""], "--default-status needs a value; --clear default_status removes the field");
  });

  it("refuses an invocation that changes nothing", async () => {
    await refuses(["edit"], "config edit needs a change");
  });

  it("takes no arguments", async () => {
    await refuses(["edit", "extra"], "config edit takes no arguments: extra");
  });

  it("reports a refusal the daemon answered with, at exit 1", async () => {
    const { code, out, err } = await runConfig(["edit", "--status", "New"], {
      [UPDATED]: { ok: false, error: { kind: "store", code: "config-change-invalid", message: "project SAGA: no" } },
    });

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe("tasma: store/config-change-invalid: project SAGA: no\n");
  });

  it("refuses an answer that carries no path", async () => {
    const { code, out, err } = await runConfig(["edit", "--status", "New"], { [UPDATED]: ok({}) });

    expect(code).toBe(3);
    expect(out).toBe("");
    expect(err).toContain("answered, but not with a configuration\n");
  });

  it("lists every flag in its help", async () => {
    const { code, out } = await runConfig(["edit", "--help"]);

    expect(code).toBe(0);
    for (const flag of ["--status", "--default-status", "--final-status", "--priority", "--workflows-path", "--clear"]) {
      expect(out, flag).toContain(`${flag} <`);
    }
    expect(out).toContain("Remove a field: statuses, default_status, final_statuses, priorities, workflows_path");
  });
});
