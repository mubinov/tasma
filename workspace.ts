import { existsSync, globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/** Scope every package published from this workspace shares. */
const INTERNAL_SCOPE = "@tasma/";

export type PackageManifest = {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
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

/**
 * Internal packages the manifest declares without the `workspace:` protocol.
 *
 * pnpm links a workspace package by bare semver range only while the local
 * version satisfies that range; on a mismatch it falls back to the public
 * registry, where the scope is unclaimed. `workspace:` links unconditionally
 * and fails the install instead of reaching the registry.
 */
export function unlinkedInternalDependencies(manifest: PackageManifest): string[] {
  const fields = [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies];
  return fields.flatMap((deps) =>
    Object.entries(deps ?? {})
      .filter(([name, range]) => name.startsWith(INTERNAL_SCOPE) && !range.startsWith("workspace:"))
      .map(([name]) => name),
  );
}
