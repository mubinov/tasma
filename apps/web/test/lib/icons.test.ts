import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const SRC = join(import.meta.dirname, "../../src");

// The root specifier exactly: a per-icon import carries the icon's name after
// it, so only the barrel matches.
const BARREL = /["']@phosphor-icons\/react["']/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/*
 * The package root re-exports 1,512 modules. A production build tree-shakes it
 * away either way, so the cost shows up only in dev, where Vite serves
 * unbundled ESM and requests every one of them — which is exactly when nobody
 * is looking for it.
 */
it("imports every icon from its own module, never the package root", () => {
  const files = sourceFiles(SRC);
  const offenders = files.filter((path) => BARREL.test(readFileSync(path, "utf8")));

  expect(files.length).toBeGreaterThan(0);
  expect(offenders).toEqual([]);
});
