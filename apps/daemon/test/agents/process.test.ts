import { describe, expect, it } from "vitest";
import { childEnv, REMOVED_VARIABLES } from "../../src/agents/process.js";
import { SESSION_ENV } from "../helpers.js";

describe("childEnv", () => {
  it("removes each variable of a Claude Code session, a Codex session and the Claude adapter", () => {
    expect(REMOVED_VARIABLES).toEqual(expect.arrayContaining([
      "CLAUDECODE",
      "CODEX_SANDBOX",
      "CODEX_MANAGED_BY_NPM",
      "CLAUDE_AGENT_LOGS",
      "CLAUDE_AGENT_ACP_EXPERIMENTAL_V2",
    ]));

    expect(childEnv({ ...SESSION_ENV, HOME: "/home/alice" }, ["/usr/bin"])).toEqual({
      HOME: "/home/alice",
      PATH: "/usr/bin",
    });
  });

  it("keeps the configuration of the user and the options of the Codex adapter", () => {
    const user = {
      HOME: "/home/alice",
      CODEX_HOME: "/srv/codex",
      CODEX_API_KEY: "key",
      CODEX_ACCESS_TOKEN: "token",
      CODEX_CA_CERTIFICATE: "/srv/ca.pem",
      CLAUDE_CONFIG_DIR: "/srv/agent",
      ANTHROPIC_MODEL: "opus",
      HTTPS_PROXY: "http://proxy.example:8080",
      MODEL_PROVIDER: "gateway",
      APP_SERVER_LOGS: "/srv/logs",
      CODEX_ACP_PROMPT_SUGGESTIONS: "false",
    };

    expect(childEnv(user, ["/usr/bin", "/bin"])).toEqual({ ...user, PATH: "/usr/bin:/bin" });
  });
});
