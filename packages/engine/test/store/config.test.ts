import { execFile as execFileCallback } from "node:child_process";
import { mkdir, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { inspect, promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { bareRoot, codes, plant, project, projectConfig, projectDir, storeError, tempRoot, userConfig } from "./helpers.js";

const execFile = promisify(execFileCallback);

const BUILT_IN_STATUSES = ["Backlog", "To Do", "In Progress", "Done"];

describe("resolution", () => {
  it("gives the built-in lists when neither file exists", async () => {
    const root = await tempRoot();

    const { config, diagnostics } = await project(root).config();

    expect(config).toEqual({
      statuses: BUILT_IN_STATUSES,
      default_status: "Backlog",
      priorities: ["high", "medium", "low"],
      workflows: [],
      instructions: [],
    });
    expect(diagnostics).toEqual([]);
  });

  it("takes the project value over the user value and does not merge the two lists", async () => {
    const root = await tempRoot();
    await plant(userConfig(root), "statuses: [Backlog, To Do, Done]\n");
    await plant(projectConfig(root), "statuses: [New, Doing]\n");

    const { config } = await project(root).config();

    expect(config.statuses).toEqual(["New", "Doing"]);
  });

  it("takes a key from the user file when the project file declares another key", async () => {
    const root = await tempRoot();
    await plant(userConfig(root), "priorities: [urgent, later]\n");
    await plant(projectConfig(root), "statuses: [New, Doing]\n");

    const { config } = await project(root).config();

    expect(config).toEqual({
      statuses: ["New", "Doing"],
      default_status: "New",
      priorities: ["urgent", "later"],
      workflows: [],
      instructions: [],
    });
  });

  it("falls back to the first entry of the resolved status list", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "statuses: [Triage, Doing]\n");

    expect((await project(root).config()).config.default_status).toBe("Triage");
  });

  it("reads a file that declares no keys as declaring none", async () => {
    const root = await tempRoot();
    await plant(userConfig(root), "# nothing but a comment\n");

    const { config, diagnostics } = await project(root).config();

    expect(config.statuses).toEqual(BUILT_IN_STATUSES);
    expect(diagnostics).toEqual([]);
  });
});

describe("unknown keys", () => {
  it("reports a key outside the recognized set and ignores its value", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "statues: [New]\n");

    const { config, diagnostics } = await project(root).config();

    expect(config.statuses).toEqual(BUILT_IN_STATUSES);
    expect(codes(diagnostics)).toEqual(["config-key-unknown"]);
    expect(diagnostics[0]?.path).toBe(projectConfig(root));
    expect(diagnostics[0]?.message).toContain("statues");
  });

  it("accepts the registry keys of the project file in silence", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "name: Tasma\npath: /Users/someone/Projects/tasma\n");

    expect((await project(root).config()).diagnostics).toEqual([]);
  });

  it("reports a registry key in the user file, where it belongs to no component", async () => {
    const root = await tempRoot();
    await plant(userConfig(root), "name: Tasma\n");

    expect(codes((await project(root).config()).diagnostics)).toEqual(["config-key-unknown"]);
  });
});

describe("a configuration file the engine refuses", () => {
  it("throws on YAML that does not parse", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "statuses: [New\n");

    const error = await storeError(project(root).config());

    expect(error.code).toBe("config-invalid");
    expect(error.path).toBe(projectConfig(root));
  });

  it("names the line it failed on and no text of the file", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "token: hunter2-SUPER-SECRET\nstatuses: [New]\n  indented: 1\n");

    const error = await storeError(project(root).config());

    expect(error.code).toBe("config-invalid");
    expect(error.message).toContain("line 3");
    expect(error.message).not.toContain("hunter2");
    // The read attaches no cause, so this guards a cause a later change adds.
    // inspect, not a string conversion: an object cause carrying the parser's
    // source frame renders as "[object Object]" and the check passes blind.
    expect(inspect(error.cause, { depth: null })).not.toContain("hunter2");
  });

  it("names the file alone for a fault the parser reports no position for", async () => {
    const root = await tempRoot();
    // More aliases than the library expands, which it refuses without reading a
    // position out of the source.
    await plant(
      projectConfig(root),
      `a: &a [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]
c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]
d: [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]
`,
    );

    const error = await storeError(project(root).config());

    expect(error.code).toBe("config-invalid");
    expect(error.message).not.toContain("line");
  });

  it("throws on a file that is not a mapping", async () => {
    const root = await tempRoot();
    await plant(userConfig(root), "- Backlog\n- Done\n");

    expect((await storeError(project(root).config())).code).toBe("config-invalid");
  });

  it.each([
    ["a set", "!!set\n? statuses\n? priorities\n"],
    ["an ordered mapping", "!!omap\n- statuses: [New]\n"],
    ["a timestamp", "!!timestamp 2001-12-15T02:59:43\n"],
  ])("throws on %s, which declares nothing a walk over its entries can see", async (_name, text) => {
    const root = await tempRoot();
    await plant(projectConfig(root), text);

    expect((await storeError(project(root).config())).code).toBe("config-invalid");
  });

  it.each([
    ["statuses that is not a list", "statuses: Backlog\n"],
    ["statuses that holds a value that is not a string", "statuses: [Backlog, 2]\n"],
    ["an empty status list", "statuses: []\n"],
    ["an empty priority list", "priorities: []\n"],
    ["a default_status that is not a string", "default_status: 3\n"],
  ])("throws on %s", async (_name, text) => {
    const root = await tempRoot();
    await plant(projectConfig(root), text);

    const error = await storeError(project(root).config());

    expect(error.code).toBe("config-invalid");
    expect(error.path).toBe(projectConfig(root));
  });

  it("checks default_status against the resolved list, not against the file it stands in", async () => {
    const root = await tempRoot();
    await plant(userConfig(root), "statuses: [Backlog, Done]\ndefault_status: Backlog\n");
    await plant(projectConfig(root), "statuses: [New, Doing, Done]\n");

    const error = await storeError(project(root).config());

    expect(error.code).toBe("config-invalid");
    expect(error.message).toContain(userConfig(root));
    expect(error.message).toContain(projectConfig(root));
  });

  it("names the built-in defaults when the status list has no file behind it", async () => {
    const root = await tempRoot();
    await plant(userConfig(root), "default_status: Later\n");

    expect((await storeError(project(root).config())).message).toContain("built-in");
  });

  it("accepts a default_status the resolved list carries", async () => {
    const root = await tempRoot();
    await plant(userConfig(root), "default_status: Done\n");

    expect((await project(root).config()).config.default_status).toBe("Done");
  });
});

describe("a configuration name that holds no regular file", () => {
  it.each([
    ["a directory", async (path: string) => mkdir(path, { recursive: true })],
    [
      "a pipe, which an open would otherwise wait on",
      async (path: string) => {
        await execFile("mkfifo", [path]);
      },
    ],
  ])("is refused as config-invalid at the project level, for %s", async (_name, stage) => {
    const root = await tempRoot();
    await stage(projectConfig(root));

    const error = await storeError(project(root).config());

    expect(error.code).toBe("config-invalid");
    expect(error.path).toBe(projectConfig(root));
  });

  it("is refused at the user level too, so both levels follow one rule", async () => {
    const root = await tempRoot();
    await execFile("mkfifo", [userConfig(root)]);

    const error = await storeError(project(root).config());

    expect(error.code).toBe("config-invalid");
    expect(error.path).toBe(userConfig(root));
  });
});

describe("a configuration file a symbolic link points at", () => {
  it("is read and its keys resolved, because the user places both configuration files", async () => {
    const elsewhere = await bareRoot();
    const outside = join(elsewhere, "tasma.yml");
    await plant(outside, "statuses: [New, Doing]\ndefault_status: Doing\n");
    const root = await tempRoot();
    await symlink(outside, projectConfig(root));

    const { config, diagnostics } = await project(root).config();

    expect(config.statuses).toEqual(["New", "Doing"]);
    expect(config.default_status).toBe("Doing");
    expect(diagnostics).toEqual([]);
  });
});

describe("workflows_path", () => {
  it("resolves a relative value against the directory holding the user file", async () => {
    const root = await tempRoot();
    await plant(userConfig(root), "workflows_path: flows\n");

    expect((await project(root).config()).config.workflows_path).toBe(join(root, "flows"));
  });

  it("expands a value that starts with a tilde", async () => {
    const root = await tempRoot();
    await plant(userConfig(root), "workflows_path: ~/flows\n");

    expect((await project(root).config()).config.workflows_path).toBe(join(homedir(), "flows"));
  });

  it("keeps an absolute value as it stands", async () => {
    const root = await tempRoot();
    await plant(userConfig(root), "workflows_path: /srv/flows\n");

    expect((await project(root).config()).config.workflows_path).toBe("/srv/flows");
  });

  it("is absent when no file states the key", async () => {
    const root = await tempRoot();

    expect((await project(root).config()).config.workflows_path).toBeUndefined();
  });

  it("reads the key written with no value as absent", async () => {
    const root = await tempRoot();
    await plant(userConfig(root), "workflows_path:\n");

    const { config, diagnostics } = await project(root).config();

    expect(config.workflows_path).toBeUndefined();
    expect(diagnostics).toEqual([]);
  });

  it.each([
    ["a value that is not a string", "workflows_path: [flows]\n", "must be a string"],
    ["the empty string, which would resolve to the root itself", 'workflows_path: ""\n', "must not be empty"],
  ])("refuses %s", async (_name, text, expected) => {
    const root = await tempRoot();
    await plant(userConfig(root), text);

    const error = await storeError(project(root).config());

    expect(error.code).toBe("config-invalid");
    expect(error.path).toBe(userConfig(root));
    expect(error.message).toContain(expected);
  });

  it("is no key of the project file, so a project cannot override it", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "workflows_path: flows\n");

    const { config, diagnostics } = await project(root).config();

    expect(config.workflows_path).toBeUndefined();
    expect(codes(diagnostics)).toEqual(["config-key-unknown"]);
    expect(diagnostics[0]?.message).toContain("workflows_path");
  });
});

describe("name and path", () => {
  it("reads both from the project file", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "name: Tasma\npath: /srv/tasma\n");

    const { config, diagnostics } = await project(root).config();

    expect(config.name).toBe("Tasma");
    expect(config.path).toBe("/srv/tasma");
    expect(diagnostics).toEqual([]);
  });

  it("leaves both absent when the project declares neither", async () => {
    const root = await tempRoot();

    const { config } = await project(root).config();

    expect(config.name).toBeUndefined();
    expect(config.path).toBeUndefined();
  });

  it("resolves a relative path against the directory holding the project file", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "path: repository\n");

    expect((await project(root).config()).config.path).toBe(join(projectDir(root), "repository"));
  });

  it("expands a path that starts with a tilde", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "path: ~/Projects/tasma\n");

    expect((await project(root).config()).config.path).toBe(join(homedir(), "Projects", "tasma"));
  });

  it.each([
    ["a name that is not a string", "name: [Tasma]\n", "must be a string"],
    ["a path that is not a string", "path: 3\n", "must be a string"],
    ["the empty path, which would resolve to the project directory", 'path: ""\n', "must not be empty"],
    ["the empty name, which would reach a reader as a blank label", 'name: ""\n', "must not be empty"],
  ])("refuses %s", async (_name, text, expected) => {
    const root = await tempRoot();
    await plant(projectConfig(root), text);

    const error = await storeError(project(root).config());

    expect(error.code).toBe("config-invalid");
    expect(error.path).toBe(projectConfig(root));
    expect(error.message).toContain(expected);
  });

  it("reads neither key from the user file, where they describe no one project", async () => {
    const root = await tempRoot();
    await plant(userConfig(root), "name: Tasma\npath: /srv/tasma\n");

    const { config, diagnostics } = await project(root).config();

    expect(config.name).toBeUndefined();
    expect(config.path).toBeUndefined();
    expect(codes(diagnostics)).toEqual(["config-key-unknown", "config-key-unknown"]);
  });
});
