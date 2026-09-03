// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DAEMON_PATH_PREFIX } from "../src/api/paths";
import config, {
  CONTENT_SECURITY_POLICY,
  isLoopbackAddress,
  proxiesHost,
  resolveDaemonUrl,
  stripLegacyFontSources,
} from "../vite.config";

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

  // Every daemon call goes through the proxy and is therefore same-origin. A
  // change that reintroduces a cross-origin call has to widen this directive,
  // and fails here rather than silently in a browser.
  it("lets the app connect to its own origin and nowhere else", () => {
    expect(directives.get("connect-src")).toEqual(["'self'"]);
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

/*
 * The proxy is the whole daemon transport in dev and preview: the daemon sends
 * no CORS headers, so without it the browser has no answer to read. None of it
 * is reachable from a rendered test, and the build above proves nothing about
 * it.
 */
describe("the daemon proxy", () => {
  // Looked up by the shared constant, not by the literal "/daemon": the
  // assertion is that the config and the renderer mount the same prefix.
  const entry = config.server?.proxy?.[DAEMON_PATH_PREFIX];
  const proxy = typeof entry === "object" ? entry : undefined;
  const rewrite = proxy?.rewrite;

  it("is mounted on the prefix the renderer builds every path against", () => {
    expect(proxy).toBeDefined();
    expect(proxy?.target).toBe(resolveDaemonUrl(process.env));
  });

  it("declares a rewrite for the path it forwards", () => {
    expect(typeof rewrite).toBe("function");
  });

  it.each([
    { asked: `${DAEMON_PATH_PREFIX}/health`, reaches: "/health" },
    { asked: `${DAEMON_PATH_PREFIX}/projects/tasma/tasks?status=To%20Do`, reaches: "/projects/tasma/tasks?status=To%20Do" },
    { asked: DAEMON_PATH_PREFIX, reaches: "/" },
  ])("strips the prefix, so $asked reaches the daemon as $reaches", ({ asked, reaches }) => {
    expect(rewrite?.(asked)).toBe(reaches);
  });

  it("addresses the daemon by the host it binds, not by the one the browser typed", () => {
    expect(proxy?.changeOrigin).toBe(true);
  });

  /*
   * Which is what blinds the daemon's own loopback guard, so under
   * `vite dev --host` this is where a peer on the network is turned away — by
   * both halves. A Host header is a claim `curl -H 'Host: localhost'` makes
   * freely, and the connection it arrives on is the half that cannot be typed.
   */
  it.each([
    { named: "192.168.1.24:8276", from: "127.0.0.1", forwarded: false },
    { named: "localhost:8276", from: "192.168.1.9", forwarded: false },
    { named: "127.0.0.1:8276", from: "192.168.1.9", forwarded: false },
    { named: "localhost:8276", from: "127.0.0.1", forwarded: true },
    { named: "localhost:8276", from: "::1", forwarded: true },
  ])("forwards a request for $named from $from: $forwarded", ({ named, from, forwarded }) => {
    const options = proxy!;
    const request = { headers: { host: named }, socket: { remoteAddress: from } } as unknown as IncomingMessage;

    expect(options.bypass?.(request, undefined, options)).toBe(forwarded ? undefined : false);
  });

  it("serves preview from the same entry it serves dev from", () => {
    expect(config.preview?.proxy).toBe(config.server?.proxy);
  });
});

/*
 * A default read off the resolved config would fail on any machine or CI job
 * exporting TASMA_DAEMON_URL — the very variable this feature tells people to
 * set — so the function is called with an explicit environment instead.
 */
// The set is the daemon's own: a name it does not serve must not be carried to
// it, and a host it would serve must not be turned away here.
describe("proxiesHost", () => {
  it.each([
    { host: "localhost:8276", carried: true },
    { host: "127.0.0.1:8276", carried: true },
    { host: "[::1]:8276", carried: true },
    { host: "192.168.1.24:8276", carried: false },
    { host: "tasma.local:8276", carried: false },
    { host: undefined, carried: false },
    { host: "a host with spaces", carried: false },
  ])("carries $host: $carried", ({ host, carried }) => {
    expect(proxiesHost(host)).toBe(carried);
  });
});

// A form this rule does not recognise is refused, so a shape nobody anticipated
// closes the proxy rather than opening it.
describe("isLoopbackAddress", () => {
  it.each([
    { address: "127.0.0.1", loopback: true },
    { address: "127.0.0.53", loopback: true },
    { address: "::1", loopback: true },
    // What Node reports for an IPv4 peer on a dual-stack socket.
    { address: "::ffff:127.0.0.1", loopback: true },
    { address: "::FFFF:127.0.0.1", loopback: true },
    { address: "192.168.1.9", loopback: false },
    { address: "::ffff:192.168.1.9", loopback: false },
    { address: "10.0.0.1", loopback: false },
    { address: "1.127.0.0.1", loopback: false },
    { address: "", loopback: false },
    { address: undefined, loopback: false },
  ])("reads $address as loopback: $loopback", ({ address, loopback }) => {
    expect(isLoopbackAddress(address)).toBe(loopback);
  });
});

describe("resolveDaemonUrl", () => {
  it("defaults to the address the daemon's own default has to match", () => {
    expect(resolveDaemonUrl({})).toBe("http://127.0.0.1:8278");
  });

  it("takes TASMA_DAEMON_URL over the default", () => {
    expect(resolveDaemonUrl({ TASMA_DAEMON_URL: "http://127.0.0.1:9000" })).toBe("http://127.0.0.1:9000");
  });
});

describe.each([
  { name: "dev", server: config.server, port: 8276 },
  { name: "preview", server: config.preview, port: 8277 },
])("the $name server", ({ server, port }) => {
  it(`serves ${port} or refuses to start`, () => {
    expect(server?.port).toBe(port);
    expect(server?.strictPort).toBe(true);
  });

  // Vite's default runs a permissive CORS middleware ahead of the proxy, so a
  // header left to it is a header on every daemon reply.
  it("sends no CORS header, so no other origin can read the daemon through it", () => {
    expect(server?.cors).toBe(false);
  });
});
