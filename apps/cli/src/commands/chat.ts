// The `chat` noun: the start of the chat of a task's current step, which the
// Tasma app shows.

import { parseArgs } from "node:util";
import type { ChatStartInput, Client, Success } from "@tasma/protocol";
import { attempt, readOrNothing, refuseAnswer, REFUSED } from "../failure.js";
import { fieldsOf } from "../output.js";
import { noun, wireText } from "../shell.js";
import type { Io, Options, Target } from "../types.js";
import { readTaskId } from "./task-id.js";
import type { TaskId } from "./task-id.js";
import { HELP_OPTION, readVerb } from "./verb.js";

const START_OPTIONS = { restart: { type: "boolean" }, ...HELP_OPTION } as const satisfies Options;

const START_HELP = [
  "Usage: tasma chat start <task-id> [options]",
  "",
  "      --restart  Stop the chat of the current step and start a new chat",
  "  -h, --help     Print this help",
];

/**
 * The route answers after the agent starts. Before that, a restart waits for the
 * old agent to stop, and a start can read the login shell for up to 10 s.
 */
const START_TIMEOUT_MS = 30_000;

/** The fields of a start answer that this verb reads. */
type StartAnswer = { chat: { chat: number; step: string; state: string }; started: boolean };

function isStartAnswer(answer: unknown): answer is StartAnswer {
  const { chat, started } = fieldsOf(answer);
  const { chat: chatNumber, step, state } = fieldsOf(chat);

  return typeof started === "boolean"
    && typeof chatNumber === "number"
    && typeof step === "string"
    && typeof state === "string";
}

/** The start answer as the wire carried it, and the reason of a failed chat where its log gives one. */
type Outcome = { answer: unknown; reason?: string };

/**
 * The reason of the last failure in the log of a chat, or nothing where the read
 * fails or the log gives none. A fault of this read changes nothing that the
 * start did, so it is not reported.
 */
async function failureReason(client: Client, task: TaskId, chatNumber: number): Promise<string | undefined> {
  const reply: unknown = (await readOrNothing(() => client.readChatEvents(task.tag, task.id, chatNumber, 0)))?.data;
  const { entries } = fieldsOf(reply);

  if (!Array.isArray(entries)) return undefined;

  const events: unknown[] = entries;
  const failures = events.map((entry) => fieldsOf(fieldsOf(entry).event)).filter((event) => event.kind === "failed");
  const reason = failures.at(-1)?.reason;

  return typeof reason === "string" ? reason : undefined;
}

async function start(args: string[], io: Io, target: Target): Promise<number> {
  const parsed = readVerb(io, args, { command: "chat start", help: START_HELP, takes: 1 }, () =>
    parseArgs({ args, strict: true, allowPositionals: true, options: START_OPTIONS }));

  if (typeof parsed === "number") return parsed;

  const task = readTaskId(io, "chat start", parsed.positionals[0]);

  if (typeof task === "number") return task;

  const input: ChatStartInput = parsed.values.restart === true ? { client: "cli", restart: true } : { client: "cli" };

  // `print` gets no client, so the log of a failed chat is read here.
  const call = async (client: Client): Promise<Success<Outcome>> => {
    const { data, diagnostics } = await client.startChat(task.tag, task.id, input);
    const answer: unknown = data;

    if (!isStartAnswer(answer) || answer.chat.state !== "failed") return { data: { answer }, diagnostics };

    return { data: { answer, reason: await failureReason(client, task, answer.chat.chat) }, diagnostics };
  };

  const print = ({ answer, reason }: Outcome, url: string): number => {
    if (!isStartAnswer(answer)) return refuseAnswer(io, url, "a chat start");

    const chatNumber = wireText(answer.chat.chat);
    const chatLabel = `chat ${chatNumber} of ${wireText(task.id)}`;

    if (answer.chat.state === "failed") {
      io.stderr.write(`tasma: ${chatLabel} failed at its start${reason === undefined ? "" : `: ${wireText(reason)}`}\n`);
      return REFUSED;
    }

    const step = wireText(answer.chat.step);

    io.stdout.write(`${chatNumber}\n`);
    io.stderr.write(answer.started
      ? `tasma: started ${chatLabel} for step ${step}\n`
      : `tasma: ${chatLabel} is already open for step ${step}\n`);

    return 0;
  };

  return attempt(io, target, call, print, { prove: true, timeoutMs: START_TIMEOUT_MS });
}

export const chat = noun("chat", "Work with the chats of tasks", [
  {
    name: "start",
    summary: "Start the chat of the current step of a task",
    usage: { help: START_HELP, options: START_OPTIONS },
    run: start,
  },
]);
