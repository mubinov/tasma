/**
 * Copies the assistant-ui kit into apps/web/src/kit with the shadcn CLI, and
 * checks that the folder is still that copy.
 *
 *   pnpm kit:update [--release <version>]
 *   pnpm kit:check
 *
 * The view files and the npm packages come from one assistant-ui release that
 * is 7 or more days old: the live registry serves only its last build, so the
 * script builds the registry from the source commit that the npm provenance of
 * the release names, and serves it on 127.0.0.1. The shadcn parts under
 * components/ui are served from the folder itself, so a run fetches them from
 * ui.shadcn.com only when the folder lacks one.
 *
 * Node runs this file directly, so it uses only erasable TypeScript syntax.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareKit, kitBlocks, lostBlocks, noteBlocks } from "./kit/blocks.ts";
import {
  applyCatalog,
  catalogOf,
  catalogVersion,
  checkProjectFiles,
  planCatalog,
  withCatalog,
  writtenDependencies,
  type Manifest,
} from "./kit/catalog.ts";
import { backUp, clearKit, readTree, restore, shadcnParts, UTILS, writeTree } from "./kit/files.ts";
import { itemUrls, serveRegistry, type KitServer } from "./kit/registry.ts";
import {
  acceptRelease,
  archiveUrl,
  attestationsUrl,
  PACKAGE,
  PACKUMENT_URL,
  releasedPackages,
  selectRelease,
  sourceCommit,
  type Packument,
} from "./kit/release.ts";

const REGISTRY_PACKAGE = "@assistant-ui/shadcn-registry";

export type Options = { check: boolean; release?: string };

export function parseOptions(args: readonly string[]): Options {
  const rest = args[0] === "--" ? args.slice(1) : args;
  const options: Options = { check: false };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    let release: string | undefined;

    if (arg === "--check") {
      options.check = true;
      continue;
    } else if (arg === "--release") {
      index += 1;
      release = rest[index];
    } else if (arg.startsWith("--release=")) {
      release = arg.slice("--release=".length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }

    if (release === undefined || release === "" || release.startsWith("-")) {
      throw new Error("--release needs a version");
    }
    options.release = release;
  }

  if (options.check && options.release !== undefined) {
    throw new Error("--check takes the version from the catalog and does not accept --release");
  }
  return options;
}

export type RepoPaths = {
  root: string;
  web: string;
  kit: string;
  components: string;
  webManifest: string;
  rootManifest: string;
  workspace: string;
  lockfile: string;
};

export function repoPaths(root: string): RepoPaths {
  const web = join(root, "apps", "web");
  return {
    root,
    web,
    kit: join(web, "src", "kit"),
    components: join(web, "components.json"),
    webManifest: join(web, "package.json"),
    rootManifest: join(root, "package.json"),
    workspace: join(root, "pnpm-workspace.yaml"),
    lockfile: join(root, "pnpm-lock.yaml"),
  };
}

/** What the script does outside its own files: processes, network, clock and log. */
export type Tools = {
  run: (command: string, args: readonly string[], cwd: string) => Promise<void>;
  download: (url: string) => Promise<Response>;
  now: () => number;
  log: (message: string) => void;
};

/**
 * Writes a note to stderr. Each control character except a line break and a
 * tab is escaped, so text from a file cannot drive the terminal.
 */
export function log(message: string): void {
  const shown = message.replace(/\p{Cc}/gu, (char) =>
    (char === "\n" || char === "\t" ? char : `\\x${char.codePointAt(0)!.toString(16).padStart(2, "0")}`));
  console.error(`kit: ${shown}`);
}

/**
 * Runs a command with the output of the script, and rejects when it does not
 * exit 0 or `signal` stops it. A stopped command rejects at its exit, not at
 * the abort, because it can write files until then.
 */
export async function run(command: string, args: readonly string[], cwd: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  log(`${command} ${args.join(" ")}  (in ${cwd})`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", signal });
    child.on("error", (error) => {
      if (signal?.aborted !== true) reject(error);
    });
    child.on("close", (code, exitSignal) => {
      if (signal?.aborted === true) reject(signal.reason as Error);
      else if (code === 0) resolve();
      else reject(new Error(`${command} ${args[0] ?? ""} failed (${exitSignal ?? `exit code ${code}`})`));
    });
  });
}

export async function download(url: string, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response;
}

type SignalSource = {
  on(event: "SIGINT" | "SIGTERM", listener: (signal: NodeJS.Signals) => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: (signal: NodeJS.Signals) => void): unknown;
};

/**
 * The tools of a real run. SIGINT or SIGTERM stops the running command and
 * download and fails each later one, so the restore and the cleanup still run.
 */
export function systemTools(source: SignalSource): { tools: Tools; dispose: () => void } {
  const controller = new AbortController();
  const stop = (signal: NodeJS.Signals) => {
    log(`stopping on ${signal}`);
    controller.abort(new Error(`stopped by ${signal}`));
  };
  source.on("SIGINT", stop);
  source.on("SIGTERM", stop);

  return {
    tools: {
      run: (command, args, cwd) => run(command, args, cwd, controller.signal),
      download: (url) => download(url, controller.signal),
      now: Date.now,
      log,
    },
    dispose: () => {
      source.off("SIGINT", stop);
      source.off("SIGTERM", stop);
    },
  };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

async function readPackument(tools: Tools): Promise<Packument> {
  return await (await tools.download(PACKUMENT_URL)).json() as Packument;
}

type Registry = { dist: string; released: Set<string> };

/** Builds the assistant-ui registry at the source commit of `version`. */
async function buildRegistry(version: string, temp: string, tools: Tools): Promise<Registry> {
  const commit = sourceCommit(await (await tools.download(attestationsUrl(version))).json(), version);
  tools.log(`source commit ${commit}`);

  const archive = join(temp, "assistant-ui.tar.gz");
  const source = join(temp, "source");
  const response = await tools.download(archiveUrl(commit));
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  mkdirSync(source);
  await tools.run("tar", ["-xzf", archive, "-C", source], temp);

  const repo = join(source, readdirSync(source)[0]!);
  await tools.run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts", "--filter", `${REGISTRY_PACKAGE}...`], repo);
  await tools.run("pnpm", ["build"], join(repo, "apps", "registry"));
  return { dist: join(repo, "apps", "registry", "dist"), released: releasedPackages(repo) };
}

async function addKit(server: KitServer, paths: RepoPaths, tools: Tools, extra: readonly string[]): Promise<void> {
  const args = ["exec", "shadcn", "add", ...itemUrls(server.origin), "--overwrite", "--yes", ...extra];
  const refuseForeign = () => {
    if (server.foreign.size > 0) {
      const names = [...server.foreign].join(", ");
      throw new Error(`a kit item names a registry dependency that is not an assistant-ui item or a shadcn name: ${names}`);
    }
  };

  await tools.run("pnpm", args, paths.web).catch((error: unknown) => {
    refuseForeign();
    throw error;
  });
  refuseForeign();
  for (const name of server.fromShadcn) tools.log(`new shadcn part from ui.shadcn.com: ${name}`);
}

/** Puts the catalog back on each dependency the CLI wrote with a version. */
function moveToCatalog(paths: RepoPaths, pinned: ReadonlyMap<string, string>, released: ReadonlySet<string>): void {
  const manifest = readJson<Manifest>(paths.webManifest);
  const written = writtenDependencies(manifest);
  const workspace = readFileSync(paths.workspace, "utf8");

  writeFileSync(paths.workspace, applyCatalog(workspace, planCatalog(catalogOf(workspace), written, pinned, released)));
  writeFileSync(paths.webManifest, `${JSON.stringify(withCatalog(manifest, Object.keys(written)), null, 2)}\n`);
}

export async function update(
  paths: RepoPaths,
  tools: Tools,
  release: string | undefined,
  temp: string,
): Promise<number> {
  const version = selectRelease(await readPackument(tools), tools.now(), release);
  tools.log(`${PACKAGE} ${version}`);

  const { dist, released } = await buildRegistry(version, temp, tools);
  const saved = [paths.kit, paths.webManifest, paths.workspace, paths.lockfile];
  const backup = join(temp, "backup");
  const noted = noteBlocks(readTree(paths.kit));
  backUp(saved, backup);

  const server = await serveRegistry(dist, shadcnParts(paths.kit));
  try {
    clearKit(paths.kit);
    await addKit(server, paths, tools, []);
    moveToCatalog(paths, server.pinned, released);
    await tools.run("pnpm", ["install"], paths.root);
  } catch (error) {
    tools.log("the update failed; the kit, the manifest, the catalog and the lockfile are put back");
    restore(saved, backup);
    await tools.run("pnpm", ["install"], paths.root).catch((reinstall: unknown) => {
      tools.log(`pnpm install after the restore failed too (${(reinstall as Error).message}); run pnpm install`);
    });
    throw error;
  } finally {
    await server.close();
  }

  const lost = lostBlocks(noted, readTree(paths.kit));
  for (const block of lost) {
    tools.log(`the update removed a tasma-edit block from ${block.file} (${block.reason}):\n${block.text}`);
  }
  return lost.length === 0 ? 0 : 1;
}

const count = (amount: number, noun: string) => `${amount} ${noun}${amount === 1 ? "" : "s"}`;

export async function check(paths: RepoPaths, tools: Tools, temp: string): Promise<number> {
  const workspace = readFileSync(paths.workspace, "utf8");
  const listed = catalogVersion(workspace, PACKAGE);
  const version = acceptRelease(await readPackument(tools), tools.now(), listed);
  tools.log(`${PACKAGE} ${version}`);

  const { dist } = await buildRegistry(version, temp, tools);
  const project = join(temp, "project");
  writeTree(project, checkProjectFiles({
    components: readFileSync(paths.components, "utf8"),
    utils: readFileSync(join(paths.kit, UTILS), "utf8"),
    webManifest: readJson<Manifest>(paths.webManifest),
    workspace,
    packageManager: readJson<{ packageManager?: string }>(paths.rootManifest).packageManager,
  }));

  const server = await serveRegistry(dist, shadcnParts(paths.kit));
  try {
    await addKit(server, paths, tools, ["--cwd", project]);
  } finally {
    await server.close();
  }

  const kit = readTree(paths.kit);
  const blocks = kitBlocks(kit);
  for (const { file, reason, first, last } of blocks) {
    tools.log(`apps/web/src/kit/${file}:${first}-${last} is a tasma-edit block: ${reason}`);
  }
  const parts = [...server.served].sort().map((name) => `components/ui/${name}.tsx`);
  for (const file of parts) {
    tools.log(`apps/web/src/kit/${file} is not verified: kit:check serves it to the CLI from this folder; review its diff`);
  }
  tools.log(`apps/web/src/kit/${UTILS} is not verified: it is a Tasma file; review its diff`);

  const differences = compareKit(readTree(join(project, "src", "kit")), kit);
  for (const { file, line } of differences) {
    tools.log(`apps/web/src/kit/${file}:${line} differs from the CLI output outside a tasma-edit block`);
  }
  if (differences.length > 0) return 1;

  const edits = blocks.length === 0 ? "" : `${count(blocks.length, "tasma-edit block")} and `;
  const unverified = count(parts.length + 1, "file");
  tools.log(`apps/web/src/kit is the CLI output for ${PACKAGE} ${version}, apart from ${edits}${unverified} that kit:check cannot verify`);
  return 0;
}

export async function main(args: readonly string[], paths: RepoPaths, tools: Tools): Promise<number> {
  const options = parseOptions(args);
  const temp = mkdtempSync(join(tmpdir(), "kit-update-"));
  try {
    return await (options.check ? check(paths, tools, temp) : update(paths, tools, options.release, temp));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** Runs `main` for the command line: a failure is logged, and the result is the exit code. */
export async function cli(args: readonly string[], paths: RepoPaths, tools: Tools): Promise<number> {
  try {
    return await main(args, paths, tools);
  } catch (error) {
    tools.log((error as Error).message);
    return 1;
  }
}

/** Whether Node started the module at `url` as the script `entry`, also through a symlink. */
export function isEntryPoint(entry: string | undefined, url: string): boolean {
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === fileURLToPath(url);
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  const system = systemTools(process);
  process.exitCode = await cli(process.argv.slice(2), repoPaths(join(import.meta.dirname, "..")), system.tools);
  system.dispose();
}
