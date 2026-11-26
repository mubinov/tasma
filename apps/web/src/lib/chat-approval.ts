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
import type { ChatPermission, ChatQuestion, ChatQuestionField, ChatTool, ChatView } from "./chat-fold";

/** The `approval` of a kit tool part. */
export type ChatApproval = NonNullable<ToolCallMessagePart["approval"]>;

/** A request of a chat, found by its id. */
export type ChatRequest = { kind: "permission"; permission: ChatPermission } | { kind: "question"; question: ChatQuestion };

/** A request, with the tool of a permission request. */
export type ChatRequestItem
  = | { kind: "permission"; permission: ChatPermission; tool: ChatTool }
    | { kind: "question"; question: ChatQuestion };

export function chatRequestId(request: ChatRequest): string {
  return request.kind === "permission" ? request.permission.request : request.question.request;
}

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

const NO_OPTIONS = "This request has no option for this answer. To end it, stop the turn with the Stop generating button. The button shows when the message field is empty.";

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
    const free = fields.filter((other) => other.choices.length === 0);
    return free.find((other) => other.noteOf === field.name) ?? free.find((other) => other.name === `${field.name}${CUSTOM_SUFFIX}`);
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
      } else if (field.otherChoice !== undefined && text !== undefined) {
        content.push([field.name, field.otherChoice]);
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
 * The kit form of the request panel answers no tool part, so no runtime
 * changes its response into the options that `permissionAnswer` and
 * `questionAnswer` read.
 */
export function requestResponse(request: ChatRequest, response: ToolApprovalResponse): RespondToToolApprovalOptions {
  const approvalId = chatRequestId(request);
  if (request.kind === "permission") {
    if ("optionId" in response) {
      return { approvalId, approved: true, optionId: response.optionId };
    }
    return { approvalId, approved: "approved" in response && response.approved };
  }
  if ("answers" in response) {
    return { approvalId, approved: true, answers: response.answers };
  }
  return { approvalId, approved: "optionId" in response && response.optionId === ACCEPT_OPTION_ID };
}

/** A request of the chat, open or closed. */
export function chatRequestOf(view: ChatView, id: string): ChatRequestItem | undefined {
  for (const message of view.messages) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const part of message.parts) {
      if (part.type === "tool" && part.tool.permission?.request === id) {
        return { kind: "permission", permission: part.tool.permission, tool: part.tool };
      }
      const question = part.type === "question" ? part.question : part.type === "tool" ? part.tool.question : undefined;
      if (question?.request === id) {
        return { kind: "question", question };
      }
    }
  }
  return undefined;
}

/** The open requests, in the order they opened. */
export function chatOpenRequests(view: ChatView): ChatRequestItem[] {
  return view.fold.open.flatMap((id) => chatRequestOf(view, id) ?? []);
}
