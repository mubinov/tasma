import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packageDirs, readManifest, unlinkedInternalDependencies, workspaceRoot } from "../workspace.js";

describe("workspace packages", () => {
  it("exist", () => {
    expect(packageDirs.length).toBeGreaterThan(0);
  });

  // The root typecheck script ends in `pnpm -r typecheck`, which silently
  // skips a package that omits the script.
  it("define a typecheck script", () => {
    for (const dir of packageDirs) {
      expect(readManifest(dir).scripts?.typecheck, `${dir}/package.json must define a "typecheck" script`).toBeTypeOf(
        "string",
      );
    }
  });

  // Root `pnpm test` runs vitest in projects mode and never calls this script;
  // it exists so a package can be tested on its own from its own directory.
  it("define a test script", () => {
    for (const dir of packageDirs) {
      expect(readManifest(dir).scripts?.test, `${dir}/package.json must define a "test" script`).toBeTypeOf("string");
    }
  });

  // A package-local vitest config is what makes the package's `test` script
  // work: without it, vitest walks up to the root projects config and fails.
  it("have a local vitest.config.ts", () => {
    for (const dir of packageDirs) {
      expect(existsSync(join(workspaceRoot, dir, "vitest.config.ts")), `${dir} must have a vitest.config.ts`).toBe(
        true,
      );
    }
  });

  it("declare internal dependencies with the workspace: protocol", () => {
    for (const dir of packageDirs) {
      expect(unlinkedInternalDependencies(readManifest(dir)), `${dir}/package.json`).toEqual([]);
    }
  });
});

describe("unlinkedInternalDependencies", () => {
  it("accepts the workspace: protocol", () => {
    expect(unlinkedInternalDependencies({ dependencies: { "@tasma/engine": "workspace:*" } })).toEqual([]);
  });

  it("rejects a semver range on an internal package", () => {
    expect(
      unlinkedInternalDependencies({
        dependencies: { "@tasma/engine": "^1.0.0" },
        devDependencies: { "@tasma/tools": "0.0.0" },
        peerDependencies: { vitest: "catalog:" },
      }),
    ).toEqual(["@tasma/engine", "@tasma/tools"]);
  });

  it("ignores external packages and a manifest without dependencies", () => {
    expect(unlinkedInternalDependencies({ devDependencies: { typescript: "catalog:" } })).toEqual([]);
    expect(unlinkedInternalDependencies({})).toEqual([]);
  });
});
