import { isMap, isScalar, parse, parseDocument, stringify } from "yaml";
import { KIT_CSS, UTILS } from "./files.ts";
import { STABLE_VERSION } from "./release.ts";

export type Manifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [field: string]: unknown;
};

const SECTIONS = ["dependencies", "devDependencies"] as const;

/** The dependencies that a manifest names with a version rather than with the catalog or the workspace. */
export function writtenDependencies(manifest: Manifest): Record<string, string> {
  return Object.fromEntries(
    SECTIONS.flatMap((section) => Object.entries(manifest[section] ?? {}))
      .filter(([, specifier]) => !specifier.startsWith("catalog:") && !specifier.startsWith("workspace:")),
  );
}

/** The manifest with `catalog:` as the specifier of each of `names`. */
export function withCatalog(manifest: Manifest, names: readonly string[]): Manifest {
  const result: Manifest = { ...manifest };
  for (const section of SECTIONS) {
    const entries = manifest[section];
    if (entries !== undefined) {
      result[section] = Object.fromEntries(
        Object.entries(entries).map(([name, specifier]) => [name, names.includes(name) ? "catalog:" : specifier]),
      );
    }
  }
  return result;
}

/**
 * The catalog entries to write for the dependencies the CLI wrote: a package
 * of the source repository that the built items pin gets the exact version of
 * its pin, a package the catalog has keeps its entry, and any other package
 * gets the range the CLI wrote.
 */
export function planCatalog(
  catalog: Readonly<Record<string, string>>,
  written: Readonly<Record<string, string>>,
  pinned: ReadonlyMap<string, string>,
  released: ReadonlySet<string>,
): Record<string, string> {
  const updates: Record<string, string> = {};
  for (const [name, range] of Object.entries(written)) {
    const pin = released.has(name) ? pinned.get(name) : undefined;
    if (pin !== undefined) {
      updates[name] = pin;
    } else if (!Object.hasOwn(catalog, name)) {
      updates[name] = range;
    }
  }
  return updates;
}

/** Writes `updates` into the catalog of a pnpm-workspace.yaml text, in order of name, keeping its comments. */
export function applyCatalog(text: string, updates: Readonly<Record<string, string>>): string {
  const document = parseDocument(text);
  const catalog = document.get("catalog");
  if (!isMap(catalog)) throw new Error("pnpm-workspace.yaml has no catalog");

  const keyOf = (index: number) => {
    const key = catalog.items[index]!.key;
    return isScalar(key) ? String(key.value) : "";
  };

  for (const [name, version] of Object.entries(updates)) {
    const indexes = catalog.items.map((_pair, index) => index);
    const existing = indexes.find((index) => keyOf(index) === name);
    if (existing === undefined) {
      const after = indexes.find((index) => keyOf(index) > name) ?? catalog.items.length;
      // yaml keeps the comment above the first entry on the map. It moves to that entry, so that a key
      // inserted above the entry does not sit under the comment.
      const first = catalog.items[0]?.key;
      if (after === 0 && catalog.commentBefore && isScalar(first)) {
        first.commentBefore = catalog.commentBefore;
        catalog.commentBefore = null;
      }
      catalog.items.splice(after, 0, document.createPair(name, version));
    } else {
      catalog.items[existing]!.value = document.createNode(version);
    }
  }
  return document.toString();
}

export function catalogOf(text: string): Record<string, string> {
  return (parse(text) as { catalog?: Record<string, string> }).catalog ?? {};
}

export function catalogVersion(text: string, name: string): string {
  const version = catalogOf(text)[name];
  if (version === undefined || !STABLE_VERSION.test(version)) {
    throw new Error(`the catalog holds no exact version of ${name}; run pnpm kit:update`);
  }
  return version;
}

export type CheckProjectFilesInput = {
  components: string;
  utils: string;
  webManifest: Manifest;
  workspace: string;
  packageManager: string | undefined;
};

/**
 * The files of the temporary project that kit:check runs the CLI on: the CLI
 * config and alias of apps/web, its dependencies at their catalog versions, and
 * the release-age rule and build policy of the workspace for the install the
 * CLI runs there.
 */
export function checkProjectFiles(input: CheckProjectFilesInput): Map<string, string> {
  const catalog = catalogOf(input.workspace);
  const dependencies = Object.fromEntries(
    Object.entries(input.webManifest.dependencies ?? {})
      .filter(([, specifier]) => !specifier.startsWith("workspace:"))
      .map(([name, specifier]) => {
        if (specifier !== "catalog:") return [name, specifier];
        const version = catalog[name];
        if (version === undefined) throw new Error(`the catalog has no ${name}`);
        return [name, version];
      }),
  );
  const settings = parse(input.workspace) as { minimumReleaseAge?: number; allowBuilds?: unknown };
  const manifest = { name: "kit-check", private: true, type: "module", packageManager: input.packageManager, dependencies };

  return new Map([
    ["components.json", input.components],
    ["tsconfig.json", `${JSON.stringify({ compilerOptions: { paths: { "@kit/*": ["./src/kit/*"] } } }, null, 2)}\n`],
    ["package.json", `${JSON.stringify(manifest, null, 2)}\n`],
    [
      "pnpm-workspace.yaml",
      stringify({ packages: [], minimumReleaseAge: settings.minimumReleaseAge, allowBuilds: settings.allowBuilds }),
    ],
    [`src/kit/${KIT_CSS}`, ""],
    [`src/kit/${UTILS}`, input.utils],
  ]);
}
