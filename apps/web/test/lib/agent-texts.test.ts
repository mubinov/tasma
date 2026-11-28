import { describe, expect, it } from "vitest";
import { agentNames, agentSkillTexts, agentTexts, screenSkillTexts } from "../../src/lib/agent-texts";

describe("agentTexts", () => {
  it("names Claude, its CLI and its account", () => {
    expect(agentTexts("claude")).toMatchObject({ name: "Claude", cli: "Claude Code CLI", account: "Claude Code", loginCommand: "claude auth login" });
  });

  it("names Codex, its CLI and its account", () => {
    expect(agentTexts("codex")).toMatchObject({ name: "Codex", cli: "Codex CLI", account: "Codex", loginCommand: "codex login" });
  });
});

describe("the texts of a skill step", () => {
  it("name the ready agents on the screen", () => {
    expect(screenSkillTexts(["claude", "codex"])).toMatchObject({
      line: "The skill lets Claude and Codex run workflow steps.",
      button: "Install the skill",
      warning: "If the skill is already in a different folder, Tasma cannot find it, and a second install makes the agent load two copies.",
      stopped: "Tasma does not check for the skill now. A coding agent needs the skill to run workflow steps.",
    });
  });

  it("name the agent of a dialog, and say that a stop is for every agent", () => {
    expect(agentSkillTexts("codex")).toEqual({
      line: "Codex needs this skill to run workflow steps.",
      button: "Install in Codex",
      warning: "If the skill is already in a different folder, Tasma cannot find it, and a second install makes Codex load two copies.",
      stopNote: "In that case, stop the check. Tasma then does not check for the skill again for any agent, also after a restart.",
      stopped: "Tasma does not check for the skill now. Codex needs the skill to run workflow steps.",
    });
    expect(agentSkillTexts("claude").button).toBe("Install in Claude Code");
  });
});

describe("agentNames", () => {
  it("joins the names of the agents", () => {
    expect(agentNames(["codex"])).toBe("Codex");
    expect(agentNames(["claude", "codex"])).toBe("Claude and Codex");
  });
});
