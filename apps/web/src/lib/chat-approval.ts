import type {
  RespondToToolApprovalOptions,
  ToolApprovalAnswer,
  ToolApprovalOption,
  ToolApprovalQuestion,
  ToolApprovalResponse,
  ToolCallMessagePart,
} from "@assistant-ui/react";
import type { QuestionValue } from "@tasma/protocol";
import type { ChatQuestionReply } from "../api/mutations";
import type { ChatPermission, ChatQuestion, ChatQuestionField, ChatView } from "./chat-fold";

/** The `approval` of a kit tool part. */
export type ChatApproval = NonNullable<ToolCallMessagePart["approval"]>;

/** A request of a chat, found by its id. */
export type ChatRequest = { kind: "permission"; permission: ChatPermission } | { kind: "question"; question: ChatQuestion };

/** One kit question: a field, and the field that holds its free text. */
type QuestionItem = { field: ChatQuestionField; custom?: ChatQuestionField };

const KIT_KINDS: Readonly<Record<string, string>> = {
  allow_once: "allow-once",
  allow_always: "allow-always",
  reject_once: "reject-once",
  reject_always: "reject-always",
};

const BOOLEAN_OPTIONS = [
  { id: "true", label: "Yes" },
  { id: "false", label: "No" },
];

/** The suffix of the field that AskUserQuestion adds for the "Other" text of a question. */
const CUSTOM_SUFFIX = "_custom";

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

const NO_OPTIONS = "This request has no options to choose. To end it, stop the turn with the Stop generating button.";

const ACCEPT_OPTION_ID = "accept";

/** The kit form keeps Send disabled while it has no questions, so a question with no fields gets these instead. */
const DECISION_OPTIONS: readonly ToolApprovalOption[] = [
  { id: ACCEPT_OPTION_ID, kind: "allow-once", label: "Accept" },
  { id: "decline", kind: "reject-once", label: "Decline" },
];

/** The agent picks the key, which can name a property of `Object.prototype`. */
function ownValue<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

export function permissionApproval(permission: ChatPermission): ChatApproval {
  return {
    id: permission.request,
    options: permission.options.map(({ id, kind, name }) => ({
      id,
      kind: ownValue(KIT_KINDS, kind) ?? kind,
      label: name,
    })),
  };
}

/** The kit "Allow" and "Deny", which a request with no reject option or no options gets, choose no option. */
export function permissionAnswer(options: RespondToToolApprovalOptions): { optionId: string } {
  if (options.optionId === undefined) {
    throw new Error(NO_OPTIONS);
  }
  return { optionId: options.optionId };
}

export function questionApproval(question: ChatQuestion): ChatApproval {
  const items = questionItems(question);

  if (items.length === 0) {
    return { id: question.request, options: DECISION_OPTIONS };
  }
  return { id: question.request, display: "questions", dismissible: true, questions: items.map(kitQuestion) };
}

function questionItems(question: ChatQuestion): QuestionItem[] {
  const { fields } = question;
  const customOf = (field: ChatQuestionField): ChatQuestionField | undefined => {
    if (field.choices.length === 0) {
      return undefined;
    }
    return fields.find((other) => other.name === `${field.name}${CUSTOM_SUFFIX}` && other.choices.length === 0);
  };
  const customs = new Set(fields.flatMap((field) => customOf(field) ?? []));

  return fields.flatMap((field) => {
    if (customs.has(field)) {
      return [];
    }
    const custom = customOf(field);
    return [custom === undefined ? { field } : { field, custom }];
  });
}

function kitQuestion({ field, custom }: QuestionItem): ToolApprovalQuestion {
  const prompt = field.description ?? field.title ?? field.name;
  const header = field.description !== undefined && field.title !== undefined ? field.title : undefined;
  const choices = field.choices.map(({ value, label, description }) => ({
    id: value,
    label,
    ...(description === undefined ? {} : { description }),
  }));
  const options = choices.length > 0 ? choices : field.type === "boolean" ? BOOLEAN_OPTIONS : undefined;

  return {
    id: field.name,
    prompt,
    ...(header === undefined ? {} : { header }),
    ...(options === undefined ? {} : { options }),
    ...(field.multiple && field.choices.length > 0 ? { multiple: true } : {}),
    ...(custom === undefined ? {} : { allowFreeform: true }),
  };
}

/** Refuses a bad number with one line for each bad field, which the kit shows under its form. */
export function questionAnswer(question: ChatQuestion, options: RespondToToolApprovalOptions): ChatQuestionReply {
  if (!options.approved) {
    return { action: "decline" };
  }

  // Entries, not assignments: a field named `__proto__` would set the prototype.
  const content: [string, QuestionValue][] = [];
  const errors: string[] = [];

  for (const { field, custom } of questionItems(question)) {
    const answer: ToolApprovalAnswer = ownValue(options.answers, field.name) ?? {};
    const chosen = answer.optionIds ?? [];
    const { text } = answer;

    if (field.choices.length > 0) {
      if (field.multiple && chosen.length > 0) {
        content.push([field.name, [...chosen]]);
      } else if (chosen[0] !== undefined) {
        content.push([field.name, chosen[0]]);
      }
      if (custom !== undefined && text !== undefined) {
        content.push([custom.name, text]);
      }
    } else if (field.type === "boolean") {
      if (chosen[0] !== undefined) {
        content.push([field.name, chosen[0] === "true"]);
      }
    } else if (text !== undefined) {
      if (field.type === "number" || field.type === "integer") {
        const value = numberOf(field, text);
        if (value === undefined) {
          errors.push(numberError(field));
        } else {
          content.push([field.name, value]);
        }
      } else {
        content.push([field.name, text]);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
  return { action: "accept", content: Object.fromEntries(content) };
}

function numberOf(field: ChatQuestionField, text: string): number | undefined {
  const trimmed = text.trim();
  if (!NUMBER.test(trimmed)) {
    return undefined;
  }
  const value = Number(trimmed);
  const fits = Number.isFinite(value)
    && (field.type !== "integer" || Number.isInteger(value))
    && (field.minimum === undefined || value >= field.minimum)
    && (field.maximum === undefined || value <= field.maximum);
  return fits ? value : undefined;
}

function numberError(field: ChatQuestionField): string {
  const name = field.title ?? field.description ?? field.name;
  const kind = field.type === "integer" ? "a whole number" : "a number";
  return `${name}: type ${kind}${rangeText(field)}.`;
}

function rangeText({ minimum, maximum }: ChatQuestionField): string {
  if (minimum !== undefined && maximum !== undefined) {
    return ` from ${String(minimum)} to ${String(maximum)}`;
  }
  if (minimum !== undefined) {
    return ` of ${String(minimum)} or more`;
  }
  return maximum === undefined ? "" : ` of ${String(maximum)} or less`;
}

/**
 * The kit view of a question with no tool answers no tool part, so no runtime
 * changes its response into the options that `questionAnswer` reads.
 */
export function questionResponse(approvalId: string, response: ToolApprovalResponse): RespondToToolApprovalOptions {
  if ("answers" in response) {
    return { approvalId, approved: true, answers: response.answers };
  }
  return { approvalId, approved: "optionId" in response && response.optionId === ACCEPT_OPTION_ID };
}

export function chatRequestOf(view: ChatView, request: string): ChatRequest | undefined {
  for (const message of view.messages) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const part of message.parts) {
      if (part.type === "tool" && part.tool.permission?.request === request) {
        return { kind: "permission", permission: part.tool.permission };
      }
      const question = part.type === "question" ? part.question : part.type === "tool" ? part.tool.question : undefined;
      if (question?.request === request) {
        return { kind: "question", question };
      }
    }
  }
  return undefined;
}
