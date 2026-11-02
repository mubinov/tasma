import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import type { AcpObject } from "@tasma/protocol";
import { claudeBackground } from "../../src/agents/claude-background.js";
import { target, until } from "../helpers.js";

function toolCall(toolCallId: string, toolName: string, rawInput: AcpObject = {}): AcpObject {
  return { sessionUpdate: "tool_call", toolCallId, _meta: { claudeCode: { toolName } }, rawInput };
}

function input(toolCallId: string, rawInput: AcpObject): AcpObject {
  return { sessionUpdate: "tool_call_update", toolCallId, rawInput };
}

function response(toolCallId: string, toolName: string, toolResponse: AcpObject): AcpObject {
  return { sessionUpdate: "tool_call_update", toolCallId, _meta: { claudeCode: { toolName, toolResponse } } };
}

function terminal(toolCallId: string, data: string): AcpObject {
  return { sessionUpdate: "tool_call_update", toolCallId, _meta: { terminal_output: { terminal_id: toolCallId, data } } };
}

/** The last update of each tool call, which the adapter sends with the name of the tool. */
function finished(toolCallId: string, toolName: string, status: "completed" | "failed" = "completed"): AcpObject {
  return { sessionUpdate: "tool_call_update", toolCallId, _meta: { claudeCode: { toolName } }, status };
}

/** The report of a tool that still runs, in the field of the tool result. */
function beat(toolCallId: string, toolName: string): AcpObject {
  return { ...response(toolCallId, toolName, { elapsedTimeSeconds: 30 }), status: "in_progress" };
}

function notice(path: string): string {
  return `Command running in background with ID: task-1. Output is being written to: ${path}`;
}

/** A tracker whose log lines are in `logged`. */
function tracker(options: { lsof?: string; timeoutMs?: number } = {}) {
  const logged: string[] = [];
  const background = claudeBackground({ log: (cause) => logged.push(cause), ...options });
  return { background, logged };
}

/** Records one background Bash command whose output goes to `output`. */
function bash(background: ReturnType<typeof tracker>["background"], toolCallId: string, description: string, output: string): void {
  background.note(toolCall(toolCallId, "Bash", { command: "pnpm test", description, run_in_background: true }));
  background.note(response(toolCallId, "Bash", { backgroundTaskId: `task-${toolCallId}`, stdout: "", stderr: "" }));
  background.note(terminal(toolCallId, notice(output)));
  background.note(finished(toolCallId, "Bash"));
}

/** Records one persistent Monitor, which runs with no check of a file. */
function watch(background: ReturnType<typeof tracker>["background"], toolCallId: string, rawInput: AcpObject): void {
  background.note(toolCall(toolCallId, "Monitor", rawInput));
  background.note(response(toolCallId, "Monitor", { taskId: `task-${toolCallId}`, persistent: true }));
}

/** Runs `sleep` with `path` open through `redirect` until `end`, and gives it once the file is open. */
async function holding(path: string, redirect: ">" | "<" | "<>" = ">"): Promise<{ end(): Promise<void> }> {
  const opened = `${path}.${randomUUID()}`;
  const child = spawn("/bin/sh", ["-c", `exec 3${redirect} "$1"; : > "$2"; exec sleep 60`, "sh", path, opened], { stdio: "ignore" });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  onTestFinished(() => {
    child.kill("SIGKILL");
  });
  await until(() => existsSync(opened), "the command opened its file");
  return {
    async end() {
      child.kill("SIGKILL");
      await exited;
    },
  };
}

describe("claudeBackground.note", () => {
  it("joins the updates of one command by toolCallId, and keeps the last description", async () => {
    const folder = await target();
    const { background } = tracker();
    const output = join(folder, "a.output");
    await holding(output);

    background.note(toolCall("call-1", "Bash", {}));
    background.note(input("call-1", { command: "pnpm test", description: "[service] Old name" }));
    background.note(input("call-1", { command: "pnpm test", description: "[job] Test loop" }));
    background.note(input("call-1", { command: "pnpm test" }));
    background.note(terminal("call-1", notice(output)));
    background.note(response("call-1", "Bash", { backgroundTaskId: "task-1" }));

    expect(await background.running()).toEqual({ running: [{ mark: "job", name: "Test loop" }], jobsEnded: 0 });
  });

  it.each([
    ["[job] Build the parser", "job", "Build the parser"],
    ["  [service]   Dev server on port 3000  ", "service", "Dev server on port 3000"],
    ["Run [job] in the middle", undefined, "Run [job] in the middle"],
    ["[JOB] Upper case", undefined, "[JOB] Upper case"],
    ["[jobs] Plural", undefined, "[jobs] Plural"],
    ["Plain text", undefined, "Plain text"],
    ["[job]", "job", "pnpm test"],
    ["\n[job]\nRun the\r\n\ttests now\u0007", "job", "Run the tests now"],
    ["[job] Run\u202E the\u2066 tests\u2069\u2028now", "job", "Run the tests now"],
  ] as const)("reads %j as the mark %s and the name %j", async (description, mark, name) => {
    const { background } = tracker();
    watch(background, "call-1", { command: "pnpm test", description });

    expect((await background.running()).running).toEqual([{ mark, name }]);
  });

  it("names a command with no description by its command, on one line, and cuts a name to 80 characters", async () => {
    const { background } = tracker();
    watch(background, "call-1", { command: "pnpm test\n  && pnpm build\n" });
    watch(background, "call-2", { command: "pnpm test", description: `[job] ${"é".repeat(79)}🙂🙂` });
    watch(background, "call-3", { description: "[service]" });

    expect((await background.running()).running).toEqual([
      { mark: undefined, name: "pnpm test && pnpm build" },
      { mark: "job", name: `${"é".repeat(79)}🙂` },
      { mark: "service", name: "" },
    ]);
  });

  it("records only Bash and Monitor, only with a background id, and no update without a toolCallId", async () => {
    const folder = await target();
    const { background, logged } = tracker({ lsof: "/nonexistent/lsof" });
    const output = join(folder, "a.output");
    background.note(toolCall("call-1", "Read", { description: "[job] Read" }));
    background.note(response("call-1", "Read", { backgroundTaskId: "task-1" }));
    background.note(terminal("call-1", notice(output)));
    background.note(toolCall("call-2", "Bash", { command: "ls", description: "[job] List" }));
    background.note(response("call-2", "Bash", { stdout: "a", stderr: "" }));
    background.note(terminal("call-2", notice(output)));
    background.note(finished("call-2", "Bash"));
    background.note(toolCall("call-3", "Monitor", { command: "tail -f log", description: "[job] Watch" }));
    background.note(response("call-3", "Monitor", { timeoutMs: 60_000 }));
    background.note({ sessionUpdate: "tool_call", _meta: { claudeCode: { toolName: "Bash" } } });
    background.note({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } });

    expect(await background.running()).toEqual({ running: [], jobsEnded: 0 });
    expect(logged).toEqual([]);
  });

  it("starts a record only at the tool_call of a call, so no update after the end of a foreground call makes one", async () => {
    const folder = await target();
    const { background } = tracker();
    const output = join(folder, "a.output");
    await holding(output);
    background.note(toolCall("call-1", "Bash", { command: "ls", description: "[job] List" }));
    background.note(response("call-1", "Bash", { stdout: "a", stderr: "" }));
    background.note(terminal("call-1", "a"));
    background.note(finished("call-1", "Bash"));

    for (const toolCallId of ["call-1", "call-2"]) {
      background.note({ ...input(toolCallId, { command: "pnpm test", description: "[job] Test loop" }), _meta: { claudeCode: { toolName: "Bash" } } });
      background.note(response(toolCallId, "Bash", { backgroundTaskId: `task-${toolCallId}` }));
      background.note(terminal(toolCallId, notice(output)));
    }

    expect(await background.running()).toEqual({ running: [], jobsEnded: 0 });
  });

  it("keeps a call through a progress beat, so a call that moves to the background later is recorded", async () => {
    const folder = await target();
    const { background } = tracker();
    const output = join(folder, "a.output");
    await holding(output);
    background.note(toolCall("call-1", "Bash", { command: "pnpm test", description: "[job] Test loop" }));
    background.note(beat("call-1", "Bash"));
    background.note(response("call-1", "Bash", { backgroundTaskId: "task-1" }));
    background.note(terminal("call-1", notice(output)));
    background.note(toolCall("call-2", "Monitor", { command: "tail -f a.log", description: "[service] Watch" }));
    background.note(beat("call-2", "Monitor"));
    background.note(response("call-2", "Monitor", { taskId: "task-2", persistent: true }));

    expect(await background.running()).toEqual({
      running: [{ mark: "job", name: "Test loop" }, { mark: "service", name: "Watch" }],
      jobsEnded: 0,
    });
  });

  it("keeps a command that has an id at each later update, also a result with no id or a failed status", async () => {
    const folder = await target();
    const { background } = tracker();
    const output = join(folder, "a.output");
    await holding(output);
    bash(background, "call-1", "[job] Test loop", output);

    background.note(beat("call-1", "Bash"));
    background.note(response("call-1", "Bash", { stdout: "", stderr: "" }));
    background.note(finished("call-1", "Bash", "failed"));

    expect(await background.running()).toEqual({ running: [{ mark: "job", name: "Test loop" }], jobsEnded: 0 });
  });

  it("drops a call with no id at its failed status, and keeps one at its completed status, as its result can come after", async () => {
    const folder = await target();
    const { background } = tracker();
    const output = join(folder, "a.output");
    await holding(output);
    for (const [toolCallId, status] of [["call-1", "failed"], ["call-2", "completed"]] as const) {
      background.note(toolCall(toolCallId, "Bash", { command: "pnpm test", description: `[job] Ended ${status}` }));
      background.note(finished(toolCallId, "Bash", status));
      background.note(response(toolCallId, "Bash", { backgroundTaskId: `task-${toolCallId}` }));
      background.note(terminal(toolCallId, notice(output)));
    }

    expect(await background.running()).toEqual({ running: [{ mark: "job", name: "Ended completed" }], jobsEnded: 0 });
  });

  it("takes the output path from the first line that names a .output file after the notice", async () => {
    const folder = await target();
    const { background } = tracker();
    const output = join(folder, "a.output");
    await holding(output);
    background.note(toolCall("call-1", "Bash", { command: "pnpm test", description: "[job] Test loop" }));
    background.note(response("call-1", "Bash", { backgroundTaskId: "task-1" }));
    background.note(terminal("call-1", `Output is being written to: no file\n${notice(output)}.old\nOutput is being written to: /a/b.output`));

    expect(await background.running()).toEqual({ running: [{ mark: "job", name: "Test loop" }], jobsEnded: 0 });
  });

  it("reads a long output with many notices and no .output file in linear time", () => {
    const { background } = tracker();
    background.note(toolCall("call-1", "Bash", { command: "cat notices.txt" }));
    const data = `${"Output is being written to: ".repeat(40_000)}\n`.repeat(2);

    const began = performance.now();
    background.note(terminal("call-1", data));

    expect(performance.now() - began).toBeLessThan(1000);
  });

  it("gives a Monitor the expiry of its timeoutMs, and a persistent Monitor none", async () => {
    const { background } = tracker();
    background.note(toolCall("call-1", "Monitor", { command: "tail -f a.log", description: "[job] Short watch" }));
    background.note(response("call-1", "Monitor", { taskId: "task-1", timeoutMs: 100, persistent: false }));
    background.note(toolCall("call-2", "Monitor", { command: "tail -f b.log", description: "[service] Long watch" }));
    background.note(response("call-2", "Monitor", { taskId: "task-2", timeoutMs: 100, persistent: true }));

    expect(await background.running()).toEqual({
      running: [{ mark: "job", name: "Short watch" }, { mark: "service", name: "Long watch" }],
      jobsEnded: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await background.running()).toEqual({ running: [{ mark: "service", name: "Long watch" }], jobsEnded: 1 });
    expect(await background.running()).toEqual({ running: [{ mark: "service", name: "Long watch" }], jobsEnded: 0 });
  });

  it("logs once a command with no output path and a Monitor with no time limit, by id, and gives neither as running", async () => {
    const { background, logged } = tracker({ lsof: "/nonexistent/lsof" });
    background.note(toolCall("call-1", "Bash", { command: "API_TOKEN=secret pnpm test" }));
    background.note(response("call-1", "Bash", { backgroundTaskId: "task-1" }));
    background.note(terminal("call-1", "Command running in background with ID: task-1."));
    background.note({ sessionUpdate: "tool_call_update", toolCallId: "call-1", _meta: { terminal_output: { terminal_id: "call-1" } } });
    background.note(toolCall("call-2", "Monitor", { command: "tail -f a.log", description: "[job] Watch" }));
    background.note(response("call-2", "Monitor", { taskId: "task-2" }));

    expect(await background.running()).toEqual({ running: [], jobsEnded: 0 });
    expect(await background.running()).toEqual({ running: [], jobsEnded: 0 });
    expect(logged).toEqual([
      "the background Bash command task-1 gave no output path, so Tasma cannot tell whether it runs",
      "the background Monitor command task-2 gave no time limit, so Tasma cannot tell whether it runs",
    ]);
  });
});

describe("claudeBackground.running", () => {
  it("gives a command as running while a process holds its output file, through a link, and as ended after", async () => {
    const folder = await target();
    await mkdir(join(folder, "real"));
    await symlink(join(folder, "real"), join(folder, "link"));
    const { background, logged } = tracker();
    const output = join(folder, "link", "a.output");
    const command = await holding(output);
    bash(background, "call-1", "[job] Test loop", output);

    expect(await background.running()).toEqual({ running: [{ mark: "job", name: "Test loop" }], jobsEnded: 0 });
    await command.end();
    expect(await background.running()).toEqual({ running: [], jobsEnded: 1 });
    expect(await background.running()).toEqual({ running: [], jobsEnded: 0 });
    expect(logged).toEqual([]);
  });

  it("gives a command as running while a process has its output file open to read and write", async () => {
    const folder = await target();
    const { background } = tracker();
    const output = join(folder, "a.output");
    await writeFile(output, "");
    const command = await holding(output, "<>");
    bash(background, "call-1", "[job] Test loop", output);

    expect(await background.running()).toEqual({ running: [{ mark: "job", name: "Test loop" }], jobsEnded: 0 });
    await command.end();
    expect(await background.running()).toEqual({ running: [], jobsEnded: 1 });
  });

  it("gives a command as ended when a process that only reads its output file stays", async () => {
    const folder = await target();
    const { background } = tracker();
    const output = join(folder, "a.output");
    const command = await holding(output);
    await holding(output, "<");
    bash(background, "call-1", "[job] Test loop", output);

    expect(await background.running()).toEqual({ running: [{ mark: "job", name: "Test loop" }], jobsEnded: 0 });
    await command.end();
    expect(await background.running()).toEqual({ running: [], jobsEnded: 1 });
  });

  it("checks two commands in one call, one held and one free, and counts only an ended job", async () => {
    const folder = await target();
    const { background } = tracker();
    const held = join(folder, "held.output");
    const free = join(folder, "free.output");
    const service = join(folder, "service.output");
    await holding(held);
    await writeFile(free, "done\n");
    await writeFile(service, "stopped\n");
    bash(background, "call-1", "[service] Dev server", held);
    bash(background, "call-2", "[job] Build", free);
    bash(background, "call-3", "[service] Watcher", service);

    expect(await background.running()).toEqual({ running: [{ mark: "service", name: "Dev server" }], jobsEnded: 1 });
  });

  it("gives a command whose output file was deleted as ended", async () => {
    const folder = await target();
    const { background, logged } = tracker({ lsof: "/nonexistent/lsof" });
    const output = join(folder, "a.output");
    await writeFile(output, "");
    bash(background, "call-1", "[job] Test loop", output);
    await rm(output);

    expect(await background.running()).toEqual({ running: [], jobsEnded: 1 });
    expect(logged).toEqual([]);
  });

  it.each([
    ["does not exist", async () => ({ lsof: "/nonexistent/lsof", cause: "lsof could not run: spawn /nonexistent/lsof ENOENT" })],
    ["cannot be started", async () => ({ lsof: "/usr/sbin/\0lsof", cause: "lsof could not run: The argument 'file'" })],
    ["takes longer than its time limit", async () => {
      const lsof = join(await target(), "lsof");
      await writeFile(lsof, "#!/bin/sh\nexec sleep 10\n");
      await chmod(lsof, 0o755);
      return { lsof, cause: "lsof did not end in 200 ms" };
    }],
  ])("gives no Bash command as running when lsof %s, and logs one line for each check", async (_case, make) => {
    const folder = await target();
    const { lsof, cause } = await make();
    const { background, logged } = tracker({ lsof, timeoutMs: 200 });
    const output = join(folder, "a.output");
    await holding(output);
    bash(background, "call-1", "[job] Test loop", output);
    bash(background, "call-2", "[job] Build", output);
    background.note(toolCall("call-3", "Monitor", { command: "tail -f a.log", description: "[job] Watch" }));
    background.note(response("call-3", "Monitor", { taskId: "task-3", timeoutMs: 60_000 }));

    expect(await background.running()).toEqual({ running: [{ mark: "job", name: "Watch" }], jobsEnded: 0 });
    expect(await background.running()).toEqual({ running: [{ mark: "job", name: "Watch" }], jobsEnded: 0 });
    expect(logged).toHaveLength(2);
    for (const line of logged) {
      expect(line.startsWith(cause)).toBe(true);
      expect(line.endsWith(", so Tasma cannot tell whether the background commands run")).toBe(true);
    }
  });

  it("does not run lsof with no Bash command that has an output file", async () => {
    const { background, logged } = tracker({ lsof: "/nonexistent/lsof" });
    background.note(toolCall("call-1", "Monitor", { command: "tail -f a.log", description: "[service] Watch" }));
    background.note(response("call-1", "Monitor", { taskId: "task-1", persistent: true }));

    expect(await background.running()).toEqual({ running: [{ mark: "service", name: "Watch" }], jobsEnded: 0 });
    expect(logged).toEqual([]);
  });
});
