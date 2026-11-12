import { chmod, mkdir, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { openAgentOptions } from "@tasma/engine";
import { bareRoot, read } from "./helpers.js";

const MODE = { id: "mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }] };
const MODEL = { id: "model", type: "select", currentValue: "large", options: [{ value: "large", name: "Large" }] };
const WHEN = "2026-03-01T08:00:00.000Z";
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function fileOf(root: string): string {
  return join(root, "agent-options.json");
}

async function stored(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(await read(fileOf(root))) as Record<string, unknown>;
}

describe("openAgentOptions", () => {
  it("names the file in the root", async () => {
    const root = await bareRoot();

    expect(openAgentOptions(root).path).toBe(fileOf(root));
  });

  it("reads a missing file as no lists, with no diagnostic", async () => {
    const root = await bareRoot();

    await expect(openAgentOptions(root).read()).resolves.toEqual({ lists: {}, diagnostics: [] });
  });

  it("reads the list of each agent as it is stored", async () => {
    const root = await bareRoot();
    await writeFile(fileOf(root), JSON.stringify({
      claude: { options: [MODE, MODEL], updated: WHEN },
      codex: { options: [], updated: WHEN },
    }));

    await expect(openAgentOptions(root).read()).resolves.toEqual({
      lists: { claude: { options: [MODE, MODEL], updated: WHEN }, codex: { options: [], updated: WHEN } },
      diagnostics: [],
    });
  });

  it("reads a key __proto__ as an agent of its own, not as the prototype of the lists", async () => {
    const root = await bareRoot();
    await writeFile(fileOf(root), `{ "__proto__": { "options": [], "updated": "${WHEN}" } }`);

    const { lists } = await openAgentOptions(root).read();

    expect(Object.getPrototypeOf(lists)).toBe(Object.prototype);
    expect(Object.hasOwn(lists, "__proto__")).toBe(true);
  });

  it.each([
    ["is not JSON", "{ claude", /^this file is not JSON: /],
    ["is no JSON object", "[1, 2]", /^this file is not a JSON object$/],
    ["is null", "null", /^this file is not a JSON object$/],
  ])("reads a file that %s as no lists, with a diagnostic", async (_name, text, fault) => {
    const root = await bareRoot();
    await writeFile(fileOf(root), text);

    const read = await openAgentOptions(root).read();

    expect(read.lists).toEqual({});
    expect(read.diagnostics).toMatchObject([{ code: "config-unreadable", path: fileOf(root) }]);
    expect(read.diagnostics[0]?.message).toMatch(fault);
  });

  it("reads a name that holds a directory or a link as no lists, with a diagnostic", async () => {
    const root = await bareRoot();
    await mkdir(join(root, "elsewhere"));
    await writeFile(join(root, "elsewhere", "options.json"), JSON.stringify({ claude: { options: [], updated: WHEN } }));
    await symlink(join(root, "elsewhere", "options.json"), fileOf(root));

    await expect(openAgentOptions(root).read()).resolves.toEqual({
      lists: {},
      diagnostics: [{ code: "config-unreadable", message: "this name holds no regular file", path: fileOf(root) }],
    });

    await rm(fileOf(root));
    await mkdir(fileOf(root));

    await expect(openAgentOptions(root).read()).resolves.toEqual({
      lists: {},
      diagnostics: [{ code: "config-unreadable", message: "this name holds no regular file", path: fileOf(root) }],
    });
  });

  it.skipIf(process.getuid?.() === 0)("reads a file it cannot open as no lists, with the cause", async () => {
    const root = await bareRoot();
    await writeFile(fileOf(root), JSON.stringify({ claude: { options: [], updated: WHEN } }));
    await chmod(fileOf(root), 0o000);
    onTestFinished(() => chmod(fileOf(root), 0o600));

    const read = await openAgentOptions(root).read();

    expect(read.lists).toEqual({});
    expect(read.diagnostics).toMatchObject([{ code: "config-unreadable", path: fileOf(root) }]);
    expect(read.diagnostics[0]?.message).toMatch(/^this file cannot be read: .*EACCES/);
  });

  it.each([
    ["an entry that is not an object", "x"],
    ["options that are not an array", { options: { mode: MODE }, updated: WHEN }],
    ["an option that is not an object", { options: [MODE, null], updated: WHEN }],
    ["an option that is an array", { options: [[MODE]], updated: WHEN }],
    ["no time of the write", { options: [MODE] }],
    ["a time that is not a string", { options: [MODE], updated: 7 }],
  ])("gives no list to an agent with %s, and keeps the list of the other agent", async (_name, entry) => {
    const root = await bareRoot();
    await writeFile(fileOf(root), JSON.stringify({ codex: entry, claude: { options: [MODEL], updated: WHEN } }));

    await expect(openAgentOptions(root).read()).resolves.toEqual({
      lists: { claude: { options: [MODEL], updated: WHEN } },
      diagnostics: [{ code: "config-unreadable", message: "the options of codex are not usable", path: fileOf(root) }],
    });
  });

  it("writes the list of an agent into a new file, with the time of the write, and makes the root", async () => {
    const root = join(await bareRoot(), "tree");
    const options = openAgentOptions(root);
    const before = Date.now();

    await options.save("claude", [MODE, MODEL]);

    const { claude } = await stored(root) as { claude: { options: unknown; updated: string } };
    expect(claude.options).toEqual([MODE, MODEL]);
    expect(claude.updated).toMatch(ISO);
    expect(Date.parse(claude.updated)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(claude.updated)).toBeLessThanOrEqual(Date.now());
    await expect(options.read()).resolves.toEqual({ lists: { claude }, diagnostics: [] });
    expect((await stat(fileOf(root))).mode & 0o777).toBe(0o600);
  });

  it("writes an empty list", async () => {
    const root = await bareRoot();

    await openAgentOptions(root).save("claude", []);

    expect(await stored(root)).toMatchObject({ claude: { options: [] } });
  });

  it("replaces the list of the agent and keeps every other key of the file", async () => {
    const root = await bareRoot();
    await writeFile(fileOf(root), JSON.stringify({
      claude: { options: [MODE, MODEL], updated: WHEN },
      codex: { options: [MODE], updated: WHEN },
      later: [1],
    }));

    await openAgentOptions(root).save("claude", [MODEL]);

    const after = await stored(root);
    expect(after).toMatchObject({
      claude: { options: [MODEL] },
      codex: { options: [MODE], updated: WHEN },
      later: [1],
    });
    expect((after.claude as { updated: string }).updated).not.toBe(WHEN);
  });

  it("replaces a file that it cannot use", async () => {
    const root = await bareRoot();
    await writeFile(fileOf(root), "{ claude");

    await openAgentOptions(root).save("claude", [MODE]);

    expect(Object.keys(await stored(root))).toEqual(["claude"]);
    expect(await stored(root)).toMatchObject({ claude: { options: [MODE] } });
  });

  it("puts a new file in the place of the old one and leaves no temp file", async () => {
    const root = await bareRoot();
    await writeFile(fileOf(root), JSON.stringify({ claude: { options: [], updated: WHEN } }));
    const before = await stat(fileOf(root));

    await openAgentOptions(root).save("claude", [MODE]);

    expect((await stat(fileOf(root))).ino).not.toBe(before.ino);
    expect(await readdir(root)).toEqual(["agent-options.json"]);
  });

  it("runs the writes one at a time, in order, so each one keeps the others", async () => {
    const root = await bareRoot();
    const options = openAgentOptions(root);

    await Promise.all([
      options.save("claude", [MODE]),
      options.save("codex", [MODEL]),
      options.save("claude", [MODE, MODEL]),
    ]);

    expect(await stored(root)).toMatchObject({ claude: { options: [MODE, MODEL] }, codex: { options: [MODEL] } });
  });

  it("rejects a write that fails, and runs the next one", async () => {
    const root = await bareRoot();
    await mkdir(fileOf(root));
    await writeFile(join(fileOf(root), "inside"), "");
    const options = openAgentOptions(root);

    const failed = options.save("claude", [MODE]);
    const next = failed.catch(() => undefined).then(() => rm(fileOf(root), { recursive: true }));
    const later = next.then(() => options.save("codex", [MODEL]));

    await expect(failed).rejects.toThrow();
    await later;
    expect(Object.keys(await stored(root))).toEqual(["codex"]);
  });
});
