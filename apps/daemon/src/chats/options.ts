// The config options of the session of a chat: the rules of each agent, the
// values that a session gets as it opens and their order, the fold of the
// updates of the agent, and the files that keep a pick.

import type {
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
  SessionUpdate,
} from "@agentclientprotocol/sdk";
import { chatRecordPath } from "@tasma/engine";
import type { AgentDefaultsStore } from "@tasma/engine";
import { AGENT_OPTION_RULES, DAEMON_NAME, printable } from "@tasma/protocol";
import type { AcpObject, ChatAgent, ChatEvent, Diagnostic } from "@tasma/protocol";
import { causeOf } from "../http/failure.js";
import type { LiveChat } from "./registry.js";

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

/** The option `configId` when it is a select that offers `value`. */
export function offering(
  options: SessionConfigOption[],
  configId: string,
  value: string,
): SessionConfigOption | undefined {
  const option = options.find((one) => one.id === configId);
  if (option?.type !== "select") return undefined;
  const entries: (SessionConfigSelectOption | SessionConfigSelectGroup)[] = option.options;
  const values = entries.flatMap((entry) => ("group" in entry ? entry.options : [entry]).map((one) => one.value));
  return values.includes(value) ? option : undefined;
}

/** Whether a default or a pick of the chat goes to the session: it is offered, not hidden, and not current. */
export function wanted(agent: ChatAgent, options: SessionConfigOption[], configId: string, value: string): boolean {
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

export type OptionFiles = {
  /**
   * The defaults of the agent for a new session. A file that cannot be used,
   * and a default that the rules leave unsaved, each give a line on stderr.
   */
  defaultsOf(agent: ChatAgent): Promise<Record<string, string>>;
  /**
   * Writes an accepted pick to the chat, and to the defaults of the agent
   * unless the rules leave it unsaved. Gives a diagnostic for each file that a
   * write missed.
   */
  save(live: LiveChat, configId: string, value: string): Promise<Diagnostic[]>;
};

export function optionFiles(options: {
  root?: string;
  defaults: AgentDefaultsStore;
  stderr: { write(text: string): unknown };
}): OptionFiles {
  const { root, defaults, stderr } = options;

  function fileLine(path: string, message: string): void {
    stderr.write(`${DAEMON_NAME}: ${printable(`${path}: ${message}`)}\n`);
  }

  function notSaved(configId: string, value: string, where: string, path: string, error: unknown): Diagnostic {
    return {
      code: "option-not-saved",
      message: `the value "${value}" of "${configId}" is not saved ${where}: ${causeOf(error)}`,
      path,
    };
  }

  return {
    async defaultsOf(agent) {
      const read = await defaults.read();
      for (const diagnostic of read.diagnostics) fileLine(defaults.path, diagnostic.message);
      const own: Record<string, string> = {};
      for (const [configId, value] of Object.entries(read.defaults[agent] ?? {})) {
        if (isUnsaved(agent, configId, value)) {
          fileLine(defaults.path, `"${value}" of "${configId}" of ${agent} is not applied: this value is never a default`);
        } else {
          own[configId] = value;
        }
      }
      return own;
    },

    async save(live, configId, value) {
      const { agent, task, chat } = live.chat;
      const diagnostics: Diagnostic[] = [];
      try {
        await live.setOptions({ ...live.chat.options, [configId]: value });
      } catch (error) {
        diagnostics.push(notSaved(configId, value, "in this chat", chatRecordPath({ project: live.tag, root }, task, chat), error));
      }
      if (isUnsaved(agent, configId, value)) return diagnostics;
      try {
        await defaults.save(agent, configId, value);
      } catch (error) {
        diagnostics.push(notSaved(configId, value, `as the default of ${agent}`, defaults.path, error));
      }
      return diagnostics;
    },
  };
}
