import {
  bodyCorrection,
  chatRefusalCode,
  chatRestartFailureTitle,
  chatStartFailureTitle,
  failureKind,
  refusalPath,
  refusalWords,
  skillAgentFailureKey,
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
import type { ChatAgent } from "@tasma/protocol";
import type { ChatPlace } from "../api/queries";
import type { Notice } from "../store/notices";
import { agentNames } from "./agent-texts";
import { chatAgentName } from "./chat-messages";

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

const CHAT_INACTIVE_FAILURE_LINES: Record<FailureKind, string> = {
  refused: "The daemon refused it, so the chat stays in Active. Its own words are below.",
  unanswered: "No daemon answered. If the daemon marked the chat, it moves to Other chats.",
  address: CHAT_FAILURE_LINES.address,
  unsent: "The request did not start, so nothing changed.",
};

const CHAT_START_FAILURE_LINES: Record<FailureKind, string> = {
  refused: "The daemon refused to start the chat. Its own words are below.",
  unanswered: "No daemon answered. If the chat started, it shows in the chats of the task.",
  address: "The daemon did not answer through the address below. Start the daemon there if it is not running.",
  unsent: "The request did not start, so no chat started.",
};

const PROJECT_CHAT_START_FAILURE_LINES: Record<FailureKind, string> = {
  ...CHAT_START_FAILURE_LINES,
  unanswered: "No daemon answered. If the chat started, it shows in the list of chats.",
};

const CHAT_RESTART_FAILURE_LINES: Record<FailureKind, string> = {
  refused: "The daemon refused the restart. Its own words are below.",
  unanswered: "No daemon answered. If the restart ran, the new chat shows in the chats of the task.",
  address: "The daemon did not answer through the address below. Start the daemon there if it is not running.",
  unsent: "The request did not start, so nothing changed.",
};

const SKILL_INSTALL_FAILURE_LINES: Record<Exclude<FailureKind, "unanswered" | "address">, string> = {
  refused: "The daemon refused the request.",
  unsent: "Tasma could not send the request to the daemon.",
};

function chatName({ tag, task, chat }: ChatPlace): string {
  return `chat ${String(chat)} of ${task ?? tag}`;
}

function capitalChatName({ tag, task, chat }: ChatPlace): string {
  return `Chat ${String(chat)} of ${task ?? tag}`;
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
    case "inactive":
      return `${capitalChatName(place)} did not move to Other chats.`;
  }
}

function inactiveFailureLine({ chat }: ChatPlace, error: WriteError): string {
  return chatRefusalCode(error) === "turn-running"
    ? `The agent of chat ${String(chat)} works or waits for an answer, so the chat stays in Active. `
    + "Mark it again when the agent stops."
    : CHAT_INACTIVE_FAILURE_LINES[failureKind(error.cause)];
}

export function chatFailure(place: ChatPlace, kind: ChatFailureKind): WriteFailure {
  return {
    title: chatFailureTitle(place, kind),
    line: (error) => {
      if (kind === "inactive") {
        return inactiveFailureLine(place, error);
      }
      // A restart in progress is the only cause of a message refused with `turn-running`.
      return kind === "message" && chatRefusalCode(error) === "turn-running"
        ? chatRestartingLine(place)
        : CHAT_FAILURE_LINES[failureKind(error.cause)];
    },
  };
}

export function chatMarkingWords(place: ChatPlace): string {
  return `Marking ${chatName(place)} as not active`;
}

export function chatInactiveWords(place: ChatPlace): string {
  return `${capitalChatName(place)} is in Other chats.`;
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
    line: "The request was already closed: it was answered, cancelled or ended. "
      + "The chat shows the outcome.",
  };
}

/** The line of a message refused with `turn-running`, which the daemon gives while the chat ends for a restart. */
export function chatRestartingLine({ chat }: ChatPlace): string {
  return `Chat ${String(chat)} stops for a restart. Write to the new chat when it opens.`;
}

export function chatStartFailure(step: string, id: string): WriteFailure {
  return {
    title: chatStartFailureTitle(step, id),
    line: (error) => CHAT_START_FAILURE_LINES[failureKind(error.cause)],
  };
}

export function projectChatStartFailure(tag: string): WriteFailure {
  return {
    title: `The new chat of ${tag} did not start`,
    line: (error) => PROJECT_CHAT_START_FAILURE_LINES[failureKind(error.cause)],
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

/** `button` holds the words of the install button, which shows the result of an install that still runs. */
export function skillInstallFailure(button: string): WriteFailure {
  return {
    title: "Cannot install the skill",
    line: (error) => {
      const kind = failureKind(error.cause);

      return kind === "unanswered" || kind === "address"
        ? `Tasma did not get an answer from the daemon. The install can still run. Select "${button}" to see its result.`
        : SKILL_INSTALL_FAILURE_LINES[kind];
    },
  };
}

/** The notice of an agent whose install failed while the install of the agents in `installed` succeeded. */
export function skillAgentFailure(agent: ChatAgent, installed: readonly ChatAgent[]): Notice {
  const name = chatAgentName(agent);

  return {
    key: skillAgentFailureKey(agent),
    form: "failure",
    title: `Cannot install the skill for ${name}`,
    line: `The skill is installed for ${agentNames(installed)}. ${name} needs it to run workflow steps.`,
    words: [],
  };
}

/** A failure that a setup step shows in its row, above the button that tries again. */
export type SetupFailure = {
  title: string;
  line: string;
  /** What the user acts on outside the app, in a box with a Copy button. */
  box?: { text: string; noun: "path" | "address" };
};

/** `added` names what the write adds, as the line of a lost answer names it. */
function setupWriteFailure(title: string, added: string, error: WriteError): SetupFailure {
  switch (failureKind(error.cause)) {
    case "refused": {
      const path = refusalPath(error);

      return { title, line: refusalWords(error), ...(path === undefined ? {} : { box: { text: path, noun: "path" } }) };
    }
    case "unanswered":
      return { title, line: `The daemon did not answer. If ${added} was added, this step changes to Done.` };
    case "address":
      return {
        title,
        line: "The daemon did not answer through the address below. Start the daemon there if it is not running.",
        box: { text: refusalWords(error), noun: "address" },
      };
    case "unsent":
      return { title, line: "The request did not start, so nothing changed." };
  }
}

export function projectAddFailure(error: WriteError): SetupFailure {
  return setupWriteFailure("Tasma cannot add the project.", "the project", error);
}

export function workflowAddFailure(error: WriteError): SetupFailure {
  return setupWriteFailure("Tasma cannot add the workflow.", "the workflow", error);
}

export const FOLDER_DIALOG_FAILURE: SetupFailure = {
  title: "Tasma cannot open the folder dialog.",
  line: "Select \"Choose folder\" to try again. If the dialog does not open, restart Tasma.",
};

export const FILE_OPEN_FAILURE_KEY = "file-open-failure";

/** `status` is the status of the refusal, or null when no answer came. */
export function fileOpenFailure(path: string, status: number | null): Notice {
  return {
    key: FILE_OPEN_FAILURE_KEY,
    form: "failure",
    title: "Tasma cannot open the file.",
    line: status === 404 ? "The file does not exist." : "Try again. If the file does not open, restart Tasma.",
    words: [path],
  };
}

export const FILE_REVEAL_FAILURE_KEY = "file-reveal-failure";

/** `status` is the status of the refusal, or null when no answer came. */
export function fileRevealFailure(path: string, status: number | null): Notice {
  return {
    key: FILE_REVEAL_FAILURE_KEY,
    form: "failure",
    title: "Tasma cannot show the file in Finder.",
    line: status === 404 ? "The file does not exist." : "Try again. If the file does not show, restart Tasma.",
    words: [path],
  };
}

export const COPY_FAILURE_KEY = "copy-failure";

/** What a copy item of the link menu copies. */
export type CopyKind = "link" | "path" | "text";

/**
 * Selected text stays selected on the page, so its notice asks for Command-C.
 * A keyboard user cannot select the words of a notice, so no notice asks for that.
 */
export function copyFailure(what: CopyKind, value: string): Notice {
  if (what === "text") {
    return {
      key: COPY_FAILURE_KEY,
      form: "failure",
      title: "Tasma cannot copy the text.",
      line: "Press Command-C to copy the selected text.",
      words: [],
    };
  }
  return { key: COPY_FAILURE_KEY, form: "failure", title: `Tasma cannot copy the ${what}.`, line: "Try again.", words: [value] };
}

export const BROWSER_OPEN_FAILURE_KEY = "browser-open-failure";

export function browserOpenFailure(name: string, url: string): Notice {
  return {
    key: BROWSER_OPEN_FAILURE_KEY,
    form: "failure",
    title: `Tasma cannot open the link in ${name}.`,
    line: "Try again. If the link does not open, restart Tasma.",
    words: [url],
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
