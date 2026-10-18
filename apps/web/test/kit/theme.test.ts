// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { SRC, tasmaSourceFiles } from "../source-files";
import { COLOR_PREFIX, OPACITY, RADIUS_SIDE, stringWords, utilityOf } from "./class-words";

const root = join(import.meta.dirname, "..", "..");
const styles = join(SRC, "styles");
const globalCss = join(styles, "global.css");
const themeCss = join(styles, "theme.css");

const IMPORT = /@import\s+["']([^"']+)["']/g;

const read = (file: string) => readFileSync(file, "utf8");

/** The file that an `@import` in `from` loads: a relative path, a file of a package or the style entry of a package. */
function resolveImport(specifier: string, from: string): string {
  if (specifier.startsWith(".")) return join(dirname(from), specifier);

  const name = specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
  const folder = join(root, "node_modules", name);
  if (specifier !== name) return join(folder, specifier.slice(name.length + 1));

  const manifest = JSON.parse(read(join(folder, "package.json"))) as {
    exports?: Record<string, { style?: string } | undefined>;
    style?: string;
  };
  return join(folder, manifest.exports?.["."]?.style ?? manifest.style ?? "index.css");
}

/** `file` and each stylesheet that it imports, at any depth. */
function withImports(file: string): string[] {
  return [file, ...[...read(file).matchAll(IMPORT)].flatMap((match) => withImports(resolveImport(match[1]!, file)))];
}

const globalImports = [...read(globalCss).matchAll(IMPORT)].map((match) => match[1]!);

/** The stylesheets that global.css loads after theme.css, which can define a name of theme.css again. */
const laterStylesheets = globalImports
  .slice(globalImports.indexOf("./theme.css") + 1)
  .flatMap((specifier) => withImports(resolveImport(specifier, globalCss)));

/** The names a stylesheet defines: custom properties, keyframes, custom variants and utilities. */
function definedNames(css: string): string[] {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [
    ...[...code.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]!),
    ...[...code.matchAll(/@(keyframes|custom-variant|utility)\s+(-?[\w-]+\*?)/g)].map((match) => `@${match[1]} ${match[2]}`),
  ];
}

const tasmaNames = new Set(definedNames(read(themeCss)));

describe("the stylesheets loaded after theme.css", () => {
  it("are tw-animate-css, the kit, its theme and the stylesheets they import", () => {
    expect(globalImports).toContain("./theme.css");
    expect(laterStylesheets.map((file) => basename(file))).toEqual(
      expect.arrayContaining(["tw-animate.css", "kit.css", "index.css", "kit-theme.css"]),
    );
  });

  it("define no name that theme.css defines", () => {
    const clashes = laterStylesheets.flatMap((file) =>
      definedNames(read(file))
        .filter((name) => tasmaNames.has(name))
        .map((name) => `${relative(root, file)}: ${name}`));

    expect(tasmaNames).toContain("@keyframes rise");
    expect(tasmaNames).toContain("--color-bg");
    expect(definedNames(read(resolveImport("tw-animate-css", globalCss)))).toContain("@keyframes enter");
    expect(clashes).toEqual([]);
  });

  it("are read for custom properties, keyframes, custom variants and utilities, outside comments", () => {
    const css = "/* --gone: 1; @keyframes gone */ @theme { --color-x: red; @keyframes spin {} }\n"
      + "@custom-variant dark (&); @utility fade-in-* {} @utility -zoom-in {} :root { --y : 1px; color: var(--z); }";

    expect(definedNames(css)).toEqual([
      "--color-x",
      "--y",
      "@keyframes spin",
      "@custom-variant dark",
      "@utility fade-in-*",
      "@utility -zoom-in",
    ]);
  });
});

const NAMESPACE_TOKEN = /^--(color|font|text|radius|shadow|ease|animate)-([a-z0-9]+(?:-[a-z0-9]+)*)$/;

/**
 * The theme tokens that only the later stylesheets declare, in the namespaces
 * that theme.css clears: `--color-muted` gives ["color", "muted"].
 */
const kitTokens = [...new Set(laterStylesheets.flatMap((file) => definedNames(read(file))))]
  .filter((name) => !tasmaNames.has(name))
  .flatMap((name) => {
    const match = NAMESPACE_TOKEN.exec(name);
    return match === null ? [] : [[match[1]!, match[2]!] as const];
  });

function tokenUtility([namespace, name]: readonly [string, string]): string {
  if (namespace === "color") return `${COLOR_PREFIX}-${name}${OPACITY}`;
  if (namespace === "radius") return `rounded${RADIUS_SIDE}-${name}`;
  return `${namespace}-${name}`;
}

const KIT_UTILITY = new RegExp(`^(?:${kitTokens.map(tokenUtility).join("|")})$`);
const KIT_PROPERTY = new RegExp(`--(?:${kitTokens.map(([namespace, name]) => `${namespace}-${name}`).join("|")})(?![\\w-])`, "g");

/** The kit utilities among the classes of `source`, and the kit tokens it reads by name. */
function kitUses(source: string): string[] {
  return [
    ...stringWords(source).filter((word) => KIT_UTILITY.test(utilityOf(word))),
    ...[...source.matchAll(KIT_PROPERTY)].map((match) => match[0]),
  ];
}

describe("the kit tokens", () => {
  it("are the tokens of the kit, not of Tasma", () => {
    for (const kit of ["dark:hover:bg-muted/50", "rounded-t-lg", "text-red-600", "font-sans", "animate-in", "text-2xl"]) {
      expect(KIT_UTILITY.test(utilityOf(kit)), kit).toBe(true);
    }
    for (const tasma of ["text-sm", "rounded-card", "bg-surface", "text-subtle", "animate-enter", "ease-standard"]) {
      expect(KIT_UTILITY.test(tasma), tasma).toBe(false);
    }
    expect(kitUses('const a = "var(--color-muted) var(--color-muted-foreground) var(--color-subtle)";'))
      .toEqual(["--color-muted", "--color-muted-foreground"]);
  });

  it("are found in a string inside an expression of a template literal", () => {
    const source = "const a = `p-2 ${open ? \"bg-muted/40\" : 'rounded-lg'} ${size}text-sm`;";

    expect(kitUses(source)).toEqual(["bg-muted/40", "rounded-lg"]);
  });

  it("are used by no Tasma file", () => {
    const scripts = tasmaSourceFiles();
    const stylesheets = readdirSync(styles)
      .filter((name) => name.endsWith(".css") && name !== "kit-theme.css")
      .map((name) => join(styles, name));

    const uses = [...scripts, ...stylesheets].flatMap((file) =>
      kitUses(read(file)).map((use) => `${relative(SRC, file)}: ${use}`));

    expect(scripts.length).toBeGreaterThan(0);
    expect(stylesheets).toContain(themeCss);
    expect(uses).toEqual([]);
  });
});
