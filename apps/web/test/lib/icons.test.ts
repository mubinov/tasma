import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { KIT, sourceFiles, SRC, tasmaSourceFiles } from "../source-files";

// The root specifier exactly: a per-icon import carries the icon's name after
// it, so only the barrel matches.
const BARREL = /["']@phosphor-icons\/react["']/;

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

const LUCIDE = /["']lucide-react(?:\/[^"']*)?["']/;

it("imports no lucide-react icon outside the kit", () => {
  const imports = (path: string) => LUCIDE.test(readFileSync(path, "utf8"));
  const offenders = tasmaSourceFiles().filter(imports);

  expect(sourceFiles(KIT).some(imports)).toBe(true);
  expect(offenders).toEqual([]);
});
