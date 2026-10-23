// A chat with the user's real `claude`, through the real adapter. It runs only
// with TASMA_REAL_CLAUDE=1, and needs CLAUDE_CODE_OAUTH_TOKEN: the HOME of each
// test file is a new temporary directory, which holds no login.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished } from "vitest";
import type { ChatEvent } from "@tasma/protocol";
import { claudeAdapter } from "../../src/agents/claude.js";
import { createChatRegistry } from "../../src/chats/registry.js";
import { createChatRunner } from "../../src/chats/runner.js";
import { createProjectHost } from "../../src/projects/host.js";
import { WriteQueue } from "../../src/tasks/serialize.js";
import { logOf, plant, projectConfig, projectsRoot, target, taskFile, taskText } from "../helpers.js";

const TURN_MS = 120_000;

describe.skipIf(process.env.TASMA_REAL_CLAUDE !== "1")("a chat with the real Claude", () => {
  it("answers two messages in one conversation, and claude --resume continues it", async () => {
    if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      throw new Error("set CLAUDE_CODE_OAUTH_TOKEN to a token from `claude setup-token`");
    }
    const root = await projectsRoot("ALPHA");
    const folder = await target();
    await plant(projectConfig(root, "ALPHA"), `path: ${folder}\n`);
    await plant(taskFile(root, "ALPHA", "ALPHA-1"), taskText("ALPHA-1"));
    const host = createProjectHost({ root });
    onTestFinished(() => host.close());
    const chats = createChatRegistry({ root, host, writes: new WriteQueue() });
    const env = { ...process.env };
    const runner = createChatRunner({ root, chats, adapters: [claudeAdapter], env });
    onTestFinished(() => runner.close());

    const live = await runner.start({
      tag: "ALPHA",
      task: "ALPHA-1",
      step: "dev:build",
      agent: "claude",
      text: "Reply with the single word: pong",
      client: "test",
    });
    /** Waits until the log holds `turns` turn ends, or a failure, and gives the log. */
    async function turnsEnded(turns: number): Promise<ChatEvent[]> {
      let log: ChatEvent[] = [];
      const ended = () => log.filter((event) => event.kind === "turn-end").length >= turns;
      const deadline = Date.now() + TURN_MS;
      while (!ended() && log.at(-1)?.kind !== "failed" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        log = await logOf(live);
      }
      return log;
    }

    const log = await turnsEnded(1);
    expect(log.at(-1)).toMatchObject({ kind: "turn-end" });
    expect(log.some((event) => event.kind === "update" && event.update.sessionUpdate === "agent_message_chunk"))
      .toBe(true);
    const session = live.chat.session;
    expect(session).toBeDefined();

    await runner.message(live, { text: "Which word did you reply with?", client: "test" });
    const second = (await turnsEnded(2)).slice(log.length);
    expect(second.at(-1)).toMatchObject({ kind: "turn-end" });
    const reply = second.flatMap((event) => {
      if (event.kind !== "update" || event.update.sessionUpdate !== "agent_message_chunk") return [];
      const content = event.update.content as { type?: string; text?: string };
      return content.type === "text" ? [content.text ?? ""] : [];
    });
    expect(reply.join("").toLowerCase()).toContain("pong");

    const launch = claudeAdapter.launch(env);
    if ("failed" in launch) throw new Error(launch.failed);
    const { stdout } = await promisify(execFile)(
      launch.env.CLAUDE_CODE_EXECUTABLE ?? "claude",
      ["-p", "--resume", session ?? "", "Which word did you reply with?"],
      { cwd: folder, env: launch.env, timeout: TURN_MS },
    );
    expect(stdout.toLowerCase()).toContain("pong");
  }, 3 * TURN_MS);
});
