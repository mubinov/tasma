import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  binDeclarationFaults,
  packageDirs,
  readLockfile,
  readManifest,
  runtimeCssInJsDependencies,
  runtimeCssInJsPackages,
  unlinkedInternalDependencies,
  workspaceRoot,
} from "../workspace.js";

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

  // Root `eslint .` already covers every package; the script exists so a
  // package can be linted on its own from its own directory, where ESLint
  // walks up to the root config.
  it("define a lint script", () => {
    for (const dir of packageDirs) {
      expect(readManifest(dir).scripts?.lint, `${dir}/package.json must define a "lint" script`).toBeTypeOf("string");
    }
  });

  // Formatting lives in ESLint and no separate formatter is installed, so this
  // is the only entry point that rewrites a file. It is per package for the
  // same reason `lint` is.
  it("define a lint:fix script", () => {
    for (const dir of packageDirs) {
      expect(
        readManifest(dir).scripts?.["lint:fix"],
        `${dir}/package.json must define a "lint:fix" script`,
      ).toBeTypeOf("string");
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

  it("declare a buildable bin, or none", () => {
    for (const dir of packageDirs) {
      expect(binDeclarationFaults(readManifest(dir)), `${dir}/package.json`).toEqual([]);
    }
  });

  it("declare internal dependencies with the workspace: protocol", () => {
    for (const dir of packageDirs) {
      expect(unlinkedInternalDependencies(readManifest(dir)), `${dir}/package.json`).toEqual([]);
    }
  });
});

// The root manifest is not a workspace package, but pnpm hoists its
// dependencies into the root node_modules, from where a bundler resolves them
// out of any package's source. The guard covers it for that reason.
describe("every manifest, the root one included", () => {
  it("declares no runtime CSS-in-JS library", () => {
    for (const dir of [".", ...packageDirs]) {
      expect(runtimeCssInJsDependencies(readManifest(dir)), `${dir}/package.json`).toEqual([]);
    }
  });
});

describe("the installed tree", () => {
  it("resolves no runtime CSS-in-JS library, transitively either", () => {
    expect(runtimeCssInJsPackages(readLockfile())).toEqual([]);
  });
});

describe("runtimeCssInJsDependencies", () => {
  it("names a runtime CSS-in-JS library in any dependency field", () => {
    expect(
      runtimeCssInJsDependencies({
        dependencies: { "styled-components": "^6.0.0" },
        devDependencies: { "@emotion/react": "^11.0.0" },
        peerDependencies: { goober: "^2.0.0" },
        optionalDependencies: { jss: "^10.0.0" },
      }),
    ).toEqual(["styled-components", "@emotion/react", "goober", "jss"]);
  });

  it("reports a library declared twice once", () => {
    expect(
      runtimeCssInJsDependencies({
        dependencies: { "@emotion/styled": "^11.0.0" },
        devDependencies: { "@emotion/styled": "^11.0.0" },
      }),
    ).toEqual(["@emotion/styled"]);
  });

  it("ignores build-time styling and a manifest without dependencies", () => {
    expect(runtimeCssInJsDependencies({ devDependencies: { tailwindcss: "catalog:" } })).toEqual([]);
    expect(runtimeCssInJsDependencies({})).toEqual([]);
  });
});

describe("runtimeCssInJsPackages", () => {
  it("names a library no manifest declares", () => {
    const lockfile = [
      "packages:",
      "  '@emotion/react@11.14.0':",
      "    resolution: {integrity: sha512-x}",
      "  '@mui/material@7.4.0':",
      "    resolution: {integrity: sha512-y}",
      "  'styled-components@6.1.19':",
      "    resolution: {integrity: sha512-z}",
    ].join("\n");

    expect(runtimeCssInJsPackages(lockfile)).toEqual(["@emotion/react", "styled-components"]);
  });

  it("reports a library resolved at two versions once", () => {
    const lockfile = [
      "packages:",
      "  'goober@2.1.16':",
      "    resolution: {integrity: sha512-x}",
      "  'goober@2.1.17':",
      "    resolution: {integrity: sha512-y}",
    ].join("\n");

    expect(runtimeCssInJsPackages(lockfile)).toEqual(["goober"]);
  });

  it("takes a lockfile that resolved nothing", () => {
    expect(runtimeCssInJsPackages("lockfileVersion: '9.0'\n")).toEqual([]);
  });
});

describe("binDeclarationFaults", () => {
  it("accepts a map of built targets beside a build script", () => {
    expect(
      binDeclarationFaults({
        bin: { "tasma": "./dist/tasma.js", "tasma-daemon": "dist/tasma-daemon.js" },
        scripts: { build: "vite build" },
      }),
    ).toEqual([]);
  });

  it("accepts the single-target string form", () => {
    expect(binDeclarationFaults({ bin: "./dist/tasma.js", scripts: { build: "vite build" } })).toEqual([]);
  });

  it("rejects a target outside dist/, in either form", () => {
    expect(binDeclarationFaults({ bin: "src/main.ts", scripts: { build: "vite build" } })).toEqual([
      'declares a "bin" target outside dist/: src/main.ts',
    ]);
    expect(binDeclarationFaults({ bin: { tasma: "../dist/tasma.js" }, scripts: { build: "vite build" } })).toEqual([
      'declares a "bin" target outside dist/: ../dist/tasma.js',
    ]);
  });

  it("rejects a target that traverses back out of dist/", () => {
    expect(binDeclarationFaults({ bin: "./dist/../src/main.ts", scripts: { build: "vite build" } })).toEqual([
      'declares a "bin" target outside dist/: ./dist/../src/main.ts',
    ]);
  });

  it("rejects a bin that no build script produces", () => {
    expect(binDeclarationFaults({ bin: { tasma: "./dist/tasma.js" }, scripts: { test: "vitest run" } })).toEqual([
      'declares "bin" without a "build" script',
    ]);
  });

  it("reports the target fault before the missing script when both apply", () => {
    expect(binDeclarationFaults({ bin: { tasma: "./src/main.ts" } })).toEqual([
      'declares a "bin" target outside dist/: ./src/main.ts',
      'declares "bin" without a "build" script',
    ]);
  });

  it("says nothing about a package that declares no bin", () => {
    expect(binDeclarationFaults({ scripts: { build: "vite build" } })).toEqual([]);
    expect(binDeclarationFaults({ bin: {} })).toEqual([]);
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
        optionalDependencies: { "@tasma/protocol": "*" },
      }),
    ).toEqual(["@tasma/engine", "@tasma/tools", "@tasma/protocol"]);
  });

  it("ignores external packages and a manifest without dependencies", () => {
    expect(unlinkedInternalDependencies({ devDependencies: { typescript: "catalog:" } })).toEqual([]);
    expect(unlinkedInternalDependencies({})).toEqual([]);
  });
});
