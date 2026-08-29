import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "fixtures");

/** Reads a fixture by its path under `test/fixtures`, for example `valid/example.md`. */
export function fixture(name: string): string {
  return readFileSync(join(root, name), "utf8");
}

/** Every fixture in one directory, as `[name, text]` pairs for `it.each`. */
export function fixturesIn(dir: string): [string, string][] {
  return readdirSync(join(root, dir))
    .filter((name) => name.endsWith(".md"))
    .map((name) => [`${dir}/${name}`, fixture(`${dir}/${name}`)]);
}
