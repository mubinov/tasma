// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTENT_SECURITY_POLICY, stripLegacyFontSources } from "../vite.config";

const root = join(import.meta.dirname, "..");

let outDir = "";
let indexHtml = "";
let assets: string[] = [];
let css = "";
let js = "";

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), "tasma-web-build-"));
  await build({ root, logLevel: "silent", build: { outDir, emptyOutDir: true } });
  indexHtml = readFileSync(join(outDir, "index.html"), "utf8");
  assets = readdirSync(join(outDir, "assets"));
  css = assets
    .filter((name) => name.endsWith(".css"))
    .map((name) => readFileSync(join(outDir, "assets", name), "utf8"))
    .join("");
  js = assets
    .filter((name) => name.endsWith(".js"))
    .map((name) => readFileSync(join(outDir, "assets", name), "utf8"))
    .join("");
}, 120_000);

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe("the built bundle", () => {
  it("references every asset by a relative path", () => {
    expect(indexHtml).toContain('src="./assets/');
    expect(indexHtml).toContain('href="./assets/');
    expect(indexHtml).not.toContain('="/assets/');
  });

  // No HTTP layer will ever exist to send the header: a shell serves this
  // document from a custom protocol or from file://. The policy also has to
  // precede the scripts it governs.
  it("declares the content security policy ahead of any script", () => {
    expect(indexHtml.replaceAll("&#39;", "'")).toContain(`content="${CONTENT_SECURITY_POLICY}"`);
    expect(indexHtml.indexOf("Content-Security-Policy")).toBeLessThan(indexHtml.indexOf("<script"));
  });

  it("ships the WOFF2 the build target picks and none of the legacy WOFF", () => {
    expect(assets.filter((name) => name.endsWith(".woff"))).toEqual([]);
    expect(assets.filter((name) => name.endsWith(".woff2")).length).toBeGreaterThan(0);
    expect(css).toContain('format("woff2")');
    expect(css).not.toContain('format("woff")');
  });

  // A subset under the inline limit would arrive as a data: URL, which the
  // policy rejects under font-src 'self' — and nothing but loading the built
  // document reports it.
  it("leaves every font a file the policy admits", () => {
    expect(css).not.toContain("data:font");
  });

  // Tailwind emits only the utilities it finds in the source it scans, so a
  // misspelt class name produces no rule and no error: the failure panel would
  // render and overflow a narrow window again. The class itself is pinned in
  // test/components/error-boundary.test.tsx; this is the half that proves it
  // resolves to a utility.
  it("emits the overflow rule the failure panel depends on", () => {
    expect(css).toContain("overflow-wrap:anywhere");
  });

  // The compiler is this app's whole memoization strategy, and AGENTS.md forbids
  // writing useMemo or useCallback by hand on the strength of it. Dropped from
  // the plugin options, an unmemoized app ships with every test still green.
  // A compiled component reads its cache slots against this sentinel; React's
  // own definition assigns it instead, so the comparison is the marker and the
  // name alone is not.
  it("runs the app through the React Compiler", () => {
    expect(js).toMatch(/]\s*===\s*Symbol\.for\((["'`])react\.memo_cache_sentinel\1\)/);
  });
});

// Asserting the built document contains the constant only proves the constant
// shipped. These name the properties that make it a policy, so weakening it
// fails here rather than in review.
describe("the content security policy", () => {
  const directives = new Map(
    CONTENT_SECURITY_POLICY.split("; ").map((directive) => {
      const [name, ...values] = directive.split(" ");
      return [name!, values];
    }),
  );

  it.each(["default-src", "object-src", "base-uri", "form-action"])("locks %s down to 'none'", (name) => {
    expect(directives.get(name)).toEqual(["'none'"]);
  });

  it("lets no script or style element come from anywhere but the bundle", () => {
    expect(directives.get("script-src")).toEqual(["'self'"]);
    expect(directives.get("style-src")).toEqual(["'self'"]);
  });

  // The inline need is a style attribute, which style-src-attr governs on its
  // own; on style-src the same keyword would admit an injected <style> element.
  it("admits inline styles as attributes only", () => {
    expect(directives.get("style-src-attr")).toEqual(["'unsafe-inline'"]);
  });

  it("keeps every directive free of a wildcard", () => {
    expect([...directives.values()].flat().filter((value) => value === "*" || value.includes("*"))).toEqual([]);
  });
});

describe("stripLegacyFontSources", () => {
  it("drops the legacy source and keeps the modern one", () => {
    expect(stripLegacyFontSources('src:url(./a.woff2)format("woff2"),url(./a.woff)format("woff")')).toBe(
      'src:url(./a.woff2)format("woff2")',
    );
  });

  it("takes the quoting @fontsource ships as well as the minifier's", () => {
    expect(stripLegacyFontSources("src: url(./a.woff2) format('woff2'), url(./a.woff) format('woff');")).toBe(
      "src: url(./a.woff2) format('woff2');",
    );
  });

  it("leaves a src list that declares no legacy source", () => {
    const modern = 'src:url(./a.woff2)format("woff2")';
    expect(stripLegacyFontSources(modern)).toBe(modern);
  });
});
