import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  check,
  cli,
  download,
  isEntryPoint,
  log,
  main,
  parseOptions,
  repoPaths,
  run,
  systemTools,
  update,
  type RepoPaths,
  type Tools,
} from "../scripts/kit-update.ts";
import type { Manifest } from "../scripts/kit/catalog.ts";
import { readTree } from "../scripts/kit/files.ts";
import { KIT_ITEMS } from "../scripts/kit/registry.ts";
import { archiveUrl, PACKUMENT_URL } from "../scripts/kit/release.ts";
import { workspaceRoot } from "../workspace.js";
import { attestationsAnswer, before, NOW, put, scratch, sourceDependency } from "./kit/helpers.ts";

const SCRIPT = join(workspaceRoot, "scripts", "kit-update.ts");

describe("parseOptions", () => {
  it("updates to the highest release when no argument is given", () => {
    expect(parseOptions([])).toEqual({ check: false });
  });

  it("checks with --check", () => {
    expect(parseOptions(["--check"])).toEqual({ check: true });
  });

  it("takes --release with the version as the next argument or after =", () => {
    expect(parseOptions(["--release", "1.2.3"])).toEqual({ check: false, release: "1.2.3" });
    expect(parseOptions(["--release=1.2.3"])).toEqual({ check: false, release: "1.2.3" });
  });

  it("gives the same result for -- --release 1.2.3 as for --release 1.2.3", () => {
    expect(parseOptions(["--", "--release", "1.2.3"])).toEqual(parseOptions(["--release", "1.2.3"]));
  });

  it("refuses --release with no version", () => {
    expect(() => parseOptions(["--release"])).toThrow("--release needs a version");
    expect(() => parseOptions(["--release", "--check"])).toThrow("--release needs a version");
    expect(() => parseOptions(["--release="])).toThrow("--release needs a version");
  });

  it("refuses --release together with --check", () => {
    expect(() => parseOptions(["--check", "--release", "1.2.3"])).toThrow("--check");
  });

  it("refuses an unknown argument", () => {
    expect(() => parseOptions(["--force"])).toThrow("unknown argument: --force");
  });
});

type FakeItem = {
  files?: { path: string; content: string }[];
  dependencies?: string[];
  registryDependencies?: string[];
};

/** A repository with the files the script reads, and a kit folder that holds only lib/utils.ts. */
function fakeRepo(): RepoPaths {
  const paths = repoPaths(scratch());
  put(paths.root, "package.json", JSON.stringify({ name: "repo", packageManager: "pnpm@11.4.0" }));
  put(paths.root, "pnpm-workspace.yaml", [
    "packages:",
    "  - apps/*",
    "catalog:",
    "  # Kept for a reason.",
    "  react: ^19.2.0",
    "minimumReleaseAge: 10080",
    "allowBuilds: {}",
    "",
  ].join("\n"));
  put(paths.root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  put(paths.web, "package.json", `${JSON.stringify({ name: "web", dependencies: { react: "catalog:" } }, null, 2)}\n`);
  put(paths.web, "components.json", '{"style":"base-nova"}\n');
  put(paths.kit, "lib/utils.ts", 'export { cn } from "cn";\n');
  return paths;
}

/**
 * The registry build of `version`: the 9 kit items, with one link to the live
 * registry, one bare shadcn name and the `extra` registry dependencies.
 */
function writeDist(dist: string, version: string, extra: readonly string[]): void {
  for (const name of KIT_ITEMS) {
    const item: FakeItem = { files: [{ path: `components/assistant-ui/${name}.tsx`, content: `${name} view\n` }] };
    if (name === "thread") {
      item.dependencies = [`@assistant-ui/react@^${version}`, "lucide-react"];
      item.registryDependencies = ["button", "https://r.assistant-ui.com/base/surfaces.json", ...extra];
    }
    put(dist, `base/${name}.json`, JSON.stringify(item));
  }
  put(dist, "base/surfaces.json", JSON.stringify({ files: [{ path: "components/assistant-ui/surfaces.tsx", content: "surfaces\n" }] }));
}

/**
 * The shadcn CLI as far as the script depends on it: it writes the files of
 * each item and of its registry dependencies into src/kit of its project, and
 * writes the npm dependencies into the manifest with a caret range, as pnpm add
 * does. A bare name stands for a part from ui.shadcn.com.
 */
async function fakeCli(args: readonly string[], cwd: string): Promise<void> {
  const at = args.indexOf("--cwd");
  const project = at === -1 ? cwd : args[at + 1]!;
  const manifest = JSON.parse(readFileSync(join(project, "package.json"), "utf8")) as Manifest;
  const queue = args.filter((arg) => arg.startsWith("http://"));
  const seen = new Set<string>();

  while (queue.length > 0) {
    const reference = queue.shift()!;
    if (seen.has(reference)) continue;
    seen.add(reference);

    const item = reference.startsWith("http://")
      ? await (await download(reference)).json() as FakeItem
      : { files: [{ path: `components/ui/${reference}.tsx`, content: `${reference} from the shadcn site\n` }] };
    for (const file of item.files ?? []) put(join(project, "src", "kit"), file.path, file.content);
    queue.push(...(item.registryDependencies ?? []));

    for (const dependency of item.dependencies ?? []) {
      const [, name, floor] = /^(@?[^@]+)(?:@\^(.+))?$/.exec(dependency)!;
      manifest.dependencies = { ...manifest.dependencies, [name!]: `^${floor ?? "0.5.0"}` };
    }
  }
  writeFileSync(join(project, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** The source commit of a fake release: its version digits, as 40 hex digits. */
const commitOf = (version: string) => version.replaceAll(".", "").padStart(40, "0");

type FakeOptions = {
  /** The age in days of each release in the packument. */
  releases?: Record<string, number>;
  /** The deprecation message of each deprecated release. */
  deprecated?: Record<string, string>;
  /** Registry dependencies that the thread item names in addition to its own. */
  registryDependencies?: string[];
  /** The number of root installs that fail first. */
  failedInstalls?: number;
  /** The first command (`args[0]` of pnpm) that a signal stops; each later command fails too. */
  stopAt?: string;
};

/** Tools that build, download and run nothing outside the test. */
function fakeTools({
  releases = { "1.2.3": 8, "1.3.0": 1 },
  deprecated = {},
  registryDependencies = [],
  failedInstalls = 0,
  stopAt,
}: FakeOptions = {}) {
  const calls: { command: string; args: readonly string[]; cwd: string }[] = [];
  const logged: string[] = [];
  const downloads: string[] = [];
  let installsToFail = failedInstalls;
  let stopped = false;
  let built = "";

  const tools: Tools = {
    now: () => NOW,
    log: (message) => logged.push(message),
    download: async (url) => {
      downloads.push(url);
      if (url === PACKUMENT_URL) {
        const entries = Object.entries(releases);
        return Response.json({
          time: Object.fromEntries(entries.map(([version, days]) => [version, before(days)])),
          versions: Object.fromEntries(entries.map(([version]) => [version, { deprecated: deprecated[version] }])),
        });
      }
      const attested = /\/attestations\/.+@(.+)$/.exec(url)?.[1];
      if (attested !== undefined) return Response.json(attestationsAnswer([sourceDependency(commitOf(attested))]));
      built = Object.keys(releases).find((version) => url === archiveUrl(commitOf(version)))!;
      return new Response("archive");
    },
    run: async (command, args, cwd) => {
      calls.push({ command, args, cwd });
      if (stopped || args[0] === stopAt) {
        stopped = true;
        throw new Error("stopped by SIGINT");
      }
      if (command === "tar") {
        const repo = join(args[3]!, `assistant-ui-${commitOf(built)}`);
        mkdirSync(join(repo, "apps", "registry"), { recursive: true });
        put(repo, "packages/react/package.json", JSON.stringify({ name: "@assistant-ui/react", version: built }));
      } else if (args[0] === "build") {
        writeDist(join(cwd, "dist"), built, registryDependencies);
      } else if (args[0] === "exec") {
        await fakeCli(args, cwd);
      } else if (args.length === 1 && args[0] === "install" && installsToFail > 0) {
        installsToFail -= 1;
        throw new Error("pnpm install failed");
      }
    },
  };
  return { tools, calls, logged, downloads };
}

function readRepo(paths: RepoPaths) {
  return {
    kit: readTree(paths.kit),
    webManifest: readFileSync(paths.webManifest, "utf8"),
    workspace: readFileSync(paths.workspace, "utf8"),
    lockfile: readFileSync(paths.lockfile, "utf8"),
  };
}

const catalogIn = (paths: RepoPaths) => (parse(readFileSync(paths.workspace, "utf8")) as { catalog: unknown }).catalog;

describe("update", () => {
  it("copies the kit of the selected release, puts the catalog on its packages and installs", async () => {
    const paths = fakeRepo();
    const { tools, calls, logged, downloads } = fakeTools();

    expect(await update(paths, tools, undefined, scratch())).toBe(0);

    const expected: [string, string][] = [
      ...KIT_ITEMS.map((name): [string, string] => [`components/assistant-ui/${name}.tsx`, `${name} view\n`]),
      ["components/assistant-ui/surfaces.tsx", "surfaces\n"],
      ["components/ui/button.tsx", "button from the shadcn site\n"],
      ["kit.css", ""],
      ["lib/utils.ts", 'export { cn } from "cn";\n'],
    ];
    expect([...readTree(paths.kit)]).toEqual(expected.sort(([left], [right]) => (left < right ? -1 : 1)));
    expect(logged).toContain("@assistant-ui/react 1.2.3");
    expect(logged).toContain(`source commit ${commitOf("1.2.3")}`);
    expect(logged).toContain("new shadcn part from ui.shadcn.com: button");
    expect(downloads.at(-1)).toBe(archiveUrl(commitOf("1.2.3")));
    expect(catalogIn(paths)).toEqual({ "@assistant-ui/react": "1.2.3", "lucide-react": "^0.5.0", "react": "^19.2.0" });
    expect(readFileSync(paths.workspace, "utf8")).toContain("  # Kept for a reason.\n  react: ^19.2.0\n");
    expect(JSON.parse(readFileSync(paths.webManifest, "utf8"))).toEqual({
      name: "web",
      dependencies: { "react": "catalog:", "@assistant-ui/react": "catalog:", "lucide-react": "catalog:" },
    });
    expect(calls.map(({ command, args }) => `${command} ${args[0]}`)).toEqual([
      "tar -xzf",
      "pnpm install",
      "pnpm build",
      "pnpm exec",
      "pnpm install",
    ]);
    expect(calls[1]!.args).toEqual(["install", "--frozen-lockfile", "--ignore-scripts", "--filter", "@assistant-ui/shadcn-registry..."]);
    expect(calls.at(-1)!.cwd).toBe(paths.root);
  });

  it("builds the release that --release names and pins that release, also when a higher one is old enough", async () => {
    const paths = fakeRepo();
    const { tools, downloads } = fakeTools({ releases: { "1.2.3": 9, "1.2.4": 8 } });

    expect(await update(paths, tools, "1.2.3", scratch())).toBe(0);

    expect(downloads).toContain(archiveUrl(commitOf("1.2.3")));
    expect(catalogIn(paths)).toMatchObject({ "@assistant-ui/react": "1.2.3" });
  });

  it("refuses a --release version less than 7 days old before it builds or changes anything", async () => {
    const paths = fakeRepo();
    const original = readRepo(paths);
    const { tools, calls, logged, downloads } = fakeTools();

    await expect(update(paths, tools, "1.3.0", scratch())).rejects.toThrow("less than 7 days old");

    expect(downloads).toEqual([PACKUMENT_URL]);
    expect(calls).toEqual([]);
    expect(logged).toEqual([]);
    expect(readRepo(paths)).toEqual(original);
  });

  it("serves the saved shadcn parts on a later run, and reports each marked block that the update removed", async () => {
    const paths = fakeRepo();
    await update(paths, fakeTools().tools, undefined, scratch());
    put(paths.kit, "components/ui/button.tsx", "// tasma-edit: keep\nbutton\n// tasma-edit end\n");
    put(paths.kit, "components/assistant-ui/thread.tsx", "{/* tasma-edit: lost */}\n{/* tasma-edit end */}\n");
    const { tools, logged } = fakeTools();

    expect(await update(paths, tools, undefined, scratch())).toBe(1);

    expect(readFileSync(join(paths.kit, "components/ui/button.tsx"), "utf8")).toBe(
      "// tasma-edit: keep\nbutton\n// tasma-edit end\n",
    );
    expect(readFileSync(join(paths.kit, "components/assistant-ui/thread.tsx"), "utf8")).toBe("thread view\n");
    expect(logged.filter((message) => message.startsWith("new shadcn part"))).toEqual([]);
    expect(logged).toContain(
      "the update removed a tasma-edit block from components/assistant-ui/thread.tsx (lost):\n"
      + "{/* tasma-edit: lost */}\n{/* tasma-edit end */}",
    );
  });

  it("puts the kit, the manifest, the catalog and the lockfile back when a step fails, and installs again", async () => {
    const paths = fakeRepo();
    put(paths.kit, "components/assistant-ui/stale.tsx", "stale\n");
    const original = readRepo(paths);
    const { tools, calls, logged } = fakeTools({ failedInstalls: 1 });

    await expect(update(paths, tools, undefined, scratch())).rejects.toThrow("pnpm install failed");

    expect(readRepo(paths)).toEqual(original);
    expect(calls.filter(({ args }) => args.length === 1 && args[0] === "install")).toHaveLength(2);
    expect(logged).toContain("the update failed; the kit, the manifest, the catalog and the lockfile are put back");
  });

  it("reports the original failure also when the install after the restore fails", async () => {
    const { tools, logged } = fakeTools({ failedInstalls: 2 });

    await expect(update(fakeRepo(), tools, undefined, scratch())).rejects.toThrow("pnpm install failed");

    expect(logged).toContain("pnpm install after the restore failed too (pnpm install failed); run pnpm install");
  });

  it("puts the tree back when a signal stops the CLI, and asks for the install it cannot run", async () => {
    const paths = fakeRepo();
    put(paths.kit, "components/assistant-ui/stale.tsx", "stale\n");
    const original = readRepo(paths);
    const { tools, logged } = fakeTools({ stopAt: "exec" });

    await expect(update(paths, tools, undefined, scratch())).rejects.toThrow("stopped by SIGINT");

    expect(readRepo(paths)).toEqual(original);
    expect(logged).toContain("pnpm install after the restore failed too (stopped by SIGINT); run pnpm install");
  });

  it("refuses an item that names a foreign registry dependency, and puts the tree back", async () => {
    const paths = fakeRepo();
    const original = readRepo(paths);
    const { tools } = fakeTools({ registryDependencies: ["@shadcn/avatar", "https://r.example.com/base/chip.json"] });

    await expect(update(paths, tools, undefined, scratch())).rejects.toThrow(
      "a kit item names a registry dependency that is not an assistant-ui item or a shadcn name: https://r.example.com/base/chip.json",
    );

    expect(readRepo(paths)).toEqual(original);
  });

  it("changes nothing when a marked block of the kit is malformed", async () => {
    const paths = fakeRepo();
    put(paths.kit, "kit.css", "/* tasma-edit: open */\n");
    const original = readRepo(paths);
    const { tools, calls } = fakeTools();

    await expect(update(paths, tools, undefined, scratch())).rejects.toThrow("kit.css: line 1");

    expect(readRepo(paths)).toEqual(original);
    expect(calls.filter(({ args }) => args[0] === "exec")).toEqual([]);
  });
});

describe("check", () => {
  async function updatedRepo(): Promise<RepoPaths> {
    const paths = fakeRepo();
    await update(paths, fakeTools().tools, undefined, scratch());
    return paths;
  }

  it("passes the kit that update copied, and names each line that differs outside a marked block", async () => {
    const paths = await updatedRepo();
    const temp = scratch();
    const { tools, calls, logged, downloads } = fakeTools();

    expect(await check(paths, tools, temp)).toBe(0);
    expect(logged.at(-1)).toBe(
      "apps/web/src/kit is the CLI output for @assistant-ui/react 1.2.3, apart from 2 files that kit:check cannot verify",
    );
    expect(downloads).toContain(archiveUrl(commitOf("1.2.3")));
    expect(calls.find(({ args }) => args[0] === "exec")!.args.slice(-2)).toEqual(["--cwd", join(temp, "project")]);

    put(paths.kit, "components/assistant-ui/thread.tsx", "thread view, edited\n");
    const second = fakeTools();

    expect(await check(paths, second.tools, scratch())).toBe(1);
    expect(second.logged).toContain(
      "apps/web/src/kit/components/assistant-ui/thread.tsx:1 differs from the CLI output outside a tasma-edit block",
    );
    expect(second.logged.filter((message) => message.includes("is the CLI output"))).toEqual([]);
  });

  it("names the shadcn parts it serves from the folder and lib/utils.ts as not verified", async () => {
    const paths = await updatedRepo();
    const { tools, logged } = fakeTools();

    expect(await check(paths, tools, scratch())).toBe(0);
    expect(logged).toContain(
      "apps/web/src/kit/components/ui/button.tsx is not verified: kit:check serves it to the CLI from this folder; review its diff",
    );
    expect(logged).toContain("apps/web/src/kit/lib/utils.ts is not verified: it is a Tasma file; review its diff");
  });

  it("lists each marked block it accepts, and counts them in the result", async () => {
    const paths = await updatedRepo();
    put(paths.kit, "components/assistant-ui/thread.tsx", "// tasma-edit: wider bubble\nthread view, wide\n// tasma-edit end\n");
    const one = fakeTools();

    expect(await check(paths, one.tools, scratch())).toBe(0);
    expect(one.logged).toContain("apps/web/src/kit/components/assistant-ui/thread.tsx:1-3 is a tasma-edit block: wider bubble");
    expect(one.logged.at(-1)).toBe(
      "apps/web/src/kit is the CLI output for @assistant-ui/react 1.2.3, apart from 1 tasma-edit block and 2 files that kit:check cannot verify",
    );

    put(paths.kit, "kit.css", "/* tasma-edit: no shimmer */\n/* tasma-edit end */\n");
    const two = fakeTools();

    expect(await check(paths, two.tools, scratch())).toBe(0);
    expect(two.logged).toContain("apps/web/src/kit/kit.css:1-2 is a tasma-edit block: no shimmer");
    expect(two.logged.at(-1)).toBe(
      "apps/web/src/kit is the CLI output for @assistant-ui/react 1.2.3, apart from 2 tasma-edit blocks and 2 files that kit:check cannot verify",
    );
  });

  it("refuses a catalog version that is young, deprecated or unlisted before it downloads the source", async () => {
    const cases: [FakeOptions, string][] = [
      [{ releases: { "1.2.3": 1 } }, "@assistant-ui/react 1.2.3 is less than 7 days old"],
      [{ releases: { "1.2.3": 30 }, deprecated: { "1.2.3": "broken build" } }, "@assistant-ui/react 1.2.3 is deprecated: broken build"],
      [{ releases: { "1.2.4": 30 } }, "@assistant-ui/react has no release 1.2.3"],
    ];

    for (const [options, reason] of cases) {
      const paths = await updatedRepo();
      const { tools, calls, downloads } = fakeTools(options);

      await expect(check(paths, tools, scratch()), reason).rejects.toThrow(reason);
      expect(downloads).toEqual([PACKUMENT_URL]);
      expect(calls).toEqual([]);
    }
  });
});

describe("main", () => {
  it("updates, checks in a temporary folder that it removes, and refuses a bad argument", async () => {
    const paths = fakeRepo();
    const updating = fakeTools();

    expect(await main([], paths, updating.tools)).toBe(0);
    expect(await main(["--check"], paths, fakeTools().tools)).toBe(0);
    await expect(main(["--force"], paths, fakeTools().tools)).rejects.toThrow("unknown argument: --force");
    expect(existsSync(updating.calls[0]!.cwd)).toBe(false);
  });
});

describe("cli", () => {
  it("gives the exit code of main: 0 for a pass, 1 for a difference", async () => {
    const paths = fakeRepo();

    expect(await cli([], paths, fakeTools().tools)).toBe(0);
    put(paths.kit, "components/assistant-ui/thread.tsx", "thread view, edited\n");
    expect(await cli(["--check"], paths, fakeTools().tools)).toBe(1);
  });

  it("logs a failure and gives exit code 1", async () => {
    const { tools, logged } = fakeTools();

    expect(await cli(["--force"], fakeRepo(), tools)).toBe(1);
    expect(logged).toEqual(["unknown argument: --force"]);
  });

  it("runs when Node starts the file, also through a symlink, and exits 1 with the reason of a failure", () => {
    const link = join(scratch(), "kit-update.ts");
    symlinkSync(SCRIPT, link);

    for (const entry of [SCRIPT, link]) {
      const result = spawnSync(process.execPath, [entry, "--force"], { encoding: "utf8" });

      expect(result.status, entry).toBe(1);
      expect(result.stderr, entry).toContain("kit: unknown argument: --force");
    }
  });
});

describe("isEntryPoint", () => {
  const url = pathToFileURL(SCRIPT).href;

  it("is true for the script, by its path or by a symlink to it", () => {
    const link = join(scratch(), "kit-update.ts");
    symlinkSync(SCRIPT, link);

    expect(isEntryPoint(SCRIPT, url)).toBe(true);
    expect(isEntryPoint(link, url)).toBe(true);
  });

  it("is false for another file, a path that does not exist and no path", () => {
    expect(isEntryPoint(join(workspaceRoot, "package.json"), url)).toBe(false);
    expect(isEntryPoint(join(scratch(), "missing.ts"), url)).toBe(false);
    expect(isEntryPoint(undefined, url)).toBe(false);
  });
});

describe("the tools of a real run", () => {
  it("log to stderr with the kit: prefix", () => {
    const printed = vi.spyOn(console, "error").mockImplementation(() => undefined);

    log("a note");

    expect(printed).toHaveBeenCalledWith("kit: a note");
    printed.mockRestore();
  });

  it("log each control character except a line break and a tab as an escape", () => {
    const printed = vi.spyOn(console, "error").mockImplementation(() => undefined);

    log("reason \u001b[8mhidden\r\u0000\u007f\u009b\nnext\tline");

    expect(printed).toHaveBeenCalledWith("kit: reason \\x1b[8mhidden\\x0d\\x00\\x7f\\x9b\nnext\tline");
    printed.mockRestore();
  });

  it("run a command, and reject when it fails, is killed or cannot start", async () => {
    const printed = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cwd = scratch();

    await expect(run(process.execPath, ["-e", "process.exit(0)"], cwd)).resolves.toBeUndefined();
    await expect(run(process.execPath, ["-e", "process.exit(3)"], cwd)).rejects.toThrow("failed (exit code 3)");
    await expect(run(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"], cwd)).rejects.toThrow("(SIGTERM)");
    await expect(run("false", [], cwd)).rejects.toThrow("false  failed");
    await expect(run(join(cwd, "missing"), [], cwd)).rejects.toThrow("ENOENT");
    expect(printed).toHaveBeenCalledWith(`kit: ${process.execPath} -e process.exit(0)  (in ${cwd})`);
    printed.mockRestore();
  });

  it("stop a running command when the signal aborts, reject only after it exits, and start none after it", async () => {
    const printed = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cwd = scratch();
    const ready = join(cwd, "ready");
    const exited = join(cwd, "exited");
    const controller = new AbortController();
    const child = [
      'const { writeFileSync } = require("node:fs");',
      `process.on("SIGTERM", () => setTimeout(() => { writeFileSync(${JSON.stringify(exited)}, ""); process.exit(1); }, 300));`,
      `writeFileSync(${JSON.stringify(ready)}, "");`,
      "setInterval(() => {}, 1000);",
    ].join("\n");

    const running = run(process.execPath, ["-e", child], cwd, controller.signal);
    await vi.waitFor(() => {
      expect(existsSync(ready)).toBe(true);
    });
    controller.abort(new Error("stopped by SIGTERM"));

    await expect(running).rejects.toThrow("stopped by SIGTERM");
    expect(existsSync(exited)).toBe(true);
    printed.mockClear();
    await expect(run(process.execPath, ["-e", "process.exit(0)"], cwd, controller.signal)).rejects.toThrow("stopped by SIGTERM");
    expect(printed).not.toHaveBeenCalled();
    printed.mockRestore();
  });

  it("download a URL, and reject an answer that is not OK or a download the signal stops", async () => {
    const server = createServer((request, response) => {
      response.writeHead(request.url === "/found" ? 200 : 404).end("body");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      expect(await (await download(`${origin}/found`)).text()).toBe("body");
      await expect(download(`${origin}/lost`)).rejects.toThrow(`${origin}/lost answered 404`);
      await expect(download(`${origin}/found`, AbortSignal.abort(new Error("stopped by SIGINT")))).rejects.toThrow("stopped by SIGINT");
    } finally {
      server.close();
    }
  });

  it("stop on SIGINT or SIGTERM until they are disposed", async () => {
    const printed = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cwd = scratch();

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const source = new EventEmitter();
      const { tools, dispose } = systemTools(source);

      await expect(tools.run(process.execPath, ["-e", "process.exit(0)"], cwd)).resolves.toBeUndefined();
      expect(tools.now()).toBeGreaterThan(0);
      source.emit(signal, signal);

      expect(printed).toHaveBeenCalledWith(`kit: stopping on ${signal}`);
      await expect(tools.run(process.execPath, ["-e", "process.exit(0)"], cwd)).rejects.toThrow(`stopped by ${signal}`);
      await expect(tools.download("http://127.0.0.1:9/")).rejects.toThrow(`stopped by ${signal}`);
      dispose();
      expect([source.listenerCount("SIGINT"), source.listenerCount("SIGTERM")]).toEqual([0, 0]);
    }
    printed.mockRestore();
  });
});
