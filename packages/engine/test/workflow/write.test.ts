import { existsSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkflow,
  createWorkflowFolder,
  openWritableWorkflows,
  removeWorkflow,
  type StepInput,
  updateWorkflow,
  type WorkflowChange,
  type WorkflowInput,
} from "@tasma/engine";
import { bareRoot, plant, projectConfig, storeError, tempRoot, userConfig } from "../store/helpers.js";
import {
  outsideWorkflows,
  plantWorkflow,
  plantWorkflowsPath,
  workflowDir,
  workflowFile,
  workflows,
  workflowsDir,
} from "./helpers.js";

/** The path of each `sync` of an opened file or folder, in order. */
const flushed = vi.hoisted(() => [] as string[]);

/** A different writer that lands after the mkdir of one path, once a test sets it. */
const race = vi.hoisted(() => ({
  after: undefined as { path: string; land: () => Promise<void> } | undefined,
}));

/**
 * The calls that fail with `EIO` on one path, one time each and in this order: a
 * create is an exclusive open, a read is any other open, and a close is the close
 * of any handle.
 */
const faults = vi.hoisted(() => [] as { call: "create" | "read" | "close" | "lstat"; path: string }[]);

vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  const faulting = (call: (typeof faults)[number]["call"], path: unknown) => {
    if (faults[0]?.call !== call || faults[0].path !== path) return;

    faults.shift();
    throw Object.assign(new Error(`EIO: i/o error: ${String(path)}`), { code: "EIO" });
  };

  return {
    ...actual,
    async lstat(...args: Parameters<typeof actual.lstat>) {
      faulting("lstat", args[0]);

      return actual.lstat(...args);
    },
    async mkdir(...args: Parameters<typeof actual.mkdir>) {
      const first = await actual.mkdir(...args);
      const after = race.after;

      if (after?.path === args[0]) {
        race.after = undefined;
        await after.land();
      }

      return first;
    },
    async open(...args: Parameters<typeof actual.open>) {
      const create = args[1] === "wx";

      faulting(create ? "create" : "read", args[0]);

      const handle = await actual.open(...args);
      const sync = handle.sync.bind(handle);
      const close = handle.close.bind(handle);

      handle.sync = async () => {
        await sync();
        flushed.push(args[0] as string);
      };
      handle.close = async () => {
        await close();
        faulting("close", args[0]);
      };

      return handle;
    },
  };
});

afterEach(() => {
  faults.length = 0;
  race.after = undefined;
  flushed.length = 0;
});

/** A step document outside the workflows tree, which a step entry can name. */
async function stepDocument(root: string, name: string): Promise<string> {
  const path = join(root, "docs", `${name}.md`);
  await plant(path, `Do ${name}.\n`);
  return path;
}

/** Steps whose documents stand on disk, each owned by an agent. */
async function steps(root: string, ...names: string[]): Promise<StepInput[]> {
  return Promise.all(names.map(async (name) => ({ name, owner: "agent" as const, file: await stepDocument(root, name) })));
}

function create(root: string, name: string, input: WorkflowInput) {
  return createWorkflow(workflows(root), name, input);
}

function edit(root: string, name: string, change: WorkflowChange) {
  return updateWorkflow(workflows(root), name, change);
}

describe("creating a workflow", () => {
  it("writes a file the reader loads back", async () => {
    const root = await tempRoot();
    const rules = await stepDocument(root, "rules");
    const input = { title: "Flow A", instructions: [rules], steps: await steps(root, "a:one", "a:two") };

    const { workflow } = await create(root, "flow-a", input);

    expect(workflow).toMatchObject({ name: "flow-a", title: "Flow A", instructions: [rules] });
    expect(workflow.steps.map((step) => step.name)).toEqual(["a:one", "a:two"]);
    expect((await workflows(root).read("flow-a")).workflow).toEqual(workflow);
  });

  it("states title, instructions and steps in that order, each step as a flow mapping", async () => {
    const root = await tempRoot();
    const rules = await stepDocument(root, "rules");
    const [one] = await steps(root, "a:one");

    await create(root, "flow-a", { steps: [one!], instructions: [rules], title: "Flow A" });

    expect(await readFile(workflowFile(root, "flow-a"), "utf8")).toBe(
      `title: Flow A\ninstructions:\n  - ${rules}\nsteps:\n  - { name: a:one, file: ${one!.file}, owner: agent }\n`,
    );
  });

  it("stores a ~/ path as stated", async () => {
    const root = await tempRoot();
    await plant(join(process.env.HOME!, "flow-a-step.md"), "Do it.\n");

    await create(root, "flow-a", { steps: [{ name: "one", owner: "human", file: "~/flow-a-step.md" }] });

    expect(await readFile(workflowFile(root, "flow-a"), "utf8")).toContain("file: ~/flow-a-step.md");
  });

  it("creates the built-in workflows directory when it is not there", async () => {
    const root = await tempRoot();

    await create(root, "flow-a", { steps: await steps(root, "one") });

    expect(await readdir(workflowsDir(root))).toEqual(["flow-a"]);
  });

  it.each<[string, (root: string) => Promise<WorkflowInput>, string]>([
    ["a step name that breaks the rule", async (root) => ({ steps: await steps(root, "Bad Name") }), "Bad Name"],
    ["a duplicate step name", async (root) => ({ steps: await steps(root, "one", "one") }), "more than once"],
    [
      "an unknown owner",
      async (root) => ({ steps: [{ ...(await steps(root, "one"))[0]!, owner: "robot" as never }] }),
      '"owner"',
    ],
    ["zero steps", () => Promise.resolve({ steps: [] }), "at least one entry"],
    ["no steps", () => Promise.resolve({} as WorkflowInput), '"steps"'],
    ["an empty title", async (root) => ({ title: "", steps: await steps(root, "one") }), '"title"'],
    ["a cleared title", async (root) => ({ title: null as never, steps: await steps(root, "one") }), "cleared"],
    ["an unknown field", async (root) => ({ steps: await steps(root, "one"), colour: "red" } as never), '"colour"'],
    [
      "an unknown step key",
      async (root) => ({ steps: [{ ...(await steps(root, "one"))[0]!, retries: 2 } as never] }),
      '"retries"',
    ],
    ["a step without a file", () => Promise.resolve({ steps: [{ name: "one", owner: "agent" } as never] }), '"file"'],
    ["a step that is no mapping", () => Promise.resolve({ steps: ["one"] as never }), "mapping"],
    ["steps that are no list", () => Promise.resolve({ steps: "one" as never }), "list"],
    ["instructions that are no list", async (root) => ({ instructions: "x" as never, steps: await steps(root, "one") }), "list"],
    ["an empty instruction", async (root) => ({ instructions: [""], steps: await steps(root, "one") }), "not empty"],
    ["an input that is no mapping", () => Promise.resolve(null as never), "mapping"],
  ])("refuses %s with workflow-change-invalid and leaves no directory", async (_case, input, fragment) => {
    const root = await tempRoot();

    const error = await storeError(create(root, "flow-a", await input(root)));

    expect(error.code).toBe("workflow-change-invalid");
    expect(error.description).toContain(fragment);
    await expect(readdir(workflowDir(root, "flow-a"))).rejects.toThrow();
  });

  it.each<[string, (root: string) => Promise<WorkflowInput>]>([
    ["a missing step document", () => Promise.resolve({ steps: [{ name: "one", owner: "agent", file: "/nowhere/one.md" }] })],
    ["a relative step document", () => Promise.resolve({ steps: [{ name: "one", owner: "agent", file: "one.md" }] })],
    ["a step document that is a directory", async (root) => ({ steps: [{ name: "one", owner: "agent", file: root }] })],
    [
      "a missing instruction document",
      async (root) => ({ instructions: ["/nowhere/rules.md"], steps: await steps(root, "one") }),
    ],
  ])("refuses %s with path-invalid", async (_case, input) => {
    const root = await tempRoot();

    const error = await storeError(create(root, "flow-a", await input(root)));

    expect(error.code).toBe("path-invalid");
    await expect(readdir(workflowDir(root, "flow-a"))).rejects.toThrow();
  });

  it("refuses a bad workflow name with workflow-unknown", async () => {
    const root = await tempRoot();

    const error = await storeError(create(root, "../flow", { steps: await steps(root, "one") }));

    expect(error.code).toBe("workflow-unknown");
  });

  it("refuses a name that exists with workflow-exists and leaves the file alone", async () => {
    const root = await tempRoot();
    await plantWorkflow(root, "flow-a", "# kept\nsteps: []\n");

    const error = await storeError(create(root, "flow-a", { steps: await steps(root, "one") }));

    expect(error.code).toBe("workflow-exists");
    expect(await readFile(workflowFile(root, "flow-a"), "utf8")).toBe("# kept\nsteps: []\n");
  });

  it("passes on a fault of the filesystem other than an existing name", async () => {
    const root = await tempRoot();
    await plant(workflowsDir(root), "not a directory\n");

    await expect(create(root, "flow-a", { steps: await steps(root, "one") })).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("removes the directory when the file cannot be written", async () => {
    const root = await tempRoot();
    const input = { steps: await steps(root, "one") };
    const store = workflows(root);
    const failing = { ...store, pathsOf: (name: string) => ({ ...store.pathsOf(name), file: join(root, "no", "dir", "workflow.yml") }) };

    await expect(createWorkflow(failing, "flow-a", input)).rejects.toThrow();

    await expect(readdir(workflowDir(root, "flow-a"))).rejects.toThrow();
  });

  it("keeps the new directory when another writer put a file in it", async () => {
    const root = await tempRoot();
    const input = { steps: await steps(root, "one") };
    const store = workflows(root);
    const directory = workflowDir(root, "flow-a");
    // The file is named once the directory stands, so another writer's file lands between the two.
    const pathsOf = (name: string) => ({
      directory: store.pathsOf(name).directory,
      get file() {
        if (existsSync(directory)) writeFileSync(join(directory, "other.md"), "Written by another process.\n");
        return join(root, "no", "dir", "workflow.yml");
      },
    });

    await expect(createWorkflow({ ...store, pathsOf }, "flow-a", input)).rejects.toThrow();

    expect(await readdir(workflowDir(root, "flow-a"))).toEqual(["other.md"]);
  });
});

const FOLDER_DEFINITION = `title: Flow A
instructions:
  - rules.md
steps:
  - {name: "a:one", file: steps/one.md, owner: agent}
  - {name: "a:two", file: steps/deep/two.md, owner: human}
`;

const FOLDER_FILES: [string, string][] = [
  ["rules.md", "Rules.\n"],
  ["steps/one.md", "Do one.\n"],
  ["steps/deep/two.md", "Do two.\n"],
];

function createFolder(root: string, definition = FOLDER_DEFINITION, files = FOLDER_FILES) {
  return createWorkflowFolder(workflows(root), "flow-a", { definition, files });
}

/** Every entry under a folder, by its path from there. */
async function listing(folder: string): Promise<string[]> {
  return (await readdir(folder, { recursive: true })).sort();
}

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe("creating a workflow folder", () => {
  it("writes each file, then workflow.yml with the text unchanged, and reads the paths inside the folder", async () => {
    const root = await tempRoot();
    const folder = workflowDir(root, "flow-a");

    const { workflow, diagnostics } = await createFolder(root);

    expect(diagnostics).toEqual([]);
    expect(workflow).toEqual({
      name: "flow-a",
      file: workflowFile(root, "flow-a"),
      title: "Flow A",
      instructions: [join(folder, "rules.md")],
      steps: [
        { name: "a:one", file: join(folder, "steps", "one.md"), owner: "agent" },
        { name: "a:two", file: join(folder, "steps", "deep", "two.md"), owner: "human" },
      ],
    });
    expect(await readFile(workflowFile(root, "flow-a"), "utf8")).toBe(FOLDER_DEFINITION);
    expect(await listing(folder)).toEqual(
      ["rules.md", "steps", "steps/deep", "steps/deep/two.md", "steps/one.md", "workflow.yml"],
    );

    for (const [path, text] of FOLDER_FILES) {
      expect(await readFile(join(folder, path), "utf8"), path).toBe(text);
      expect(await modeOf(join(folder, path)), path).toBe(0o600);
    }

    for (const path of [folder, join(folder, "steps"), join(folder, "steps", "deep")]) {
      expect(await modeOf(path), path).toBe(0o700);
    }
  });

  it("flushes each file and each folder it made before the workflow.yml that names them", async () => {
    const root = await tempRoot();
    const folder = workflowDir(root, "flow-a");

    flushed.length = 0;
    await createFolder(root);

    const created = flushed.indexOf(workflowFile(root, "flow-a"));

    expect(created).toBeGreaterThan(-1);

    const files = FOLDER_FILES.map(([path]) => join(folder, path));

    for (const path of [...files, join(folder, "steps", "deep"), join(folder, "steps"), folder, workflowsDir(root)]) {
      expect(flushed, path).toContain(path);
      expect(flushed.indexOf(path), path).toBeLessThan(created);
    }
  });

  it("refuses a workflow folder that exists with workflow-exists, and leaves it as it is", async () => {
    const root = await tempRoot();
    const folder = workflowDir(root, "flow-a");

    await plant(join(folder, "note.md"), "A file of the user.\n");

    const error = await storeError(createFolder(root));

    expect(error).toMatchObject({ code: "workflow-exists", path: folder });
    expect(await listing(folder)).toEqual(["note.md"]);
  });

  it("refuses a bad workflow name with workflow-unknown", async () => {
    const root = await tempRoot();

    const error = await storeError(createWorkflowFolder(workflows(root), "../flow", {
      definition: FOLDER_DEFINITION,
      files: FOLDER_FILES,
    }));

    expect(error.code).toBe("workflow-unknown");
  });

  const withFile = (path: string): [string, string][] => [...FOLDER_FILES, [path, "Text.\n"]];

  it.each<[string, string, [string, string][], string]>([
    ["a step document that is not a file of the folder", FOLDER_DEFINITION, FOLDER_FILES.slice(0, 2), "steps/deep/two.md"],
    ["an instruction document that is not a file of the folder", FOLDER_DEFINITION, FOLDER_FILES.slice(1), "rules.md"],
    [
      "a document outside the folder",
      FOLDER_DEFINITION.replace("rules.md", "/nowhere/rules.md"),
      FOLDER_FILES,
      "/nowhere/rules.md",
    ],
    ["an absolute file path", FOLDER_DEFINITION, withFile("/nowhere/extra.md"), "/nowhere/extra.md"],
    ["a file path that goes up", FOLDER_DEFINITION, withFile("../extra.md"), "../extra.md"],
    ["a file path that goes up inside it", FOLDER_DEFINITION, withFile("steps/../../extra.md"), "steps/../../extra.md"],
    ["an empty file path", FOLDER_DEFINITION, withFile(""), '""'],
    ["a file path of the folder itself", FOLDER_DEFINITION, withFile("."), '"."'],
    ["a file path with a trailing /", FOLDER_DEFINITION, withFile("extra/"), "extra/"],
    ["a file path of workflow.yml", FOLDER_DEFINITION, withFile("workflow.yml"), "workflow.yml"],
    ["a file path of workflow.yml in a different case", FOLDER_DEFINITION, withFile("Workflow.yml"), "Workflow.yml"],
    ["a file path of workflow.yml in a different form", FOLDER_DEFINITION, withFile("./workflow.yml"), "./workflow.yml"],
    ["a duplicate file path", FOLDER_DEFINITION, withFile("steps/one.md"), "the same file"],
    ["a file path that differs only by case", FOLDER_DEFINITION, withFile("Steps/One.md"), "the same file"],
    ["a file path that differs only by form", FOLDER_DEFINITION, withFile("steps//one.md"), "the same file"],
    ["a file path that is a folder of a different entry", FOLDER_DEFINITION, withFile("steps/deep"), "also the folder"],
    ["folder names that differ only by case", FOLDER_DEFINITION, withFile("Steps/three.md"), "differ only by case"],
    [
      "folder names that differ only by Unicode form",
      FOLDER_DEFINITION,
      [...FOLDER_FILES, ["café/a.md", "A.\n"], ["café/b.md", "B.\n"]],
      "differ only by case",
    ],
    ["a definition the reader refuses", "steps: [\n", FOLDER_FILES, "not valid YAML"],
  ])("refuses %s with workflow-change-invalid and writes nothing", async (_case, definition, files, fragment) => {
    const root = await tempRoot();

    const error = await storeError(createFolder(root, definition, files));

    expect(error.code).toBe("workflow-change-invalid");
    expect(error.description).toContain(fragment);
    await expect(readdir(workflowsDir(root))).rejects.toThrow();
  });

  it("removes what it made when a file cannot be written, and passes the failure on", async () => {
    const root = await tempRoot();

    faults.push({ call: "create", path: join(workflowDir(root, "flow-a"), "steps", "deep", "two.md") });

    await expect(createFolder(root)).rejects.toMatchObject({ code: "EIO" });
    expect(await readdir(workflowsDir(root))).toEqual([]);
  });

  it("removes the workflow folder when the flush of its name fails", async () => {
    const root = await tempRoot();

    faults.push({ call: "close", path: workflowsDir(root) });

    await expect(createFolder(root)).rejects.toMatchObject({ code: "EIO" });
    expect(await readdir(workflowsDir(root))).toEqual([]);
  });

  it("removes what it made when workflow.yml cannot be created and does not stand", async () => {
    const root = await tempRoot();

    faults.push({ call: "create", path: workflowFile(root, "flow-a") });

    await expect(createFolder(root)).rejects.toMatchObject({ code: "EIO" });
    expect(await readdir(workflowsDir(root))).toEqual([]);
  });

  it("keeps a file of a different writer and the folder that holds it, and removes the rest", async () => {
    const root = await tempRoot();
    const folder = workflowDir(root, "flow-a");
    const note = join(folder, "steps", "note.md");

    race.after = { path: join(folder, "steps"), land: () => writeFile(note, "A file of someone else.\n") };
    faults.push({ call: "create", path: join(folder, "steps", "deep", "two.md") });

    await expect(createFolder(root)).rejects.toMatchObject({ code: "EIO" });
    expect(await listing(folder)).toEqual(["steps", "steps/note.md"]);
    expect(await readFile(note, "utf8")).toBe("A file of someone else.\n");
  });

  it("keeps everything when the create of workflow.yml fails after the file stands", async () => {
    const root = await tempRoot();

    faults.push({ call: "close", path: workflowFile(root, "flow-a") });

    await expect(createFolder(root)).rejects.toMatchObject({ code: "EIO" });
    expect((await workflows(root).read("flow-a")).workflow.steps).toHaveLength(2);
    expect(await listing(workflowDir(root, "flow-a"))).toContain("steps/deep/two.md");
  });

  it("counts workflow.yml as standing when the look at it fails, and keeps the files", async () => {
    const root = await tempRoot();
    const file = workflowFile(root, "flow-a");

    faults.push({ call: "create", path: file }, { call: "lstat", path: file });

    await expect(createFolder(root)).rejects.toMatchObject({ code: "EIO" });
    expect(await listing(workflowDir(root, "flow-a"))).toEqual(
      ["rules.md", "steps", "steps/deep", "steps/deep/two.md", "steps/one.md"],
    );
  });

  it("keeps everything when the read that ends the create fails", async () => {
    const root = await tempRoot();

    faults.push({ call: "read", path: workflowFile(root, "flow-a") });

    expect((await storeError(createFolder(root))).code).toBe("workflow-invalid");
    expect((await workflows(root).read("flow-a")).workflow.instructions).toHaveLength(1);
  });

  it("never uses a folder that a different writer puts at a copy path, and removes only what it wrote", async () => {
    const root = await tempRoot();
    const folder = workflowDir(root, "flow-a");

    race.after = { path: folder, land: () => mkdir(join(folder, "steps")) };

    const error = await storeError(createFolder(root));

    expect(error).toMatchObject({ code: "workflow-exists", path: folder });
    expect(await listing(folder)).toEqual(["steps"]);
  });

  it("never overwrites a file that a different writer puts at a copy path, and removes only what it wrote", async () => {
    const root = await tempRoot();
    const folder = workflowDir(root, "flow-a");
    const planted = join(folder, "steps", "one.md");

    race.after = { path: join(folder, "steps"), land: () => writeFile(planted, "A file of the user.\n") };

    expect((await storeError(createFolder(root))).code).toBe("workflow-exists");
    expect(await listing(folder)).toEqual(["steps", "steps/one.md"]);
    expect(await readFile(planted, "utf8")).toBe("A file of the user.\n");
  });

  it("removes only what it wrote when a different writer takes workflow.yml during the run", async () => {
    const root = await tempRoot();
    const folder = workflowDir(root, "flow-a");
    const file = workflowFile(root, "flow-a");

    race.after = { path: join(folder, "steps", "deep"), land: () => writeFile(file, "steps: []\n") };

    expect((await storeError(createFolder(root))).code).toBe("workflow-exists");
    expect(await listing(folder)).toEqual(["workflow.yml"]);
    expect(await readFile(file, "utf8")).toBe("steps: []\n");
  });
});

/** A workflow file written by hand, with everything a write has to keep. */
const HAND_WRITTEN = (one: string, two: string) => `# The flow of the saga team.
title: Flow A # the display name
steps:
  - {name: "a:one", file: ${one}, owner: agent, retries: 2}
  - {name: "a:two", file: ${two}, owner: human}
owners:
  "a:one": [{team: saga}]
colour: red
`;

async function handWritten(root: string): Promise<{ one: StepInput; two: StepInput }> {
  const [one, two] = await steps(root, "a:one", "a:two");
  await plantWorkflow(root, "flow-a", HAND_WRITTEN(one!.file, two!.file));
  return { one: one!, two: { ...two!, owner: "human" } };
}

describe("editing a workflow", () => {
  it("sets the title and keeps comments, key order and unknown keys", async () => {
    const root = await tempRoot();
    await handWritten(root);

    const { workflow } = await edit(root, "flow-a", { title: "Flow B" });

    const text = await readFile(workflowFile(root, "flow-a"), "utf8");
    expect(workflow.title).toBe("Flow B");
    expect(text).toContain("# The flow of the saga team.\ntitle: Flow B # the display name\nsteps:");
    expect(text).toContain('owners:\n  "a:one": [ { team: saga } ]\ncolour: red\n');
  });

  it("keeps the custom keys of a kept step and drops those of a renamed step", async () => {
    const root = await tempRoot();
    const { one, two } = await handWritten(root);

    const kept = await edit(root, "flow-a", { steps: [one, two] });
    expect(kept.workflow.steps[0]!.custom).toEqual({ retries: 2 });
    expect(kept.removedSteps).toEqual([]);

    const renamed = await edit(root, "flow-a", { steps: [{ ...one, name: "a:first" }, two] });
    expect(renamed.workflow.steps[0]!.custom).toBeUndefined();
    expect(renamed.removedSteps).toEqual(["a:one"]);
  });

  it("writes each step as a flow mapping and keeps the style of a flow list", async () => {
    const root = await tempRoot();
    const [one] = await steps(root, "one");
    await plantWorkflow(root, "flow-a", `steps: [{name: one, file: ${one!.file}, owner: agent}]\n`);

    await edit(root, "flow-a", { steps: [{ ...one!, owner: "human" }] });

    expect(await readFile(workflowFile(root, "flow-a"), "utf8")).toBe(
      `steps: [ { name: one, file: ${one!.file}, owner: human } ]\n`,
    );
  });

  it("sets and removes the instructions", async () => {
    const root = await tempRoot();
    await handWritten(root);
    const rules = await stepDocument(root, "rules");

    expect((await edit(root, "flow-a", { instructions: [rules] })).workflow.instructions).toEqual([rules]);
    expect((await edit(root, "flow-a", { instructions: null })).workflow.instructions).toEqual([]);
    expect(await readFile(workflowFile(root, "flow-a"), "utf8")).not.toContain("instructions");
  });

  it.each([
    ["no list", "steps: broken\n"],
    ["entries with no name", "steps: [broken, {file: /x.md}]\n"],
  ])("repairs a file whose steps are %s", async (_case, text) => {
    const root = await tempRoot();
    const [one] = await steps(root, "one");
    await plantWorkflow(root, "flow-a", text);

    const { workflow, removedSteps } = await edit(root, "flow-a", { steps: [one!] });

    expect(workflow.steps.map((step) => step.name)).toEqual(["one"]);
    expect(removedSteps).toEqual([]);
  });

  it("removes the title", async () => {
    const root = await tempRoot();
    await handWritten(root);

    const { workflow } = await edit(root, "flow-a", { title: null });

    expect(workflow.title).toBeUndefined();
    expect(await readFile(workflowFile(root, "flow-a"), "utf8")).not.toContain("title");
  });

  it("writes a value equal to the stored one", async () => {
    const root = await tempRoot();
    await handWritten(root);

    const { workflow } = await edit(root, "flow-a", { title: "Flow A" });

    expect(workflow.title).toBe("Flow A");
  });

  it("writes nothing for a change that states no field", async () => {
    const root = await tempRoot();
    const { one, two } = await handWritten(root);

    const result = await edit(root, "flow-a", {});

    expect(result.removedSteps).toEqual([]);
    expect(await readFile(workflowFile(root, "flow-a"), "utf8")).toBe(HAND_WRITTEN(one.file, two.file));
  });

  it.each<[string, WorkflowChange, string]>([
    ["cleared steps", { steps: null as never }, "cleared"],
    ["an empty step file", { steps: [{ name: "x", owner: "agent", file: "" }] }, '"file"'],
  ])("refuses %s with workflow-change-invalid", async (_case, change, fragment) => {
    const root = await tempRoot();
    await handWritten(root);

    const error = await storeError(edit(root, "flow-a", change));

    expect(error.code).toBe("workflow-change-invalid");
    expect(error.description).toContain(fragment);
  });

  it("refuses a change the reader would refuse and leaves the file alone", async () => {
    const root = await tempRoot();
    const { one, two } = await handWritten(root);

    const error = await storeError(edit(root, "flow-a", { steps: [one, { ...two, name: "a:one" }] }));

    expect(error.code).toBe("workflow-change-invalid");
    expect(error.description).toContain('"a:one" is declared more than once');
    expect(await readFile(workflowFile(root, "flow-a"), "utf8")).toBe(HAND_WRITTEN(one.file, two.file));
  });

  it("refuses a symlinked workflow.yml with workflow-invalid", async () => {
    const root = await tempRoot();
    const { one } = await handWritten(root);
    const target = join(await bareRoot(), "workflow.yml");
    await writeFile(target, `steps: [{name: one, file: ${one.file}, owner: agent}]\n`);
    await mkdir(workflowDir(root, "flow-b"), { recursive: true });
    await symlink(target, workflowFile(root, "flow-b"));

    const error = await storeError(edit(root, "flow-b", { title: "Flow B" }));

    expect(error.code).toBe("workflow-invalid");
  });

  it("follows a symlinked workflow directory", async () => {
    const root = await tempRoot();
    const { one } = await handWritten(root);
    const target = join(await bareRoot(), "flow-b");
    await plant(join(target, "workflow.yml"), `steps: [{name: one, file: ${one.file}, owner: agent}]\n`);
    await mkdir(workflowsDir(root), { recursive: true });
    await symlink(target, workflowDir(root, "flow-b"));

    await edit(root, "flow-b", { title: "Flow B" });

    expect(await readFile(join(target, "workflow.yml"), "utf8")).toContain("title: Flow B");
  });

  it("refuses a missing workflow with workflow-unknown", async () => {
    const root = await tempRoot();

    expect((await storeError(edit(root, "flow-a", { title: "Flow A" }))).code).toBe("workflow-unknown");
  });

  it("refuses a directory with no workflow.yml with workflow-invalid", async () => {
    const root = await tempRoot();
    await mkdir(workflowDir(root, "flow-a"), { recursive: true });

    expect((await storeError(edit(root, "flow-a", { title: "Flow A" }))).code).toBe("workflow-invalid");
  });

  it("refuses a key whose anchor another value reads", async () => {
    const root = await tempRoot();
    const [one] = await steps(root, "one");
    await plantWorkflow(root, "flow-a", `title: &name Flow A\nsteps: [{name: one, file: ${one!.file}, owner: agent}]\ncolour: *name\n`);

    const error = await storeError(edit(root, "flow-a", { title: "Flow B" }));

    expect(error.code).toBe("workflow-invalid");
    expect(error.description).toContain("anchor");
  });

  it("refuses a missing step document with path-invalid", async () => {
    const root = await tempRoot();
    await handWritten(root);

    const error = await storeError(edit(root, "flow-a", { steps: [{ name: "one", owner: "agent", file: "/nowhere.md" }] }));

    expect(error.code).toBe("path-invalid");
  });
});

describe("deleting a workflow", () => {
  it("removes the directory", async () => {
    const root = await bareRoot();
    await handWritten(root);

    await removeWorkflow("flow-a", { root });

    expect(await readdir(workflowsDir(root))).toEqual([]);
  });

  it("removes only the link of a symlinked directory", async () => {
    const root = await bareRoot();
    const target = join(await bareRoot(), "flow-b");
    await plant(join(target, "workflow.yml"), "steps: []\n");
    await mkdir(workflowsDir(root), { recursive: true });
    await symlink(target, workflowDir(root, "flow-b"));

    await removeWorkflow("flow-b", { root });

    expect(await readdir(workflowsDir(root))).toEqual([]);
    expect(await readdir(target)).toEqual(["workflow.yml"]);
  });

  it("refuses a workflow that projects list with workflow-in-use", async () => {
    const root = await tempRoot();
    await handWritten(root);
    await plant(projectConfig(root), "workflows: [flow-a]\n");
    await plant(projectConfig(root, "BETA"), "workflows: [flow-b, flow-a]\n");

    const error = await storeError(removeWorkflow("flow-a", { root }));

    expect(error.code).toBe("workflow-in-use");
    expect(error.description).toBe('the workflow "flow-a" is listed by the projects BETA, SAGA');
    expect(await readdir(workflowsDir(root))).toEqual(["flow-a"]);
  });

  it("refuses when a project configuration cannot be read", async () => {
    const root = await tempRoot();
    await handWritten(root);
    await plant(projectConfig(root), "workflows: [unclosed\n");

    const error = await storeError(removeWorkflow("flow-a", { root }));

    expect(error.code).toBe("workflow-in-use");
    expect(error.description).toBe('the configuration of the project SAGA cannot be read, so it may list the workflow "flow-a"');
  });

  it("refuses when a discovered project holds no configuration file, and keeps the workflow", async () => {
    const root = await tempRoot();
    await handWritten(root);

    const error = await storeError(removeWorkflow("flow-a", { root }));

    expect(error.code).toBe("workflow-in-use");
    expect(error.description).toBe('the configuration of the project SAGA cannot be read, so it may list the workflow "flow-a"');
    expect(await readdir(workflowsDir(root))).toEqual(["flow-a"]);
  });

  it("passes over a project that lists other workflows", async () => {
    const root = await tempRoot();
    await handWritten(root);
    await plant(projectConfig(root), "workflows: [flow-b]\n");

    await removeWorkflow("flow-a", { root });

    expect(await readdir(workflowsDir(root))).toEqual([]);
  });

  it("refuses a missing workflow with workflow-unknown", async () => {
    const root = await tempRoot();

    expect((await storeError(removeWorkflow("flow-a", { root }))).code).toBe("workflow-unknown");
  });

  it("refuses a directory with no workflow.yml and leaves what it holds", async () => {
    const root = await tempRoot();
    await plant(join(workflowDir(root, "notes"), "draft.md"), "Keep me.\n");

    const error = await storeError(removeWorkflow("notes", { root }));

    expect(error.code).toBe("workflow-invalid");
    expect(await readdir(workflowDir(root, "notes"))).toEqual(["draft.md"]);
  });

  it("removes the workflow from the directory the user's configuration names", async () => {
    const root = await bareRoot();
    const path = outsideWorkflows(root);
    await plantWorkflowsPath(root, path);
    await plantWorkflow(root, "flow-a", "steps: []\n", path);

    await removeWorkflow("flow-a", { root });

    expect(await readdir(path)).toEqual([]);
  });
});

describe("the workflows of a tree for a write", () => {
  it("stands on the directory the user's configuration names", async () => {
    const root = await bareRoot();
    const path = outsideWorkflows(root);
    await plantWorkflowsPath(root, path);

    expect((await openWritableWorkflows(root)).directory).toBe(path);
  });

  it("stands on the built-in directory when no configuration names one", async () => {
    const root = await bareRoot();

    expect((await openWritableWorkflows(root)).directory).toBe(workflowsDir(root));
  });

  it("refuses a configuration it cannot resolve rather than degrading", async () => {
    const root = await bareRoot();
    await plant(userConfig(root), "workflows_path: [\n");

    expect((await storeError(openWritableWorkflows(root))).code).toBe("config-invalid");
  });
});
