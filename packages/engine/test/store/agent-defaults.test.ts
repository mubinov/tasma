import { chmod, mkdir, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { openAgentDefaults } from "@tasma/engine";
import { bareRoot, read } from "./helpers.js";

function fileOf(root: string): string {
  return join(root, "agent-defaults.json");
}

async function stored(root: string): Promise<unknown> {
  return JSON.parse(await read(fileOf(root)));
}

describe("openAgentDefaults", () => {
  it("names the file in the root", async () => {
    const root = await bareRoot();

    expect(openAgentDefaults(root).path).toBe(fileOf(root));
  });

  it("reads a missing file as empty, with no diagnostic", async () => {
    const root = await bareRoot();

    await expect(openAgentDefaults(root).read()).resolves.toEqual({ defaults: {}, diagnostics: [] });
  });

  it("reads the string values of each agent, and an agent that holds no object as empty", async () => {
    const root = await bareRoot();
    await writeFile(fileOf(root), JSON.stringify({ claude: { mode: "auto", depth: 3, model: null }, codex: "x", other: [1] }));

    await expect(openAgentDefaults(root).read()).resolves.toEqual({
      defaults: { claude: { mode: "auto" }, codex: {}, other: {} },
      diagnostics: [],
    });
  });

  it.each([
    ["is not JSON", "{ mode", /^this file is not JSON: /],
    ["is no JSON object", "[1, 2]", /^this file is not a JSON object$/],
    ["is null", "null", /^this file is not a JSON object$/],
  ])("reads a file that %s as empty, with a diagnostic", async (_name, text, fault) => {
    const root = await bareRoot();
    await writeFile(fileOf(root), text);

    const read = await openAgentDefaults(root).read();

    expect(read.defaults).toEqual({});
    expect(read.diagnostics).toMatchObject([{ code: "config-unreadable", path: fileOf(root) }]);
    expect(read.diagnostics[0]?.message).toMatch(fault);
  });

  it("reads a name that holds a directory or a link as empty, with a diagnostic", async () => {
    const root = await bareRoot();
    await mkdir(join(root, "elsewhere"));
    await writeFile(join(root, "elsewhere", "defaults.json"), JSON.stringify({ claude: { mode: "auto" } }));
    await symlink(join(root, "elsewhere", "defaults.json"), fileOf(root));

    await expect(openAgentDefaults(root).read()).resolves.toEqual({
      defaults: {},
      diagnostics: [{ code: "config-unreadable", message: "this name holds no regular file", path: fileOf(root) }],
    });

    await rm(fileOf(root));
    await mkdir(fileOf(root));

    await expect(openAgentDefaults(root).read()).resolves.toEqual({
      defaults: {},
      diagnostics: [{ code: "config-unreadable", message: "this name holds no regular file", path: fileOf(root) }],
    });
  });

  it.skipIf(process.getuid?.() === 0)("reads a file it cannot open as empty, with the cause", async () => {
    const root = await bareRoot();
    await writeFile(fileOf(root), JSON.stringify({ claude: { mode: "auto" } }));
    await chmod(fileOf(root), 0o000);
    onTestFinished(() => chmod(fileOf(root), 0o600));

    const read = await openAgentDefaults(root).read();

    expect(read.defaults).toEqual({});
    expect(read.diagnostics).toMatchObject([{ code: "config-unreadable", path: fileOf(root) }]);
    expect(read.diagnostics[0]?.message).toMatch(/^this file cannot be read: .*EACCES/);
  });

  it("writes a value into a new file, and makes the root when it is missing", async () => {
    const root = join(await bareRoot(), "tree");
    const defaults = openAgentDefaults(root);

    await defaults.save("claude", "mode", "acceptEdits");

    expect(await stored(root)).toEqual({ claude: { mode: "acceptEdits" } });
    await expect(defaults.read()).resolves.toEqual({ defaults: { claude: { mode: "acceptEdits" } }, diagnostics: [] });
    expect((await stat(fileOf(root))).mode & 0o777).toBe(0o600);
  });

  it("keeps every key of the file it does not change", async () => {
    const root = await bareRoot();
    await writeFile(fileOf(root), JSON.stringify({
      claude: { model: "large", depth: 3, mode: "default" },
      codex: { mode: "full" },
      later: [1],
    }));

    await openAgentDefaults(root).save("claude", "mode", "auto");

    expect(await stored(root)).toEqual({
      claude: { model: "large", depth: 3, mode: "auto" },
      codex: { mode: "full" },
      later: [1],
    });
  });

  it("replaces an agent that holds no object", async () => {
    const root = await bareRoot();
    await writeFile(fileOf(root), JSON.stringify({ claude: "auto" }));

    await openAgentDefaults(root).save("claude", "mode", "auto");

    expect(await stored(root)).toEqual({ claude: { mode: "auto" } });
  });

  it("replaces a file that it reads as empty", async () => {
    const root = await bareRoot();
    await writeFile(fileOf(root), "{ mode");

    await openAgentDefaults(root).save("claude", "mode", "auto");

    expect(await stored(root)).toEqual({ claude: { mode: "auto" } });
  });

  it("puts a new file in the place of the old one and leaves no temp file", async () => {
    const root = await bareRoot();
    await writeFile(fileOf(root), JSON.stringify({ claude: { mode: "default" } }));
    const before = await stat(fileOf(root));

    await openAgentDefaults(root).save("claude", "mode", "auto");

    expect((await stat(fileOf(root))).ino).not.toBe(before.ino);
    expect(await readdir(root)).toEqual(["agent-defaults.json"]);
  });

  it("runs the writes one at a time, so each one keeps the others", async () => {
    const root = await bareRoot();
    const defaults = openAgentDefaults(root);

    await Promise.all([
      defaults.save("claude", "mode", "auto"),
      defaults.save("claude", "model", "large"),
      defaults.save("codex", "mode", "full"),
    ]);

    expect(await stored(root)).toEqual({ claude: { mode: "auto", model: "large" }, codex: { mode: "full" } });
  });

  it("rejects a write that fails, and runs the next one", async () => {
    const root = await bareRoot();
    await mkdir(fileOf(root));
    await writeFile(join(fileOf(root), "inside"), "");
    const defaults = openAgentDefaults(root);

    const failed = defaults.save("claude", "mode", "auto");
    const next = failed.catch(() => undefined).then(() => rm(fileOf(root), { recursive: true }));
    const later = next.then(() => defaults.save("claude", "model", "large"));

    await expect(failed).rejects.toThrow();
    await later;
    expect(await stored(root)).toEqual({ claude: { model: "large" } });
  });
});
