// The commands that Claude runs in the background for one agent process: each
// Bash command with `run_in_background` and each Monitor, with the mark that
// `BACKGROUND_RULE` asks for, and whether it still runs.

import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import type { AcpObject } from "@tasma/protocol";
import type { BackgroundCommands, BackgroundState, RunningCommand } from "./adapter.js";

export const BACKGROUND_RULE = "Rule of this application: every time you start a command in the background (the Bash tool with run_in_background, or the Monitor tool), give it a description that begins with one of two marks. Use [job] when the command ends by itself, for example tests or a build. Use [service] when the command runs until something stops it, for example a dev server or a watcher.";

const LSOF = "/usr/sbin/lsof";

const LSOF_TIMEOUT_MS = 5000;

const NAME_LIMIT = 80;

const MARK = /^\[(job|service)\]\s*/;

const OUTPUT_NOTICE = "Output is being written to: ";

const OUTPUT_SUFFIX = ".output";

/** In the output of `lsof -F an`: the access of a file, write or read and write, and on the next line its name. */
const OPEN_TO_WRITE = /^a[wu]\nn(.*)$/gm;

type Command = {
  tool: "Bash" | "Monitor";
  description?: string;
  commandLine?: string;
  /**
   * The `backgroundTaskId` of a Bash call, or the `taskId` of a Monitor. Only
   * a command with it runs in the background.
   */
  id?: string;
  /** Bash only. */
  output?: string;
  /** Monitor only: the time it stops, `null` for a persistent one, `undefined` when unknown. */
  expires?: number | null;
  /** Set once a check has logged that it cannot tell whether the command runs. */
  logged: boolean;
};

type Detached = Command & { id: string };

type Status = "running" | "ended" | "unknown";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * A name goes into the prompt of the agent and into the failure reason, so it
 * must not break a line or reorder the text around it.
 */
function oneLine(text: string | undefined): string {
  return (text ?? "").replace(/[\s\p{Cc}‪-‮⁦-⁩]+/gu, " ").trim();
}

function described(command: Command): RunningCommand {
  const description = oneLine(command.description);
  const mark = MARK.exec(description);
  const rest = mark === null ? description : description.slice(mark[0].length);
  const name = rest === "" ? oneLine(command.commandLine) : rest;
  return { mark: mark?.[1] as RunningCommand["mark"], name: Array.from(name).slice(0, NAME_LIMIT).join("") };
}

/**
 * The path that the notice of a background Bash command names. The output of
 * a foreground command can be long, so each line is read once.
 */
function outputPath(data: string): string | undefined {
  for (const line of data.split("\n")) {
    const at = line.indexOf(OUTPUT_NOTICE);
    if (at === -1) continue;
    const rest = line.slice(at + OUTPUT_NOTICE.length);
    const end = rest.indexOf(OUTPUT_SUFFIX);
    if (end !== -1) return rest.slice(0, end + OUTPUT_SUFFIX.length);
  }
  return undefined;
}

/** Sets the id and the expiry of the command from its tool result, when the command detached. */
function applyResponse(command: Command, response: Record<string, unknown>): void {
  const id = stringOf(command.tool === "Bash" ? response.backgroundTaskId : response.taskId);
  if (id === undefined) return;
  command.id = id;
  if (command.tool === "Monitor") {
    const { timeoutMs } = response;
    if (response.persistent === true) command.expires = null;
    else if (typeof timeoutMs === "number") command.expires = Date.now() + timeoutMs;
  }
}

/**
 * The names of the files that `lsof` lists as open to write, of `paths`. `lsof`
 * exits with 1 when a path is not open, which is no failure.
 */
function filesOpenToWrite(lsof: string, paths: string[], timeoutMs: number): Promise<Set<string> | { failed: string }> {
  return new Promise((resolve) => {
    try {
      execFile(lsof, ["-F", "an", "--", ...paths], { timeout: timeoutMs, killSignal: "SIGKILL" }, (error, stdout) => {
        if (error?.killed === true) resolve({ failed: `lsof did not end in ${String(timeoutMs)} ms` });
        else if (error !== null && typeof error.code !== "number") resolve({ failed: `lsof could not run: ${error.message}` });
        else resolve(new Set(Array.from(stdout.matchAll(OPEN_TO_WRITE), (match) => match[1]!)));
      });
    } catch (error) {
      resolve({ failed: `lsof could not run: ${(error as Error).message}` });
    }
  });
}

/**
 * A Bash command runs while its output file is open to write: only the command
 * and its child processes do that. A reader, for example a `tail -f`, can stay
 * after the command ends.
 */
async function bashStatus(
  commands: Command[],
  options: { lsof: string; timeoutMs: number; log: (cause: string) => void },
): Promise<Map<Command, Status>> {
  const status = new Map<Command, Status>();
  const paths = new Map<Command, string>();
  await Promise.all(commands.map(async (command) => {
    if (command.output === undefined) return;
    const path = await realpath(command.output).catch(() => undefined);
    if (path === undefined) status.set(command, "ended");
    else paths.set(command, path);
  }));
  if (paths.size === 0) return status;
  const open = await filesOpenToWrite(options.lsof, [...new Set(paths.values())], options.timeoutMs);
  if (!(open instanceof Set)) {
    options.log(`${open.failed}, so Tasma cannot tell whether the background commands run`);
    return status;
  }
  for (const [command, path] of paths) status.set(command, open.has(path) ? "running" : "ended");
  return status;
}

/** `lsof` and `timeoutMs` are for the tests alone. */
type Options = { log: (cause: string) => void; lsof?: string; timeoutMs?: number };

/** The background commands of one agent process. */
export function claudeBackground(options: Options): BackgroundCommands {
  const { log, lsof = LSOF, timeoutMs = LSOF_TIMEOUT_MS } = options;
  const commands = new Map<string, Command>();

  /** The line names the command by its id: its command line can hold a secret. */
  function uncheckable(command: Detached, missing: string): Status {
    if (!command.logged) log(`the background ${command.tool} command ${command.id} gave no ${missing}, so Tasma cannot tell whether it runs`);
    command.logged = true;
    return "unknown";
  }

  return {
    note(update: AcpObject) {
      const { toolCallId } = update;
      if (typeof toolCallId !== "string") return;
      const meta = isRecord(update._meta) ? update._meta : {};
      const claudeCode = isRecord(meta.claudeCode) ? meta.claudeCode : {};
      let command = commands.get(toolCallId);
      if (command === undefined) {
        // The later updates of a call also name its tool, after the result that drops a foreground call too.
        const tool = claudeCode.toolName;
        if (update.sessionUpdate !== "tool_call" || (tool !== "Bash" && tool !== "Monitor")) return;
        command = { tool, logged: false };
        commands.set(toolCallId, command);
      }
      if (isRecord(update.rawInput)) {
        command.description = stringOf(update.rawInput.description) ?? command.description;
        command.commandLine = stringOf(update.rawInput.command) ?? command.commandLine;
      }
      if (command.tool === "Bash" && isRecord(meta.terminal_output)) {
        const path = outputPath(stringOf(meta.terminal_output.data) ?? "");
        if (path !== undefined) command.output = path;
      }
      const { toolResponse } = claudeCode;
      // A progress beat comes in the field of the result, and a tool that still runs can detach after it.
      const result = isRecord(toolResponse) && !("elapsedTimeSeconds" in toolResponse) ? toolResponse : undefined;
      if (result !== undefined) applyResponse(command, result);
      // A completed status does not end a call: its result, which holds the id, can come after it.
      if (command.id === undefined && (result !== undefined || update.status === "failed")) commands.delete(toolCallId);
    },

    async running(): Promise<BackgroundState> {
      const listed = [...commands].filter((entry): entry is [string, Detached] => entry[1].id !== undefined);
      const bashCommands = listed.map(([, command]) => command).filter((command) => command.tool === "Bash");
      const bashStatuses = await bashStatus(bashCommands, { lsof, timeoutMs, log });
      const now = Date.now();
      const state: BackgroundState = { running: [], jobsEnded: 0 };
      for (const [toolCallId, command] of listed) {
        let status: Status;
        if (command.tool === "Monitor") {
          if (command.expires === undefined) status = uncheckable(command, "time limit");
          else status = command.expires === null || command.expires > now ? "running" : "ended";
        } else if (command.output === undefined) {
          status = uncheckable(command, "output path");
        } else {
          status = bashStatuses.get(command) ?? "unknown";
        }
        const { mark, name } = described(command);
        if (status === "running") state.running.push({ mark, name });
        // A call of `running()` that runs at the same time can have dropped it.
        else if (status === "ended" && commands.delete(toolCallId) && mark === "job") state.jobsEnded += 1;
      }
      return state;
    },
  };
}
