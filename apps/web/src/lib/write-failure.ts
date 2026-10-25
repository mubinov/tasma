import {
  bodyCorrection,
  chatRefusalCode,
  chatStartFailureTitle,
  failureKind,
  titleCorrection,
  type ChatWrite,
  type ClosedNotice,
  type FailureKind,
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

const TURN_RUNNING_LINE = "The agent is working on a turn. Send the message when the turn ends.";

function chatName({ task, chat }: ChatPlace): string {
  return `chat ${String(chat)} of ${task}`;
}

function chatFailureTitle(place: ChatPlace, kind: ChatWrite["kind"]): string {
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

export function chatFailure(place: ChatPlace, kind: ChatWrite["kind"]): WriteFailure {
  return {
    title: chatFailureTitle(place, kind),
    line: (error) => kind === "message" && chatRefusalCode(error) === "turn-running"
      ? TURN_RUNNING_LINE
      : CHAT_FAILURE_LINES[failureKind(error.cause)],
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

export function chatStartFailure(step: string, id: string): WriteFailure {
  return {
    title: chatStartFailureTitle(step, id),
    line: (error) => CHAT_START_FAILURE_LINES[failureKind(error.cause)],
  };
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
