import type { IncomingMessage } from "node:http";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type HtmlTagDescriptor, type Plugin } from "vite";
// With the extension, which Vite's native config loader requires. The import
// never goes the other way: pulling this config into renderer code would pull
// Node into the bundle with it.
import { DAEMON_PATH_PREFIX } from "./src/api/paths.ts";

/**
 * The renderer's only possible policy. A desktop shell serves this document
 * from a custom protocol or from file://, so no server exists to send the
 * header and a meta element is the one place a policy can be declared.
 *
 * The style directive is split because the need is a style *attribute* —
 * VirtualList positions each row inline — and 'unsafe-inline' on style-src
 * would also admit an injected <style> element, which is the overlay and
 * control-spoofing primitive. form-action is listed because it does not fall
 * back to default-src, so without it injected markup can post anywhere.
 * data: images is the empty favicon.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const CSP_META: HtmlTagDescriptor = {
  tag: "meta",
  attrs: { "http-equiv": "Content-Security-Policy", "content": CONTENT_SECURITY_POLICY },
  injectTo: "head-prepend",
};

const FONT_FILE = /\.(?:woff2?|ttf|otf)$/;

// A legacy WOFF source beside the WOFF2 one in the same @font-face src list.
// The quote style is whatever the CSS minifier left behind.
const LEGACY_FONT_SOURCE = /,\s*url\([^)]*\)\s*format\((["']?)woff\1\)/g;

/** Drops the legacy sources from an @font-face src list, keeping WOFF2. */
export function stripLegacyFontSources(css: string): string {
  return css.replace(LEGACY_FONT_SOURCE, "");
}

function contentSecurityPolicy(): Plugin {
  return {
    name: "tasma:content-security-policy",
    // Dev serves an inline react-refresh preamble and an HMR socket, neither of
    // which this policy admits. The built document is the one a shell loads.
    apply: "build",
    transformIndexHtml: () => [CSP_META],
  };
}

function dropLegacyFontFormats(): Plugin {
  return {
    name: "tasma:drop-legacy-font-formats",
    apply: "build",
    // @fontsource declares a WOFF beside every WOFF2, which is 44% of the font
    // payload and which the build target never downloads: a current engine
    // always takes the first format it supports.
    generateBundle(_options, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        if (fileName.endsWith(".woff")) {
          delete bundle[fileName];
        } else if (output.type === "asset" && fileName.endsWith(".css") && typeof output.source === "string") {
          output.source = stripLegacyFontSources(output.source);
        }
      }
    },
  };
}

/**
 * Where the daemon listens. `TASMA_DAEMON_URL` overrides the default, which the
 * daemon's own default has to match.
 *
 * Exported so a test pins the default without reading the machine's environment,
 * which may export the very variable this overrides.
 */
export function resolveDaemonUrl(env: NodeJS.ProcessEnv): string {
  return env.TASMA_DAEMON_URL ?? "http://127.0.0.1:8278";
}

const DAEMON_URL = resolveDaemonUrl(process.env);

/** The names the daemon answers to. It binds the loopback address and no other. */
const PROXIED_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * `changeOrigin` hands the daemon its own name, which blinds the daemon's own
 * loopback guard, and Vite's `allowedHosts` does not stand in for it: an
 * IP-literal Host passes there unconditionally. This is the browser and
 * DNS-rebinding half of the guard; a client that writes its own headers is
 * turned away by the connection instead.
 *
 * Exported so a test can drive the rule without a running server.
 */
export function proxiesHost(host: string | undefined): boolean {
  if (host === undefined) {
    return false;
  }

  try {
    return PROXIED_HOSTS.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

// Node reports an IPv4 peer on a dual-stack socket in the IPv4-mapped form.
const IPV4_MAPPED = /^::ffff:/i;

const LOOPBACK_IPV4 = /^127(?:\.\d{1,3}){3}$/;

/**
 * A Host header is a claim any client that writes its own headers makes freely,
 * so `curl -H 'Host: localhost'` from the network satisfies `proxiesHost` on its
 * own. The address a connection came from is the half no request can type, and
 * under `--host` it is what keeps this proxy from becoming the route to a daemon
 * that binds loopback and nothing else.
 *
 * An address in a form not listed here is refused, so a shape nobody anticipated
 * closes the proxy rather than opening it.
 *
 * Exported so a test can drive the rule without a running server.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) {
    return false;
  }

  const bare = address.replace(IPV4_MAPPED, "");

  return bare === "::1" || LOOPBACK_IPV4.test(bare);
}

/*
 * Every daemon call is same-origin and this proxy is what carries it: the daemon
 * sends no CORS headers, so a direct cross-origin call from the browser has no
 * answer to read. The CSP needs no daemon origin for the same reason —
 * connect-src stays 'self'.
 *
 * One object serves dev and preview, so the two cannot drift apart.
 */
const daemonProxy = {
  [DAEMON_PATH_PREFIX]: {
    target: DAEMON_URL,
    // A request to exactly /daemon leaves an empty path, which is not a path.
    rewrite: (path: string) => path.slice(DAEMON_PATH_PREFIX.length) || "/",
    // The daemon serves its own loopback names alone and reads the forwarded
    // Host to decide. Without this, `vite dev --host` forwards an address it
    // refuses.
    changeOrigin: true,
    // Which takes the daemon's own guard off the request, so it is applied
    // here instead — over the header a browser sends and over the connection a
    // client cannot forge. `false` answers 404 rather than forwarding.
    bypass: (request: IncomingMessage) =>
      proxiesHost(request.headers.host) && isLoopbackAddress(request.socket.remoteAddress) ? undefined : false,
  },
};

export default defineConfig({
  /*
   * One 827x block, clear of Vite's 5173/4173 and of the 3000/8000/8080 range
   * other projects sit in: 8276 dev, 8277 preview, 8278 the daemon. `strictPort`
   * holds the address still — Vite's default is to increment past a taken port.
   *
   * `cors: false` because the renderer is same-origin. Vite's default reflects
   * any localhost origin and answers the preflight itself, both ahead of the
   * proxy, which would open the daemon to every other page on one.
   */
  server: { port: 8276, strictPort: true, cors: false, proxy: daemonProxy },
  preview: { port: 8277, strictPort: true, cors: false, proxy: daemonProxy },
  // Read by src/api/transport.ts, which shows it when no daemon answers.
  define: { __DAEMON_URL__: JSON.stringify(DAEMON_URL) },
  // Relative asset paths, for a shell that serves the bundle from a custom
  // protocol or from file://. Coupled to the router's hash history; the
  // coupling is stated and enforced in test/router.test.tsx.
  base: "./",
  // compiler: true runs React Compiler through oxc, so nothing memoizes by hand.
  plugins: [react({ compiler: true }), tailwindcss(), contentSecurityPolicy(), dropLegacyFontFormats()],
  build: {
    // The app runs only in a current Chromium or a current browser.
    target: "esnext",
    // A subset small enough to inline would arrive as a data: URL, which the
    // policy above rejects under font-src 'self'. Fonts stay files; everything
    // else keeps the default limit.
    assetsInlineLimit: (filePath) => (FONT_FILE.test(filePath) ? false : undefined),
  },
});
