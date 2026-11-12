import { describe, expect, it } from "vitest";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AgentDefaultsRead, AgentDefaultsStore, AgentOptionsStore } from "@tasma/engine";
import type { FeedEvent } from "@tasma/protocol";
import type { LiveChat } from "../../src/chats/registry.js";
import {
  applyPlan,
  isHidden,
  offering,
  optionFiles,
  startDefaults,
  startOptions,
  wanted,
} from "../../src/chats/options.js";
import { modelOption, modeOption } from "../agents/fake-agent.js";

const OPTIONS = [modeOption(), modelOption()];

const DEFAULTS_PATH = "/home/alice/.tasma/agent-defaults.json";

const OPTIONS_PATH = "/home/alice/.tasma/agent-options.json";

/** A store of the options that keeps each saved list in `kept`, or rejects each save with `failure`. */
function optionsStore(failure?: Error) {
  const kept: { agent: string; options: readonly Record<string, unknown>[] }[] = [];
  const store: AgentOptionsStore = {
    path: OPTIONS_PATH,
    read: async () => ({ lists: {}, diagnostics: [] }),
    save: async (agent, options) => {
      if (failure !== undefined) throw failure;
      kept.push({ agent, options });
    },
  };
  return { store, kept };
}

/**
 * The files over a defaults file whose read gives `read`, the lines that they
 * write on stderr, the events that they publish and the lists that they keep.
 */
function filesOver(
  read: AgentDefaultsRead,
  stores: { defaults?: Partial<AgentDefaultsStore>; agentOptions?: AgentOptionsStore } = {},
) {
  const lines: string[] = [];
  const published: FeedEvent[] = [];
  const { store, kept } = optionsStore();
  const files = optionFiles({
    defaults: { path: DEFAULTS_PATH, read: async () => read, save: async () => undefined, ...stores.defaults },
    agentOptions: stores.agentOptions ?? store,
    stderr: { write: (line: string) => lines.push(line) },
    publish: (event) => published.push(event),
  });
  return { files, lines, published, kept };
}

/** A chat of claude whose record takes every write. */
function liveChat(): LiveChat {
  return {
    tag: "ALPHA",
    chat: { task: "ALPHA-1", chat: 1, agent: "claude", options: {} },
    setOptions: async () => undefined,
  } as unknown as LiveChat;
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

describe("startDefaults", () => {
  it("gives the saved values of the agent and the start mode auto", () => {
    expect(startDefaults("claude", OPTIONS, saved({ claude: { model: "large" }, codex: { mode: "full" } }))).toEqual({
      defaults: { model: "large", mode: "auto" },
      ignored: [],
    });
  });

  it("gives a saved value that is never a default as ignored, and no start mode", () => {
    expect(startDefaults("claude", OPTIONS, saved({ claude: { mode: "bypassPermissions", model: "large" } }))).toEqual({
      defaults: { model: "large" },
      ignored: [{ configId: "mode", value: "bypassPermissions" }],
    });
  });

  it("gives no start mode for a read with a fault", () => {
    const read: AgentDefaultsRead = {
      defaults: {},
      diagnostics: [{ code: "config-unreadable", message: "this file is not JSON", path: DEFAULTS_PATH }],
    };

    expect(startDefaults("claude", OPTIONS, read)).toEqual({ defaults: {}, ignored: [] });
  });
});

describe("startOptions", () => {
  it("sets the current value of each option to a default that it wants, and keeps the other options as they are", () => {
    const effort: SessionConfigOption = { id: "effort", name: "Effort", type: "boolean", currentValue: false };
    const options = [modeOption(), modelOption(), effort];

    const start = startOptions("claude", options, { model: "large", mode: "auto" });

    expect(start).toEqual([modeOption("auto"), modelOption("large"), effort]);
    expect(start[2]).toBe(effort);
    expect(options).toEqual([modeOption(), modelOption(), effort]);
  });

  it.each([
    ["a hidden value", { mode: "plan" }],
    ["a value that the option does not offer", { mode: "fast", model: "huge" }],
    ["an option that the list lacks", { effort: "high" }],
    ["the current value", { mode: "default" }],
  ])("keeps the opened value for %s", (_case, defaults) => {
    const start = startOptions("claude", OPTIONS, defaults);

    expect(start).toEqual(OPTIONS);
    expect(start.every((option, index) => option === OPTIONS[index])).toBe(true);
  });

  it("sets no value on an option that is not a select, also when a select of the same id takes the default", () => {
    const flag: SessionConfigOption = { id: "mode", name: "Mode", type: "boolean", currentValue: false };

    expect(startOptions("claude", [modeOption(), flag], { mode: "auto" })).toEqual([modeOption("auto"), flag]);
  });

  it("finds no option for a default named as a member of the prototype of an object", () => {
    expect(startOptions("claude", OPTIONS, JSON.parse('{ "__proto__": "auto" }') as Record<string, string>)).toEqual(OPTIONS);
  });
});

describe("offering", () => {
  const select = (options: unknown): SessionConfigOption => (
    { id: "mode", name: "Mode", type: "select", currentValue: "default", options } as SessionConfigOption
  );

  it.each([
    ["a select whose options are not an array", select({ value: "auto" })],
    ["a select whose entry is null", select([null, "auto", ["auto"]])],
    ["a group whose options are not an array", select([{ group: "all", name: "All", options: { value: "auto" } }])],
    ["a group whose value is not an object", select([{ group: "all", name: "All", options: [null, "auto", ["auto"]] }])],
  ])("offers nothing for %s", (_case, option) => {
    expect(offering([option], "mode", "auto")).toBeUndefined();
  });

  it("offers the usable values beside the parts of a bad shape", () => {
    const option = select([null, { value: "auto", name: "Auto" }, { group: "all", name: "All", options: [7, { value: "plan", name: "Plan" }] }]);

    expect(offering([option], "mode", "auto")).toBe(option);
    expect(offering([option], "mode", "plan")).toBe(option);
  });
});

describe("keep", () => {
  it("saves the options of the agent and publishes agent-options", async () => {
    const { files, lines, published, kept } = filesOver(saved({}));

    await files.keep("claude", OPTIONS);

    expect(kept).toEqual([{ agent: "claude", options: OPTIONS }]);
    expect(published).toEqual([{ kind: "agent-options", agent: "claude" }]);
    expect(lines).toEqual([]);
  });

  it("writes one line on stderr for a write that fails, publishes nothing, and does not reject", async () => {
    const { store } = optionsStore(new Error("EACCES: permission denied"));
    const { files, lines, published } = filesOver(saved({}), { agentOptions: store });

    await expect(files.keep("codex", [])).resolves.toBeUndefined();

    expect(lines).toEqual([`tasma-daemon: ${OPTIONS_PATH}: the options of codex are not saved: EACCES: permission denied\n`]);
    expect(published).toEqual([]);
  });
});

describe("save", () => {
  it("publishes agent-options after the default of the agent is written", async () => {
    const { files, published } = filesOver(saved({}));

    await expect(files.save(liveChat(), "mode", "acceptEdits")).resolves.toEqual([]);

    expect(published).toEqual([{ kind: "agent-options", agent: "claude" }]);
  });

  it("publishes nothing for a value that is never a default", async () => {
    const { files, published } = filesOver(saved({}));

    await expect(files.save(liveChat(), "mode", "bypassPermissions")).resolves.toEqual([]);

    expect(published).toEqual([]);
  });

  it("publishes nothing when the write of the default fails", async () => {
    const failing = { save: async () => Promise.reject(new Error("EROFS: read-only file system")) };
    const { files, published } = filesOver(saved({}), { defaults: failing });

    const diagnostics = await files.save(liveChat(), "mode", "acceptEdits");

    expect(diagnostics).toMatchObject([{ code: "option-not-saved", path: DEFAULTS_PATH }]);
    expect(published).toEqual([]);
  });
});
