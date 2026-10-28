import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RequestError } from "@agentclientprotocol/sdk";
import type { PromptRequest, SessionConfigOption } from "@agentclientprotocol/sdk";
import { TaskStoreError } from "@tasma/engine";
import type { ChatEvent } from "@tasma/protocol";
import type { LiveChat } from "../../src/chats/registry.js";
import { logOf, logUntil, until } from "../helpers.js";
import { actAsAdapter, forever, modelOption, modeOption, SESSION } from "../agents/fake-agent.js";
import type { Script } from "../agents/fake-agent.js";
import {
  defaultsFile,
  fakeAdapter,
  gate,
  heldTurns,
  modeUpdate,
  NEXT,
  optionsUpdate,
  PICK,
  slowEnd,
  START,
  USER,
  world,
} from "./runner-world.js";
import type { World, WorldOptions } from "./runner-world.js";

const OPTIONS = [modeOption(), modelOption()];

const TURN_END: ChatEvent = { kind: "turn-end", stopReason: "end_turn" };

const NEXT_USER: ChatEvent = { kind: "user", ...NEXT };

const LATER = { text: "And the tests", client: "web" } as const;

const STOPPING = { code: "chat-not-running", message: "chat 1 of ALPHA-1 cannot run: the daemon is stopping" };

const USER_MESSAGE = { text: START.text, client: START.client };

const EFFORT: SessionConfigOption = {
  id: "effort",
  name: "Effort",
  category: "thought_level",
  type: "select",
  currentValue: "low",
  options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }],
};

async function plantDefaults(root: string, value: unknown): Promise<void> {
  await writeFile(defaultsFile(root), JSON.stringify(value));
}

async function storedDefaults(root: string): Promise<unknown> {
  return JSON.parse(await readFile(defaultsFile(root), "utf8"));
}

function promptText(params: PromptRequest): string {
  return params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/**
 * A script with `OPTIONS` that records what the agent gets, in order: each set
 * as `<configId>=<value>` and each prompt as `prompt <text>`.
 */
function recording(extra: Script = {}): { script: Script; seen: string[] } {
  const seen: string[] = [];
  const script: Script = {
    configOptions: OPTIONS,
    ...extra,
    setConfigOption(params, fake) {
      seen.push(`${params.configId}=${String(params.value)}`);
      return (extra.setConfigOption ?? actAsAdapter)(params, fake);
    },
    async prompt(params, fake) {
      seen.push(`prompt ${promptText(params)}`);
      return extra.prompt?.(params, fake) ?? { stopReason: "end_turn" };
    },
  };
  return { script, seen };
}

/** A set that the agent refuses for `configId`, as the adapter does. */
function refusing(configId: string): Script["setConfigOption"] {
  return async (params, fake) => {
    if (params.configId === configId) throw new Error(`${String(params.value)} needs another model`);
    return actAsAdapter(params, fake);
  };
}

/** A chat whose first turn has ended and whose agent process the runner then ended. */
async function stopped(options: WorldOptions = { script: { configOptions: OPTIONS } }) {
  const setup = await world(options);
  const live = await setup.runner.start(START);
  const log = await logUntil(live, "turn-end");
  await setup.runner.stop(live);
  return { ...setup, live, log };
}

/** A chat whose agent process exited after the first turn, so the chat is failed. */
async function failed(options: WorldOptions) {
  const setup = await world(options);
  const live = await setup.runner.start(START);
  await logUntil(live, "turn-end");
  setup.processes[0]?.exit({ code: 137, signal: null });
  const log = await logUntil(live, "failed");
  return { ...setup, live, log };
}

/** A chat whose first turn has ended and whose agent process the runner is ending, slowly. */
async function endingSlowly(options: WorldOptions = {}) {
  const setup = await world({ script: { configOptions: OPTIONS }, started: slowEnd(100), ...options });
  const live = await setup.runner.start(START);
  const log = await logUntil(live, "turn-end");
  void setup.runner.stop(live);
  await until(() => (setup.processes[0]?.endCalls ?? 0) > 0, "the runner ended the process");
  return { ...setup, live, log };
}

/** A `recording` script whose resume of the session waits for `resume.open`. */
function gatedResume(extra: Script = {}) {
  const resume = gate();
  const { script, seen } = recording({
    ...extra,
    async resume(_params, fake) {
      await resume.opened;
      return { configOptions: fake.configOptions };
    },
  });
  return { resume, script, seen };
}

/**
 * Holds the log write of the `resumed` event in its turn until `open`, so a
 * later write of the chat comes after it. `asked` tells whether the runner
 * gave an event of the kind to the log.
 */
function holdResumedWrite(live: LiveChat, writes: World["writes"]) {
  const held = gate();
  const kinds: ChatEvent["kind"][] = [];
  const append = live.append.bind(live);
  vi.spyOn(live, "append").mockImplementation((event) => {
    kinds.push(event.kind);
    if (event.kind === "resumed") void writes.run("ALPHA", () => held.opened);
    return append(event);
  });
  return { open: held.open, asked: (kind: ChatEvent["kind"]) => kinds.includes(kind) };
}

/** A stopped chat whose pick starts the agent again, which waits in the resume of the session until `resume.open`. */
async function pickInResume(options: WorldOptions = {}) {
  const { resume, script, seen } = gatedResume(options.script);
  const setup = await stopped({ ...options, script });
  const picked = setup.runner.setOption(setup.live, PICK);
  await until(() => setup.processes[1]?.resumes.length === 1, "the relaunch resumes the session");
  return { ...setup, resume, seen, picked };
}

/** A failed chat whose pick starts the agent again, which waits in the log write of `resumed` until `resumed.open`. */
async function pickInResumedWrite(options: WorldOptions = {}) {
  const { script, seen } = recording(options.script);
  const setup = await failed({ ...options, script });
  const resumed = holdResumedWrite(setup.live, setup.writes);
  const picked = setup.runner.setOption(setup.live, PICK);
  await until(() => resumed.asked("resumed"), "the relaunch writes resumed");
  return { ...setup, resumed, seen, picked };
}

/** A stopped chat whose agent refused the resume of the restart for `NEXT`, so the agent never got `NEXT`. */
async function failedBeforeNext() {
  let resumes = 0;
  const setup = await stopped({
    script: {
      configOptions: OPTIONS,
      async resume(_params, fake) {
        resumes += 1;
        if (resumes === 1) throw RequestError.authRequired();
        return { configOptions: fake.configOptions };
      },
    },
  });
  await setup.runner.message(setup.live, NEXT);
  await logUntil(setup.live, "failed");
  return setup;
}

/** A `setConfigOption` that holds a set of the mode `auto` until `open`. */
function holdingAuto() {
  const held = gate();
  const setConfigOption: Script["setConfigOption"] = async (params, fake) => {
    if (params.value === "auto") await held.opened;
    return actAsAdapter(params, fake);
  };
  return { open: held.open, setConfigOption };
}

describe("the options of a session that opens", () => {
  it("applies the defaults of the agent before the first prompt, the model first, logs each list, and writes no file", async () => {
    const { script, seen } = recording();
    const { runner, root } = await world({ script });
    await plantDefaults(root, { claude: { mode: "acceptEdits", model: "large" }, codex: { mode: "full" } });
    const before = await readFile(defaultsFile(root), "utf8");

    const live = await runner.start(START);

    expect(await logUntil(live, "turn-end")).toEqual([
      USER,
      optionsUpdate(OPTIONS),
      optionsUpdate([modeOption(), modelOption("large")]),
      modeUpdate("acceptEdits"),
      optionsUpdate([modeOption("acceptEdits"), modelOption("large")]),
      TURN_END,
    ]);
    expect(seen).toEqual(["model=large", "mode=acceptEdits", `prompt ${START.text}`]);
    expect(live.chat.options).toBeUndefined();
    await expect(readFile(defaultsFile(root), "utf8")).resolves.toBe(before);
  });

  it.each([
    ["an option the session does not offer", { effort: "high", mode: "default" }],
    ["a value the session does not offer", { model: "huge" }],
    ["the current value", { mode: "default" }],
  ])("sends no default that is %s", async (_case, values) => {
    const { script, seen } = recording();
    const { runner, root, errors } = await world({ script });
    await plantDefaults(root, { claude: values });

    const live = await runner.start(START);

    expect(await logUntil(live, "turn-end")).toEqual([USER, optionsUpdate(OPTIONS), TURN_END]);
    expect(seen).toEqual([`prompt ${START.text}`]);
    expect(errors).toEqual([]);
  });

  it.each(["bypassPermissions", "plan"])("sends no default %s, with a fault line that names the file", async (value) => {
    const { script, seen } = recording();
    const { runner, root, errors } = await world({ script });
    await plantDefaults(root, { claude: { mode: value, model: "large" } });

    const live = await runner.start(START);
    await logUntil(live, "turn-end");

    expect(seen).toEqual(["model=large", `prompt ${START.text}`]);
    expect(errors).toEqual([
      `tasma-daemon: ${defaultsFile(root)}: "${value}" of "mode" of claude is not applied: this value is never a default\n`,
    ]);
  });

  it("writes a fault line for a default that the agent refuses, and goes on", async () => {
    const { script, seen } = recording({ setConfigOption: refusing("mode") });
    const { runner, root, errors } = await world({ script });
    await plantDefaults(root, { claude: { mode: "auto", model: "large" } });

    const live = await runner.start(START);

    expect((await logUntil(live, "turn-end")).at(-2)).toEqual(optionsUpdate([modeOption(), modelOption("large")]));
    expect(seen).toEqual(["model=large", "mode=auto", `prompt ${START.text}`]);
    expect(errors).toEqual(['tasma-daemon: chat 1 of ALPHA-1: the agent refused "auto" for "mode": auto needs another model\n']);
  });

  it("uses a defaults file it cannot parse as empty, with a fault line that names the file", async () => {
    const { script, seen } = recording();
    const { runner, root, errors } = await world({ script });
    await writeFile(defaultsFile(root), "{ mode");

    const live = await runner.start(START);
    await logUntil(live, "turn-end");

    expect(seen).toEqual([`prompt ${START.text}`]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(new RegExp(`^tasma-daemon: ${defaultsFile(root)}: this file is not JSON: `));
  });

  it("logs no list and sends no default when the daemon closes while the session opens", async () => {
    const held = gate();
    const { script, seen } = recording({
      async newSession(_params, fake) {
        await held.opened;
        return { sessionId: SESSION, configOptions: fake.configOptions };
      },
    });
    const { runner, root, processes } = await world({ script, started: slowEnd(200) });
    await plantDefaults(root, { claude: { mode: "acceptEdits" } });
    const live = await runner.start(START);
    await until(() => processes[0]?.newSession !== undefined, "the session is opening");

    const closed = runner.close();
    held.open();
    await until(() => live.chat.session === SESSION, "the agent opened the session");
    await closed;

    expect(await logOf(live)).toEqual([USER, { kind: "interrupted" }]);
    expect(seen).toEqual([]);
  });

  it("reads no defaults and logs no list for a session with no options", async () => {
    const { runner, root, errors, processes } = await world();
    await writeFile(defaultsFile(root), "{ mode");

    const live = await runner.start(START);

    expect(await logUntil(live, "turn-end")).toEqual([USER, TURN_END]);
    expect(errors).toEqual([]);
    expect(processes[0]?.configSets).toEqual([]);
  });

  it("keeps the list of the run to the notifications of the agent", async () => {
    const { runner, processes } = await world({
      script: {
        configOptions: OPTIONS,
        async prompt(params, agent) {
          if (promptText(params) === START.text) {
            await agent.update({ sessionUpdate: "current_mode_update", currentModeId: "plan" });
          } else {
            agent.configOptions = [modeOption("plan"), EFFORT];
            await agent.update({ sessionUpdate: "config_option_update", configOptions: agent.configOptions });
          }
          return { stopReason: "end_turn" };
        },
      },
    });
    const live = await runner.start(START);
    await logUntil(live, "turn-end");

    expect(runner.running(live)?.options).toEqual([modeOption("plan"), modelOption()]);

    await runner.message(live, NEXT);
    await logUntil(live, "turn-end");

    expect(runner.running(live)?.options).toEqual([modeOption("plan"), EFFORT]);
    await expect(runner.setOption(live, { configId: "effort", value: "high", client: "web" })).resolves.toEqual([]);
    expect(processes[0]?.configSets.map((set) => set.configId)).toEqual(["effort"]);
  });
});

describe("a pick on a chat whose session is open", () => {
  async function opened(script: Script = { configOptions: OPTIONS }) {
    const setup = await world({ script });
    const live = await setup.runner.start(START);
    const log = await logUntil(live, "turn-end");
    return { ...setup, live, log };
  }

  it("sets the value, logs the list, and saves it in the chat and as the default of the agent", async () => {
    const { runner, live, log, root, processes } = await opened();
    await plantDefaults(root, { claude: { model: "large" }, codex: { mode: "full" } });

    await expect(runner.setOption(live, PICK)).resolves.toEqual([]);

    expect(processes[0]?.configSets).toEqual([{ sessionId: SESSION, configId: "mode", value: "acceptEdits" }]);
    expect(await logOf(live)).toEqual([
      ...log,
      modeUpdate("acceptEdits"),
      optionsUpdate([modeOption("acceptEdits"), modelOption()]),
    ]);
    expect(live.chat).toMatchObject({ state: "needs-you", options: { mode: "acceptEdits" } });
    expect(await storedDefaults(root)).toEqual({ claude: { model: "large", mode: "acceptEdits" }, codex: { mode: "full" } });
  });

  it("keeps the picks of the other options of the chat", async () => {
    const { runner, live } = await opened();

    await runner.setOption(live, PICK);
    await runner.setOption(live, { configId: "model", value: "large", client: "web" });

    expect(live.chat.options).toEqual({ mode: "acceptEdits", model: "large" });
  });

  it("saves bypassPermissions in the chat alone", async () => {
    const { runner, live, root } = await opened();

    await expect(runner.setOption(live, { ...PICK, value: "bypassPermissions" })).resolves.toEqual([]);

    expect(live.chat.options).toEqual({ mode: "bypassPermissions" });
    await expect(readFile(defaultsFile(root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sends and saves a pick of the current value", async () => {
    const { runner, live, root, processes } = await opened();

    await runner.setOption(live, { ...PICK, value: "default" });

    expect(processes[0]?.configSets).toHaveLength(1);
    expect(live.chat.options).toEqual({ mode: "default" });
    expect(await storedDefaults(root)).toEqual({ claude: { mode: "default" } });
  });

  it("sends a pick of the mode the chat had before the agent entered plan mode", async () => {
    const { runner, live, processes } = await opened({
      configOptions: OPTIONS,
      async prompt(_params, agent) {
        agent.configOptions = [modeOption("plan"), modelOption()];
        await agent.update({ sessionUpdate: "current_mode_update", currentModeId: "plan" });
        return { stopReason: "end_turn" };
      },
    });

    await runner.setOption(live, { ...PICK, value: "default" });

    expect(processes[0]?.configSets.map((set) => set.value)).toEqual(["default"]);
    expect(runner.running(live)?.options[0]).toEqual(modeOption("default"));
  });

  it.each([
    ["a hidden value", { configId: "mode", value: "plan" }, 'offers no value "plan" for "mode"'],
    ["a value it does not offer", { configId: "mode", value: "fast" }, 'offers no value "fast" for "mode"'],
    ["an option it does not offer", { configId: "effort", value: "high" }, 'offers no value "high" for "effort"'],
  ])("refuses %s before it asks the agent, and writes nothing", async (_case, pick, message) => {
    const { runner, live, root, processes } = await opened();

    await expect(runner.setOption(live, { ...pick, client: "web" })).rejects.toMatchObject({
      code: "option-refused",
      message: `the agent of chat 1 of ALPHA-1 ${message}`,
    });

    expect(processes[0]?.configSets).toEqual([]);
    expect(live.chat.options).toBeUndefined();
    await expect(readFile(defaultsFile(root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a value the agent refuses with its message, and writes nothing", async () => {
    const { runner, live, log, root } = await opened({ configOptions: OPTIONS, setConfigOption: refusing("mode") });

    await expect(runner.setOption(live, { ...PICK, value: "auto" })).rejects.toMatchObject({
      code: "option-refused",
      message: 'the agent of chat 1 of ALPHA-1 refused "auto" for "mode": auto needs another model',
    });

    expect(await logOf(live)).toEqual(log);
    expect(live.chat.options).toBeUndefined();
    await expect(readFile(defaultsFile(root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sets a value during a turn, while a permission request is open", async () => {
    const { runner, processes } = await world({
      script: {
        configOptions: OPTIONS,
        prompt(_params, agent) {
          void agent.permission().catch(() => undefined);
          return forever();
        },
      },
    });
    const live = await runner.start(START);
    await logUntil(live, "permission");

    await expect(runner.setOption(live, PICK)).resolves.toEqual([]);

    expect(processes[0]?.configSets).toHaveLength(1);
    expect(live.chat).toMatchObject({ state: "needs-you", options: { mode: "acceptEdits" } });
    expect(live.fold.turn).toBe(true);
  });

  it("runs the picks of one chat one after the other, and the last one wins", async () => {
    const held = gate();
    const { runner, live, root, processes } = await opened({
      configOptions: OPTIONS,
      async setConfigOption(params, fake) {
        if (fake.configSets.length === 1) await held.opened;
        return actAsAdapter(params, fake);
      },
    });

    const first = runner.setOption(live, PICK);
    const second = runner.setOption(live, { ...PICK, value: "auto" });
    await until(() => processes[0]?.configSets.length === 1, "the agent got the first set");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(processes[0]?.configSets).toHaveLength(1);
    held.open();
    await Promise.all([first, second]);

    expect(processes[0]?.configSets.map((set) => set.value)).toEqual(["acceptEdits", "auto"]);
    expect(live.chat.options).toEqual({ mode: "auto" });
    expect(await storedDefaults(root)).toEqual({ claude: { mode: "auto" } });
  });

  it("refuses with chat-not-running when the connection closes during the set, and fails nothing", async () => {
    const { runner, live, log, processes } = await opened({ configOptions: OPTIONS, setConfigOption: () => forever() });

    const picked = runner.setOption(live, PICK);
    await until(() => processes[0]?.configSets.length === 1, "the agent got the set");
    processes[0]?.exit({ code: 0, signal: null });

    await expect(picked).rejects.toMatchObject({ code: "chat-not-running" });
    await until(() => runner.running(live) === undefined, "the chat stopped running");
    expect(await logOf(live)).toEqual(log);
  });

  it("answers with a diagnostic for the record of the chat that it could not write", async () => {
    const { runner, live, root } = await opened();
    vi.spyOn(live, "setOptions").mockRejectedValue(new Error("the disk is full"));

    await expect(runner.setOption(live, PICK)).resolves.toEqual([{
      code: "option-not-saved",
      message: 'the value "acceptEdits" of "mode" is not saved in this chat: the disk is full',
      path: join(root, "projects", "ALPHA", "chats", "1", "1", "chat.json"),
    }]);
    expect(await storedDefaults(root)).toEqual({ claude: { mode: "acceptEdits" } });
  });

  it("refuses a pick once the daemon stops", async () => {
    const { runner, live, processes } = await opened();
    runner.stopStarts();

    await expect(runner.setOption(live, PICK)).rejects.toMatchObject({ code: "chat-not-running" });
    expect(processes[0]?.configSets).toEqual([]);
  });
});

describe("a pick while the session opens", () => {
  it("is applied after the defaults and before the first prompt, and its answer comes then", async () => {
    const held = gate();
    const { script, seen } = recording({
      async newSession(_params, fake) {
        await held.opened;
        return { sessionId: SESSION, configOptions: fake.configOptions };
      },
    });
    const { runner, root, processes } = await world({ script });
    await plantDefaults(root, { claude: { mode: "acceptEdits", model: "large" } });
    const live = await runner.start(START);
    await until(() => processes[0]?.newSession !== undefined, "the session is opening");

    const picked = runner.setOption(live, { ...PICK, value: "auto" });
    held.open();

    await expect(picked).resolves.toEqual([]);
    await logUntil(live, "turn-end");
    expect(seen).toEqual(["model=large", "mode=auto", `prompt ${START.text}`]);
    expect(live.chat.options).toEqual({ mode: "auto" });
    expect(await storedDefaults(root)).toEqual({ claude: { mode: "auto", model: "large" } });
  });

  it("is applied when it comes during the apply step, before the first prompt", async () => {
    const held = gate();
    const { script, seen } = recording({
      async setConfigOption(params, fake) {
        if (params.configId === "model") await held.opened;
        return actAsAdapter(params, fake);
      },
    });
    const { runner, root } = await world({ script });
    await plantDefaults(root, { claude: { model: "large" } });
    const live = await runner.start(START);
    await until(() => seen.includes("model=large"), "the default is on its way");

    const picked = runner.setOption(live, { ...PICK, value: "auto" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    held.open();

    await expect(picked).resolves.toEqual([]);
    await logUntil(live, "turn-end");
    expect(seen).toEqual(["model=large", "mode=auto", `prompt ${START.text}`]);
  });

  it.each([
    ["a value the session does not offer", { configId: "effort", value: "high" }, 'offers no value "high" for "effort"'],
    ["a value the agent refuses", { configId: "mode", value: "auto" }, 'refused "auto" for "mode": auto needs another model'],
  ])("is refused for %s, and the chat goes on", async (_case, pick, message) => {
    const held = gate();
    const { script, seen } = recording({
      async newSession(_params, fake) {
        await held.opened;
        return { sessionId: SESSION, configOptions: fake.configOptions };
      },
      setConfigOption: refusing("mode"),
    });
    const { runner, processes } = await world({ script });
    const live = await runner.start(START);
    await until(() => processes[0]?.newSession !== undefined, "the session is opening");

    const picked = runner.setOption(live, { ...pick, client: "web" });
    held.open();

    await expect(picked).rejects.toMatchObject({ code: "option-refused", message: `the agent of chat 1 of ALPHA-1 ${message}` });
    await logUntil(live, "turn-end");
    expect(seen.at(-1)).toBe(`prompt ${START.text}`);
    expect(live.chat.options).toBeUndefined();
  });

  it("is refused with the reason when the session cannot open", async () => {
    const held = gate();
    const { runner, processes } = await world({
      script: {
        async newSession() {
          await held.opened;
          throw RequestError.internalError({ details: "no room for a session" });
        },
      },
    });
    const live = await runner.start(START);
    await until(() => processes[0]?.newSession !== undefined, "the session is opening");

    const picked = runner.setOption(live, PICK);
    held.open();

    await expect(picked).rejects.toMatchObject({
      code: "chat-not-running",
      message: "chat 1 of ALPHA-1 has no agent process: no room for a session",
    });
    expect(await logUntil(live, "failed")).toEqual([USER, { kind: "failed", reason: "no room for a session" }]);
  });

  for (const what of ["a waiting pick", "a default"] as const) {
    it(`ends the apply step when the connection closes during ${what}, and fails the chat`, async () => {
      const held = gate();
      const { script, seen } = recording({
        async newSession(_params, fake) {
          await held.opened;
          return { sessionId: SESSION, configOptions: fake.configOptions };
        },
        setConfigOption: () => forever(),
      });
      const { runner, root, processes } = await world({ script });
      if (what === "a default") await plantDefaults(root, { claude: { model: "large" } });
      const live = await runner.start(START);
      await until(() => processes[0]?.newSession !== undefined, "the session is opening");

      const picked = runner.setOption(live, { ...PICK, value: "auto" });
      held.open();
      await until(() => seen.length === 1, "the agent got a set");
      processes[0]?.exit({ code: 0, signal: null });

      await expect(picked).rejects.toMatchObject({ code: "chat-not-running" });
      expect((await logUntil(live, "failed")).at(-1)).toEqual({ kind: "failed", reason: "The agent process ended with exit code 0" });
      expect(seen).toEqual([what === "a default" ? "model=large" : "mode=auto"]);
    });
  }

  it("answers a waiting pick with chat-not-running when the log of the chat is gone", async () => {
    const held = gate();
    const { runner, root, processes, errors } = await world({
      script: {
        configOptions: OPTIONS,
        async newSession(_params, fake) {
          await held.opened;
          return { sessionId: SESSION, configOptions: fake.configOptions };
        },
      },
    });
    await plantDefaults(root, { claude: { model: "large" } });
    const live = await runner.start(START);
    await until(() => processes[0]?.newSession !== undefined, "the session is opening");
    vi.spyOn(live, "append").mockRejectedValue(new TaskStoreError("chat-not-found", "this chat is no longer here"));

    const picked = runner.setOption(live, PICK);
    held.open();

    await expect(picked).rejects.toMatchObject({ code: "chat-not-running" });
    await until(() => runner.running(live) === undefined, "the chat stopped running");
    expect(processes[0]?.configSets).toEqual([]);
    expect(processes[0]?.prompts).toEqual([]);
    expect(errors).toEqual([]);
  });

  for (const when of ["after", "during"] as const) {
    it(`sets no session when the log of the chat goes ${when} the last set`, async () => {
      const started: { live?: LiveChat } = {};
      const { runner, root, processes } = await world({
        script: {
          configOptions: OPTIONS,
          async setConfigOption(params, fake) {
            const live = started.live!;
            vi.spyOn(live, "append").mockRejectedValue(new TaskStoreError("chat-not-found", "this chat is no longer here"));
            if (when === "during") {
              // The halt ends the process, which then still answers until its slow end.
              await fake.update({ sessionUpdate: "current_mode_update", currentModeId: "auto" });
              await until(() => runner.running(live) === undefined, "the run halted");
            }
            return actAsAdapter(params, fake);
          },
        },
        started: slowEnd(300),
      });
      await plantDefaults(root, { claude: { model: "large" } });
      const live = await runner.start(START);
      started.live = live;

      await until(() => runner.running(live) === undefined, "the chat stopped running");
      expect(processes[0]?.configSets).toHaveLength(1);
      expect(processes[0]?.prompts).toEqual([]);
    });
  }

  it("refuses a pick that comes during the apply step with chat-not-running when the connection closes", async () => {
    const held = gate();
    const { script, seen } = recording({
      async setConfigOption(params, fake) {
        if (params.configId === "mode") return forever();
        await held.opened;
        return actAsAdapter(params, fake);
      },
    });
    const { runner, root, processes } = await world({ script });
    await plantDefaults(root, { claude: { model: "large" } });
    const live = await runner.start(START);
    await until(() => seen.includes("model=large"), "the default is on its way");

    const picked = runner.setOption(live, { ...PICK, value: "auto" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    held.open();
    await until(() => seen.includes("mode=auto"), "the agent got the pick");
    processes[0]?.exit({ code: 0, signal: null });

    await expect(picked).rejects.toMatchObject({ code: "chat-not-running" });
    await logUntil(live, "failed");
  });
});

describe("the options of a resumed session", () => {
  it("are the picks of the chat, not the defaults of the agent", async () => {
    const { runner, live, root, processes } = await stopped();
    await runner.setOption(live, { ...PICK, value: "auto" });
    await runner.stop(live);
    await plantDefaults(root, { claude: { mode: "acceptEdits", model: "large" } });

    await runner.message(live, NEXT);
    await logUntil(live, "turn-end");

    expect(processes[2]?.resumes).toHaveLength(1);
    expect(processes[2]?.configSets.map((set) => `${set.configId}=${String(set.value)}`)).toEqual(["mode=auto"]);
    expect(processes[2]?.prompts.map(promptText)).toEqual([NEXT.text]);
  });

  it("skips a pick of the chat that the agent refuses, with a fault line", async () => {
    const { runner, live, errors, processes } = await stopped({ script: { configOptions: OPTIONS, setConfigOption: refusing("mode") } });
    await live.setOptions({ mode: "auto" });

    await runner.message(live, NEXT);
    await logUntil(live, "turn-end");

    expect(errors).toEqual(['tasma-daemon: chat 1 of ALPHA-1: the agent refused "auto" for "mode": auto needs another model\n']);
    expect(processes[1]?.prompts.map(promptText)).toEqual([NEXT.text]);
  });

  it("of a lost session that never answered are the defaults of the agent, then the picks of the chat", async () => {
    let resumes = 0;
    const { script, seen } = recording({
      async resume() {
        resumes += 1;
        throw RequestError.resourceNotFound(SESSION);
      },
    });
    const { runner, root, chats, folder } = await world({ script });
    const live = await chats.create("ALPHA", "ALPHA-1", { step: START.step, agent: "claude", folder }, USER_MESSAGE);
    await live.setSession(SESSION);
    await live.setOptions({ mode: "auto" });
    await plantDefaults(root, { claude: { mode: "acceptEdits", model: "large" } });

    await runner.message(live, NEXT);
    await logUntil(live, "turn-end");

    expect(resumes).toBe(1);
    expect(seen).toEqual(["model=large", "mode=auto", `prompt ${START.text}\n\n${NEXT.text}`]);
  });
});

describe("a pick on a chat with no agent process", () => {
  it("starts the agent on the session with no prompt and no message, applies and saves the pick, and waits", async () => {
    const { runner, live, log, root, processes } = await stopped();

    await expect(runner.setOption(live, PICK)).resolves.toEqual([]);

    expect(processes[1]?.resumes).toEqual([{ sessionId: SESSION, cwd: processes[0]?.folder, mcpServers: [] }]);
    expect(processes[1]?.prompts).toEqual([]);
    expect(await logOf(live)).toEqual([
      ...log,
      optionsUpdate(OPTIONS),
      modeUpdate("acceptEdits"),
      optionsUpdate([modeOption("acceptEdits"), modelOption()]),
    ]);
    expect(live.chat).toMatchObject({ state: "needs-you", options: { mode: "acceptEdits" } });
    expect(await storedDefaults(root)).toEqual({ claude: { mode: "acceptEdits" } });
    expect(runner.running(live)?.session).toBeDefined();

    await runner.message(live, NEXT);
    await logUntil(live, "turn-end");
    expect(processes[1]?.prompts.map(promptText)).toEqual([NEXT.text]);
    expect(processes).toHaveLength(2);
  });

  it("takes a message while it starts the agent, refuses a second one, and sends the first after the pick", async () => {
    const { runner, live, log, resume, seen, picked } = await pickInResume();

    await runner.message(live, NEXT);
    expect(await logOf(live)).toEqual([...log, NEXT_USER]);
    await expect(runner.message(live, LATER)).rejects.toMatchObject({
      code: "turn-running",
      message: "a turn of chat 1 of ALPHA-1 is running",
    });
    resume.open();

    await expect(picked).resolves.toEqual([]);
    expect((await logUntil(live, "turn-end")).slice(log.length)).toEqual([
      NEXT_USER,
      optionsUpdate(OPTIONS),
      modeUpdate("acceptEdits"),
      optionsUpdate([modeOption("acceptEdits"), modelOption()]),
      TURN_END,
    ]);
    expect(seen).toEqual([`prompt ${START.text}`, "mode=acceptEdits", `prompt ${NEXT.text}`]);
  });

  it("sends the prompt of a message after a pick that came before the message", async () => {
    const { runner, live, resume, seen, picked } = await pickInResume();
    const second = runner.setOption(live, { ...PICK, value: "auto" });

    await runner.message(live, NEXT);
    resume.open();

    await expect(picked).resolves.toEqual([]);
    await expect(second).resolves.toEqual([]);
    await logUntil(live, "turn-end");
    expect(seen).toEqual([`prompt ${START.text}`, "mode=acceptEdits", "mode=auto", `prompt ${NEXT.text}`]);
  });

  it("sends no prompt and ends the turn as cancelled at a Stop while the message waits for a pick before it", async () => {
    const auto = holdingAuto();
    const { runner, live, resume, seen } = await pickInResume({ script: { setConfigOption: auto.setConfigOption } });
    const second = runner.setOption(live, { ...PICK, value: "auto" });
    await runner.message(live, NEXT);
    resume.open();
    await until(() => seen.includes("mode=auto"), "the agent got the second pick");

    await runner.cancel(live, { client: "web" });
    auto.open();

    await expect(second).resolves.toEqual([]);
    expect((await logUntil(live, "turn-end")).at(-1)).toEqual({ kind: "turn-end", stopReason: "cancelled" });
    expect(seen).toEqual([`prompt ${START.text}`, "mode=acceptEdits", "mode=auto"]);
  });

  it("writes the user event of a message after the interrupt of the start, and sends the texts of the chat with it", async () => {
    const { script, seen } = recording();
    const { runner, chats, folder } = await world({ script });
    const live = await chats.create("ALPHA", "ALPHA-1", { step: START.step, agent: "claude", folder }, USER_MESSAGE);
    await live.setSession(SESSION);

    const picked = runner.setOption(live, PICK);
    await runner.message(live, NEXT);

    expect(await logOf(live)).toEqual([USER, { kind: "interrupted" }, NEXT_USER]);
    await expect(picked).resolves.toEqual([]);
    await logUntil(live, "turn-end");
    expect(seen).toEqual(["mode=acceptEdits", `prompt ${START.text}\n\n${NEXT.text}`]);
  });

  it("writes the user event of a message that comes during the resumed event after it, and sends one prompt", async () => {
    const { runner, live, log, resumed, seen, picked } = await pickInResumedWrite();

    const sent = runner.message(live, NEXT);
    resumed.open();
    await sent;

    await expect(picked).resolves.toEqual([]);
    expect((await logUntil(live, "turn-end")).slice(log.length)).toEqual([
      optionsUpdate(OPTIONS),
      modeUpdate("acceptEdits"),
      optionsUpdate([modeOption("acceptEdits"), modelOption()]),
      { kind: "resumed" },
      NEXT_USER,
      TURN_END,
    ]);
    expect(seen).toEqual([`prompt ${START.text}`, "mode=acceptEdits", `prompt ${NEXT.text}`]);
  });

  it("writes no resumed event for a message that comes during the apply step of a failed chat", async () => {
    const held = gate();
    const { script, seen } = recording({
      async setConfigOption(params, fake) {
        await held.opened;
        return actAsAdapter(params, fake);
      },
    });
    const { runner, live, log } = await failed({ script });
    const picked = runner.setOption(live, PICK);
    await until(() => seen.includes("mode=acceptEdits"), "the agent got the pick");

    await runner.message(live, NEXT);
    held.open();

    await expect(picked).resolves.toEqual([]);
    expect((await logUntil(live, "turn-end")).slice(log.length)).toEqual([
      optionsUpdate(OPTIONS),
      NEXT_USER,
      modeUpdate("acceptEdits"),
      optionsUpdate([modeOption("acceptEdits"), modelOption()]),
      TURN_END,
    ]);
    expect(live.chat.state).toBe("needs-you");
    expect(seen).toEqual([`prompt ${START.text}`, "mode=acceptEdits", `prompt ${NEXT.text}`]);
  });

  it("refuses a message during a turn that starts after a start with no message", async () => {
    const turns = heldTurns();
    const { runner, processes } = await world({ script: { ...turns.script, configOptions: OPTIONS } });
    const live = await runner.start(START);
    await until(() => processes[0]?.prompts.length === 1, "the agent got the first prompt");
    turns.finish();
    await logUntil(live, "turn-end");
    await runner.stop(live);
    await runner.setOption(live, PICK);

    await runner.message(live, NEXT);

    await expect(runner.message(live, LATER)).rejects.toMatchObject({ code: "turn-running" });
    await until(() => processes[1]?.prompts.length === 1, "the agent got the prompt of the message");
    turns.finish();
    await logUntil(live, "turn-end");
  });

  it("sends one prompt with every text of the chat for a lost session that never answered", async () => {
    const { script, seen } = recording({ resume: () => Promise.reject(RequestError.resourceNotFound(SESSION)) });
    const { runner, chats, folder } = await world({ script });
    const live = await chats.create("ALPHA", "ALPHA-1", { step: START.step, agent: "claude", folder }, USER_MESSAGE);
    await live.setSession("session-0");

    const picked = runner.setOption(live, PICK);
    await runner.message(live, NEXT);

    await expect(picked).resolves.toEqual([]);
    await logUntil(live, "turn-end");
    expect(live.chat.session).toBe(SESSION);
    expect(seen).toEqual(["mode=acceptEdits", `prompt ${START.text}\n\n${NEXT.text}`]);
  });

  it("sends the texts that the last process did not get before the text of a message that joins the start", async () => {
    const { runner, live, processes } = await failedBeforeNext();

    const picked = runner.setOption(live, PICK);
    await runner.message(live, LATER);

    await expect(picked).resolves.toEqual([]);
    await logUntil(live, "turn-end");
    expect(processes[2]?.prompts.map(promptText)).toEqual([`${NEXT.text}\n\n${LATER.text}`]);
  });

  it("sends no prompt and ends the turn as cancelled at a Stop after a message joins the start", async () => {
    const { runner, live, log, processes, resume, picked } = await pickInResume();
    await runner.message(live, NEXT);

    await runner.cancel(live, { client: "web" });
    resume.open();

    await expect(picked).resolves.toEqual([]);
    expect((await logUntil(live, "turn-end")).slice(log.length).at(-1)).toEqual({ kind: "turn-end", stopReason: "cancelled" });
    expect(processes[1]?.prompts).toEqual([]);
    expect(processes[1]?.cancels).toEqual([]);
    await runner.message(live, LATER);
    await until(() => processes[1]?.prompts.length === 1, "the agent got the next prompt");
    expect(processes[1]?.prompts.map(promptText)).toEqual([LATER.text]);
  });

  it("sends the prompt of a message after a Stop during the resume, which comes before the message", async () => {
    const { runner, live, processes, resume, picked } = await pickInResume();

    await runner.cancel(live, { client: "web" });
    const sent = runner.message(live, NEXT);
    resume.open();
    await sent;

    await expect(picked).resolves.toEqual([]);
    expect((await logUntil(live, "turn-end")).at(-1)).toEqual(TURN_END);
    expect(processes[1]?.cancels).toEqual([]);
    expect(processes[1]?.prompts.map(promptText)).toEqual([NEXT.text]);
  });

  it("sends the prompt of a message after a Stop during the write of resumed, which comes before the message", async () => {
    const { runner, live, processes, resumed, picked } = await pickInResumedWrite();

    await runner.cancel(live, { client: "web" });
    const sent = runner.message(live, NEXT);
    resumed.open();
    await sent;

    await expect(picked).resolves.toEqual([]);
    expect((await logUntil(live, "turn-end")).at(-1)).toEqual(TURN_END);
    expect(processes[1]?.cancels).toEqual([]);
    expect(processes[1]?.prompts.map(promptText)).toEqual([NEXT.text]);
  });

  it("takes a message and fails the chat with the reason when the agent refuses the resume after the user event", async () => {
    const { runner, live, log } = await stopped({
      script: { configOptions: OPTIONS, resume: () => Promise.reject(RequestError.authRequired()) },
    });

    const picked = runner.setOption(live, PICK);
    await runner.message(live, NEXT);

    await expect(picked).rejects.toMatchObject({
      code: "chat-not-running",
      message: "chat 1 of ALPHA-1 has no agent process: Log in to the agent first",
    });
    expect((await logUntil(live, "failed")).slice(log.length)).toEqual([NEXT_USER, { kind: "failed", reason: "Log in to the agent first" }]);
  });

  it("handles a message again as a new message when the start ends before its user event", async () => {
    const { adapter } = fakeAdapter();
    const { runner, chats, folder } = await world({ adapter: { ...adapter, agent: "codex" } });
    const live = await chats.create("ALPHA", "ALPHA-1", { step: START.step, agent: "claude", folder }, USER_MESSAGE);
    const reason = "Tasma cannot run claude yet";

    const picked = runner.setOption(live, PICK);
    await runner.message(live, NEXT);

    await expect(picked).rejects.toMatchObject({ code: "chat-not-running", message: `chat 1 of ALPHA-1 has no agent process: ${reason}` });
    expect(await logUntil(live, "failed")).toEqual([
      USER,
      { kind: "interrupted" },
      { kind: "failed", reason },
      NEXT_USER,
      { kind: "failed", reason },
    ]);
  });

  it("refuses a message that joins the start with chat-not-running when the daemon stop begins in its step", async () => {
    const { runner, live, log, processes, resume, picked } = await pickInResume();

    const sent = runner.message(live, NEXT);
    runner.stopStarts();

    await expect(sent).rejects.toMatchObject(STOPPING);
    await expect(picked).rejects.toMatchObject(STOPPING);
    resume.open();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await logOf(live)).toEqual(log);
    expect(processes[1]?.prompts).toEqual([]);
  });

  it("sends no prompt of a message that joined the start when the daemon stop refuses a pick before the message", async () => {
    const { runner, live, log, resume, seen, picked } = await pickInResume();
    const second = runner.setOption(live, { ...PICK, value: "auto" });
    await runner.message(live, NEXT);

    runner.stopStarts();
    resume.open();

    await expect(picked).resolves.toEqual([]);
    await expect(second).rejects.toMatchObject(STOPPING);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toEqual([`prompt ${START.text}`, "mode=acceptEdits"]);
    await runner.close();
    expect((await logOf(live)).slice(log.length)).toEqual([
      NEXT_USER,
      optionsUpdate(OPTIONS),
      modeUpdate("acceptEdits"),
      optionsUpdate([modeOption("acceptEdits"), modelOption()]),
      { kind: "interrupted" },
    ]);
  });

  it("rejects a message with the fault of the write of its user event, halts the run, and sends no prompt", async () => {
    const { runner, live, processes, errors, resumed, picked } = await pickInResumedWrite();
    const spy = vi.spyOn(live, "append");
    const append = spy.getMockImplementation()!;
    spy.mockImplementation((event) => (event.kind === "user" ? Promise.reject(new Error("the disk is full")) : append(event)));

    await expect(runner.message(live, NEXT)).rejects.toThrow("the disk is full");
    resumed.open();

    await expect(picked).resolves.toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await logOf(live)).at(-1)).toEqual({ kind: "resumed" });
    expect(processes[1]?.prompts).toEqual([]);
    expect(runner.running(live)).toBeUndefined();
    expect(errors).toEqual(["tasma-daemon: chat 1 of ALPHA-1: the disk is full\n"]);
  });

  it("sends the prompt in the mode of the chat when the agent refuses the kept pick", async () => {
    const { script, seen } = recording({ setConfigOption: refusing("mode") });
    const { runner, live } = await stopped({ script });

    const picked = runner.setOption(live, { ...PICK, value: "auto" });
    await runner.message(live, NEXT);

    await expect(picked).rejects.toMatchObject({ code: "option-refused" });
    await logUntil(live, "turn-end");
    expect(seen).toEqual([`prompt ${START.text}`, "mode=auto", `prompt ${NEXT.text}`]);
  });

  it("sends the texts that the last process did not get with the next message", async () => {
    const { runner, live, processes } = await failedBeforeNext();

    await runner.setOption(live, PICK);
    await runner.message(live, LATER);
    await logUntil(live, "turn-end");

    expect(processes[2]?.prompts.map(promptText)).toEqual([`${NEXT.text}\n\n${LATER.text}`]);
  });

  for (const answer of ["takes", "refuses"] as const) {
    it(`takes a failed chat out of its stop when the agent ${answer} the pick`, async () => {
      const { runner, processes, feed } = await world({
        script: { configOptions: OPTIONS, setConfigOption: answer === "takes" ? actAsAdapter : refusing("mode") },
      });
      const live = await runner.start(START);
      await logUntil(live, "turn-end");
      processes[0]?.exit({ code: 137, signal: null });
      await logUntil(live, "failed");

      const picked = runner.setOption(live, PICK);

      if (answer === "takes") await expect(picked).resolves.toEqual([]);
      else await expect(picked).rejects.toMatchObject({ code: "option-refused" });
      expect((await logOf(live)).at(-1)).toEqual({ kind: "resumed" });
      expect(live.chat.state).toBe("needs-you");
      expect(feed.flatMap((event) => (event.kind === "chat" ? [event.state] : [])).slice(-2)).toEqual(["failed", "needs-you"]);
    });
  }

  it("opens a new session for a lost session that never answered, sends no prompt, and keeps its texts", async () => {
    const setup = await world({
      script: { configOptions: OPTIONS, resume: () => Promise.reject(RequestError.resourceNotFound(SESSION)) },
    });
    const live = await setup.chats.create("ALPHA", "ALPHA-1", { step: START.step, agent: "claude", folder: setup.folder }, USER_MESSAGE);
    await live.setSession("session-0");

    await setup.runner.setOption(live, PICK);

    expect(setup.processes[0]?.prompts).toEqual([]);
    expect(live.chat.session).toBe(SESSION);
    await setup.runner.message(live, NEXT);
    await logUntil(live, "turn-end");
    expect(setup.processes[0]?.prompts.map(promptText)).toEqual([`${START.text}\n\n${NEXT.text}`]);
  });

  it("refuses the pick with the reason, and fails the chat, when the agent cannot start", async () => {
    const { runner, live } = await stopped({
      script: { configOptions: OPTIONS, resume: () => Promise.reject(RequestError.resourceNotFound(SESSION)) },
    });

    await expect(runner.setOption(live, PICK)).rejects.toMatchObject({
      code: "chat-not-running",
      message: "chat 1 of ALPHA-1 has no agent process: The agent lost the chat",
    });
    expect((await logUntil(live, "failed")).at(-1)).toEqual({ kind: "failed", reason: "The agent lost the chat" });
  });

  for (const how of ["stopStarts", "close"] as const) {
    it(`refuses the pick with chat-not-running when ${how} overtakes the wait for the last process`, async () => {
      const { runner, live, log, processes } = await endingSlowly();

      const picked = runner.setOption(live, PICK);
      if (how === "stopStarts") runner.stopStarts();
      else await runner.close();

      await expect(picked).rejects.toMatchObject(STOPPING);
      expect(await logOf(live)).toEqual(log);
      expect(processes).toHaveLength(1);
    });

    it(`refuses a message that joins the start with chat-not-running when ${how} overtakes the wait for the last process`, async () => {
      const { runner, live, log, processes } = await endingSlowly();
      const picked = runner.setOption(live, PICK);
      const refused = expect(runner.message(live, NEXT)).rejects.toMatchObject(STOPPING);

      if (how === "stopStarts") runner.stopStarts();
      else await runner.close();

      await refused;
      await expect(picked).rejects.toMatchObject(STOPPING);
      expect(await logOf(live)).toEqual(log);
      expect(processes).toHaveLength(1);
    });
  }

  it("refuses the pick with chat-not-running when the daemon stop begins during the launch", async () => {
    const held = gate();
    let reads = 0;
    const { runner, live, processes } = await stopped({
      script: { configOptions: OPTIONS },
      async idleLimit() {
        reads += 1;
        if (reads > 1) await held.opened;
        return 60_000;
      },
    });

    const picked = runner.setOption(live, PICK);
    await until(() => reads === 2, "the relaunch reads its limit");
    runner.stopStarts();
    held.open();

    await expect(picked).rejects.toMatchObject(STOPPING);
    expect(processes).toHaveLength(1);
  });

  it("refuses the pick with chat-not-running when the log of the chat is gone", async () => {
    const { runner, live, processes } = await stopped();
    vi.spyOn(live, "interrupt").mockRejectedValue(new TaskStoreError("chat-not-found", "this chat is no longer here"));

    await expect(runner.setOption(live, PICK)).rejects.toMatchObject({ code: "chat-not-running" });
    expect(processes).toHaveLength(1);
  });

  it("refuses the pick with chat-not-running when the daemon closes while the session opens", async () => {
    const held = gate();
    const { runner, live } = await stopped({
      script: {
        configOptions: OPTIONS,
        async resume(_params, fake) {
          await held.opened;
          return { configOptions: fake.configOptions };
        },
      },
    });

    const picked = runner.setOption(live, PICK);
    await until(() => runner.running(live)?.process !== undefined, "the agent started");
    const closed = runner.close();
    held.open();

    await expect(picked).rejects.toMatchObject(STOPPING);
    await closed;
  });
});

describe("a pick and the end of a chat for a restart", () => {
  it("is refused while the end runs", async () => {
    const { runner, processes } = await world({ script: { configOptions: OPTIONS }, started: slowEnd(100) });
    const live = await runner.start(START);
    await logUntil(live, "turn-end");

    const end = runner.end(live, { client: "web" });

    await expect(runner.setOption(live, PICK)).rejects.toMatchObject({
      code: "turn-running",
      message: "chat 1 of ALPHA-1 is ending for a restart",
    });
    await end;
    expect(processes).toHaveLength(1);
  });

  it("refuses the kept pick of a relaunch with chat-not-running, writes nothing, and ends the process", async () => {
    const held = gate();
    const { runner, live, log, processes } = await stopped({
      script: {
        configOptions: OPTIONS,
        async resume(_params, fake) {
          await held.opened;
          return { configOptions: fake.configOptions };
        },
      },
      endGraceMs: 60_000,
    });
    const picked = runner.setOption(live, PICK);
    await until(() => processes[1]?.resumes.length === 1, "the relaunch resumes the session");

    await runner.end(live, { client: "web" });
    held.open();

    await expect(picked).rejects.toMatchObject({ code: "chat-not-running" });
    expect(await logOf(live)).toEqual(log);
    expect(processes[1]?.endCalls).toBeGreaterThan(0);
    expect(runner.running(live)).toBeUndefined();
  });

  it("interrupts the turn of a message that joined a relaunch, sends no prompt, and ends the process", async () => {
    const { runner, live, log, processes, resume, picked } = await pickInResume({ endGraceMs: 60_000 });
    await runner.message(live, NEXT);

    await runner.end(live, { client: "web" });
    resume.open();

    await expect(picked).rejects.toMatchObject({ code: "chat-not-running" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await logOf(live)).slice(log.length)).toEqual([NEXT_USER, { kind: "interrupted" }]);
    expect(processes[1]?.prompts).toEqual([]);
    expect(processes[1]?.cancels).toEqual([]);
    expect(processes[1]?.endCalls).toBeGreaterThan(0);
    expect(runner.running(live)).toBeUndefined();
  });

  it("interrupts the turn of a message that joined a relaunch while it waits for a pick before it, with no prompt", async () => {
    const auto = holdingAuto();
    const { runner, live, log, processes, resume, seen, picked } = await pickInResume({
      script: { setConfigOption: auto.setConfigOption },
      endGraceMs: 60_000,
    });
    const second = runner.setOption(live, { ...PICK, value: "auto" });
    await runner.message(live, NEXT);
    resume.open();
    await until(() => seen.includes("mode=auto"), "the agent got the second pick");

    await runner.end(live, { client: "web" });

    await expect(picked).resolves.toEqual([]);
    await expect(second).rejects.toMatchObject({ code: "chat-not-running" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await logOf(live)).slice(log.length).at(-1)).toEqual({ kind: "interrupted" });
    expect(seen).toEqual([`prompt ${START.text}`, "mode=acceptEdits", "mode=auto"]);
    expect(processes[1]?.cancels).toEqual([]);
    expect(processes[1]?.endCalls).toBeGreaterThan(0);
    expect(runner.running(live)).toBeUndefined();
  });

  it("interrupts the turn of a message that joined a relaunch during its resumed event, with no cancel and no prompt", async () => {
    const { runner, live, log, processes, resumed, picked } = await pickInResumedWrite({ endGraceMs: 60_000 });
    const sent = runner.message(live, NEXT);
    await until(() => resumed.asked("user"), "the message writes its user event");

    const end = runner.end(live, { client: "web" });
    resumed.open();
    await end;

    await sent;
    await expect(picked).resolves.toEqual([]);
    expect((await logOf(live)).slice(log.length)).toEqual([
      optionsUpdate(OPTIONS),
      modeUpdate("acceptEdits"),
      optionsUpdate([modeOption("acceptEdits"), modelOption()]),
      { kind: "resumed" },
      NEXT_USER,
      { kind: "interrupted" },
    ]);
    expect(processes[1]?.cancels).toEqual([]);
    expect(processes[1]?.prompts).toEqual([]);
    expect(processes[1]?.endCalls).toBeGreaterThan(0);
    expect(runner.running(live)).toBeUndefined();
  });

  it("refuses a message that joined a relaunch when the end comes during the wait for the last process", async () => {
    const { runner, live, log, processes } = await endingSlowly({ endGraceMs: 60_000 });
    const picked = runner.setOption(live, PICK);
    const refused = expect(runner.message(live, NEXT)).rejects.toMatchObject({
      code: "turn-running",
      message: "chat 1 of ALPHA-1 is ending for a restart",
    });

    await runner.end(live, { client: "web" });

    await refused;
    await expect(picked).rejects.toMatchObject({ code: "chat-not-running" });
    expect(await logOf(live)).toEqual(log);
    expect(processes).toHaveLength(1);
  });

  it("waits for a relaunch of a failed chat that writes its resumed event, and then ends the process", async () => {
    const { runner, processes } = await world({ script: { configOptions: OPTIONS }, endGraceMs: 60_000 });
    const live = await runner.start(START);
    await logUntil(live, "turn-end");
    processes[0]?.exit({ code: 137, signal: null });
    await logUntil(live, "failed");
    const held = gate();
    let resuming = false;
    const append = live.append.bind(live);
    vi.spyOn(live, "append").mockImplementation(async (event) => {
      if (event.kind === "resumed") {
        resuming = true;
        await held.opened;
      }
      return append(event);
    });
    const picked = runner.setOption(live, PICK);
    await until(() => resuming, "the relaunch writes resumed");

    const end = runner.end(live, { client: "web" });
    held.open();
    await end;

    await expect(picked).resolves.toEqual([]);
    expect(processes[1]?.cancels).toHaveLength(1);
    expect((await logOf(live)).at(-1)).toEqual({ kind: "resumed" });
    expect(processes[1]?.endCalls).toBeGreaterThan(0);
    expect(runner.running(live)).toBeUndefined();
  });
});
