import { existsSync, globSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { parse } from "yaml";

/** Scope every package published from this workspace shares. */
const INTERNAL_SCOPE = "@tasma/";

/**
 * Styling libraries that build their CSS during render.
 *
 * Zero-runtime CSS is one of this workspace's performance invariants: the
 * styling layer emits a stylesheet at build time and costs nothing per render.
 * A library from this list reintroduces that cost the moment it is installed,
 * so the guard names the package rather than leaving it to review.
 */
const RUNTIME_CSS_IN_JS = [
  "@emotion/css",
  "@emotion/react",
  "@emotion/styled",
  "@stitches/react",
  "@vanilla-extract/dynamic",
  "goober",
  "jss",
  "styled-components",
  "styled-jsx",
  "twin.macro",
];

export type PackageManifest = {
  name?: string;
  // npm accepts both forms: one target under the package's own name, or a map
  // of command name to target.
  bin?: string | Record<string, string>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

export const workspaceRoot = import.meta.dirname;

// pnpm-workspace.yaml is the single source of the workspace shape; the vitest
// projects and the repo guard derive from this module rather than restate it.
export const packageGlobs = (
  parse(readFileSync(join(workspaceRoot, "pnpm-workspace.yaml"), "utf8")) as { packages: string[] }
).packages;

// A glob can match a directory that carries no manifest, which is not a package.
export const packageDirs = globSync(packageGlobs, { cwd: workspaceRoot }).filter((dir) =>
  existsSync(join(workspaceRoot, dir, "package.json")),
);

export function readManifest(dir: string): PackageManifest {
  return JSON.parse(readFileSync(join(workspaceRoot, dir, "package.json"), "utf8")) as PackageManifest;
}

// Every field npm installs from. A guard that reads a subset leaves the
// remaining fields as a way in, so both guards below share this one list.
function dependencyFields(manifest: PackageManifest): (Record<string, string> | undefined)[] {
  return [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies, manifest.optionalDependencies];
}

/**
 * Internal packages the manifest declares without the `workspace:` protocol.
 *
 * pnpm links a workspace package by bare semver range only while the local
 * version satisfies that range; on a mismatch it falls back to the public
 * registry, where the scope is unclaimed. `workspace:` links unconditionally
 * and fails the install instead of reaching the registry.
 */
export function unlinkedInternalDependencies(manifest: PackageManifest): string[] {
  return dependencyFields(manifest).flatMap((deps) =>
    Object.entries(deps ?? {})
      .filter(([name, range]) => name.startsWith(INTERNAL_SCOPE) && !range.startsWith("workspace:"))
      .map(([name]) => name),
  );
}

/** Runtime CSS-in-JS libraries the manifest declares, in any dependency field. */
export function runtimeCssInJsDependencies(manifest: PackageManifest): string[] {
  return [...new Set(dependencyFields(manifest).flatMap((deps) => Object.keys(deps ?? {})))].filter((name) =>
    RUNTIME_CSS_IN_JS.includes(name),
  );
}

/** Every path a manifest's `bin` installs, whichever of the two forms it uses. */
export function binTargets(manifest: PackageManifest): string[] {
  return typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin ?? {});
}

/**
 * Faults in a manifest's `bin` declaration.
 *
 * An executable in this workspace is built, never hand-written: pnpm links the
 * `bin` target at install time, so a target outside `dist/` is a source file
 * being run as a program, and a `bin` without a `build` script is a target
 * nothing ever produces.
 */
export function binDeclarationFaults(manifest: PackageManifest): string[] {
  const targets = binTargets(manifest);

  if (targets.length === 0) {
    return [];
  }

  // Normalized before the prefix test: `dist/../src/main.ts` carries the prefix
  // and still names a file outside the directory.
  const faults = targets
    .filter((target) => !posix.normalize(target).startsWith("dist/"))
    .map((target) => `declares a "bin" target outside dist/: ${target}`);

  if (manifest.scripts?.build === undefined) {
    faults.push('declares "bin" without a "build" script');
  }

  return faults;
}

// A lockfile v9 packages: key is `name@version`, and a scoped name starts with
// its own @, so the version separator is the last one.
function packageNameFromLockKey(key: string): string {
  return key.slice(0, key.lastIndexOf("@"));
}

/**
 * Runtime CSS-in-JS libraries anywhere in the installed tree.
 *
 * A manifest scan only catches a package that declares the library itself. One
 * dependency pulling it in transitively — `@mui/material` brings `@emotion/react`
 * and `@emotion/styled` — reaches the renderer just the same while every
 * manifest stays clean, so the guard reads what the install actually resolves.
 */
export function runtimeCssInJsPackages(lockfile: string): string[] {
  const packages = (parse(lockfile) as { packages?: Record<string, unknown> }).packages ?? {};
  return [...new Set(Object.keys(packages).map(packageNameFromLockKey))].filter((name) =>
    RUNTIME_CSS_IN_JS.includes(name),
  );
}

/** The lockfile text, which records what the install actually resolved. */
export function readLockfile(): string {
  return readFileSync(join(workspaceRoot, "pnpm-lock.yaml"), "utf8");
}
