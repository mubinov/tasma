import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

/** The one Tasma file in the kit folder. The CLI does not write it, and kit:check skips it. */
export const UTILS = "lib/utils.ts";
export const KIT_CSS = "kit.css";

/** The files under `dir` by their relative `/` paths, in order of path. A path with a control character is refused. */
export function readTree(dir: string): Map<string, string> {
  if (!existsSync(dir)) return new Map();

  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)));
  const named = files.find((file) => /\p{Cc}/u.test(file));
  if (named !== undefined) throw new Error(`a file name in ${dir} holds a control character: ${JSON.stringify(named)}`);

  return new Map(
    files
      .map((file) => [file.split(sep).join("/"), readFileSync(join(dir, file), "utf8")] as const)
      .sort(([left], [right]) => (left < right ? -1 : 1)),
  );
}

export function writeTree(dir: string, files: ReadonlyMap<string, string>): void {
  for (const [file, text] of files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
}

/** The shadcn parts saved in the kit folder, by name. */
export function shadcnParts(kit: string): Map<string, string> {
  const parts = new Map<string, string>();
  for (const [file, text] of readTree(join(kit, "components", "ui"))) {
    if (file.endsWith(".tsx") && !file.includes("/")) parts.set(file.slice(0, -".tsx".length), text);
  }
  return parts;
}

/** Empties the kit folder except lib/utils.ts, and leaves an empty kit.css, so nothing of an older release stays. */
export function clearKit(kit: string): void {
  const utilsDir = dirname(UTILS);
  mkdirSync(kit, { recursive: true });
  for (const entry of readdirSync(kit)) {
    if (entry !== utilsDir) rmSync(join(kit, entry), { recursive: true, force: true });
  }
  const lib = join(kit, utilsDir);
  if (existsSync(lib)) {
    for (const entry of readdirSync(lib)) {
      if (entry !== basename(UTILS)) rmSync(join(lib, entry), { recursive: true, force: true });
    }
  }
  writeFileSync(join(kit, KIT_CSS), "");
}

/** Copies each of `paths` that exists into `into`, by its index. */
export function backUp(paths: readonly string[], into: string): void {
  paths.forEach((path, index) => {
    if (existsSync(path)) cpSync(path, join(into, String(index)), { recursive: true });
  });
}

/** Puts each of `paths` back as `backUp` saved it, and removes one that did not exist then. */
export function restore(paths: readonly string[], from: string): void {
  paths.forEach((path, index) => {
    rmSync(path, { recursive: true, force: true });
    const saved = join(from, String(index));
    if (existsSync(saved)) cpSync(saved, path, { recursive: true });
  });
}
