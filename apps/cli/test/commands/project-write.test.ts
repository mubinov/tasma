import { describe, expect, it } from "vitest";
// Relative: this package declares no exports, so its own name does not resolve.
import { project } from "../../src/commands/project.js";
import type { Command } from "../../src/types.js";
import { CWD, HEALTH, HINT, ok, runCommand } from "../helpers.js";
import type { Ran } from "../helpers.js";

/** Runs a write verb of the noun against a server answering the table, and reports what it wrote. */
function runProject(args: string[], table: Record<string, unknown> = {}, options: { cwd?: string } = {}): Promise<Ran> {
  return runCommand(project, args, table, options);
}

const CREATED = "POST /projects";
const UPDATED = "PATCH /projects/TASM";
const RENAMED = "POST /projects/TASM/rename";
const DELETED = "DELETE /projects/TASM";

/** What a write of the planted project answers, and what the rename answers under the new tag. */
const WRITTEN = ok({ tag: "TASM", name: "tasma", path: "/srv/tasma" });
const MOVED = ok({ tag: "TAS", name: "tasma", path: "/srv/tasma" });

/** The object the write sent, which is the last call behind the probe that proved the address. */
async function sent(args: string[], table: Record<string, unknown>, options: { cwd?: string } = {}): Promise<unknown> {
  const { code, bodies } = await runProject(args, table, options);

  expect(code, args.join(" ")).toBe(0);

  return bodies.at(-1);
}

/** Asserts that an invocation was refused from argv alone, with the line it names and no call made. */
async function refuses(args: string[], line: string, options: { cwd?: string } = {}): Promise<void> {
  const { code, out, err, seen } = await runProject(args, {}, options);

  expect(code, args.join(" ")).toBe(2);
  expect(out, args.join(" ")).toBe("");
  expect(err, args.join(" ")).toBe(`tasma: ${line}\n${HINT}`);
  expect(seen, args.join(" ")).toEqual([]);
}

/** A refusal as the daemon answers one. */
function refusal(code: string, message: string): unknown {
  return { ok: false, error: { kind: "store", code, message } };
}

describe("project create", () => {
  it("sends the path alone where no other flag was typed, and prints the tag the daemon generated", async () => {
    const { code, out, err, seen, bodies } = await runProject(["create", "--path", "/srv/tasma"], { [CREATED]: WRITTEN });

    expect(code).toBe(0);
    expect(out).toBe("TASM\n");
    expect(err).toBe("");
    expect(seen).toEqual([HEALTH, CREATED]);
    expect(bodies.at(-1)).toEqual({ path: "/srv/tasma" });
  });

  it("sends the name and the tag as they were typed", async () => {
    expect(await sent(["create", "--path", "/srv/tasma", "--name", "Tasma app", "--tag", "tasm"], { [CREATED]: WRITTEN }))
      .toEqual({ path: "/srv/tasma", name: "Tasma app", tag: "tasm" });
  });

  it("writes the notes of the write after the tag", async () => {
    const { out, err } = await runProject(["create", "--path", "/srv/tasma"], {
      [CREATED]: ok({ tag: "TASM" }, [{ code: "path-missing", message: "no directory", path: "/srv/tasma" }]),
    });

    expect(out).toBe("TASM\n");
    expect(err).toBe("tasma: note: path-missing: no directory (/srv/tasma)\n");
  });

  it("reports a refusal the daemon answered with, at exit 1", async () => {
    const { code, out, err } = await runProject(["create", "--path", "/srv/tasma"], {
      [CREATED]: refusal("project-exists", 'a project tagged "TASM" exists'),
    });

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe('tasma: store/project-exists: a project tagged "TASM" exists\n');
  });

  it("refuses every fault visible from argv alone, before it reaches a daemon", async () => {
    await refuses(["create"], "project create needs --path <path>");
    await refuses(["create", "--path", ""], "project create needs --path <path>");
    await refuses(["create", "--name", "x"], "project create needs --path <path>");
    await refuses(["create", "--path", "/srv/tasma", "--name", ""], "--name needs a value");
    await refuses(["create", "--path", "/srv/tasma", "--tag", ""], "--tag needs a value");
    await refuses(["create", "--path", "/srv/tasma", "extra"], "project create takes no arguments: extra");
  });

  it("knows no --clear", async () => {
    const { code, err, seen } = await runProject(["create", "--path", "/srv/tasma", "--clear", "name"]);

    expect(code).toBe(2);
    expect(err).toContain("--clear");
    expect(seen).toEqual([]);
  });
});

describe("project edit", () => {
  it("sends only the keys that were typed, and prints the tag", async () => {
    const { code, out, err, seen, bodies } = await runProject(["edit", "TASM", "--name", "Tasma"], { [UPDATED]: WRITTEN });

    expect(code).toBe(0);
    expect(out).toBe("TASM\n");
    expect(err).toBe("");
    expect(seen).toEqual([HEALTH, UPDATED]);
    expect(bodies.at(-1)).toEqual({ name: "Tasma" });
  });

  it("sends the path and the name together", async () => {
    expect(await sent(["edit", "TASM", "--path", "/srv/other", "--name", "Other"], { [UPDATED]: WRITTEN }))
      .toEqual({ path: "/srv/other", name: "Other" });
  });

  it("sends --clear name as null, once where it was named twice", async () => {
    expect(await sent(["edit", "TASM", "--clear", "name"], { [UPDATED]: WRITTEN })).toEqual({ name: null });
    expect(await sent(["edit", "TASM", "--clear", "name", "--clear", "name"], { [UPDATED]: WRITTEN }))
      .toEqual({ name: null });
  });

  it("writes the notes of the write after the tag", async () => {
    const { out, err } = await runProject(["edit", "TASM", "--name", "Tasma"], {
      [UPDATED]: ok({ tag: "TASM" }, [{ code: "path-missing", message: "no directory" }]),
    });

    expect(out).toBe("TASM\n");
    expect(err).toBe("tasma: note: path-missing: no directory\n");
  });

  it("reports a refusal the daemon answered with, at exit 1", async () => {
    const { code, out, err } = await runProject(["edit", "TASM", "--name", "Tasma"], {
      [UPDATED]: refusal("project-not-found", 'no project of this tree is tagged "TASM"'),
    });

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe('tasma: store/project-not-found: no project of this tree is tagged "TASM"\n');
  });

  it("refuses every fault visible from argv alone, before it reaches a daemon", async () => {
    await refuses(["edit"], "project edit needs a project tag");
    await refuses(["edit", "", "--name", "x"], "project edit needs a project tag");
    await refuses(["edit", "a/b", "--name", "x"], "not a project tag: a/b");
    await refuses(["edit", "TASM", "extra", "--name", "x"], "project edit takes one argument: extra");
    await refuses(["edit", "TASM", "--path", ""], "--path needs a value");
    await refuses(["edit", "TASM", "--name", ""], "--name needs a value; --clear name removes the field");
    await refuses(["edit", "TASM", "--clear", ""], "--clear needs a field");
    await refuses(["edit", "TASM", "--clear", "path"], "not a clearable field: path");
    await refuses(["edit", "TASM", "--clear", "tag"], "not a clearable field: tag");
    await refuses(["edit", "TASM", "--clear", "name", "--name", "x"], "--clear name and --name exclude each other");
    await refuses(["edit", "TASM"], "project edit needs a change");
  });

  it("knows no --tag", async () => {
    const { code, err, seen } = await runProject(["edit", "TASM", "--tag", "NEW"]);

    expect(code).toBe(2);
    expect(err).toContain("--tag");
    expect(seen).toEqual([]);
  });
});

describe("project rename", () => {
  it("sends the new tag in the body, and prints the tag the answer carries", async () => {
    const { code, out, err, seen, bodies } = await runProject(["rename", "TASM", "TAS"], { [RENAMED]: MOVED });

    expect(code).toBe(0);
    expect(out).toBe("TAS\n");
    expect(err).toBe("");
    expect(seen).toEqual([HEALTH, RENAMED]);
    expect(bodies.at(-1)).toEqual({ tag: "TAS" });
  });

  it("sends a new tag no path component can hold, for the daemon to refuse", async () => {
    const { code, err, bodies } = await runProject(["rename", "TASM", "a/b"], {
      [RENAMED]: refusal("tag-invalid", 'the tag "a/b" holds a character other than a letter or a digit'),
    });

    expect(code).toBe(1);
    expect(bodies.at(-1)).toEqual({ tag: "a/b" });
    expect(err).toBe('tasma: store/tag-invalid: the tag "a/b" holds a character other than a letter or a digit\n');
  });

  it("writes the notes of the rename after the tag", async () => {
    const { out, err } = await runProject(["rename", "TASM", "TAS"], {
      [RENAMED]: ok({ tag: "TAS" }, [{ code: "task-file-foreign", message: "left as it stands", path: "/t/X-1.md" }]),
    });

    expect(out).toBe("TAS\n");
    expect(err).toBe("tasma: note: task-file-foreign: left as it stands (/t/X-1.md)\n");
  });

  it("reports a refusal the daemon answered with, at exit 1", async () => {
    const { code, out, err } = await runProject(["rename", "TASM", "TASM"], {
      [RENAMED]: refusal("project-exists", 'a project tagged "TASM" exists'),
    });

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe('tasma: store/project-exists: a project tagged "TASM" exists\n');
  });

  it("refuses every fault visible from argv alone, before it reaches a daemon", async () => {
    await refuses(["rename"], "project rename needs a project tag");
    await refuses(["rename", "", "TAS"], "project rename needs a project tag");
    await refuses(["rename", "a/b", "TAS"], "not a project tag: a/b");
    await refuses(["rename", "TASM"], "project rename needs a new tag");
    await refuses(["rename", "TASM", ""], "project rename needs a new tag");
    await refuses(["rename", "TASM", "TAS", "extra"], "project rename takes two arguments: extra");
  });
});

describe("project delete", () => {
  it("calls the route with no body at all, and prints the removed tag", async () => {
    const { code, out, err, seen, bodies } = await runProject(["delete", "TASM"], { [DELETED]: WRITTEN });

    expect(code).toBe(0);
    expect(out).toBe("TASM\n");
    expect(err).toBe("");
    expect(seen).toEqual([HEALTH, DELETED]);
    expect(bodies).toEqual([undefined, undefined]);
  });

  it("writes the notes of the delete after the tag", async () => {
    const { out, err } = await runProject(["delete", "TASM"], {
      [DELETED]: ok({ tag: "TASM" }, [{ code: "index-stale", message: "rebuilt" }]),
    });

    expect(out).toBe("TASM\n");
    expect(err).toBe("tasma: note: index-stale: rebuilt\n");
  });

  it("reports a refusal the daemon answered with, at exit 1", async () => {
    const { code, out, err } = await runProject(["delete", "TASM"], {
      [DELETED]: refusal("project-not-found", 'no project of this tree is tagged "TASM"'),
    });

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe('tasma: store/project-not-found: no project of this tree is tagged "TASM"\n');
  });

  it("refuses a missing tag, one that is no tag, and an extra argument", async () => {
    await refuses(["delete"], "project delete needs a project tag");
    await refuses(["delete", ""], "project delete needs a project tag");
    await refuses(["delete", "a/b"], "not a project tag: a/b");
    await refuses(["delete", "TASM", "extra"], "project delete takes one argument: extra");
  });
});

describe("the path a write sends", () => {
  it("is made absolute against the working directory where it was typed relative", async () => {
    expect(await sent(["create", "--path", "apps/cli"], { [CREATED]: WRITTEN })).toEqual({ path: `${CWD}/apps/cli` });
    expect(await sent(["create", "--path", "."], { [CREATED]: WRITTEN })).toEqual({ path: CWD });
    expect(await sent(["edit", "TASM", "--path", "../other"], { [UPDATED]: WRITTEN })).toEqual({ path: "/srv/other" });
  });

  it("is sent unchanged where it is absolute or starts with ~/", async () => {
    for (const path of ["/srv/tasma", "~/Projects/tasma"]) {
      expect(await sent(["create", "--path", path], { [CREATED]: WRITTEN }), path).toEqual({ path });
      expect(await sent(["edit", "TASM", "--path", path], { [UPDATED]: WRITTEN }), path).toEqual({ path });
    }
  });

  it("is sent unchanged where it is absolute and the working directory could not be read", async () => {
    expect(await sent(["create", "--path", "/srv/tasma"], { [CREATED]: WRITTEN }, { cwd: "" }))
      .toEqual({ path: "/srv/tasma" });
    expect(await sent(["edit", "TASM", "--path", "~/tasma"], { [UPDATED]: WRITTEN }, { cwd: "" }))
      .toEqual({ path: "~/tasma" });
  });

  it("is refused where it is relative and the working directory could not be read", async () => {
    const line = "the working directory could not be read; state --path as an absolute path";

    await refuses(["create", "--path", "tasma"], line, { cwd: "" });
    await refuses(["edit", "TASM", "--path", "tasma"], line, { cwd: "" });
  });

  it("is not read where the edit states no path", async () => {
    expect(await sent(["edit", "TASM", "--name", "Tasma"], { [UPDATED]: WRITTEN }, { cwd: "" })).toEqual({ name: "Tasma" });
  });
});

describe("every project write", () => {
  it("proves its address ahead of the call", async () => {
    const invocations: [string[], Record<string, unknown>, string][] = [
      [["create", "--path", "/srv/tasma"], { [CREATED]: WRITTEN }, CREATED],
      [["edit", "TASM", "--name", "Tasma"], { [UPDATED]: WRITTEN }, UPDATED],
      [["rename", "TASM", "TAS"], { [RENAMED]: MOVED }, RENAMED],
      [["delete", "TASM"], { [DELETED]: WRITTEN }, DELETED],
    ];

    for (const [args, table, route] of invocations) {
      const { code, seen } = await runProject(args, table);

      expect(code, args.join(" ")).toBe(0);
      expect(seen, args.join(" ")).toEqual([HEALTH, route]);
    }
  });

  it("refuses an answer that is not a write receipt", async () => {
    const invocations: [string[], string][] = [
      [["create", "--path", "/srv/tasma"], CREATED],
      [["edit", "TASM", "--name", "Tasma"], UPDATED],
      [["rename", "TASM", "TAS"], RENAMED],
      [["delete", "TASM"], DELETED],
    ];

    for (const [args, route] of invocations) {
      for (const data of [{ tag: 7 }, {}, "TASM", null]) {
        const { code, out, err } = await runProject(args, { [route]: ok(data) });

        expect(code, `${args.join(" ")} ${JSON.stringify(data)}`).toBe(3);
        expect(out).toBe("");
        expect(err).toContain("answered, but not with a write receipt\n");
      }
    }
  });
});

describe("every option a project write accepts", () => {
  /** The string options one write verb's parser takes, read off the registry rather than restated here. */
  function stringOptions(name: string): string[] {
    const verb: Command | undefined = (project.verbs ?? []).find((entry) => entry.name === name);

    return Object.entries(verb?.usage?.options ?? {})
      .filter(([, option]) => option.type === "string")
      .map(([flag]) => flag);
  }

  it("is refused with an empty value, before any call is made", async () => {
    for (const [verb, args] of [["create", ["create", "--path", "/srv/tasma"]], ["edit", ["edit", "TASM"]]] as const) {
      expect(stringOptions(verb).length, verb).toBeGreaterThan(0);

      for (const flag of stringOptions(verb)) {
        const { code, out, err, seen } = await runProject([...args, `--${flag}`, ""]);

        expect(code, `${verb} --${flag}`).toBe(2);
        expect(out, `${verb} --${flag}`).toBe("");
        expect(err, `${verb} --${flag}`).toContain(`--${flag}`);
        expect(seen, `${verb} --${flag}`).toEqual([]);
      }
    }
  });
});
