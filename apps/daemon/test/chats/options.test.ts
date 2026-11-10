import { describe, expect, it } from "vitest";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AgentDefaultsRead } from "@tasma/engine";
import { applyPlan, isHidden, optionFiles, wanted } from "../../src/chats/options.js";
import { modelOption, modeOption } from "../agents/fake-agent.js";

const OPTIONS = [modeOption(), modelOption()];

const DEFAULTS_PATH = "/home/alice/.tasma/agent-defaults.json";

/** The files over a defaults file whose read gives `read`, and the lines that they write on stderr. */
function filesOver(read: AgentDefaultsRead) {
  const lines: string[] = [];
  const files = optionFiles({
    defaults: { path: DEFAULTS_PATH, read: async () => read, save: async () => undefined },
    stderr: { write: (line: string) => lines.push(line) },
  });
  return { files, lines };
}

function saved(defaults: AgentDefaultsRead["defaults"]): AgentDefaultsRead {
  return { defaults, diagnostics: [] };
}

describe("applyPlan", () => {
  it("puts the model first, then the other options in list order, and an option the list lacks last", () => {
    const plan = applyPlan(OPTIONS, { defaults: { effort: "high", mode: "auto", model: "large" }, chosen: {}, waiting: [] });

    expect(plan).toEqual([
      { configId: "model", value: "large" },
      { configId: "mode", value: "auto" },
      { configId: "effort", value: "high" },
    ]);
  });

  it("takes a pick of the chat over a default, and a waiting pick over both", () => {
    const first = { configId: "mode", value: "acceptEdits" };
    const second = { configId: "mode", value: "auto" };

    const plan = applyPlan(OPTIONS, {
      defaults: { mode: "default", model: "large" },
      chosen: { mode: "bypassPermissions", model: "small" },
      waiting: [first, second],
    });

    expect(plan).toEqual([
      { configId: "model", value: "small" },
      { ...first, pick: first },
      { ...second, pick: second },
    ]);
  });
});

describe("wanted", () => {
  it.each([
    ["an offered value that is not current", "mode", "auto", true],
    ["a value in a group", "model", "large", true],
    ["the current value", "mode", "default", false],
    ["a hidden value", "mode", "plan", false],
    ["a value the option does not offer", "mode", "fast", false],
    ["an option the list lacks", "effort", "high", false],
  ])("gives whether to send %s", (_case, configId, value, expected) => {
    expect(wanted("claude", OPTIONS, configId, value)).toBe(expected);
  });
});

describe("isHidden", () => {
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])("finds no rule for an option named %s", (configId) => {
    expect(isHidden("claude", configId, "plan")).toBe(false);
  });

  it("finds the hidden values of the agent alone", () => {
    expect(isHidden("claude", "mode", "plan")).toBe(true);
    expect(isHidden("codex", "mode", "plan")).toBe(false);
  });
});

describe("defaultsOf", () => {
  it.each([
    ["no saved value", {}, { mode: "auto" }],
    ["no saved value of claude", { codex: { mode: "full" } }, { mode: "auto" }],
    ["a saved model", { claude: { model: "large" } }, { model: "large", mode: "auto" }],
  ])("gives claude the mode auto for a session that opens in default with %s", async (_case, defaults, expected) => {
    const { files, lines } = filesOver(saved(defaults));

    await expect(files.defaultsOf("claude", OPTIONS)).resolves.toEqual(expected);
    expect(lines).toEqual([]);
  });

  it("gives codex no mode", async () => {
    const { files } = filesOver(saved({ codex: { model: "large" } }));

    await expect(files.defaultsOf("codex", OPTIONS)).resolves.toEqual({ model: "large" });
  });

  it.each([
    ["a saved mode", { claude: { mode: "default" } }, { mode: "default" }],
    ["a saved mode that is never a default", { claude: { mode: "plan", model: "large" } }, { model: "large" }],
  ])("gives claude no other mode for %s", async (_case, defaults, expected) => {
    const { files } = filesOver(saved(defaults));

    await expect(files.defaultsOf("claude", OPTIONS)).resolves.toEqual(expected);
  });

  it("gives claude no mode when the defaults file cannot be used, with a fault line", async () => {
    const { files, lines } = filesOver({
      defaults: {},
      diagnostics: [{ code: "config-unreadable", message: "this file is not JSON", path: DEFAULTS_PATH }],
    });

    await expect(files.defaultsOf("claude", OPTIONS)).resolves.toEqual({});
    expect(lines).toEqual([`tasma-daemon: ${DEFAULTS_PATH}: this file is not JSON\n`]);
  });

  it.each<[string, SessionConfigOption[]]>([
    ["opens in another mode", [modeOption("acceptEdits"), modelOption()]],
    ["has no mode option", [modelOption()]],
  ])("gives claude no mode for a session that %s", async (_case, options) => {
    const { files } = filesOver(saved({}));

    await expect(files.defaultsOf("claude", options)).resolves.toEqual({});
  });
});
