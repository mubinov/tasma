import { readdirSync } from "node:fs";
import { join, sep } from "node:path";

export const SRC = join(import.meta.dirname, "..", "src");
export const KIT = join(SRC, "kit");

/** The .ts and .tsx files under `dir`. */
export function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** The .ts and .tsx files of src outside src/kit: the Tasma code. */
export function tasmaSourceFiles(): string[] {
  return sourceFiles(SRC).filter((file) => !file.startsWith(`${KIT}${sep}`));
}
