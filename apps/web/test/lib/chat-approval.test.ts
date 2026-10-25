import type { RespondToToolApprovalOptions, ToolApprovalAnswer } from "@assistant-ui/react";
import type { ChatEntry, QuestionValue } from "@tasma/protocol";
import { describe, expect, it } from "vitest";
import {
  chatRequestOf,
  permissionAnswer,
  permissionApproval,
  questionAnswer,
  questionApproval,
  questionResponse,
} from "../../src/lib/chat-approval";
import {
  CHAT_VIEW_START,
  foldChatEntries,
  type ChatPermission,
  type ChatQuestion,
  type ChatQuestionField,
  type ChatView,
} from "../../src/lib/chat-fold";
import { CONFIRM_LOG, FORM_LOG, PERMISSION_LOG, QUESTION_LOG, QUESTIONS_LOG, REFUSAL_LOG, TEXT_LOG } from "../chat-fixtures";

function view(entries: readonly ChatEntry[]): ChatView {
  return foldChatEntries(CHAT_VIEW_START, entries);
}

/** The open request of a log cut before the entry that resolves it. */
function openRequest(entries: readonly ChatEntry[], request: string) {
  const found = chatRequestOf(view(entries), request);
  if (found === undefined) {
    throw new Error(`no request ${request}`);
  }
  return found;
}

function openPermission(): ChatPermission {
  const found = openRequest(PERMISSION_LOG.slice(0, 5), "r1");
  if (found.kind !== "permission") {
    throw new Error("not a permission");
  }
  return found.permission;
}

function openQuestion(entries: readonly ChatEntry[], request: string): ChatQuestion {
  const found = openRequest(entries, request);
  if (found.kind !== "question") {
    throw new Error("not a question");
  }
  return found.question;
}

function nameQuestion(): ChatQuestion {
  return openQuestion(QUESTION_LOG.slice(0, 4), "r2");
}

function releaseQuestion(): ChatQuestion {
  return openQuestion(QUESTIONS_LOG.slice(0, 4), "r3");
}

function refusalQuestion(): ChatQuestion {
  return openQuestion(REFUSAL_LOG.slice(0, 2), "r4");
}

function formQuestion(): ChatQuestion {
  return openQuestion(FORM_LOG.slice(0, 2), "r5");
}

function confirmQuestion(): ChatQuestion {
  return openQuestion(CONFIRM_LOG.slice(0, 2), "r6");
}

function field(fields: Partial<ChatQuestionField> & { name: string }): ChatQuestionField {
  return { required: false, multiple: false, choices: [], ...fields };
}

function question(fields: readonly ChatQuestionField[]): ChatQuestion {
  return { request: "q1", message: "Answer.", fields, state: "open" };
}

function accepted(answers: RespondToToolApprovalOptions["answers"]): RespondToToolApprovalOptions {
  return { approvalId: "q1", approved: true, ...(answers === undefined ? {} : { answers }) };
}

describe("permissionApproval", () => {
  it("gives the request id and one kit option for each option, with the kit kind and the name as the label", () => {
    expect(permissionApproval(openPermission())).toEqual({
      id: "r1",
      options: [
        { id: "allow-once", kind: "allow-once", label: "Yes" },
        { id: "allow-with-updates", kind: "allow-always", label: "Yes, and don't ask again for pnpm build commands" },
        { id: "reject", kind: "reject-once", label: "No" },
      ],
    });
  });

  it("gives each ACP kind its kit kind, and keeps another kind as it is", () => {
    const permission: ChatPermission = {
      request: "p1",
      state: "open",
      options: [
        { id: "a", name: "A", kind: "allow_once" },
        { id: "b", name: "B", kind: "allow_always" },
        { id: "c", name: "C", kind: "reject_once" },
        { id: "d", name: "D", kind: "reject_always" },
        { id: "e", name: "E", kind: "plan_mode" },
        { id: "f", name: "F", kind: "" },
      ],
    };

    expect(permissionApproval(permission).options?.map((option) => option.kind)).toEqual([
      "allow-once",
      "allow-always",
      "reject-once",
      "reject-always",
      "plan_mode",
      "",
    ]);
  });

  it("keeps a kind that names a property of every object as it is", () => {
    const kinds = ["toString", "constructor", "__proto__"];
    const permission: ChatPermission = {
      request: "p1",
      state: "open",
      options: kinds.map((kind) => ({ id: kind, name: kind, kind })),
    };

    expect(permissionApproval(permission).options?.map((option) => option.kind)).toEqual(kinds);
  });
});

describe("permissionAnswer", () => {
  it("gives the chosen option", () => {
    expect(permissionAnswer({ approvalId: "r1", approved: true, optionId: "allow-once" })).toEqual({ optionId: "allow-once" });
  });

  it.each([true, false])("refuses an answer with no option, approved %s", (approved) => {
    expect(() => permissionAnswer({ approvalId: "r1", approved })).toThrow(
      "This request has no options to choose. To end it, stop the turn with the Stop generating button.",
    );
  });
});

describe("questionApproval", () => {
  it("joins the custom field of AskUserQuestion to its question as free text, and names it by the title", () => {
    expect(questionApproval(nameQuestion())).toEqual({
      id: "r2",
      display: "questions",
      dismissible: true,
      questions: [
        {
          id: "question_0",
          prompt: "Name",
          allowFreeform: true,
          options: [
            { id: "lexer", label: "lexer", description: "A short name for the new module" },
            { id: "scanner", label: "scanner", description: "The name of the old module" },
          ],
        },
      ],
    });
  });

  it("gives a question with a description the description as the prompt and the title as the header, and a list several choices", () => {
    const { questions } = questionApproval(releaseQuestion());

    expect(questions).toEqual([
      expect.objectContaining({
        id: "question_0",
        prompt: "Which version should the release take?",
        header: "Version",
        allowFreeform: true,
      }),
      expect.objectContaining({
        id: "question_1",
        prompt: "Which checks should run first?",
        header: "Checks",
        multiple: true,
        allowFreeform: true,
      }),
    ]);
    expect(questions?.[0]).not.toHaveProperty("multiple");
    expect(questions?.[1]?.options?.map((option) => option.id)).toEqual(["lint", "test"]);
  });

  it("names a field with no title and no description by its name, with no free text", () => {
    expect(questionApproval(refusalQuestion()).questions).toEqual([
      {
        id: "choice",
        prompt: "choice",
        options: [
          { id: "retry_fallback", label: "Retry with Model B", description: "The session continues on Model B." },
          { id: "cancelled", label: "Keep the refusal", description: "You can send a new message." },
        ],
      },
    ]);
  });

  it("gives a yes or no field the options Yes and No, and a number a text field", () => {
    expect(questionApproval(formQuestion()).questions).toEqual([
      {
        id: "confirm",
        prompt: "Deploy to the preview host?",
        header: "Confirm",
        options: [
          { id: "true", label: "Yes" },
          { id: "false", label: "No" },
        ],
      },
      { id: "retries", prompt: "Retries" },
    ]);
  });

  it("keeps a custom field as a question when its base field has no choices, or there is no base field", () => {
    const { questions } = questionApproval(question([
      field({ name: "note", type: "string" }),
      field({ name: "note_custom", type: "string" }),
      field({ name: "alone_custom", type: "string" }),
    ]));

    expect(questions?.map(({ id, allowFreeform }) => [id, allowFreeform])).toEqual([
      ["note", undefined],
      ["note_custom", undefined],
      ["alone_custom", undefined],
    ]);
  });

  it("gives a question with no fields an Accept and a Decline option, not a form", () => {
    expect(questionApproval(confirmQuestion())).toEqual({
      id: "r6",
      options: [
        { id: "accept", kind: "allow-once", label: "Accept" },
        { id: "decline", kind: "reject-once", label: "Decline" },
      ],
    });
  });

  it("keeps a custom field with choices as a question of its own", () => {
    const { questions } = questionApproval(question([
      field({ name: "size", choices: [{ value: "s", label: "Small" }] }),
      field({ name: "size_custom", choices: [{ value: "m", label: "Medium" }] }),
    ]));

    expect(questions?.map(({ id, allowFreeform }) => [id, allowFreeform])).toEqual([
      ["size", undefined],
      ["size_custom", undefined],
    ]);
  });
});

describe("questionAnswer", () => {
  it("declines a dismissal", () => {
    expect(questionAnswer(nameQuestion(), { approvalId: "r2", approved: false })).toEqual({ action: "decline" });
  });

  it("gives one choice as its value, and the free text under the custom field", () => {
    expect(questionAnswer(nameQuestion(), accepted({ question_0: { optionIds: ["lexer"], text: "lexer2" } }))).toEqual({
      action: "accept",
      content: { question_0: "lexer", question_0_custom: "lexer2" },
    });
  });

  it("gives several choices as a list, and leaves out a question with no answer", () => {
    expect(questionAnswer(releaseQuestion(), accepted({ question_1: { optionIds: ["lint", "test"] } }))).toEqual({
      action: "accept",
      content: { question_1: ["lint", "test"] },
    });
  });

  it("gives only the free text when no choice is selected", () => {
    expect(questionAnswer(nameQuestion(), accepted({ question_0: { text: "parser" } }))).toEqual({
      action: "accept",
      content: { question_0_custom: "parser" },
    });
  });

  it("gives Yes as true and No as false, and a whole number as a number", () => {
    expect(questionAnswer(formQuestion(), accepted({ confirm: { optionIds: ["true"] }, retries: { text: " 3 " } }))).toEqual({
      action: "accept",
      content: { confirm: true, retries: 3 },
    });
    expect(questionAnswer(formQuestion(), accepted({ confirm: { optionIds: ["false"] } }))).toEqual({
      action: "accept",
      content: { confirm: false },
    });
  });

  it("gives a text field, and a field of another type or no type, the text as typed", () => {
    const form = question([
      field({ name: "note", type: "string" }),
      field({ name: "path", type: "uri-list" }),
      field({ name: "any" }),
    ]);

    expect(questionAnswer(form, accepted({ note: { text: "Ship it " }, path: { text: "/a" }, any: { text: "x" } }))).toEqual({
      action: "accept",
      content: { note: "Ship it ", path: "/a", any: "x" },
    });
  });

  it("gives a number with a fraction", () => {
    const form = question([field({ name: "ratio", type: "number" })]);

    expect(questionAnswer(form, accepted({ ratio: { text: "0.5" } }))).toEqual({ action: "accept", content: { ratio: 0.5 } });
  });

  it("gives an accept with no content for no answers", () => {
    expect(questionAnswer(formQuestion(), { approvalId: "r5", approved: true })).toEqual({ action: "accept", content: {} });
  });

  it("gives Accept of a question with no fields as an accept with no content, and Decline as a decline", () => {
    expect(questionAnswer(confirmQuestion(), { approvalId: "r6", approved: true, optionId: "accept" })).toEqual({
      action: "accept",
      content: {},
    });
    expect(questionAnswer(confirmQuestion(), { approvalId: "r6", approved: false, optionId: "decline" })).toEqual({
      action: "decline",
    });
  });

  it("refuses a whole number out of its range, and names the field by its title", () => {
    expect(() => questionAnswer(formQuestion(), accepted({ retries: { text: "9" } }))).toThrow(
      "Retries: type a whole number from 1 to 5.",
    );
    expect(() => questionAnswer(formQuestion(), accepted({ retries: { text: "0" } }))).toThrow(
      "Retries: type a whole number from 1 to 5.",
    );
  });

  it("refuses a fraction for a whole number", () => {
    expect(() => questionAnswer(formQuestion(), accepted({ retries: { text: "2.5" } }))).toThrow(
      "Retries: type a whole number from 1 to 5.",
    );
  });

  it("refuses text that is not a number, with one line for each bad field, named by the prompt with no title", () => {
    const form = question([
      field({ name: "count", type: "integer" }),
      field({ name: "ratio", type: "number", description: "The ratio of the split" }),
      field({ name: "low", type: "number", minimum: 2 }),
      field({ name: "high", type: "number", maximum: 8 }),
    ]);

    expect(() => questionAnswer(form, accepted({
      count: { text: "many" },
      ratio: { text: "1e" },
      low: { text: "1" },
      high: { text: "9" },
    }))).toThrow([
      "count: type a whole number.",
      "The ratio of the split: type a number.",
      "low: type a number of 2 or more.",
      "high: type a number of 8 or less.",
    ].join("\n"));
  });

  it("accepts a number at each end of its range", () => {
    expect(questionAnswer(formQuestion(), accepted({ retries: { text: "1" } }))).toEqual({ action: "accept", content: { retries: 1 } });
    expect(questionAnswer(formQuestion(), accepted({ retries: { text: "5" } }))).toEqual({ action: "accept", content: { retries: 5 } });
  });

  const CHECKS = [{ value: "lint", label: "lint" }, { value: "test", label: "test" }];

  it.each<[string, Omit<Partial<ChatQuestionField>, "name">, ToolApprovalAnswer, QuestionValue]>([
    ["a text", { type: "string" }, { text: "lexer" }, "lexer"],
    ["one choice", { choices: CHECKS }, { optionIds: ["lint"] }, "lint"],
    ["several choices", { multiple: true, choices: CHECKS }, { optionIds: ["lint", "test"] }, ["lint", "test"]],
    ["a yes", { type: "boolean" }, { optionIds: ["true"] }, true],
    ["a number", { type: "integer" }, { text: "3" }, 3],
  ])("sends %s of a field named __proto__ under that name", (_name, fields, answer, value) => {
    const reply = questionAnswer(question([field({ name: "__proto__", ...fields })]), accepted({ ["__proto__"]: answer }));

    expect(JSON.stringify(reply)).toBe(JSON.stringify({ action: "accept", content: { ["__proto__"]: value } }));
  });
});

describe("questionResponse", () => {
  it("gives the answers of the kit form as an accept", () => {
    const answers = { choice: { optionIds: ["retry_fallback"] } };

    expect(questionResponse("r4", { answers })).toEqual({ approvalId: "r4", approved: true, answers });
  });

  it("gives Dismiss as a decline", () => {
    expect(questionResponse("r4", { approved: false })).toEqual({ approvalId: "r4", approved: false });
  });

  it("gives Accept of a question with no fields as an accept, and Decline as a decline", () => {
    expect(questionResponse("r6", { optionId: "accept" })).toEqual({ approvalId: "r6", approved: true });
    expect(questionResponse("r6", { optionId: "decline" })).toEqual({ approvalId: "r6", approved: false });
  });
});

describe("chatRequestOf", () => {
  it("finds a permission", () => {
    expect(chatRequestOf(view(PERMISSION_LOG.slice(0, 5)), "r1")).toEqual({ kind: "permission", permission: openPermission() });
  });

  it("finds a question on a tool, and a question with no tool", () => {
    expect(chatRequestOf(view(QUESTION_LOG.slice(0, 4)), "r2")).toMatchObject({ kind: "question", question: { request: "r2" } });
    expect(chatRequestOf(view(REFUSAL_LOG.slice(0, 2)), "r4")).toMatchObject({ kind: "question", question: { request: "r4" } });
  });

  it("finds a closed request too", () => {
    expect(chatRequestOf(view(PERMISSION_LOG), "r1")).toMatchObject({ kind: "permission", permission: { state: "selected" } });
  });

  it("finds nothing for a request that is not in the chat", () => {
    expect(chatRequestOf(view(PERMISSION_LOG), "r9")).toBeUndefined();
    expect(chatRequestOf(view(QUESTION_LOG), "r1")).toBeUndefined();
    expect(chatRequestOf(view(TEXT_LOG), "r1")).toBeUndefined();
  });
});
