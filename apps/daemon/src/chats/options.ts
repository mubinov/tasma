// The config options of the session of a chat: the rules of each agent, the
// values that a session gets as it opens and their order, the fold of the
// updates of the agent, and the files that keep a pick and the options of a
// new session.

import type { SessionConfigOption, SessionUpdate } from "@agentclientprotocol/sdk";
import { chatRecordPath, projectChatRecordPath } from "@tasma/engine";
import type { AgentDefaultsRead, AgentDefaultsStore, AgentOptionsStore } from "@tasma/engine";
import { AGENT_OPTION_RULES, DAEMON_NAME, printable } from "@tasma/protocol";
import type { AcpObject, ChatAgent, ChatEvent, Diagnostic } from "@tasma/protocol";
import type { Publish } from "../events/feed.js";
import { causeOf } from "../http/failure.js";
import { isProjectChat } from "./registry.js";
import type { AnyLiveChat } from "./registry.js";

type OptionValues = Readonly<Record<string, readonly string[]>>;

/** `configId` comes from a client, so a name of an `Object.prototype` member must find nothing. */
function listed(values: OptionValues, configId: string, value: string): boolean {
  return Object.hasOwn(values, configId) && values[configId]!.includes(value);
}

export function isHidden(agent: ChatAgent, configId: string, value: string): boolean {
  return listed(AGENT_OPTION_RULES[agent].hidden, configId, value);
}

function isUnsaved(agent: ChatAgent, configId: string, value: string): boolean {
  return listed(AGENT_OPTION_RULES[agent].unsaved, configId, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The values of a list of select entries. A stored list holds any JSON, so a part of another shape offers nothing. */
function valuesOf(entries: unknown): unknown[] {
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    if (!("group" in entry)) return [entry.value];
    return Array.isArray(entry.options) ? entry.options.filter(isRecord).map((one) => one.value) : [];
  });
}

/**
 * The option `configId` when it is a select that offers `value`. The options
 * are typed as any JSON object, as a stored list can hold one of any shape.
 */
export function offering<O extends AcpObject>(options: readonly O[], configId: string, value: string): O | undefined {
  const option = options.find((one) => one.id === configId);
  if (option?.type !== "select") return undefined;
  return valuesOf(option.options).includes(value) ? option : undefined;
}

/** Whether a default or a pick of the chat goes to the session: it is offered, not hidden, and not current. */
export function wanted(agent: ChatAgent, options: readonly AcpObject[], configId: string, value: string): boolean {
  const option = offering(options, configId, value);
  return option !== undefined && !isHidden(agent, configId, value) && option.currentValue !== value;
}

/** The options after one update of the agent. A mode change of the agent comes as `current_mode_update` alone. */
export function foldOptions(options: SessionConfigOption[], update: AcpObject): SessionConfigOption[] {
  const typed = update as SessionUpdate;
  switch (typed.sessionUpdate) {
    case "config_option_update":
      return typed.configOptions;
    case "current_mode_update":
      return options.map((option) =>
        option.category === "mode" && option.type === "select" ? { ...option, currentValue: typed.currentModeId } : option);
    default:
      return options;
  }
}

/** A list of the options as the log keeps it: in the shape of the agent's own `config_option_update`. */
export function optionsEvent(configOptions: SessionConfigOption[]): ChatEvent {
  return { kind: "update", update: { sessionUpdate: "config_option_update", configOptions } };
}

/** The options of the agent with category `model` go first: a change of the model rebuilds the other options. */
function applyOrder(options: SessionConfigOption[], configId: string): number {
  const index = options.findIndex((option) => option.id === configId);
  if (index === -1) return Number.MAX_SAFE_INTEGER;
  return options[index]!.category === "model" ? -1 : index;
}

type Pick = { configId: string; value: string };

/** One value for a session that opens. `pick` is the waiting pick that asks for it. */
export type PlannedValue<P extends Pick> = Pick & { pick?: P };

/**
 * The values for a session that just opened, in the order to send them. Of the
 * defaults, the picks of the chat and the waiting picks, a later one replaces
 * an earlier one of the same option. Two waiting picks of one option both stay,
 * in arrival order.
 */
export function applyPlan<P extends Pick>(
  options: SessionConfigOption[],
  values: { defaults: Record<string, string>; chosen: Record<string, string>; waiting: readonly P[] },
): PlannedValue<P>[] {
  const merged = new Map([...Object.entries(values.defaults), ...Object.entries(values.chosen)]);
  for (const pick of values.waiting) merged.delete(pick.configId);
  const plan: PlannedValue<P>[] = [
    ...values.waiting.map((pick) => ({ configId: pick.configId, value: pick.value, pick })),
    ...[...merged].map(([configId, value]) => ({ configId, value })),
  ];
  return plan.sort((one, other) => applyOrder(options, one.configId) - applyOrder(options, other.configId));
}

/**
 * The defaults of the agent for a new session that opened with `options`, from
 * a read of the defaults file. A saved value that the rules leave unsaved goes
 * to `ignored`. A session of claude that opened in the mode `default` gets the
 * start mode `auto` while the read has no fault and holds no mode of claude,
 * unsaved values included; nothing writes the start mode to a file.
 */
export function startDefaults(
  agent: ChatAgent,
  options: readonly AcpObject[],
  read: AgentDefaultsRead,
): { defaults: Record<string, string>; ignored: Pick[] } {
  const saved = read.defaults[agent] ?? {};
  const defaults: Record<string, string> = {};
  const ignored: Pick[] = [];
  for (const [configId, value] of Object.entries(saved)) {
    if (isUnsaved(agent, configId, value)) {
      ignored.push({ configId, value });
    } else {
      defaults[configId] = value;
    }
  }
  const manual = options.find((option) => option.id === "mode")?.currentValue === "default";
  if (agent === "claude" && manual && read.diagnostics.length === 0 && !Object.hasOwn(saved, "mode")) {
    defaults.mode = "auto";
  }
  return { defaults, ignored };
}

/** `options` with the current value of each option set to its default, where `wanted` takes the default. */
export function startOptions<O extends AcpObject>(
  agent: ChatAgent,
  options: readonly O[],
  defaults: Record<string, string>,
): O[] {
  const taken = Object.entries(defaults).filter(([configId, value]) => wanted(agent, options, configId, value));
  const start = new Map<unknown, string>(taken);
  return options.map((option) => {
    const value = start.get(option.id);
    return value === undefined || option.type !== "select" ? option : { ...option, currentValue: value };
  });
}

export type OptionFiles = {
  /**
   * `startDefaults` over the defaults file. A file that cannot be used, and
   * each ignored value, give a line on stderr.
   */
  defaultsOf(agent: ChatAgent, options: SessionConfigOption[]): Promise<Record<string, string>>;
  /**
   * Stores the options that a new session of the agent opened with, and
   * publishes `agent-options`. A failed write gives a line on stderr and
   * publishes nothing. Resolves whether the write is done. Never rejects.
   */
  keep(agent: ChatAgent, options: SessionConfigOption[]): Promise<boolean>;
  /**
   * Writes an accepted pick to the chat, and to the defaults of the agent
   * unless the rules leave it unsaved. Gives a diagnostic for each file that a
   * write missed. A written default publishes `agent-options`.
   */
  save(live: AnyLiveChat, configId: string, value: string): Promise<Diagnostic[]>;
};

export function optionFiles(options: {
  root?: string;
  defaults: AgentDefaultsStore;
  agentOptions: AgentOptionsStore;
  stderr: { write(text: string): unknown };
  publish?: Publish;
}): OptionFiles {
  const { root, defaults, agentOptions, stderr, publish } = options;

  function fileLine(path: string, message: string): void {
    stderr.write(`${DAEMON_NAME}: ${printable(`${path}: ${message}`)}\n`);
  }

  function recordPathOf(live: AnyLiveChat): string {
    const options = { project: live.tag, root };
    if (isProjectChat(live)) return projectChatRecordPath(options, live.chat.chat);
    return chatRecordPath(options, live.chat.task, live.chat.chat);
  }

  function notSaved(configId: string, value: string, where: string, path: string, error: unknown): Diagnostic {
    return {
      code: "option-not-saved",
      message: `the value "${value}" of "${configId}" is not saved ${where}: ${causeOf(error)}`,
      path,
    };
  }

  return {
    async defaultsOf(agent, options) {
      const read = await defaults.read();
      for (const diagnostic of read.diagnostics) fileLine(defaults.path, diagnostic.message);
      const { defaults: own, ignored } = startDefaults(agent, options, read);
      for (const { configId, value } of ignored) {
        fileLine(defaults.path, `"${value}" of "${configId}" of ${agent} is not applied: this value is never a default`);
      }
      return own;
    },

    async keep(agent, options) {
      try {
        await agentOptions.save(agent, options);
      } catch (error) {
        fileLine(agentOptions.path, `the options of ${agent} are not saved: ${causeOf(error)}`);
        return false;
      }
      publish?.({ kind: "agent-options", agent });
      return true;
    },

    async save(live, configId, value) {
      const { agent } = live.chat;
      const diagnostics: Diagnostic[] = [];
      try {
        await live.setOptions({ ...live.chat.options, [configId]: value });
      } catch (error) {
        diagnostics.push(notSaved(configId, value, "in this chat", recordPathOf(live), error));
      }
      if (isUnsaved(agent, configId, value)) return diagnostics;
      try {
        await defaults.save(agent, configId, value);
      } catch (error) {
        diagnostics.push(notSaved(configId, value, `as the default of ${agent}`, defaults.path, error));
        return diagnostics;
      }
      publish?.({ kind: "agent-options", agent });
      return diagnostics;
    },
  };
}
