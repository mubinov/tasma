import {
  bodyCorrection,
  chatRefusalCode,
  chatRestartFailureTitle,
  chatStartFailureTitle,
  failureKind,
  titleCorrection,
  type ChatWrite,
  type ClosedNotice,
  type FailureKind,
  type SavedNotice,
  type SkippedNotice,
  type TaskWriteError,
  type WriteError,
  type WriteFailure,
} from "../api/mutations";
import type { ChatPlace } from "../api/queries";

/** Nothing was written. */
const WHOLE_FAILURE_LINES: Record<FailureKind, string> = {
  refused: "The daemon refused the write, and the task is back where it was. Its own words are below.",
  unanswered: "No daemon answered, so nothing was written.",
  address: "The daemon did not answer through the address below. Start the daemon there if it is not running. "
    + "The board shows the task where the daemon holds it after the next read.",
  unsent: "The write did not start, and the task is back where it was.",
};

/** A write before the failed one succeeded. */
const PARTIAL_FAILURE_LINES: Record<FailureKind, string> = {
  refused: "The daemon refused a write, and the move did not complete. The board shows what the daemon holds. "
    + "Its own words are below.",
  unanswered: "The daemon stopped answering, and the move did not complete. "
    + "The board shows what the daemon holds after the next read.",
  address: "The daemon did not answer through the address below, and the move did not complete. "
    + "Start the daemon there if it is not running. The board shows what the daemon holds after the next read.",
  unsent: "A write did not start, and the move did not complete. The board shows what the daemon holds.",
};

/** A page write is one write, so it has no partial form. */
const PAGE_FAILURE_LINES: Record<FailureKind, string> = {
  refused: "The daemon refused the write, so nothing changed on disk. Its own words are below.",
  unanswered: "No daemon answered, so nothing was written.",
  address: "The daemon did not answer through the address below. Start the daemon there if it is not running. "
    + "The page shows the task as the daemon holds it after the next read.",
  unsent: "The write did not start, so nothing changed on disk.",
};

const CHAT_FAILURE_LINES: Record<FailureKind, string> = {
  refused: "The daemon refused it, so nothing changed in the chat. Its own words are below.",
  unanswered: "No daemon answered, so nothing was sent.",
  address: "The daemon did not answer through the address below. Start the daemon there if it is not running.",
  unsent: "The write did not start, so nothing was sent.",
};

const CHAT_START_FAILURE_LINES: Record<FailureKind, string> = {
  refused: "The daemon refused to start the chat. Its own words are below.",
  unanswered: "No daemon answered. If the chat started, it shows in the chats of the task.",
  address: "The daemon did not answer through the address below. Start the daemon there if it is not running.",
  unsent: "The request did not start, so no chat started.",
};

const CHAT_RESTART_FAILURE_LINES: Record<FailureKind, string> = {
  refused: "The daemon refused the restart. Its own words are below.",
  unanswered: "No daemon answered. If the restart ran, the new chat shows in the chats of the task.",
  address: "The daemon did not answer through the address below. Start the daemon there if it is not running.",
  unsent: "The request did not start, so nothing changed.",
};

const TURN_RUNNING_LINE = "The agent is working on a turn. Send the message when the turn ends.";

function chatName({ task, chat }: ChatPlace): string {
  return `chat ${String(chat)} of ${task}`;
}

/** An option write names its option, so its texts come from `chatOptionFailure`. */
type ChatFailureKind = Exclude<ChatWrite["kind"], "option">;

function chatFailureTitle(place: ChatPlace, kind: ChatFailureKind): string {
  switch (kind) {
    case "message":
      return `The message to ${chatName(place)} was not sent.`;
    case "cancel":
      return `The turn of ${chatName(place)} did not stop.`;
    case "permission":
    case "question":
      return `The answer to ${chatName(place)} was not sent.`;
  }
}

export function chatFailure(place: ChatPlace, kind: ChatFailureKind): WriteFailure {
  return {
    title: chatFailureTitle(place, kind),
    line: (error) => kind === "message" && chatRefusalCode(error) === "turn-running"
      ? TURN_RUNNING_LINE
      : CHAT_FAILURE_LINES[failureKind(error.cause)],
  };
}

/** `name` is the name of the option. */
export function chatOptionFailure(place: ChatPlace, name: string): WriteFailure {
  return {
    title: `${name} of ${chatName(place)} did not change.`,
    // A refused relaunch writes a `failed` event, so the chat can change.
    line: (error) => {
      const kind = failureKind(error.cause);
      return kind === "refused"
        ? `The daemon refused it, so ${name} did not change. Its own words are below.`
        : CHAT_FAILURE_LINES[kind];
    },
  };
}

/** The warning of a value that applies to the chat, with a file that the daemon could not write. */
export function chatOptionSavedNotice(place: ChatPlace, name: string): SavedNotice {
  return {
    title: `${name} of ${chatName(place)} changed, but it is not saved.`,
    line: "The chat uses the new value now. The daemon could not write the files below, "
      + "so a new chat or a resumed one can start with the old value.",
  };
}

/** The warning of an answer that the daemon refused with `already-answered`. */
export function chatClosedNotice(place: ChatPlace): ClosedNotice {
  return {
    title: `Your answer to ${chatName(place)} was not used.`,
    line: "The request was already closed: another window answered it, or it was cancelled or ended. "
      + "The chat shows the outcome.",
  };
}

/** The line of a message refused with `turn-running` while this window restarts the task from the chat. */
export function chatRestartingLine({ chat }: ChatPlace): string {
  return `Chat ${String(chat)} stops for a restart. Write to the new chat when it opens.`;
}

export function chatStartFailure(step: string, id: string): WriteFailure {
  return {
    title: chatStartFailureTitle(step, id),
    line: (error) => CHAT_START_FAILURE_LINES[failureKind(error.cause)],
  };
}

/** `chat` is the chat that the restart replaces. */
export function chatRestartFailure(step: string, id: string, chat: number): WriteFailure {
  return {
    title: chatRestartFailureTitle(step, id),
    line: (error) => chatRefusalCode(error) === "chat-not-current"
      ? `The task moved to another step while the agent of chat ${String(chat)} stopped. `
      + `Chat ${String(chat)} stopped, and no new chat started.`
      : CHAT_RESTART_FAILURE_LINES[failureKind(error.cause)],
  };
}

/** The warning of a restart that the dialog did not send. */
export function chatRestartSkippedNotice(id: string, chat: number): SkippedNotice {
  return { title: "Nothing restarted", line: `Chat ${String(chat)} of ${id} is no longer the chat of its step.` };
}

export function boardFailureLine(error: TaskWriteError): string {
  return (error.completed > 0 ? PARTIAL_FAILURE_LINES : WHOLE_FAILURE_LINES)[failureKind(error.cause)];
}

/** `property` is the sidebar row the write changes, named in front of the line. */
export function pageFailureLine(error: WriteError, property?: string): string {
  const named = property === undefined ? "" : `${property}. `;
  const line = `${named}${PAGE_FAILURE_LINES[failureKind(error.cause)]}`;
  const correction = bodyCorrection(error) ?? titleCorrection(error);

  return correction === undefined ? line : `${line} ${correction}`;
}
