import { chmod, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { readUserConfig, type UserConfigChange, type UserConfigInfo, updateUserConfig } from "@tasma/engine";
import { plantWorkflow, stepsOnly } from "../workflow/helpers.js";
import {
  bareRoot,
  codes,
  folderIn,
  plant,
  projectConfig,
  projectDir,
  read,
  storeError,
  tempRoot,
  userConfig,
} from "./helpers.js";

/** One write of the user's file of a tree. */
function edit(root: string, change: UserConfigChange): Promise<UserConfigInfo> {
  return updateUserConfig(root, change);
}

/** The value of every key, without the `set` flags. */
function values(info: UserConfigInfo): Record<string, unknown> {
  return {
    statuses: info.statuses.value,
    default_status: info.default_status.value,
    final_statuses: info.final_statuses.value,
    priorities: info.priorities.value,
    workflows_path: info.workflows_path.value,
  };
}

/** The `set` flag of every key. */
function setFlags(info: UserConfigInfo): Record<string, boolean> {
  return {
    statuses: info.statuses.set,
    default_status: info.default_status.set,
    final_statuses: info.final_statuses.set,
    priorities: info.priorities.set,
    workflows_path: info.workflows_path.set,
  };
}

const BUILT_IN = {
  statuses: ["Backlog", "To Do", "In Progress", "Done"],
  default_status: "Backlog",
  final_statuses: ["Done"],
  priorities: ["high", "medium", "low"],
};

const NONE_SET = {
  statuses: false,
  default_status: false,
  final_statuses: false,
  priorities: false,
  workflows_path: false,
};

describe("reading the user's configuration", () => {
  it("answers the built-in defaults, none of them set, where the file is absent", async () => {
    const root = await bareRoot();

    const info = await readUserConfig(root);

    expect(info.path).toBe(userConfig(root));
    expect(values(info)).toEqual({ ...BUILT_IN, workflows_path: join(root, "workflows") });
    expect(setFlags(info)).toEqual(NONE_SET);
    expect(info.diagnostics).toEqual([]);
  });

  it("marks each key the file sets", async () => {
    const root = await bareRoot();
    const flows = await folderIn(root, "flows");
    const text = [
      "statuses: [New, Doing, Shipped]",
      "default_status: Doing",
      "final_statuses: [Shipped]",
      "priorities: [urgent, later]",
      `workflows_path: ${flows}`,
      "",
    ].join("\n");
    await plant(userConfig(root), text);

    const info = await readUserConfig(root);

    expect(values(info)).toEqual({
      statuses: ["New", "Doing", "Shipped"],
      default_status: "Doing",
      final_statuses: ["Shipped"],
      priorities: ["urgent", "later"],
      workflows_path: flows,
    });
    expect(Object.values(setFlags(info))).toEqual([true, true, true, true, true]);
  });

  it("reads a key written with no value as not set", async () => {
    const root = await bareRoot();
    await plant(userConfig(root), "statuses:\ndefault_status: ~\n");

    expect(setFlags(await readUserConfig(root))).toEqual(NONE_SET);
  });

  it("resolves a relative workflows_path against the root, and a ~/ path against the home directory", async () => {
    const root = await bareRoot();
    await plant(userConfig(root), "workflows_path: flows\n");
    expect((await readUserConfig(root)).workflows_path.value).toBe(join(root, "flows"));

    await plant(userConfig(root), "workflows_path: ~/flows\n");
    expect((await readUserConfig(root)).workflows_path.value).toBe(join(homedir(), "flows"));
  });

  it("reports a key it does not know", async () => {
    const root = await bareRoot();
    await plant(userConfig(root), "statuse: [New]\n");

    expect(codes((await readUserConfig(root)).diagnostics)).toEqual(["config-key-unknown"]);
  });

  it.each([
    ["is no valid YAML", "statuses: [\n"],
    ["holds statuses that are no list", "statuses: New\n"],
    ["states a default_status the built-in statuses lack", "default_status: Review\n"],
  ])("refuses a file that %s", async (_reason, text) => {
    const root = await bareRoot();
    await plant(userConfig(root), text);

    expect((await storeError(readUserConfig(root))).code).toBe("config-invalid");
  });
});

describe("writing the user's configuration", () => {
  it.each<[string, UserConfigChange, Record<string, unknown>]>([
    ["statuses", { statuses: ["New", "Backlog"] }, { statuses: ["New", "Backlog"], final_statuses: ["Backlog"] }],
    ["default_status", { default_status: "Done" }, { default_status: "Done" }],
    ["final_statuses", { final_statuses: ["Done", "To Do"] }, { final_statuses: ["Done", "To Do"] }],
    ["priorities", { priorities: ["urgent", "later"] }, { priorities: ["urgent", "later"] }],
  ])("sets %s, which the read answers as set", async (key, change, expected) => {
    const root = await tempRoot();

    const info = await edit(root, change);

    expect(values(info)).toMatchObject(expected);
    expect(setFlags(info)[key]).toBe(true);
  });

  it("sets an absolute workflows_path, stored as given", async () => {
    const root = await tempRoot();
    const flows = await folderIn(root, "flows");

    const info = await edit(root, { workflows_path: flows });

    expect(info.workflows_path).toEqual({ value: flows, set: true });
    expect(await read(userConfig(root))).toBe(`workflows_path: ${flows}\n`);
  });

  it("stores a ~/ workflows_path as given and resolves it on read", async () => {
    const root = await tempRoot();
    const flows = await folderIn(root, "flows");
    const fromHome = `~/${relative(homedir(), flows)}`;

    const info = await edit(root, { workflows_path: fromHome });

    expect(info.workflows_path.value).toBe(flows);
    expect(await read(userConfig(root))).toBe(`workflows_path: ${fromHome}\n`);
  });

  it.each<keyof UserConfigChange>(["statuses", "default_status", "final_statuses", "priorities", "workflows_path"])(
    "clears %s, which then takes its built-in default",
    async (key) => {
      const root = await tempRoot();
      const flows = await folderIn(root, "flows");
      await plant(
        userConfig(root),
        `statuses: [Backlog, To Do, In Progress, Done]\ndefault_status: To Do\nfinal_statuses: [Done]\npriorities: [urgent]\nworkflows_path: ${flows}\n`,
      );

      const info = await edit(root, { [key]: null });

      expect(setFlags(info)[key]).toBe(false);
      expect(await read(userConfig(root))).not.toMatch(new RegExp(`^${key}:`, "m"));
    },
  );

  it("keeps comments, key order and keys it does not know", async () => {
    const root = await tempRoot();
    await plant(userConfig(root), "# Machine rules.\npriorities: [urgent] # short list\nlater_key: kept\n");

    const info = await edit(root, { priorities: ["urgent", "later"] });

    expect(await read(userConfig(root))).toBe(
      "# Machine rules.\npriorities: [ urgent, later ] # short list\nlater_key: kept\n",
    );
    expect(codes(info.diagnostics)).toEqual(["config-key-unknown"]);
  });

  it("creates a missing file, and the root it stands in", async () => {
    const root = join(await bareRoot(), "tree");

    await edit(root, { priorities: ["urgent"] });

    expect(await read(userConfig(root))).toBe("priorities:\n  - urgent\n");
  });

  it.each<[string, UserConfigChange]>([
    ["names no key", {}],
    ["clears a key the file does not state", { statuses: null }],
  ])("writes nothing for a change that %s", async (_reason, change) => {
    const root = await bareRoot();

    await edit(root, change);

    await expect(readdir(root)).resolves.toEqual([]);
  });

  it("refuses a symbolic link at the file", async () => {
    const root = await tempRoot();
    const target = join(root, "real.yml");
    await writeFile(target, "priorities: [urgent]\n");
    await symlink(target, userConfig(root));

    expect((await storeError(edit(root, { priorities: ["later"] }))).code).toBe("config-invalid");
    expect(await read(target)).toBe("priorities: [urgent]\n");
  });

  it("refuses a key that is not one of the five", async () => {
    const root = await tempRoot();

    const change = { workflows: ["review"] } as UserConfigChange;
    expect((await storeError(edit(root, change))).code).toBe("field-not-writable");
  });

  it.each<[string, UserConfigChange]>([
    ["an empty list", { statuses: [] }],
    ["a repeated entry", { priorities: ["urgent", "urgent"] }],
    ["a list of another type", { final_statuses: "Done" as unknown as string[] }],
    ["an empty default_status", { default_status: "" }],
    ["a default_status of another type", { default_status: 3 as unknown as string }],
    ["an empty workflows_path", { workflows_path: "" }],
    ["a workflows_path of another type", { workflows_path: 3 as unknown as string }],
    ["a default_status the statuses lack", { statuses: ["New", "Done"], default_status: "Doing" }],
    ["statuses that drop the stored default_status", { statuses: ["New", "Done"] }],
  ])("refuses %s as config-change-invalid and writes nothing", async (_reason, change) => {
    const root = await tempRoot();
    const text = "# Kept.\ndefault_status: Backlog\n";
    await plant(userConfig(root), text);

    expect((await storeError(edit(root, change))).code).toBe("config-change-invalid");
    expect(await read(userConfig(root))).toBe(text);
  });

  it.each([
    ["is relative", async () => "flows"],
    ["names a file", async (root: string) => {
      const file = join(root, "flows.txt");
      await writeFile(file, "");
      return file;
    }],
    ["names nothing", async (root: string) => join(root, "gone")],
  ])("refuses a workflows_path that %s as path-invalid and writes nothing", async (_reason, stated) => {
    const root = await tempRoot();

    expect((await storeError(edit(root, { workflows_path: await stated(root) }))).code).toBe("path-invalid");
    await expect(readdir(root)).resolves.not.toContain("config.yml");
  });

  it("refuses a change whose conflict involves no key of it as a fault of the file on disk", async () => {
    const root = await tempRoot();
    const text = "statuses: [New, Doing]\ndefault_status: Shipped\n";
    await plant(userConfig(root), text);

    expect((await storeError(edit(root, { priorities: ["urgent"] }))).code).toBe("config-invalid");
    expect(await read(userConfig(root))).toBe(text);
  });

  it.each<[string, string, (root: string) => Promise<UserConfigChange>]>([
    ["statuses that conflict, for a change of workflows_path", "statuses: [A, B]\ndefault_status: C\n", async (root) => ({
      workflows_path: await folderIn(root, "flows"),
    })],
    ["a workflows_path the reader refuses, for a change of priorities", "workflows_path: 5\n", async () => ({
      priorities: ["urgent"],
    })],
  ])("refuses stored %s as config-invalid and writes nothing", async (_reason, text, change) => {
    const root = await tempRoot();
    await plant(userConfig(root), text);

    expect((await storeError(edit(root, await change(root)))).code).toBe("config-invalid");
    expect(await read(userConfig(root))).toBe(text);
  });

  it("repairs a stored default_status that is not among the stored statuses", async () => {
    const root = await tempRoot();
    await plant(userConfig(root), "statuses: [A, B]\ndefault_status: C\n");

    const info = await edit(root, { default_status: "A" });

    expect(info.default_status).toEqual({ value: "A", set: true });
  });

  it("refuses a change that sets a key whose anchor another value reads", async () => {
    const root = await tempRoot();
    const text = "statuses: &s [New, Done]\nlater_key: *s\n";
    await plant(userConfig(root), text);

    expect((await storeError(edit(root, { statuses: ["New", "Shipped"] }))).code).toBe("config-invalid");
    expect(await read(userConfig(root))).toBe(text);
  });
});

describe("the projects a change of the user's configuration must not break", () => {
  it("refuses statuses that a project which inherits them resolves no more, naming the project", async () => {
    const root = await tempRoot();
    const text = "statuses: [Backlog, Review, Done]\n";
    await plant(userConfig(root), text);
    await plant(projectConfig(root), "default_status: Review\n");

    const error = await storeError(edit(root, { statuses: ["Backlog", "Done"] }));

    expect(error.code).toBe("config-change-invalid");
    expect(error.message).toContain(`project SAGA: default_status "Review" is not one of the statuses declared in ${userConfig(root)}`);
    expect(error.path).toBe(projectConfig(root));
    expect(await read(userConfig(root))).toBe(text);
  });

  it("passes over a project that does not resolve before the change", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "default_status: Review\n");

    const info = await edit(root, { statuses: ["Backlog", "Done"] });

    expect(info.statuses.value).toEqual(["Backlog", "Done"]);
  });

  it.each([
    ["is no valid YAML", async (root: string) => plant(projectConfig(root), "statuses: [\n")],
    ["is a directory", async (root: string) => mkdir(projectConfig(root))],
    ["cannot be opened", async (root: string) => {
      await plant(projectConfig(root), "default_status: Review\n");
      await chmod(projectConfig(root), 0o000);
      onTestFinished(() => chmod(projectConfig(root), 0o600));
    }],
  ])("passes over a project whose file %s", async (_reason, broken) => {
    const root = await tempRoot();
    await plant(userConfig(root), "statuses: [Backlog, Review, Done]\n");
    await broken(root);

    await edit(root, { statuses: ["Backlog", "Done"] });

    expect((await readUserConfig(root)).statuses.value).toEqual(["Backlog", "Done"]);
  });

  it("is not held back by a project that states all of its own statuses", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "statuses: [New, Shipped]\ndefault_status: New\nfinal_statuses: [Shipped]\n");

    const info = await edit(root, { statuses: ["Open", "Closed"] });

    expect(info.statuses.value).toEqual(["Open", "Closed"]);
  });

  it("repairs a broken user file that every inheriting project fails on today", async () => {
    const root = await tempRoot();
    await plant(userConfig(root), "statuses: [A, B]\ndefault_status: C\n");
    await mkdir(projectDir(root, "KITE"), { recursive: true });

    const info = await edit(root, { default_status: "A" });

    expect(info.default_status.value).toBe("A");
  });

  it("checks no project for a change of priorities that keeps them resolving", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "priorities: [p1]\n");

    expect((await edit(root, { priorities: ["urgent"] })).priorities.value).toEqual(["urgent"]);
  });
});

describe("the workflows a new workflows_path must keep loading", () => {
  it("refuses a directory that holds no workflow a project lists, naming the project and the workflow", async () => {
    const root = await tempRoot();
    await plantWorkflow(root, "review", stepsOnly("check"));
    await plant(projectConfig(root), "workflows: [review]\n");
    const empty = await folderIn(root, "empty");

    const error = await storeError(edit(root, { workflows_path: empty }));

    expect(error.code).toBe("workflow-unknown");
    expect(error.message).toContain('project SAGA, workflow "review"');
    await expect(readdir(root)).resolves.not.toContain("config.yml");
  });

  it("refuses a directory from which a workflow a project lists cannot be loaded", async () => {
    const root = await tempRoot();
    const flows = join(root, "flows");
    await plantWorkflow(root, "review", stepsOnly("check"));
    await plantWorkflow(root, "review", "steps: [\n", flows);
    await plant(projectConfig(root), "workflows: [review]\n");

    expect((await storeError(edit(root, { workflows_path: flows }))).code).toBe("workflow-invalid");
  });

  it("accepts a directory from which every listed workflow loads", async () => {
    const root = await tempRoot();
    const flows = join(root, "flows");
    await plantWorkflow(root, "review", stepsOnly("check"));
    await plantWorkflow(root, "review", stepsOnly("check"), flows);
    await plant(projectConfig(root), "workflows: [review]\n");

    expect((await edit(root, { workflows_path: flows })).workflows_path.value).toBe(flows);
  });

  it("passes over a listed workflow that does not load today", async () => {
    const root = await tempRoot();
    await plant(projectConfig(root), "workflows: [review, ../outside]\n");
    const empty = await folderIn(root, "empty");

    expect((await edit(root, { workflows_path: empty })).workflows_path.value).toBe(empty);
  });

  it("passes over a project whose workflows list is no list", async () => {
    const root = await tempRoot();
    await plantWorkflow(root, "review", stepsOnly("check"));
    await plant(projectConfig(root), "workflows: review\n");
    const empty = await folderIn(root, "empty");

    expect((await edit(root, { workflows_path: empty })).workflows_path.value).toBe(empty);
  });

  it("checks a clear against the built-in directory", async () => {
    const root = await tempRoot();
    const flows = join(root, "flows");
    await plantWorkflow(root, "review", stepsOnly("check"), flows);
    await plant(userConfig(root), `workflows_path: ${flows}\n`);
    await plant(projectConfig(root), "workflows: [review]\n");

    expect((await storeError(edit(root, { workflows_path: null }))).code).toBe("workflow-unknown");
  });

  it("reads a stored workflows_path the reader refuses as the built-in directory", async () => {
    const root = await tempRoot();
    await plant(userConfig(root), "workflows_path: 3\n");
    await plantWorkflow(root, "review", stepsOnly("check"));
    await plant(projectConfig(root), "workflows: [review]\n");
    const empty = await folderIn(root, "empty");

    expect((await storeError(edit(root, { workflows_path: empty }))).code).toBe("workflow-unknown");
  });
});
