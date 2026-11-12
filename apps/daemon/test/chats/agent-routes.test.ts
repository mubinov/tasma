import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { openAgentDefaults, openAgentOptions } from "@tasma/engine";
import type { AgentOptions } from "@tasma/protocol";
import { agentRoutes } from "../../src/chats/agent-routes.js";
import { failure, get, projectsRoot, startTestServer, success } from "../helpers.js";
import type { TestServer } from "../helpers.js";
import { modelOption, modeOption } from "../agents/fake-agent.js";
import { defaultsFile, optionsFile, plantDefaults } from "./runner-world.js";

const WHEN = "2026-03-01T08:00:00.000Z";

const OPENED = [modeOption(), modelOption()];

async function plantOptions(root: string, value: unknown): Promise<void> {
  await writeFile(optionsFile(root), JSON.stringify(value));
}

/** A daemon serving the agent routes over a tree, and the tree. */
async function serving(): Promise<{ root: string; server: TestServer }> {
  const root = await projectsRoot();
  const stores = { options: openAgentOptions(root), defaults: openAgentDefaults(root) };
  const server = await startTestServer(agentRoutes(stores));
  return { root, server };
}

describe("GET /agents/{agent}/options", () => {
  it("answers no options and no time for an agent with no stored list", async () => {
    const { server } = await serving();

    const response = await get(server, "/agents/claude/options");

    expect(response.status).toBe(200);
    await expect(success<AgentOptions>(response)).resolves.toEqual({ data: { agent: "claude", options: [] }, diagnostics: [] });
  });

  it("answers the stored list with the values that a new chat starts with: a saved model, and the start mode auto", async () => {
    const { root, server } = await serving();
    await plantOptions(root, { claude: { options: OPENED, updated: WHEN } });
    await plantDefaults(root, { claude: { model: "large" } });

    const response = await get(server, "/agents/claude/options");

    await expect(success<AgentOptions>(response)).resolves.toEqual({
      data: { agent: "claude", options: [modeOption("auto"), modelOption("large")], updated: WHEN },
      diagnostics: [],
    });
  });

  it("answers the opened values with no start mode, and no diagnostic, for a saved value that is never a default", async () => {
    const { root, server } = await serving();
    await plantOptions(root, { claude: { options: OPENED, updated: WHEN } });
    await plantDefaults(root, { claude: { mode: "plan" } });

    const response = await get(server, "/agents/claude/options");

    await expect(success<AgentOptions>(response)).resolves.toEqual({
      data: { agent: "claude", options: OPENED, updated: WHEN },
      diagnostics: [],
    });
  });

  it("answers no options, with the diagnostic of the file, for a file of options that cannot be used", async () => {
    const { root, server } = await serving();
    await writeFile(optionsFile(root), "{ claude");

    const response = await get(server, "/agents/claude/options");

    expect(response.status).toBe(200);
    const { data, diagnostics } = await success<AgentOptions>(response);
    expect(data).toEqual({ agent: "claude", options: [] });
    expect(diagnostics).toMatchObject([{ code: "config-unreadable", path: optionsFile(root) }]);
  });

  it("answers the opened values with no start mode, with the diagnostic of the file, for a file of defaults that cannot be used", async () => {
    const { root, server } = await serving();
    await plantOptions(root, { claude: { options: OPENED, updated: WHEN } });
    await mkdir(defaultsFile(root));

    const response = await get(server, "/agents/claude/options");

    await expect(success<AgentOptions>(response)).resolves.toEqual({
      data: { agent: "claude", options: OPENED, updated: WHEN },
      diagnostics: [{ code: "config-unreadable", message: "this name holds no regular file", path: defaultsFile(root) }],
    });
  });

  it("answers a stored option of a bad shape as it is stored", async () => {
    const { root, server } = await serving();
    const broken = [
      { id: "mode", type: "select", currentValue: "default", options: [null, { group: "all", name: "All", options: 7 }] },
      { id: "model", type: "select", currentValue: "small", options: "large" },
    ];
    await plantOptions(root, { claude: { options: broken, updated: WHEN } });
    await plantDefaults(root, { claude: { model: "large" } });

    const response = await get(server, "/agents/claude/options");

    expect(response.status).toBe(200);
    await expect(success<AgentOptions>(response)).resolves.toEqual({
      data: { agent: "claude", options: broken, updated: WHEN },
      diagnostics: [],
    });
  });

  it("answers the list of codex apart from the list of claude", async () => {
    const { root, server } = await serving();
    await plantOptions(root, { claude: { options: OPENED, updated: WHEN } });

    await expect(success<AgentOptions>(await get(server, "/agents/codex/options"))).resolves.toEqual({
      data: { agent: "codex", options: [] },
      diagnostics: [],
    });

    await plantOptions(root, { codex: { options: [modelOption()], updated: WHEN } });
    await plantDefaults(root, { codex: { model: "large" } });

    await expect(success<AgentOptions>(await get(server, "/agents/codex/options"))).resolves.toEqual({
      data: { agent: "codex", options: [modelOption("large")], updated: WHEN },
      diagnostics: [],
    });
  });

  it.each(["other", "__proto__", "constructor", "toString"])("refuses the agent %s with agent-unknown", async (agent) => {
    const { root, server } = await serving();
    await plantOptions(root, { [agent]: { options: OPENED, updated: WHEN } });

    const response = await get(server, `/agents/${agent}/options`);

    expect(response.status).toBe(404);
    await expect(failure(response)).resolves.toEqual({
      kind: "daemon",
      code: "agent-unknown",
      message: `Tasma knows no agent "${agent}"`,
    });
  });

  it("refuses a query", async () => {
    const { server } = await serving();

    const response = await get(server, "/agents/claude/options?fresh=1");

    expect(response.status).toBe(400);
    await expect(failure(response)).resolves.toMatchObject({ kind: "daemon", code: "malformed-request" });
  });

  it("writes nothing on stderr for the faults of the files", async () => {
    const { root, server } = await serving();
    await plantOptions(root, { claude: { options: OPENED, updated: WHEN }, codex: "x" });
    await plantDefaults(root, { claude: { mode: "plan" } });
    const write = vi.spyOn(process.stderr, "write");

    const response = await get(server, "/agents/claude/options");
    await writeFile(defaultsFile(root), "{ mode");
    const broken = await get(server, "/agents/claude/options");

    expect(response.status).toBe(200);
    expect(broken.status).toBe(200);
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });
});
