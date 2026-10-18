import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyCatalog,
  catalogVersion,
  checkProjectFiles,
  planCatalog,
  withCatalog,
  writtenDependencies,
} from "../../scripts/kit/catalog.ts";
import { writeTree } from "../../scripts/kit/files.ts";
import { scratch } from "./helpers.ts";

describe("the catalog update", () => {
  const workspace = [
    "packages:",
    "  - apps/*",
    "",
    "# Shared versions.",
    "catalog:",
    '  "@assistant-ui/react": 0.1.0',
    '  "@base-ui/react": ^1.7.0',
    "  # Kept on 19 for a reason.",
    "  react: ^19.2.0",
    "  zustand: ^5.0.0",
    "",
    "minimumReleaseAge: 10080",
    "allowBuilds: {}",
    "",
  ].join("\n");

  const catalog = { "@assistant-ui/react": "0.1.0", "@base-ui/react": "^1.7.0", "react": "^19.2.0", "zustand": "^5.0.0" };

  const released = new Set(["@assistant-ui/react", "tw-shimmer"]);

  it("gives a pinned package of the source repository the version of its pin, also when the catalog has an older one", () => {
    const pinned = new Map([["@assistant-ui/react", "0.2.3"], ["tw-shimmer", "0.4.13"]]);

    expect(planCatalog(catalog, { "@assistant-ui/react": "^0.2.3", "tw-shimmer": "^0.4.13" }, pinned, released))
      .toEqual({ "@assistant-ui/react": "0.2.3", "tw-shimmer": "0.4.13" });
  });

  it("keeps the catalog entry of a package that is not pinned, and adds a new one with the range of the CLI", () => {
    expect(planCatalog(catalog, { "@base-ui/react": "^1.9.0", "lucide-react": "^1.5.0" }, new Map(), released))
      .toEqual({ "lucide-react": "^1.5.0" });
  });

  it("treats a caret pin of a package from outside the source repository as a range of the CLI", () => {
    const pinned = new Map([["@base-ui/react", "1.2.0"], ["zod", "3.23.0"]]);

    expect(planCatalog(catalog, { "@base-ui/react": "^1.2.0", "zod": "^3.23.0" }, pinned, released))
      .toEqual({ zod: "^3.23.0" });
  });

  it("writes the versions in order of name and keeps the comments of the file", () => {
    const updates = {
      "@assistant-ui/react": "0.2.3",
      "lucide-react": "^1.5.0",
      "tw-shimmer": "0.4.14",
      "zx-chart": "^2.0.0",
      "@assistant-ui/react-markdown": "0.14.21",
    };

    expect(applyCatalog(workspace, updates)).toBe([
      "packages:",
      "  - apps/*",
      "",
      "# Shared versions.",
      "catalog:",
      '  "@assistant-ui/react": 0.2.3',
      '  "@assistant-ui/react-markdown": 0.14.21',
      '  "@base-ui/react": ^1.7.0',
      "  lucide-react: ^1.5.0",
      "  # Kept on 19 for a reason.",
      "  react: ^19.2.0",
      "  tw-shimmer: 0.4.14",
      "  zustand: ^5.0.0",
      "  zx-chart: ^2.0.0",
      "",
      "minimumReleaseAge: 10080",
      "allowBuilds: {}",
      "",
    ].join("\n"));
  });

  it("keeps the comment above the first entry on that entry when a key goes above it", () => {
    const text = "catalog:\n  # Kept for a reason.\n  react: ^19.2.0\n";

    expect(applyCatalog(text, { "@acme/core": "1.0.0" }))
      .toBe('catalog:\n  "@acme/core": 1.0.0\n  # Kept for a reason.\n  react: ^19.2.0\n');
  });

  it("refuses a workspace file with no catalog", () => {
    expect(() => applyCatalog("packages: []\n", { a: "1.0.0" })).toThrow("no catalog");
  });

  it("finds the dependencies the CLI wrote with a version, and puts the catalog back on them", () => {
    const manifest = {
      name: "web",
      dependencies: { "a": "catalog:", "b": "^1.0.0", "@acme/core": "workspace:*" },
      devDependencies: { c: "~2.0.0" },
    };

    const written = writtenDependencies(manifest);

    expect(written).toEqual({ b: "^1.0.0", c: "~2.0.0" });
    expect(withCatalog(manifest, Object.keys(written))).toEqual({
      name: "web",
      dependencies: { "a": "catalog:", "b": "catalog:", "@acme/core": "workspace:*" },
      devDependencies: { c: "catalog:" },
    });
    expect(writtenDependencies({ name: "bare" })).toEqual({});
    expect(withCatalog({ name: "bare" }, [])).toEqual({ name: "bare" });
  });

  it("reads the exact version of a package from the catalog", () => {
    expect(catalogVersion(workspace, "@assistant-ui/react")).toBe("0.1.0");
    expect(() => catalogVersion(workspace, "react")).toThrow("no exact version of react");
    expect(() => catalogVersion(workspace, "lucide-react")).toThrow("no exact version of lucide-react");
    expect(() => catalogVersion("packages: []\n", "react")).toThrow("no exact version of react");
  });
});

describe("the project of kit:check", () => {
  const input = {
    components: '{"style":"base-nova"}',
    utils: 'export { cn } from "cn";\n',
    webManifest: {
      name: "web",
      dependencies: { "@assistant-ui/react": "catalog:", "react": "catalog:", "@acme/core": "workspace:*", "pinned": "1.0.0" },
      devDependencies: { tailwindcss: "catalog:" },
    },
    workspace: [
      "packages:",
      "  - apps/*",
      "catalog:",
      '  "@assistant-ui/react": 0.2.3',
      "  react: ^19.2.0",
      "  tailwindcss: ^4.3.0",
      "minimumReleaseAge: 10080",
      "allowBuilds: {}",
      "",
    ].join("\n"),
    packageManager: "pnpm@11.4.0",
  };

  it("holds the CLI config, the alias, the dependencies at their catalog versions and the release-age rule", () => {
    const files = checkProjectFiles(input);

    expect([...files.keys()].sort()).toEqual([
      "components.json",
      "package.json",
      "pnpm-workspace.yaml",
      "src/kit/kit.css",
      "src/kit/lib/utils.ts",
      "tsconfig.json",
    ]);
    expect(files.get("components.json")).toBe(input.components);
    expect(files.get("src/kit/kit.css")).toBe("");
    expect(files.get("src/kit/lib/utils.ts")).toBe(input.utils);
    expect(JSON.parse(files.get("tsconfig.json")!)).toEqual({
      compilerOptions: { paths: { "@kit/*": ["./src/kit/*"] } },
    });
    expect(JSON.parse(files.get("package.json")!)).toEqual({
      name: "kit-check",
      private: true,
      type: "module",
      packageManager: "pnpm@11.4.0",
      dependencies: { "@assistant-ui/react": "0.2.3", "react": "^19.2.0", "pinned": "1.0.0" },
    });
    expect(files.get("pnpm-workspace.yaml")).toBe("packages: []\nminimumReleaseAge: 10080\nallowBuilds: {}\n");
  });

  it("refuses a dependency that the catalog does not have", () => {
    const webManifest = { name: "web", dependencies: { missing: "catalog:" } };

    expect(() => checkProjectFiles({ ...input, webManifest })).toThrow("the catalog has no missing");
  });

  it("is written into a folder that the CLI can use", () => {
    const root = scratch();

    writeTree(root, checkProjectFiles({ ...input, webManifest: { name: "web" }, packageManager: undefined }));

    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))).toEqual({
      name: "kit-check",
      private: true,
      type: "module",
      dependencies: {},
    });
  });
});
