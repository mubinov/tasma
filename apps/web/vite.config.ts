import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type HtmlTagDescriptor, type Plugin } from "vite";

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

export default defineConfig({
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
