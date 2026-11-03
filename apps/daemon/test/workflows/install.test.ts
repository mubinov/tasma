import { chmod, lstat, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { openWorkflows } from "@tasma/engine";
import type { Failure, FeedEvent, Workflow, WorkflowInstall } from "@tasma/protocol";
import { WriteQueue } from "../../src/tasks/serialize.js";
import { installBaseWorkflow } from "../../src/workflows/install.js";
import { workflowRoutes } from "../../src/workflows/routes.js";
import {
  failure,
  get,
  plant,
  projectsRoot,
  send,
  startTestServer,
  success,
  userConfig,
  workflowDir,
  workflowFile,
} from "../helpers.js";
import type { TestServer } from "../helpers.js";

const BASE_WORKFLOWS = join(import.meta.dirname, "..", "..", "base-workflows");

/** The call a different writer lands after, once a test sets it. */
const race = vi.hoisted(() => ({
  after: undefined as { call: "lstat" | "readdir" | "mkdir"; path: string; land: () => Promise<void> } | undefined,
}));

/** The path of each `sync` of an opened file or folder, in order. */
const flushed = vi.hoisted(() => [] as string[]);

/** The reads and looks that fail with `EMFILE`, one time each and in this order. */
const faults = vi.hoisted(() => [] as { call: "read" | "stat"; path: string }[]);

vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  const faulting = (call: "read" | "stat", path: unknown) => {
    if (faults[0]?.call !== call || faults[0].path !== path) return;

    faults.shift();
    throw Object.assign(new Error(`EMFILE: too many open files: ${String(path)}`), { code: "EMFILE" });
  };
  const landing = async (call: "lstat" | "readdir" | "mkdir", path: unknown) => {
    const after = race.after;

    if (after?.call !== call || after.path !== path) return;

    race.after = undefined;
    await after.land();
  };

  return {
    ...actual,
    async lstat(...args: Parameters<typeof actual.lstat>) {
      try {
        return await actual.lstat(...args);
      } finally {
        await landing("lstat", args[0]);
      }
    },
    async mkdir(...args: Parameters<typeof actual.mkdir>) {
      const first = await actual.mkdir(...args);

      await landing("mkdir", args[0]);

      return first;
    },
    async open(...args: Parameters<typeof actual.open>) {
      if (args[1] !== "wx") faulting("read", args[0]);

      const handle = await actual.open(...args);
      const sync = handle.sync.bind(handle);

      handle.sync = async () => {
        await sync();
        flushed.push(args[0] as string);
      };

      return handle;
    },
    async readdir(...args: Parameters<typeof actual.readdir>) {
      const entries = await actual.readdir(...args);

      await landing("readdir", args[0]);

      return entries;
    },
    async stat(...args: Parameters<typeof actual.stat>) {
      faulting("stat", args[0]);

      return actual.stat(...args);
    },
  };
});

type Tree = {
  temp: string;
  root: string;
  server: TestServer;
  events: FeedEvent[];
  install: (name?: string) => Promise<Response>;
};

/** A daemon over `<temp>/.tasma`, because the default target is built from the folder that contains the root. */
async function tree(rootName = ".tasma"): Promise<Tree> {
  const temp = await projectsRoot();
  const root = join(temp, rootName);

  await mkdir(root);

  const events: FeedEvent[] = [];
  const server = await startTestServer(workflowRoutes({
    root,
    writes: new WriteQueue(),
    publish: (event) => {
      events.push(event);
    },
  }));

  return {
    temp,
    root,
    server,
    events,
    install: (name = "dev") => send(server, "POST", `/workflows/${name}/install`, {}),
  };
}

function setWorkflowsPath(root: string, path: string): Promise<void> {
  return plant(userConfig(root), `workflows_path: ${JSON.stringify(path)}\n`);
}

/** Every entry under a folder, by its path from there. */
async function listing(folder: string): Promise<string[]> {
  return (await readdir(folder, { recursive: true })).sort();
}

/** The files of the base workflow `dev`, by their path from its folder. */
async function baseDocuments(): Promise<string[]> {
  const entries = await listing(join(BASE_WORKFLOWS, "dev"));
  const files = [];

  for (const entry of entries) {
    if (entry === "workflow.yml" || basename(entry).startsWith(".")) continue;
    if ((await stat(join(BASE_WORKFLOWS, "dev", entry))).isFile()) files.push(entry);
  }

  return files;
}

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

/** Runs one install, asserts a refusal with `path-taken` and an unchanged disk, and answers the refusal. */
async function refusesUnchanged(place: Tree, path: string): Promise<Failure> {
  const before = await listing(place.temp);
  const response = await place.install();

  expect(response.status).toBe(409);

  const refusal = await failure(response);

  expect(refusal).toMatchObject({ kind: "store", code: "path-taken", path });
  expect(await listing(place.temp)).toEqual(before);

  return refusal;
}

async function installsTo(install: Tree["install"], folder: string): Promise<void> {
  expect((await success<WorkflowInstall>(await install())).data).toEqual({ result: "installed", folder });
}

async function answersInternal(response: Response): Promise<void> {
  expect(response.status).toBe(500);
  expect(await failure(response)).toMatchObject({ kind: "daemon", code: "internal" });
}

describe("POST /workflows/{workflow}/install", () => {
  it("copies the documents to the folder beside the tree, and creates the workflow over the copies", async () => {
    const { temp, root, server, install } = await tree();
    const target = join(temp, "tasma-workflows", "dev");

    const response = await install();

    expect(response.status).toBe(200);
    expect(await success<WorkflowInstall>(response)).toEqual({
      data: { result: "installed", folder: target },
      diagnostics: [],
    });

    const documents = await baseDocuments();

    expect(documents).toContain("instructions.md");

    for (const document of documents) {
      const copy = join(target, document);

      expect(await readFile(copy), document).toEqual(await readFile(join(BASE_WORKFLOWS, "dev", document)));
      expect(await modeOf(copy), document).toBe(0o600);
    }

    expect(await listing(target)).toEqual([...documents, "steps"].sort());
    expect(await modeOf(target)).toBe(0o700);
    expect(await modeOf(join(target, "steps"))).toBe(0o700);
    expect(await modeOf(dirname(target))).toBe(0o700);

    const base = (await openWorkflows({ path: BASE_WORKFLOWS }).read("dev")).workflow;
    const { data: stored } = await success<Workflow>(await get(server, "/workflows/dev"));
    const inTarget = (path: string) => path.replace(join(BASE_WORKFLOWS, "dev"), target);

    expect(stored.file).toBe(workflowFile(root, "dev"));
    expect(stored.title).toBe(base.title);
    expect(stored.instructions).toEqual(base.instructions.map(inTarget));
    expect(stored.steps).toHaveLength(7);
    expect(stored.steps).toEqual(base.steps.map((step) => ({ ...step, file: inTarget(step.file) })));
  });

  it("reports exists on a second run, and a changed copy keeps its change", async () => {
    const { temp, install } = await tree();
    const copy = join(temp, "tasma-workflows", "dev", "instructions.md");

    await install();
    await writeFile(copy, "Changed by the user.\n");

    const response = await install();

    expect(response.status).toBe(200);
    expect(await success<WorkflowInstall>(response)).toEqual({ data: { result: "exists" }, diagnostics: [] });
    expect(await readFile(copy, "utf8")).toBe("Changed by the user.\n");
  });

  it("reports exists for a workflow.yml that does not load, and leaves it as it is", async () => {
    const { root, install } = await tree();
    const file = workflowFile(root, "dev");

    await plant(file, "steps: [\n");

    expect(await success<WorkflowInstall>(await install())).toEqual({ data: { result: "exists" }, diagnostics: [] });
    expect(await readFile(file, "utf8")).toBe("steps: [\n");
  });

  it("puts the documents beside a workflows_path outside the tree", async () => {
    const { temp, root, server, install } = await tree();
    const flows = join(temp, "shared", "flows");

    await mkdir(flows, { recursive: true });
    await setWorkflowsPath(root, flows);

    await installsTo(install, join(temp, "shared", "dev"));
    expect((await success<Workflow>(await get(server, "/workflows/dev"))).data.file)
      .toBe(join(flows, "dev", "workflow.yml"));
  });

  it("puts the documents outside the tree for a workflows_path inside the tree", async () => {
    const { temp, root, install } = await tree();

    await setWorkflowsPath(root, join(root, "deep", "flows"));
    await mkdir(join(root, "deep"));

    await installsTo(install, join(temp, "tasma-workflows", "dev"));
  });

  it("compares path parts, so a folder that only starts with the name of the tree is outside it", async () => {
    const { temp, root, install } = await tree();

    await mkdir(join(temp, ".tasma-other"));
    await setWorkflowsPath(root, join(temp, ".tasma-other", "flows"));

    await installsTo(install, join(temp, ".tasma-other", "dev"));
  });

  it("counts a folder inside the tree whose name starts with two dots as inside it", async () => {
    const { temp, root, install } = await tree();

    await mkdir(join(root, "..deep"));
    await setWorkflowsPath(root, join(root, "..deep", "flows"));

    await installsTo(install, join(temp, "tasma-workflows", "dev"));
  });

  it("makes the missing folders above the target, and uses one that exists", async () => {
    const { temp, root, install } = await tree();
    const flows = join(temp, "kept", "a", "b", "flows");

    await mkdir(join(temp, "kept"));
    await setWorkflowsPath(root, flows);

    await installsTo(install, join(temp, "kept", "a", "b", "dev"));
    expect(await modeOf(join(temp, "kept", "a"))).toBe(0o700);
    expect(await modeOf(join(temp, "kept", "a", "b"))).toBe(0o700);
  });

  it("uses a folder above the target that exists", async () => {
    const { temp, install } = await tree();
    const parent = join(temp, "tasma-workflows");

    await mkdir(parent);
    await chmod(parent, 0o750);

    expect((await install()).status).toBe(200);
    expect(await modeOf(parent)).toBe(0o750);
  });

  it("counts a path that differs from the tree only by case as inside it", async () => {
    const { temp, root, install } = await tree();
    const flows = join(temp, ".TASMA", "flows");

    await mkdir(dirname(flows), { recursive: true });
    await setWorkflowsPath(root, flows);

    await installsTo(install, join(temp, "tasma-workflows", "dev"));
  });

  it("counts a path that differs from the tree only by Unicode form as inside it", async () => {
    const name = ".rootá";
    const { temp, root, install } = await tree(name);
    const flows = join(temp, name.normalize("NFD"), "flows");

    await mkdir(dirname(flows), { recursive: true });
    await setWorkflowsPath(root, flows);

    await installsTo(install, join(temp, "tasma-workflows", "dev"));
  });

  it("refuses a workflows_path named as the workflow", async () => {
    const place = await tree();
    const flows = join(place.temp, "dev");

    await setWorkflowsPath(place.root, flows);

    expect((await refusesUnchanged(place, flows)).message).toContain("is workflows_path");
  });

  it("refuses a workflows_path named as the workflow in a different case, with or without its folder", async () => {
    const absent = await tree();

    await setWorkflowsPath(absent.root, join(absent.temp, "Dev"));

    expect((await refusesUnchanged(absent, join(absent.temp, "dev"))).message).toContain("is workflows_path");

    const empty = await tree();

    await mkdir(join(empty.temp, "Dev"));
    await setWorkflowsPath(empty.root, join(empty.temp, "Dev"));

    expect((await refusesUnchanged(empty, join(empty.temp, "dev"))).message).toContain("is workflows_path");
  });

  it("refuses a workflows_path that is a link to an empty target folder", async () => {
    const place = await tree();
    const target = join(place.temp, "dev");
    const link = join(place.temp, "flows");

    await mkdir(target);
    await symlink(target, link);
    await setWorkflowsPath(place.root, link);

    expect((await refusesUnchanged(place, target)).message).toContain("is workflows_path");
  });

  it("accepts an empty target folder, and keeps it", async () => {
    const { temp, install } = await tree();
    const target = join(temp, "tasma-workflows", "dev");

    await mkdir(target, { recursive: true });
    await chmod(target, 0o750);

    await installsTo(install, target);
    expect(await modeOf(target)).toBe(0o750);
    expect(await listing(target)).toContain("instructions.md");
  });

  it("refuses a target folder that holds a file, and changes nothing", async () => {
    const place = await tree();
    const target = join(place.temp, "tasma-workflows", "dev");

    await plant(join(target, "note.md"), "A file of the user.\n");

    expect((await refusesUnchanged(place, target)).message).toContain("it is not free");
    expect(await readFile(join(target, "note.md"), "utf8")).toBe("A file of the user.\n");
  });

  it("refuses a target that is a file, a link to nothing or a link to an empty folder", async () => {
    const asFile = await tree();
    const fileTarget = join(asFile.temp, "tasma-workflows", "dev");

    await plant(fileTarget, "A file of the user.\n");
    await refusesUnchanged(asFile, fileTarget);

    const toNothing = await tree();
    const danglingTarget = join(toNothing.temp, "tasma-workflows", "dev");

    await mkdir(dirname(danglingTarget));
    await symlink(join(toNothing.temp, "nowhere"), danglingTarget);
    await refusesUnchanged(toNothing, danglingTarget);

    const toEmpty = await tree();
    const linkedTarget = join(toEmpty.temp, "tasma-workflows", "dev");

    await mkdir(dirname(linkedTarget));
    await mkdir(join(toEmpty.temp, "empty"));
    await symlink(join(toEmpty.temp, "empty"), linkedTarget);
    await refusesUnchanged(toEmpty, linkedTarget);

    expect((await lstat(linkedTarget)).isSymbolicLink()).toBe(true);
    expect(await readdir(join(toEmpty.temp, "empty"))).toEqual([]);
  });

  it("refuses a target whose parent is a file", async () => {
    const place = await tree();
    const parent = join(place.temp, "tasma-workflows");

    await writeFile(parent, "A file of the user.\n");
    await refusesUnchanged(place, join(parent, "dev"));
  });

  it("refuses an empty target folder of a different account", async () => {
    const place = await tree();
    const target = join(place.temp, "tasma-workflows", "dev");
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);

    onTestFinished(() => {
      getuid.mockRestore();
    });

    await mkdir(target, { recursive: true });
    await refusesUnchanged(place, target);
  });

  it("refuses a folder at the place of the workflow that holds no workflow.yml, and makes no copy", async () => {
    const place = await tree();
    const folder = workflowDir(place.root, "dev");

    await mkdir(folder, { recursive: true });

    expect((await refusesUnchanged(place, folder)).message).toContain("holds no workflow.yml");
  });

  it("treats a workflow.yml that is a folder as a folder that holds no workflow.yml", async () => {
    const place = await tree();
    const folder = workflowDir(place.root, "dev");

    await mkdir(join(folder, "workflow.yml"), { recursive: true });
    await refusesUnchanged(place, folder);
  });

  it("removes what it made when the create fails after the copy, and a retry succeeds", async () => {
    const { temp, root, install } = await tree();
    const regularFile = join(temp, "flows");

    await writeFile(regularFile, "A file of the user.\n");
    await setWorkflowsPath(root, regularFile);

    const before = await listing(temp);

    await answersInternal(await install());
    expect(await listing(temp)).toEqual(before);

    await mkdir(join(temp, "elsewhere"));
    await setWorkflowsPath(root, join(temp, "elsewhere", "flows"));

    await installsTo(install, join(temp, "elsewhere", "dev"));
  });

  it("keeps the copies when the read that ends the create fails, so the next install answers exists", async () => {
    const { temp, root, server, install } = await tree();
    const target = join(temp, "tasma-workflows", "dev");

    faults.push({ call: "read", path: workflowFile(root, "dev") });

    const response = await install();

    expect(response.status).toBe(422);
    expect(await failure(response)).toMatchObject({ kind: "store", code: "workflow-invalid" });
    expect(await listing(target)).toEqual([...(await baseDocuments()), "steps"].sort());

    const { data: stored } = await success<Workflow>(await get(server, "/workflows/dev"));

    for (const step of stored.steps) expect((await stat(step.file)).isFile(), step.file).toBe(true);

    expect(await success<WorkflowInstall>(await install())).toEqual({ data: { result: "exists" }, diagnostics: [] });
  });

  it("keeps the copies and answers the first failure when the look at workflow.yml also fails", async () => {
    const { temp, root, install } = await tree();
    const file = workflowFile(root, "dev");

    faults.push({ call: "read", path: file }, { call: "stat", path: file });

    const response = await install();

    expect(response.status).toBe(422);
    expect(await failure(response)).toMatchObject({ kind: "store", code: "workflow-invalid" });
    expect(await listing(join(temp, "tasma-workflows", "dev"))).toContain("instructions.md");
  });

  it("removes the copies when a different writer takes the workflow folder during the install", async () => {
    const { temp, root, install } = await tree();
    const file = workflowFile(root, "dev");

    race.after = { call: "lstat", path: workflowDir(root, "dev"), land: () => plant(file, "steps: []\n") };

    const response = await install();

    expect(response.status).toBe(409);
    expect(await failure(response)).toMatchObject({ kind: "store", code: "workflow-exists" });
    expect(await readdir(temp)).toEqual([".tasma"]);
    expect(await readFile(file, "utf8")).toBe("steps: []\n");
  });

  it("removes the copies when a different writer takes workflow.yml during the create", async () => {
    const { temp, root, install } = await tree();
    const file = workflowFile(root, "dev");

    race.after = { call: "mkdir", path: workflowDir(root, "dev"), land: () => writeFile(file, "steps: []\n") };

    await answersInternal(await install());
    expect(await readdir(temp)).toEqual([".tasma"]);
    expect(await readFile(file, "utf8")).toBe("steps: []\n");
  });

  it("removes a folder above the target that it made when the create fails", async () => {
    const { temp, root, install } = await tree();

    await writeFile(join(root, "flows"), "A file of the user.\n");
    await setWorkflowsPath(root, join(root, "flows"));

    expect((await install()).status).toBe(500);
    expect(await readdir(temp)).toEqual([".tasma"]);
  });

  it("keeps a folder it made that now holds a file of someone else, and answers the first failure", async () => {
    const { temp, root, install } = await tree();
    const parent = join(temp, "tasma-workflows");
    const note = join(parent, "note.md");

    await writeFile(join(root, "flows"), "A file of the user.\n");
    await setWorkflowsPath(root, join(root, "flows"));
    race.after = { call: "mkdir", path: join(parent, "dev"), land: () => writeFile(note, "A file of someone else.\n") };

    await answersInternal(await install());
    expect(await readdir(parent)).toEqual(["note.md"]);
    expect(await readFile(note, "utf8")).toBe("A file of someone else.\n");
  });

  it("answers a folder above the target that cannot be made as internal", async () => {
    const { temp, root, install } = await tree();
    const locked = join(temp, "locked");

    await mkdir(locked, { mode: 0o500 });
    onTestFinished(() => chmod(locked, 0o700));
    await setWorkflowsPath(root, join(locked, "a", "flows"));

    await answersInternal(await install());
    expect(await readdir(locked)).toEqual([]);
  });

  it("answers a link to nothing two levels above the target as internal, and writes nothing", async () => {
    const { temp, root, install } = await tree();

    await symlink(join(temp, "nowhere"), join(temp, "link"));
    await setWorkflowsPath(root, join(temp, "link", "sub", "flows"));

    const before = await listing(temp);

    await answersInternal(await install());
    expect(await listing(temp)).toEqual(before);
  });

  it("flushes each copy and each folder it made before the workflow.yml that names them", async () => {
    const { temp, root, install } = await tree();
    const target = join(temp, "tasma-workflows", "dev");

    flushed.length = 0;

    expect((await install()).status).toBe(200);

    const copies = (await baseDocuments()).map((document) => join(target, document));
    const created = flushed.indexOf(workflowFile(root, "dev"));

    expect(created).toBeGreaterThan(-1);

    for (const path of [...copies, join(target, "steps"), target, dirname(target), temp]) {
      expect(flushed, path).toContain(path);
      expect(flushed.indexOf(path), path).toBeLessThan(created);
    }
  });

  it("keeps an empty target folder that was there, and a file beside it, when the create fails", async () => {
    const { temp, root, install } = await tree();
    const target = join(temp, "dev");
    const beside = join(temp, "note.md");

    await writeFile(join(temp, "flows"), "A file of the user.\n");
    await setWorkflowsPath(root, join(temp, "flows"));
    await mkdir(target);
    await writeFile(beside, "A file of the user.\n");

    expect((await install()).status).toBe(500);
    expect(await readdir(target)).toEqual([]);
    expect(await readFile(beside, "utf8")).toBe("A file of the user.\n");
  });

  it("refuses a name no base workflow has, with no write", async () => {
    const { temp, install } = await tree();
    const before = await listing(temp);
    const response = await install("nope");

    expect(response.status).toBe(400);

    const refusal = await failure(response);

    expect(refusal).toMatchObject({ kind: "store", code: "workflow-unknown" });
    expect(refusal.message).toContain('"nope"');
    expect(await listing(temp)).toEqual(before);
  });

  it("refuses a broken config.yml, with no write", async () => {
    const { temp, root, install } = await tree();

    await plant(userConfig(root), "workflows_path: [\n");

    const before = await listing(temp);
    const response = await install();

    expect(response.status).toBe(422);
    expect(await failure(response)).toMatchObject({ kind: "store", code: "config-invalid" });
    expect(await listing(temp)).toEqual(before);
  });

  it("answers an unknown fault of the look at the workflow as internal", async () => {
    const { temp, root, install } = await tree();

    await symlink(join(temp, "loop"), join(temp, "loop"));
    await setWorkflowsPath(root, join(temp, "loop", "flows"));

    await answersInternal(await install());
  });

  it("answers an unknown fault of the look at the target as internal", async () => {
    const { temp, install } = await tree();

    await symlink(join(temp, "tasma-workflows"), join(temp, "tasma-workflows"));

    await answersInternal(await install());
  });

  it("answers a copy that fails with an errno as internal, and writes nothing", async () => {
    const { temp, root, server, install } = await tree();
    const target = join(temp, "tasma-workflows", "dev");

    await mkdir(target, { recursive: true });
    await chmod(target, 0o500);
    onTestFinished(() => chmod(target, 0o700));

    await answersInternal(await install());
    expect(await readdir(target)).toEqual([]);
    expect((await get(server, "/workflows/dev")).status).toBe(400);
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses when a folder appears at the target after the check, and never uses it", async () => {
    const { temp, install } = await tree();
    const target = join(temp, "tasma-workflows", "dev");

    race.after = {
      call: "lstat",
      path: target,
      land: async () => {
        await mkdir(target, { recursive: true });
      },
    };

    const response = await install();

    expect(response.status).toBe(409);
    expect(await failure(response)).toMatchObject({ kind: "store", code: "path-taken", path: target });
    expect(await readdir(target)).toEqual([]);
  });

  it("refuses when a folder appears at a copy path, and removes only what it wrote", async () => {
    const { temp, install } = await tree();
    const target = join(temp, "tasma-workflows", "dev");

    await mkdir(target, { recursive: true });
    race.after = {
      call: "readdir",
      path: target,
      land: () => mkdir(join(target, "steps")),
    };

    const response = await install();

    expect(response.status).toBe(409);
    expect(await failure(response)).toMatchObject({ kind: "store", code: "path-taken", path: target });
    expect(await readdir(target)).toEqual(["steps"]);
  });

  it("removes what it wrote when a copy fails after a different writer took workflow.yml", async () => {
    const { temp, root, install } = await tree();
    const target = join(temp, "tasma-workflows", "dev");
    const file = workflowFile(root, "dev");

    await mkdir(target, { recursive: true });
    race.after = {
      call: "readdir",
      path: target,
      land: async () => {
        await mkdir(join(target, "steps"));
        await plant(file, "steps: []\n");
      },
    };

    const response = await install();

    expect(response.status).toBe(409);
    expect(await failure(response)).toMatchObject({ kind: "store", code: "path-taken", path: target });
    expect(await readdir(target)).toEqual(["steps"]);
    expect(await readFile(file, "utf8")).toBe("steps: []\n");
  });

  it("refuses when a file appears at a copy path, and never overwrites it", async () => {
    const { temp, install } = await tree();
    const target = join(temp, "tasma-workflows", "dev");
    const planted = join(target, "instructions.md");

    await mkdir(target, { recursive: true });
    race.after = { call: "readdir", path: target, land: () => writeFile(planted, "A file of the user.\n") };

    const response = await install();

    expect(response.status).toBe(409);
    expect(await failure(response)).toMatchObject({ kind: "store", code: "path-taken", path: target });
    expect(await readdir(target)).toEqual(["instructions.md"]);
    expect(await readFile(planted, "utf8")).toBe("A file of the user.\n");
  });

  it("answers one installed and one exists for two requests at the same time", async () => {
    const { install } = await tree();

    const answers = await Promise.all([install(), install()]);
    const bodies = await Promise.all(answers.map((answer) => success<WorkflowInstall>(answer)));
    const results = bodies.map((body) => body.data.result);

    expect(results.sort()).toEqual(["exists", "installed"]);
  });

  it("publishes one workflow event for installed and none for exists", async () => {
    const { events, install } = await tree();

    await install();
    expect(events).toEqual([{ kind: "workflow", name: "dev", change: "created" }]);

    await install();
    expect(events).toHaveLength(1);
  });

  it("refuses a query", async () => {
    const { server } = await tree();

    expect((await send(server, "POST", "/workflows/dev/install?force=1", {})).status).toBe(400);
  });
});

describe("installBaseWorkflow", () => {
  const baseFile = (name: string, path: string) => `../../base-workflows/${name}/${path}`;

  it("takes a new base folder, leaves a key the file does not state absent, and makes each inner folder", async () => {
    const { temp, root } = await tree();
    const target = join(temp, "tasma-workflows", "flow-a");

    const installed = await installBaseWorkflow("flow-a", {
      root,
      files: {
        [baseFile("flow-a", "workflow.yml")]: 'steps:\n  - {name: "one", file: a/b/one.md, owner: agent}\n  - {name: "two", file: a/two.md, owner: human}\n',
        [baseFile("flow-a", "a/b/one.md")]: "Do one.\n",
        [baseFile("flow-a", "a/two.md")]: "Do two.\n",
        [baseFile("flow-b", "workflow.yml")]: "steps: []\n",
      },
    });

    expect(installed).toEqual({ data: { result: "installed", folder: target }, diagnostics: [] });
    expect(await listing(target)).toEqual(["a", "a/b", "a/b/one.md", "a/two.md"]);
    expect(await readFile(join(target, "a", "b", "one.md"), "utf8")).toBe("Do one.\n");

    const { workflow } = await openWorkflows({ root }).read("flow-a");

    expect(workflow.title).toBeUndefined();
    expect(workflow.instructions).toEqual([]);

    const stored = await readFile(workflow.file, "utf8");

    expect(stored).not.toContain("title");
    expect(stored).not.toContain("instructions");
  });

  it("passes a refusal of the engine on unchanged, and removes what it copied", async () => {
    const { temp, root } = await tree();

    await expect(installBaseWorkflow("flow-a", {
      root,
      files: {
        [baseFile("flow-a", "workflow.yml")]: 'steps:\n  - {name: "one", file: missing.md, owner: agent}\n',
        [baseFile("flow-a", "kept.md")]: "Kept.\n",
      },
    })).rejects.toMatchObject({ code: "path-invalid" });
    expect(await readdir(temp)).toEqual([".tasma"]);
  });

  it("refuses a name that holds only documents and no workflow.yml", async () => {
    const { root } = await tree();

    await expect(installBaseWorkflow("flow-a", {
      root,
      files: { [baseFile("flow-a", "one.md")]: "Do one.\n" },
    })).rejects.toMatchObject({ code: "workflow-unknown", path: undefined });
  });
});
