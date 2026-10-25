import type { AcpObject, ChatEntry, ChatEvent } from "@tasma/protocol";

// Chat logs with the shapes that claude-agent-acp 0.89.1 sends to the daemon.
// The adapter streams each tool use: a `tool_call` with the empty input, an
// update for each complete top-level field but the last, the whole input with
// the content, the result, and the update of the PostToolUse hook.

export const SESSION_ID = "0b6c2f4e-5d1a-4c8e-9f3b-7a2d1e6c4b90";

export function atSeq(seq: number): string {
  return new Date(Date.UTC(2026, 8, 1, 10, 0, seq)).toISOString();
}

/** The events as log entries, with `seq` from `first` up and one second between entries. */
export function chatEntries(events: readonly ChatEvent[], first = 1): ChatEntry[] {
  return events.map((event, index) => ({ seq: first + index, at: atSeq(first + index), event }));
}

export function userMessage(text: string): ChatEvent {
  return { kind: "user", text, client: "web-1" };
}

export function agentUpdate(update: AcpObject): ChatEvent {
  return { kind: "update", update };
}

export function textChunk(text: string, messageId?: string | null): ChatEvent {
  return agentUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
    ...(messageId === undefined ? {} : { messageId }),
  });
}

export function thoughtChunk(text: string, messageId?: string | null): ChatEvent {
  return agentUpdate({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text },
    ...(messageId === undefined ? {} : { messageId }),
  });
}

export function planUpdate(...entries: (readonly [content: string, status: string])[]): ChatEvent {
  return agentUpdate({
    sessionUpdate: "plan",
    entries: entries.map(([content, status]) => ({ content, status, priority: "medium" })),
  });
}

export function toolCall(fields: AcpObject): ChatEvent {
  return agentUpdate({ sessionUpdate: "tool_call", ...fields });
}

export function toolCallUpdate(fields: AcpObject): ChatEvent {
  return agentUpdate({ sessionUpdate: "tool_call_update", ...fields });
}

export function permissionRequest(request: string, toolCall: AcpObject, options: readonly AcpObject[]): ChatEvent {
  return { kind: "permission", request, permission: { sessionId: SESSION_ID, toolCall, options } };
}

export function permissionResolved(request: string, outcome: AcpObject): ChatEvent {
  return { kind: "permission-resolved", request, outcome, client: "web-1" };
}

export function questionRequest(request: string, question: AcpObject): ChatEvent {
  return { kind: "question", request, question: { mode: "form", sessionId: SESSION_ID, ...question } };
}

export function questionResolved(request: string, answer: AcpObject): ChatEvent {
  return { kind: "question-resolved", request, answer, client: "web-1" };
}

export function turnEnd(stopReason = "end_turn"): ChatEvent {
  return { kind: "turn-end", stopReason };
}

/** The `_meta` of a report of a tool, with more keys for `claudeCode` and for `_meta`. */
function toolMeta(toolName: string, claudeCode: AcpObject = {}, meta: AcpObject = {}): AcpObject {
  return { claudeCode: { toolName, ...claudeCode }, ...meta };
}

/** The options of a Bash permission: allow once, allow with a rule, reject. */
export const BASH_OPTIONS: readonly AcpObject[] = [
  { optionId: "allow-once", name: "Yes", kind: "allow_once" },
  { optionId: "allow-with-updates", name: "Yes, and don't ask again for pnpm build commands", kind: "allow_always" },
  { optionId: "reject", name: "No", kind: "reject_once" },
];

const OTHER_SINGLE = "Type your own answer, or add a note to the option you chose above (optional).";

const OTHER_MULTIPLE = "Type your own answer to add to your selection above (optional).";

/** Text and thought chunks with a message id, a plan that changes, and a usage update. */
export const TEXT_LOG: readonly ChatEntry[] = chatEntries([
  userMessage("Rename the parser module."),
  thoughtChunk("Looking at ", "msg_01"),
  thoughtChunk("the module layout.", "msg_01"),
  planUpdate(["Renaming the module", "in_progress"], ["Update the imports", "pending"]),
  textChunk("I renamed ", "msg_02"),
  textChunk("the module.", "msg_02"),
  planUpdate(["Rename the module", "completed"], ["Update the imports", "completed"]),
  agentUpdate({ sessionUpdate: "usage_update", used: 18342, size: 200000, _meta: { "_claude/model": "model-a" } }),
  turnEnd(),
]);

const PARSER_PATH = "/work/saga/src/parser.ts";

const PARSER_BEFORE = 'export function parse(input: string) {\n  return input.split(" ");\n}';

const PARSER_AFTER = 'export function parseAll(input: string) {\n  return input.split(" ");\n}';

const LEXER_PATH = "/work/saga/src/lexer.ts";

const LEXER_TEXT = "export const lexer = 1;\n";

/** An Edit with a diff and the final diff of its hook, and a Write of a new file. */
export const EDIT_LOG: readonly ChatEntry[] = chatEntries([
  userMessage("Split the parser."),
  toolCall({
    toolCallId: "toolu_01EditParser",
    name: "Edit",
    rawInput: {},
    status: "pending",
    title: "Edit",
    kind: "edit",
    content: [],
    locations: [],
    _meta: toolMeta("Edit"),
  }),
  toolCallUpdate({
    toolCallId: "toolu_01EditParser",
    rawInput: { file_path: PARSER_PATH },
    title: "Edit src/parser.ts",
    locations: [{ path: PARSER_PATH }],
    _meta: toolMeta("Edit"),
  }),
  toolCallUpdate({
    toolCallId: "toolu_01EditParser",
    rawInput: { file_path: PARSER_PATH, old_string: "parse(" },
    _meta: toolMeta("Edit"),
  }),
  toolCallUpdate({
    toolCallId: "toolu_01EditParser",
    rawInput: { file_path: PARSER_PATH, old_string: "parse(", new_string: "parseAll(" },
    content: [{ type: "diff", path: PARSER_PATH, oldText: "parse(", newText: "parseAll(" }],
    _meta: toolMeta("Edit"),
  }),
  toolCallUpdate({
    toolCallId: "toolu_01EditParser",
    status: "completed",
    rawOutput: `The file ${PARSER_PATH} has been updated successfully.`,
    _meta: toolMeta("Edit"),
  }),
  toolCallUpdate({
    toolCallId: "toolu_01EditParser",
    content: [{ type: "diff", path: PARSER_PATH, oldText: PARSER_BEFORE, newText: PARSER_AFTER }],
    locations: [{ path: PARSER_PATH, line: 1 }],
    _meta: toolMeta("Edit", {
      toolResponse: {
        filePath: PARSER_PATH,
        oldString: "parse(",
        newString: "parseAll(",
        originalFile: `${PARSER_BEFORE}\n`,
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 3,
            newStart: 1,
            newLines: 3,
            lines: [
              "-export function parse(input: string) {",
              "+export function parseAll(input: string) {",
              '   return input.split(" ");',
              " }",
            ],
          },
        ],
        userModified: false,
        replaceAll: false,
      },
    }),
  }),
  toolCall({
    toolCallId: "toolu_02WriteLexer",
    name: "Write",
    rawInput: {},
    status: "pending",
    title: "Preparing file…",
    kind: "edit",
    content: [],
    locations: [],
    _meta: toolMeta("Write"),
  }),
  toolCallUpdate({
    toolCallId: "toolu_02WriteLexer",
    rawInput: { file_path: LEXER_PATH },
    title: "Write src/lexer.ts",
    locations: [{ path: LEXER_PATH }],
    _meta: toolMeta("Write"),
  }),
  toolCallUpdate({
    toolCallId: "toolu_02WriteLexer",
    rawInput: { file_path: LEXER_PATH, content: LEXER_TEXT },
    content: [{ type: "diff", path: LEXER_PATH, oldText: null, newText: LEXER_TEXT }],
    _meta: toolMeta("Write"),
  }),
  toolCallUpdate({
    toolCallId: "toolu_02WriteLexer",
    status: "completed",
    rawOutput: `File created successfully at: ${LEXER_PATH}`,
    _meta: toolMeta("Write"),
  }),
  toolCallUpdate({
    toolCallId: "toolu_02WriteLexer",
    _meta: toolMeta("Write", {
      toolResponse: { type: "create", filePath: LEXER_PATH, content: LEXER_TEXT, structuredPatch: [], originalFile: null },
    }),
  }),
  textChunk("The parser is split.", "msg_03"),
  turnEnd(),
]);

/** A Bash command, a progress beat, its terminal output, its exit code with the status, and its hook. */
export const TERMINAL_LOG: readonly ChatEntry[] = chatEntries([
  userMessage("Run the tests."),
  toolCall({
    toolCallId: "toolu_03RunTests",
    name: "Bash",
    rawInput: {},
    status: "pending",
    title: "Terminal",
    kind: "execute",
    content: [{ type: "terminal", terminalId: "toolu_03RunTests" }],
    _meta: toolMeta("Bash", {}, { terminal_info: { terminal_id: "toolu_03RunTests" } }),
  }),
  toolCallUpdate({
    toolCallId: "toolu_03RunTests",
    rawInput: { command: "pnpm test" },
    title: "pnpm test",
    _meta: toolMeta("Bash"),
  }),
  toolCallUpdate({
    toolCallId: "toolu_03RunTests",
    rawInput: { command: "pnpm test", description: "Run the tests" },
    _meta: toolMeta("Bash"),
  }),
  toolCallUpdate({
    toolCallId: "toolu_03RunTests",
    status: "in_progress",
    _meta: toolMeta("Bash", { toolResponse: { elapsedTimeSeconds: 2 } }),
  }),
  toolCallUpdate({
    toolCallId: "toolu_03RunTests",
    _meta: { terminal_output: { terminal_id: "toolu_03RunTests", data: "12 passed\n" } },
  }),
  toolCallUpdate({
    toolCallId: "toolu_03RunTests",
    status: "completed",
    _meta: toolMeta("Bash", {}, { terminal_exit: { terminal_id: "toolu_03RunTests", exit_code: 0, signal: null } }),
  }),
  toolCallUpdate({
    toolCallId: "toolu_03RunTests",
    _meta: toolMeta("Bash", { toolResponse: { stdout: "12 passed", stderr: "", interrupted: false } }),
  }),
  textChunk("All tests pass.", "msg_04"),
  turnEnd(),
]);

/** A Bash command that waits for a permission, the selected option, and the run. */
export const PERMISSION_LOG: readonly ChatEntry[] = chatEntries([
  userMessage("Build the app."),
  toolCall({
    toolCallId: "toolu_04BuildApp",
    name: "Bash",
    rawInput: {},
    status: "pending",
    title: "Terminal",
    kind: "execute",
    content: [{ type: "terminal", terminalId: "toolu_04BuildApp" }],
    _meta: toolMeta("Bash", {}, { terminal_info: { terminal_id: "toolu_04BuildApp" } }),
  }),
  toolCallUpdate({
    toolCallId: "toolu_04BuildApp",
    rawInput: { command: "pnpm build" },
    title: "pnpm build",
    _meta: toolMeta("Bash"),
  }),
  toolCallUpdate({
    toolCallId: "toolu_04BuildApp",
    rawInput: { command: "pnpm build", description: "Build the app" },
    _meta: toolMeta("Bash"),
  }),
  permissionRequest(
    "r1",
    {
      toolCallId: "toolu_04BuildApp",
      name: "Bash",
      status: "pending",
      rawInput: { command: "pnpm build", description: "Build the app" },
      title: "pnpm build",
      kind: "execute",
      content: [{ type: "terminal", terminalId: "toolu_04BuildApp" }],
    },
    BASH_OPTIONS,
  ),
  permissionResolved("r1", { outcome: "selected", optionId: "allow-once" }),
  toolCallUpdate({
    toolCallId: "toolu_04BuildApp",
    _meta: { terminal_output: { terminal_id: "toolu_04BuildApp", data: "built in 2.1s\n" } },
  }),
  toolCallUpdate({
    toolCallId: "toolu_04BuildApp",
    status: "completed",
    _meta: toolMeta("Bash", {}, { terminal_exit: { terminal_id: "toolu_04BuildApp", exit_code: 0, signal: null } }),
  }),
  toolCallUpdate({
    toolCallId: "toolu_04BuildApp",
    _meta: toolMeta("Bash", { toolResponse: { stdout: "built in 2.1s", stderr: "", interrupted: false } }),
  }),
  turnEnd(),
]);

const NAME_QUESTION = "Which name should the module take?";

const NAME_INPUT = {
  questions: [
    {
      question: NAME_QUESTION,
      header: "Name",
      multiSelect: false,
      options: [
        { label: "lexer", description: "A short name for the new module" },
        { label: "scanner", description: "The name of the old module" },
      ],
    },
  ],
};

const NAME_RESULT = `User has answered your questions: "${NAME_QUESTION}"="lexer". You can now continue with the user's answers in mind.`;

/** An AskUserQuestion question with one item, its answer, and its result. */
export const QUESTION_LOG: readonly ChatEntry[] = chatEntries([
  userMessage("Name the new module."),
  toolCall({
    toolCallId: "toolu_05AskName",
    name: "AskUserQuestion",
    rawInput: {},
    status: "pending",
    title: "Asking for your input",
    kind: "other",
    content: [],
    _meta: toolMeta("AskUserQuestion"),
  }),
  toolCallUpdate({
    toolCallId: "toolu_05AskName",
    rawInput: NAME_INPUT,
    title: NAME_QUESTION,
    content: [{ type: "content", content: { type: "text", text: NAME_QUESTION } }],
    _meta: toolMeta("AskUserQuestion"),
  }),
  questionRequest("r2", {
    toolCallId: "toolu_05AskName",
    message: NAME_QUESTION,
    requestedSchema: {
      type: "object",
      properties: {
        question_0: {
          type: "string",
          title: "Name",
          oneOf: [
            { const: "lexer", title: "lexer", description: "A short name for the new module" },
            { const: "scanner", title: "scanner", description: "The name of the old module" },
          ],
        },
        question_0_custom: { type: "string", title: "Other", description: OTHER_SINGLE },
      },
    },
  }),
  questionResolved("r2", { action: "accept", content: { question_0: "lexer" } }),
  toolCallUpdate({
    toolCallId: "toolu_05AskName",
    status: "completed",
    rawOutput: NAME_RESULT,
    content: [{ type: "content", content: { type: "text", text: NAME_RESULT } }],
    _meta: toolMeta("AskUserQuestion"),
  }),
  toolCallUpdate({
    toolCallId: "toolu_05AskName",
    _meta: toolMeta("AskUserQuestion", {
      toolResponse: { questions: NAME_INPUT.questions, answers: { [NAME_QUESTION]: "lexer" } },
    }),
  }),
  turnEnd(),
]);

const VERSION_QUESTION = "Which version should the release take?";

const CHECKS_QUESTION = "Which checks should run first?";

const RELEASE_INPUT = {
  questions: [
    {
      question: VERSION_QUESTION,
      header: "Version",
      multiSelect: false,
      options: [
        { label: "2.0.0", description: "A major release" },
        { label: "1.4.0", description: "A minor release" },
      ],
    },
    {
      question: CHECKS_QUESTION,
      header: "Checks",
      multiSelect: true,
      options: [
        { label: "lint", description: "The static checks" },
        { label: "test", description: "The unit tests" },
      ],
    },
  ],
};

const RELEASE_RESULT = `User has answered your questions: "${VERSION_QUESTION}"="2.0.0", "${CHECKS_QUESTION}"="lint, test". You can now continue with the user's answers in mind.`;

/** An AskUserQuestion question with two items, one of them with more than one choice. */
export const QUESTIONS_LOG: readonly ChatEntry[] = chatEntries([
  userMessage("Prepare the release."),
  toolCall({
    toolCallId: "toolu_06AskRelease",
    name: "AskUserQuestion",
    rawInput: {},
    status: "pending",
    title: "Asking for your input",
    kind: "other",
    content: [],
    _meta: toolMeta("AskUserQuestion"),
  }),
  toolCallUpdate({
    toolCallId: "toolu_06AskRelease",
    rawInput: RELEASE_INPUT,
    content: [
      { type: "content", content: { type: "text", text: VERSION_QUESTION } },
      { type: "content", content: { type: "text", text: CHECKS_QUESTION } },
    ],
    _meta: toolMeta("AskUserQuestion"),
  }),
  questionRequest("r3", {
    toolCallId: "toolu_06AskRelease",
    message: "Please answer the following questions.",
    requestedSchema: {
      type: "object",
      properties: {
        question_0: {
          type: "string",
          title: "Version",
          description: VERSION_QUESTION,
          oneOf: [
            { const: "2.0.0", title: "2.0.0", description: "A major release" },
            { const: "1.4.0", title: "1.4.0", description: "A minor release" },
          ],
        },
        question_0_custom: { type: "string", title: "Other", description: OTHER_SINGLE },
        question_1: {
          type: "array",
          title: "Checks",
          description: CHECKS_QUESTION,
          items: {
            anyOf: [
              { const: "lint", title: "lint", description: "The static checks" },
              { const: "test", title: "test", description: "The unit tests" },
            ],
          },
        },
        question_1_custom: { type: "string", title: "Other", description: OTHER_MULTIPLE },
      },
    },
  }),
  questionResolved("r3", { action: "accept", content: { question_0: "2.0.0", question_1: ["lint", "test"] } }),
  toolCallUpdate({
    toolCallId: "toolu_06AskRelease",
    status: "completed",
    rawOutput: RELEASE_RESULT,
    content: [{ type: "content", content: { type: "text", text: RELEASE_RESULT } }],
    _meta: toolMeta("AskUserQuestion"),
  }),
  toolCallUpdate({
    toolCallId: "toolu_06AskRelease",
    _meta: toolMeta("AskUserQuestion", {
      toolResponse: {
        questions: RELEASE_INPUT.questions,
        answers: { [VERSION_QUESTION]: "2.0.0", [CHECKS_QUESTION]: "lint, test" },
      },
    }),
  }),
  turnEnd(),
]);

/** The form that asks to retry a refused request on the fallback model: a question with no tool. */
export const REFUSAL_LOG: readonly ChatEntry[] = chatEntries([
  userMessage("Summarize the release notes."),
  questionRequest("r4", {
    message: "Model A declined this request. Retry with Model B?",
    requestedSchema: {
      type: "object",
      properties: {
        choice: {
          type: "string",
          oneOf: [
            { const: "retry_fallback", title: "Retry with Model B", description: "The session continues on Model B." },
            { const: "cancelled", title: "Keep the refusal", description: "You can send a new message." },
          ],
        },
      },
    },
  }),
  questionResolved("r4", { action: "accept", content: { choice: "retry_fallback" } }),
  textChunk("The release adds a lexer.", "msg_07"),
  turnEnd(),
]);

/** The form of an MCP server, a question with no tool: a yes or no field, and a whole number in a range. */
export const FORM_LOG: readonly ChatEntry[] = chatEntries([
  userMessage("Deploy the preview."),
  questionRequest("r5", {
    message: "The deploy server needs two answers.",
    requestedSchema: {
      type: "object",
      properties: {
        confirm: { type: "boolean", title: "Confirm", description: "Deploy to the preview host?" },
        retries: { type: "integer", title: "Retries", minimum: 1, maximum: 5 },
      },
      required: ["confirm"],
    },
  }),
  questionResolved("r5", { action: "accept", content: { confirm: true, retries: 3 } }),
  textChunk("The preview is deployed.", "msg_08"),
  turnEnd(),
]);

/** The form of an MCP server that asks only to accept or decline: a question with no fields and no tool. */
export const CONFIRM_LOG: readonly ChatEntry[] = chatEntries([
  userMessage("Publish the preview."),
  questionRequest("r6", {
    message: "Publish the preview to the team?",
    requestedSchema: { type: "object", properties: {} },
  }),
  questionResolved("r6", { action: "accept", content: {} }),
  textChunk("The preview is published.", "msg_09"),
  turnEnd(),
]);

export const CHAT_FIXTURES: Readonly<Record<string, readonly ChatEntry[]>> = {
  text: TEXT_LOG,
  edit: EDIT_LOG,
  terminal: TERMINAL_LOG,
  permission: PERMISSION_LOG,
  question: QUESTION_LOG,
  questions: QUESTIONS_LOG,
  refusal: REFUSAL_LOG,
  form: FORM_LOG,
  confirm: CONFIRM_LOG,
};
