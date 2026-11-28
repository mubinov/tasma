import type { ChatAgent } from "@tasma/protocol";
import { chatAgentName } from "./chat-messages";

/** A command of a setup step, with the line above it. */
export type AgentCommand = { intro: string; command: string };

export type AgentTexts = {
  /** The name of a row and of the title of the dialog. */
  name: string;
  /** The CLI that the install step names. */
  cli: string;
  /** What the user logs in to, and what gets the skill. */
  account: string;
  /** The commands of the install step, above the link to the guide. */
  installCommands: readonly AgentCommand[];
  guide: { url: string; words: string };
  loginCommand: string;
  /** Where the user runs the plugin commands. */
  pluginPlace: string;
  pluginCommands: readonly [string, string];
};

type OwnTexts = Omit<AgentTexts, "name">;

const TEXTS: Record<ChatAgent, OwnTexts> = {
  claude: {
    cli: "Claude Code CLI",
    account: "Claude Code",
    installCommands: [],
    guide: { url: "https://code.claude.com/docs/en/setup", words: "Open the Claude Code CLI install guide" },
    loginCommand: "claude auth login",
    pluginPlace: "in Claude Code",
    pluginCommands: ["/plugin marketplace add mubinov/tasma-skill", "/plugin install tasma@tasma"],
  },
  codex: {
    cli: "Codex CLI",
    account: "Codex",
    installCommands: [
      { intro: "Run this command in a terminal:", command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh" },
      { intro: "Or with Homebrew:", command: "brew install --cask codex" },
    ],
    guide: { url: "https://learn.chatgpt.com/docs/codex/cli", words: "Open the Codex CLI install guide" },
    loginCommand: "codex login",
    pluginPlace: "in a terminal",
    pluginCommands: ["codex plugin marketplace add mubinov/tasma-skill", "codex plugin add tasma@tasma"],
  },
};

export function agentTexts(agent: ChatAgent): AgentTexts {
  return { name: chatAgentName(agent), ...TEXTS[agent] };
}

const NAME_LIST = new Intl.ListFormat("en", { type: "conjunction" });

/** "Claude", "Claude and Codex". */
export function agentNames(agents: readonly ChatAgent[]): string {
  return NAME_LIST.format(agents.map(chatAgentName));
}

/** The texts of a skill step. */
export type SkillTexts = {
  line: string;
  button: string;
  /** The first sentence of the warning, which describes the install button. */
  warning: string;
  /** The rest of the warning, which also describes the stop button. */
  stopNote: string;
  /** The line of the step after the check stopped. */
  stopped: string;
};

const WARNING_START = "If the skill is already in a different folder, Tasma cannot find it, and a second install makes";

/** The skill step of the screen, which installs for each ready agent. */
export function screenSkillTexts(agents: readonly ChatAgent[]): SkillTexts {
  return {
    line: `The skill lets ${agentNames(agents)} run workflow steps.`,
    button: "Install the skill",
    warning: `${WARNING_START} the agent load two copies.`,
    stopNote: "In that case, stop the check. Tasma then does not check for the skill again, also after a restart.",
    stopped: "Tasma does not check for the skill now. A coding agent needs the skill to run workflow steps.",
  };
}

/** The skill step of the dialog of one agent. */
export function agentSkillTexts(agent: ChatAgent): SkillTexts {
  const name = chatAgentName(agent);

  return {
    line: `${name} needs this skill to run workflow steps.`,
    button: `Install in ${TEXTS[agent].account}`,
    warning: `${WARNING_START} ${name} load two copies.`,
    stopNote: "In that case, stop the check. Tasma then does not check for the skill again for any agent, also after a restart.",
    stopped: `Tasma does not check for the skill now. ${name} needs the skill to run workflow steps.`,
  };
}
