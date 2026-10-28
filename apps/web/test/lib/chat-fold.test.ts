import { CHAT_START, foldChat, type ChatEntry, type ChatEvent } from "@tasma/protocol";
import { describe, expect, it } from "vitest";
import {
  CHAT_VIEW_START,
  chatBusy,
  foldChatEntries,
  type ChatAgentMessage,
  type ChatOption,
  type ChatOptionValue,
  type ChatPart,
  type ChatQuestion,
  type ChatQuestionField,
  type ChatTool,
  type ChatView,
} from "../../src/lib/chat-fold";
import {
  agentUpdate,
  atSeq,
  BASH_OPTIONS,
  BOOLEAN_OPTION,
  CHAT_FIXTURES,
  chatEntries,
  EDIT_LOG,
  MODEL_OPTION,
  modeOption,
  modeUpdate,
  optionsUpdate,
  PERMISSION_LOG,
  permissionRequest,
  permissionResolved,
  planUpdate,
  QUESTION_LOG,
  questionRequest,
  questionResolved,
  QUESTIONS_LOG,
  REFUSAL_LOG,
  TERMINAL_LOG,
  TEXT_LOG,
  textChunk,
  thoughtChunk,
  toolCall,
  toolCallUpdate,
  turnEnd,
  userMessage,
} from "../chat-fixtures";

/** Folds the events after the view, with `seq` from the next number up. */
function foldEvents(events: readonly ChatEvent[], view: ChatView = CHAT_VIEW_START): ChatView {
  return foldChatEntries(view, chatEntries(events, view.seq + 1));
}

function agentAt(view: ChatView, index: number): ChatAgentMessage {
  const message = view.messages[index];
  if (message?.role !== "assistant") {
    throw new Error(`message ${index} is not an assistant message`);
  }
  return message;
}

function partsAt(view: ChatView, index: number): readonly ChatPart[] {
  return agentAt(view, index).parts;
}

function toolsOf(view: ChatView): ChatTool[] {
  return view.messages.flatMap((message) =>
    message.role === "assistant" ? message.parts.flatMap((part) => (part.type === "tool" ? [part.tool] : [])) : [],
  );
}

function toolOf(view: ChatView, id: string): ChatTool {
  const found = toolsOf(view).find((each) => each.id === id);
  if (found === undefined) {
    throw new Error(`no tool ${id}`);
  }
  return found;
}

/** The questions of the question parts, in the order of the messages. */
function questionsOf(view: ChatView): ChatQuestion[] {
  return view.messages.flatMap((message) =>
    message.role === "assistant" ? message.parts.flatMap((part) => (part.type === "question" ? [part.question] : [])) : [],
  );
}

function tool(fields: Partial<ChatTool> & { id: string }): ChatTool {
  return { title: "", kind: "other", status: "pending", stopped: false, content: [], terminals: {}, ...fields };
}

function foldOf(entries: readonly ChatEntry[]) {
  return entries.reduce((fold, entry) => foldChat(fold, entry.event), CHAT_START);
}

const NAME_SCHEMA = {
  type: "object",
  properties: { name: { type: "string", title: "Name", enum: ["lexer", "scanner"] } },
};

const NAME_FIELD: ChatQuestionField = {
  name: "name",
  type: "string",
  title: "Name",
  required: false,
  multiple: false,
  choices: [
    { value: "lexer", label: "lexer" },
    { value: "scanner", label: "scanner" },
  ],
};

/** A field of type string with no choices and no limits. */
function textField(fields: Partial<ChatQuestionField> & { name: string }): ChatQuestionField {
  return { type: "string", required: false, multiple: false, choices: [], ...fields };
}

describe("foldChatEntries: user", () => {
  it("adds a user message with the id u<seq>", () => {
    const view = foldEvents([userMessage("Rename the parser.")]);

    expect(view.messages).toEqual([{ role: "user", id: "u1", at: atSeq(1), text: "Rename the parser." }]);
  });

  it("closes the open message before it adds the user message", () => {
    const view = foldEvents([textChunk("Ready."), userMessage("Go on."), textChunk("Working.")]);

    expect(view.messages).toEqual([
      { role: "assistant", id: "a1", at: atSeq(1), parts: [{ type: "text", text: "Ready." }], open: false, running: false },
      { role: "user", id: "u2", at: atSeq(2), text: "Go on." },
      { role: "assistant", id: "a3", at: atSeq(3), parts: [{ type: "text", text: "Working." }], open: true, running: true },
    ]);
  });
});

describe("foldChatEntries: text and thought chunks", () => {
  it("joins chunks with the same message id into one text part", () => {
    const view = foldEvents([userMessage("Hi."), textChunk("Hello, ", "m1"), textChunk("there.", "m1")]);

    expect(partsAt(view, 1)).toEqual([{ type: "text", text: "Hello, there.", messageId: "m1" }]);
  });

  it("starts a new text part for a new message id", () => {
    const view = foldEvents([textChunk("One.", "m1"), textChunk("Two.", "m2")]);

    expect(partsAt(view, 0)).toEqual([
      { type: "text", text: "One.", messageId: "m1" },
      { type: "text", text: "Two.", messageId: "m2" },
    ]);
  });

  it("starts a new text part after a thought, with the same message id", () => {
    const view = foldEvents([textChunk("One.", "m1"), thoughtChunk("Hmm.", "m1"), textChunk("Two.", "m1")]);

    expect(partsAt(view, 0)).toEqual([
      { type: "text", text: "One.", messageId: "m1" },
      { type: "reasoning", text: "Hmm.", messageId: "m1" },
      { type: "text", text: "Two.", messageId: "m1" },
    ]);
  });

  it("joins thought chunks with the same message id into one reasoning part", () => {
    const view = foldEvents([thoughtChunk("Looking ", "m1"), thoughtChunk("around.", "m1")]);

    expect(partsAt(view, 0)).toEqual([{ type: "reasoning", text: "Looking around.", messageId: "m1" }]);
  });

  it("counts a null or a non-string message id as absent", () => {
    const view = foldEvents([
      textChunk("One, ", null),
      textChunk("two, "),
      agentUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "three." }, messageId: 7 }),
    ]);

    expect(partsAt(view, 0)).toEqual([{ type: "text", text: "One, two, three." }]);
  });

  it("skips a chunk whose content is not text, and opens no message for it", () => {
    const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
    const view = foldEvents([
      agentUpdate({ sessionUpdate: "agent_message_chunk", content: image }),
      agentUpdate({ sessionUpdate: "agent_thought_chunk", content: "plain" }),
      agentUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: 3 } }),
    ]);

    expect(view.messages).toEqual([]);
    expect(view.seq).toBe(3);
  });

  it("adds no part to the open message for a chunk that is not text", () => {
    const view = foldEvents([
      textChunk("One."),
      agentUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "audio", data: "", mimeType: "audio/wav" } }),
    ]);

    expect(partsAt(view, 0)).toEqual([{ type: "text", text: "One." }]);
  });
});

describe("foldChatEntries: plan", () => {
  it("adds a plan part, and replaces its entries at its place on the next plan", () => {
    const view = foldEvents([
      planUpdate(["Read", "in_progress"], ["Write", "pending"]),
      textChunk("Reading."),
      planUpdate(["Read", "completed"], ["Write", "in_progress"]),
    ]);

    expect(partsAt(view, 0)).toEqual([
      {
        type: "plan",
        entries: [
          { content: "Read", status: "completed" },
          { content: "Write", status: "in_progress" },
        ],
      },
      { type: "text", text: "Reading." },
    ]);
  });

  it("skips an entry with no string content, and reads an unknown status as pending", () => {
    const view = foldEvents([
      agentUpdate({
        sessionUpdate: "plan",
        entries: [
          { content: "Read", status: "done" },
          { content: 4, status: "pending" },
          { status: "pending" },
          "Write",
          { content: "Test" },
        ],
      }),
    ]);

    expect(partsAt(view, 0)).toEqual([
      {
        type: "plan",
        entries: [
          { content: "Read", status: "pending" },
          { content: "Test", status: "pending" },
        ],
      },
    ]);
  });

  it("reads a plan with no entry list as an empty plan", () => {
    const view = foldEvents([planUpdate(["Read", "pending"]), agentUpdate({ sessionUpdate: "plan" })]);

    expect(partsAt(view, 0)).toEqual([{ type: "plan", entries: [] }]);
  });
});

describe("foldChatEntries: tool calls", () => {
  it("adds a tool part with the fields of the tool call, and takes the fields of each report of the input", () => {
    const first = foldChatEntries(CHAT_VIEW_START, EDIT_LOG.slice(0, 2));
    const view = foldChatEntries(first, EDIT_LOG.slice(2, 5));

    expect(partsAt(first, 1)).toEqual([
      { type: "tool", tool: tool({ id: "toolu_01EditParser", title: "Edit", kind: "edit", input: {} }) },
    ]);
    expect(partsAt(view, 1)).toEqual([
      {
        type: "tool",
        tool: tool({
          id: "toolu_01EditParser",
          title: "Edit src/parser.ts",
          kind: "edit",
          status: "pending",
          input: { file_path: "/work/saga/src/parser.ts", old_string: "parse(", new_string: "parseAll(" },
          content: [{ type: "diff", path: "/work/saga/src/parser.ts", oldText: "parse(", newText: "parseAll(" }],
        }),
      },
    ]);
  });

  it("adds a tool with the defaults for an update of an unknown tool", () => {
    const view = foldEvents([toolCallUpdate({ toolCallId: "t1" })]);

    expect(partsAt(view, 0)).toEqual([{ type: "tool", tool: tool({ id: "t1" }) }]);
  });

  it("replaces the fields that are present, keeps those that are null, and replaces the content whole", () => {
    const first = { type: "content", content: { type: "text", text: "first" } };
    const second = { type: "content", content: { type: "text", text: "second" } };
    const third = { type: "content", content: { type: "text", text: "third" } };
    const view = foldEvents([
      toolCall({ toolCallId: "t1", title: "Read", kind: "read", status: "pending", rawInput: { a: 1 }, content: [first, second] }),
      toolCallUpdate({ toolCallId: "t1", title: null, kind: null, status: null, rawInput: null, rawOutput: null, content: null }),
      toolCallUpdate({ toolCallId: "t1", status: "in_progress", content: [third] }),
      toolCallUpdate({ toolCallId: "t1", title: "Read file", rawOutput: { lines: 3 } }),
    ]);

    expect(toolOf(view, "t1")).toEqual(
      tool({
        id: "t1",
        title: "Read file",
        kind: "read",
        status: "in_progress",
        input: { a: 1 },
        output: { lines: 3 },
        content: [{ type: "text", text: "third" }],
      }),
    );
  });

  it("does not apply a status that ACP does not define, or a title or a kind that is not a string", () => {
    const view = foldEvents([
      toolCall({ toolCallId: "t1", title: "Read", kind: "read", status: "in_progress" }),
      toolCallUpdate({ toolCallId: "t1", title: 3, kind: false, status: "done" }),
    ]);

    expect(toolOf(view, "t1")).toEqual(tool({ id: "t1", title: "Read", kind: "read", status: "in_progress" }));
  });

  it("changes a tool of an earlier message, and adds no part", () => {
    const before = foldEvents([
      userMessage("Read it."),
      toolCall({ toolCallId: "t1", title: "Read", status: "in_progress" }),
      turnEnd(),
      textChunk("Later."),
    ]);
    const view = foldEvents([toolCallUpdate({ toolCallId: "t1", status: "completed" })], before);

    expect(partsAt(view, 1)).toEqual([
      { type: "tool", tool: tool({ id: "t1", title: "Read", status: "completed", stopped: true }) },
    ]);
    expect(view.messages[2]).toBe(before.messages[2]);
  });

  it("skips an update with no tool call id", () => {
    const view = foldEvents([
      toolCall({ title: "Read", status: "pending" }),
      toolCallUpdate({ toolCallId: 5, status: "completed" }),
    ]);

    expect(view.messages).toEqual([]);
  });

  it("maps each kind of tool content, and skips what it cannot show", () => {
    const view = foldEvents([
      toolCall({
        toolCallId: "t1",
        content: [
          { type: "content", content: { type: "text", text: "Found 2 files." } },
          { type: "diff", path: "/work/saga/a.ts", oldText: "a", newText: "b" },
          { type: "diff", path: "/work/saga/new.ts", newText: "new" },
          { type: "diff", path: "/work/saga/null.ts", oldText: null, newText: "c" },
          { type: "terminal", terminalId: "term-1" },
          { type: "content", content: { type: "image", data: "aGVsbG8=", mimeType: "image/png" } },
          { type: "content", content: "text" },
          { type: "content", content: { type: "text", text: 1 } },
          { type: "diff", path: 1, newText: "b" },
          { type: "diff", path: "/work/saga/b.ts" },
          { type: "diff", path: "/work/saga/c.ts", oldText: 1, newText: "b" },
          { type: "terminal" },
          { type: "resource_link", uri: "file:///work/saga/a.ts" },
          "text",
          null,
        ],
      }),
    ]);

    expect(toolOf(view, "t1").content).toEqual([
      { type: "text", text: "Found 2 files." },
      { type: "diff", path: "/work/saga/a.ts", oldText: "a", newText: "b" },
      { type: "diff", path: "/work/saga/new.ts", oldText: null, newText: "new" },
      { type: "diff", path: "/work/saga/null.ts", oldText: null, newText: "c" },
      { type: "terminal", terminal: "term-1" },
    ]);
  });

  it("keeps the path, the old text and the new text of an edit, of the final diff of its hook, and of a new file", () => {
    const view = foldChatEntries(CHAT_VIEW_START, EDIT_LOG);

    expect(toolOf(view, "toolu_01EditParser")).toMatchObject({
      status: "completed",
      output: "The file /work/saga/src/parser.ts has been updated successfully.",
      content: [
        {
          type: "diff",
          path: "/work/saga/src/parser.ts",
          oldText: 'export function parse(input: string) {\n  return input.split(" ");\n}',
          newText: 'export function parseAll(input: string) {\n  return input.split(" ");\n}',
        },
      ],
    });
    expect(toolOf(view, "toolu_02WriteLexer")).toMatchObject({
      title: "Write src/lexer.ts",
      status: "completed",
      content: [{ type: "diff", path: "/work/saga/src/lexer.ts", oldText: null, newText: "export const lexer = 1;\n" }],
    });
  });

  it("joins the output and then the exit code to the terminal of the tool", () => {
    const running = foldChatEntries(CHAT_VIEW_START, TERMINAL_LOG.slice(0, 6));
    const view = foldChatEntries(running, TERMINAL_LOG.slice(6));
    const runTests = tool({
      id: "toolu_03RunTests",
      title: "pnpm test",
      kind: "execute",
      status: "in_progress",
      input: { command: "pnpm test", description: "Run the tests" },
      content: [{ type: "terminal", terminal: "toolu_03RunTests" }],
      terminals: { toolu_03RunTests: { output: "12 passed\n" } },
    });

    expect(toolOf(running, "toolu_03RunTests")).toEqual(runTests);
    expect(toolOf(view, "toolu_03RunTests")).toEqual({
      ...runTests,
      status: "completed",
      terminals: { toolu_03RunTests: { output: "12 passed\n", exitCode: 0 } },
    });
  });

  it("replaces the output with the data of the next output, and keeps each terminal apart", () => {
    const output = (terminal: string, data: string) => ({ terminal_output: { terminal_id: terminal, data } });
    const view = foldEvents([
      toolCallUpdate({ toolCallId: "t1", _meta: output("term-1", "one\n") }),
      toolCallUpdate({ toolCallId: "t1", _meta: output("term-1", "one\ntwo\n") }),
      toolCallUpdate({ toolCallId: "t1", _meta: output("term-2", "other\n") }),
      toolCallUpdate({ toolCallId: "t1", _meta: { terminal_exit: { terminal_id: "term-2", exit_code: null, signal: "SIGTERM" } } }),
    ]);

    expect(toolOf(view, "t1").terminals).toEqual({
      "term-1": { output: "one\ntwo\n" },
      "term-2": { output: "other\n", exitCode: null },
    });
  });

  it("skips terminal meta with no terminal id or no string output, and reads a bad exit code as null", () => {
    const view = foldEvents([
      toolCallUpdate({
        toolCallId: "t1",
        _meta: {
          terminal_output: { terminal_id: "term-1", data: 5 },
          terminal_exit: { terminal_id: "term-1", exit_code: "1" },
        },
      }),
      toolCallUpdate({ toolCallId: "t1", _meta: { terminal_output: { data: "lost" }, terminal_exit: { exit_code: 1 } } }),
      toolCallUpdate({ toolCallId: "t1", _meta: { terminal_output: "lost", terminal_exit: 1 } }),
      toolCallUpdate({ toolCallId: "t1", _meta: "lost" }),
    ]);

    expect(toolOf(view, "t1").terminals).toEqual({ "term-1": { exitCode: null } });
  });

  it("changes nothing for an update that has only a tool response", () => {
    const before = foldChatEntries(CHAT_VIEW_START, EDIT_LOG.slice(0, 11));
    const view = foldChatEntries(before, EDIT_LOG.slice(11, 12));

    expect(view.messages[1]).toBe(before.messages[1]);
    expect(view.seq).toBe(12);
  });
});

describe("foldChatEntries: other updates", () => {
  it("skips the update kinds it does not show, an update with no kind, and an update that is not an object", () => {
    const view = foldEvents([
      agentUpdate({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Hi." } }),
      agentUpdate({ sessionUpdate: "available_commands_update", availableCommands: [] }),
      agentUpdate({ sessionUpdate: "current_mode_update", currentModeId: "plan" }),
      agentUpdate({ sessionUpdate: "config_option_update", configOptions: [] }),
      agentUpdate({ sessionUpdate: "session_info_update", title: "Rename" }),
      agentUpdate({ sessionUpdate: "usage_update", used: 10, size: 100 }),
      agentUpdate({ sessionUpdate: "something_new" }),
      agentUpdate({ content: { type: "text", text: "Hi." } }),
      { kind: "update", update: null } as unknown as ChatEvent,
    ]);

    expect(view.messages).toEqual([]);
    expect(view.seq).toBe(9);
  });
});

describe("foldChatEntries: permission", () => {
  const buildApp = tool({
    id: "toolu_04BuildApp",
    title: "pnpm build",
    kind: "execute",
    input: { command: "pnpm build", description: "Build the app" },
    content: [{ type: "terminal", terminal: "toolu_04BuildApp" }],
    permission: {
      request: "r1",
      options: [
        { id: "allow-once", name: "Yes", kind: "allow_once" },
        { id: "allow-with-updates", name: "Yes, and don't ask again for pnpm build commands", kind: "allow_always" },
        { id: "reject", name: "No", kind: "reject_once" },
      ],
      state: "open",
    },
  });

  it("attaches the permission to its tool", () => {
    const view = foldChatEntries(CHAT_VIEW_START, PERMISSION_LOG.slice(0, 5));

    expect(partsAt(view, 1)).toEqual([{ type: "tool", tool: buildApp }]);
    expect(view.fold.status).toEqual({ state: "needs-you" });
  });

  it("merges the tool call of the request into a tool that has only the empty input", () => {
    const beforeInput = PERMISSION_LOG.filter((entry) => [1, 2, 5].includes(entry.seq));
    const view = foldChatEntries(CHAT_VIEW_START, beforeInput);

    expect(partsAt(view, 1)).toEqual([{ type: "tool", tool: buildApp }]);
  });

  it("gives the tool the id of the request when the tool call has no id, and takes its fields", () => {
    const view = foldEvents([
      permissionRequest("r1", { title: "Fetch", content: [{ type: "terminal", terminalId: "term-1" }] }, BASH_OPTIONS.slice(0, 1)),
    ]);

    expect(toolsOf(view)).toEqual([
      tool({
        id: "r1",
        title: "Fetch",
        content: [{ type: "terminal", terminal: "term-1" }],
        permission: { request: "r1", options: [{ id: "allow-once", name: "Yes", kind: "allow_once" }], state: "open" },
      }),
    ]);
  });

  it("adds a tool for a permission with no tool call or no option list", () => {
    const view = foldEvents([
      { kind: "permission", request: "r1", permission: { sessionId: "s" } },
      { kind: "permission", request: "r2", permission: null } as unknown as ChatEvent,
    ]);

    expect(toolsOf(view)).toEqual([
      tool({ id: "r1", permission: { request: "r1", options: [], state: "open" } }),
      tool({ id: "r2", permission: { request: "r2", options: [], state: "open" } }),
    ]);
  });

  it("skips an option with no string id, names an option by its id, and reads a bad kind as empty", () => {
    const options = [{ name: "Yes", kind: "allow_once" }, { optionId: 3, name: "No" }, { optionId: "allow", kind: 1 }, "reject"];
    const view = foldEvents([{ kind: "permission", request: "r1", permission: { toolCall: { toolCallId: "t1" }, options } }]);

    expect(toolOf(view, "t1").permission?.options).toEqual([{ id: "allow", name: "allow", kind: "" }]);
  });

  it("marks the permission selected with the chosen option", () => {
    const view = foldChatEntries(CHAT_VIEW_START, PERMISSION_LOG);

    expect(toolOf(view, "toolu_04BuildApp")).toMatchObject({
      status: "completed",
      permission: { state: "selected", option: "allow-once" },
      terminals: { toolu_04BuildApp: { output: "built in 2.1s\n", exitCode: 0 } },
    });
    expect(view.fold.status).toEqual({ state: "needs-you" });
  });

  it("marks the permission selected with no option when the option id is not a string", () => {
    const view = foldEvents([
      permissionRequest("r1", { toolCallId: "t1" }, BASH_OPTIONS),
      permissionResolved("r1", { outcome: "selected", optionId: 2 }),
    ]);

    expect(toolOf(view, "t1").permission).toEqual({
      request: "r1",
      options: toolOf(view, "t1").permission?.options,
      state: "selected",
    });
  });

  it("marks the permission cancelled for any outcome other than selected", () => {
    const events = (outcome: unknown) => [
      permissionRequest("r1", { toolCallId: "t1" }, BASH_OPTIONS),
      permissionResolved("r1", { outcome: "selected", optionId: "reject" }),
      { kind: "permission-resolved", request: "r1", outcome } as ChatEvent,
    ];

    for (const outcome of [{ outcome: "cancelled" }, { outcome: "dismissed" }, null]) {
      const permission = toolOf(foldEvents(events(outcome)), "t1").permission;
      expect(permission?.state).toBe("cancelled");
      expect(permission).not.toHaveProperty("option");
    }
  });

  it("skips a resolution of a request that no tool holds", () => {
    const before = foldEvents([toolCall({ toolCallId: "t1", title: "Read" })]);
    const view = foldEvents([permissionResolved("r9", { outcome: "cancelled" })], before);

    expect(view.messages).toEqual(before.messages);
    expect(view.messages[0]).toBe(before.messages[0]);
  });

  it("marks an open permission ended when the turn ends", () => {
    const view = foldEvents([
      userMessage("Clean."),
      permissionRequest("r1", { toolCallId: "t1" }, BASH_OPTIONS),
      turnEnd("cancelled"),
    ]);

    expect(toolOf(view, "t1").permission?.state).toBe("ended");
  });
});

describe("foldChatEntries: question", () => {
  it("sets the question on its tool, with the message as the question of one item", () => {
    const view = foldChatEntries(CHAT_VIEW_START, QUESTION_LOG.slice(0, 4));

    expect(toolOf(view, "toolu_05AskName").question).toEqual({
      request: "r2",
      message: "Which name should the module take?",
      fields: [
        {
          name: "question_0",
          type: "string",
          title: "Name",
          required: false,
          multiple: false,
          choices: [
            { value: "lexer", label: "lexer", description: "A short name for the new module" },
            { value: "scanner", label: "scanner", description: "The name of the old module" },
          ],
        },
        textField({
          name: "question_0_custom",
          title: "Other",
          description: "Type your own answer, or add a note to the option you chose above (optional).",
        }),
      ],
      state: "open",
    } satisfies ChatQuestion);
    expect(partsAt(view, 1)).toHaveLength(1);
  });

  it("gives each item of a question with two items its header, its question, its choices and its kind", () => {
    const view = foldChatEntries(CHAT_VIEW_START, QUESTIONS_LOG.slice(0, 4));
    const question = toolOf(view, "toolu_06AskRelease").question;

    expect(question?.message).toBe("Please answer the following questions.");
    expect(question?.fields).toEqual([
      {
        name: "question_0",
        type: "string",
        title: "Version",
        description: "Which version should the release take?",
        required: false,
        multiple: false,
        choices: [
          { value: "2.0.0", label: "2.0.0", description: "A major release" },
          { value: "1.4.0", label: "1.4.0", description: "A minor release" },
        ],
      },
      textField({
        name: "question_0_custom",
        title: "Other",
        description: "Type your own answer, or add a note to the option you chose above (optional).",
      }),
      {
        name: "question_1",
        type: "array",
        title: "Checks",
        description: "Which checks should run first?",
        required: false,
        multiple: true,
        choices: [
          { value: "lint", label: "lint", description: "The static checks" },
          { value: "test", label: "test", description: "The unit tests" },
        ],
      },
      textField({
        name: "question_1_custom",
        title: "Other",
        description: "Type your own answer to add to your selection above (optional).",
      }),
    ]);
  });

  it("adds a question part to the open message when the question names no tool, with the value of each choice", () => {
    const view = foldChatEntries(CHAT_VIEW_START, REFUSAL_LOG.slice(0, 2));

    expect(partsAt(view, 1)).toEqual([
      {
        type: "question",
        question: {
          request: "r4",
          message: "Model A declined this request. Retry with Model B?",
          fields: [
            {
              name: "choice",
              type: "string",
              required: false,
              multiple: false,
              choices: [
                { value: "retry_fallback", label: "Retry with Model B", description: "The session continues on Model B." },
                { value: "cancelled", label: "Keep the refusal", description: "You can send a new message." },
              ],
            },
          ],
          state: "open",
        },
      },
    ]);
  });

  it("reads the choices from oneOf, anyOf, the items and enum, in that order of preference", () => {
    const view = foldEvents([
      questionRequest("r1", {
        requestedSchema: {
          properties: {
            titles: { oneOf: [{ const: "a", title: "A" }, { const: "b" }, { const: 3, title: "C" }, "c", { title: "D" }] },
            any: { anyOf: [{ const: "d", title: "D", description: "The fourth" }], enum: ["skipped"] },
            items: { type: "array", items: { anyOf: [{ const: "e", description: null }] } },
            itemsOneOf: { type: "array", items: { oneOf: [{ const: "f", title: 6, description: 7 }] } },
            empty: { oneOf: [], enum: ["g", 7, "h"] },
            itemsEnum: { type: "array", items: { enum: ["i", null] } },
            none: { type: "string" },
            bad: "not a property",
          },
        },
      }),
    ]);
    const field = (name: string, choices: ChatQuestionField["choices"], type?: string): ChatQuestionField => ({
      name,
      ...(type === undefined ? {} : { type }),
      required: false,
      multiple: type === "array",
      choices,
    });

    expect(partsAt(view, 0)).toEqual([
      {
        type: "question",
        question: {
          request: "r1",
          message: "",
          fields: [
            field("titles", [
              { value: "a", label: "A" },
              { value: "b", label: "b" },
            ]),
            field("any", [{ value: "d", label: "D", description: "The fourth" }]),
            field("items", [{ value: "e", label: "e" }], "array"),
            field("itemsOneOf", [{ value: "f", label: "f" }], "array"),
            field("empty", [
              { value: "g", label: "g" },
              { value: "h", label: "h" },
            ]),
            field("itemsEnum", [{ value: "i", label: "i" }], "array"),
            field("none", [], "string"),
            field("bad", []),
          ],
          state: "open",
        },
      },
    ]);
  });

  it("marks the fields that the required list of the schema names", () => {
    const properties = { name: { type: "string" }, note: { type: "string" } };
    const view = foldEvents([
      questionRequest("r1", { requestedSchema: { required: ["name", 3, "missing"], properties } }),
      questionRequest("r2", { requestedSchema: { required: "name", properties } }),
    ]);
    expect(questionsOf(view).map((question) => question.fields.map(({ name, required }) => [name, required]))).toEqual([
      [
        ["name", true],
        ["note", false],
      ],
      [
        ["name", false],
        ["note", false],
      ],
    ]);
  });

  it("keeps the type, the default and the limits of each field", () => {
    const view = foldEvents([
      questionRequest("r1", {
        requestedSchema: {
          properties: {
            text: { type: "string", default: "lexer", minLength: 1, maxLength: 40, pattern: "^[a-z]+$", format: "email" },
            count: { type: "integer", default: 3, minimum: 1, maximum: 9 },
            ratio: { type: "number", default: 0.5 },
            flag: { type: "boolean", default: false },
            checks: { type: "array", default: ["lint"], minItems: 1, maxItems: 2, items: { enum: ["lint", "test"] } },
            color: { type: "_saga/color", default: "red" },
          },
        },
      }),
    ]);

    expect(questionsOf(view)[0]?.fields).toEqual([
      textField({ name: "text", default: "lexer", minLength: 1, maxLength: 40, pattern: "^[a-z]+$", format: "email" }),
      textField({ name: "count", type: "integer", default: 3, minimum: 1, maximum: 9 }),
      textField({ name: "ratio", type: "number", default: 0.5 }),
      textField({ name: "flag", type: "boolean", default: false }),
      {
        name: "checks",
        type: "array",
        required: false,
        multiple: true,
        choices: [
          { value: "lint", label: "lint" },
          { value: "test", label: "test" },
        ],
        default: ["lint"],
        minItems: 1,
        maxItems: 2,
      },
      textField({ name: "color", type: "_saga/color" }),
    ]);
  });

  it("drops a type, a title, a default or a limit whose value does not fit", () => {
    const view = foldEvents([
      questionRequest("r1", {
        requestedSchema: {
          properties: {
            text: { type: "string", default: 4, minLength: "1", maxLength: null, pattern: 5, format: null, title: null, description: 2 },
            count: { type: "number", default: "3", minimum: null, maximum: "9" },
            flag: { type: "boolean", default: "false" },
            checks: { type: "array", default: ["lint", 2], minItems: "1", maxItems: null },
            list: { type: "array", default: "lint" },
            none: { type: 5, default: "x" },
          },
        },
      }),
    ]);
    expect(questionsOf(view)[0]?.fields).toEqual([
      textField({ name: "text" }),
      textField({ name: "count", type: "number" }),
      textField({ name: "flag", type: "boolean" }),
      textField({ name: "checks", type: "array", multiple: true }),
      textField({ name: "list", type: "array", multiple: true }),
      { name: "none", required: false, multiple: false, choices: [] },
    ]);
  });

  it("keeps the title and the description of the schema, also when the question is answered", () => {
    const view = foldEvents([
      questionRequest("r1", {
        message: "Set up the deploy.",
        requestedSchema: { title: "Deploy", description: "The settings of the deploy.", properties: {} },
      }),
      questionRequest("r2", { message: "Ready?", requestedSchema: { title: 3, description: null } }),
      questionResolved("r1", { action: "accept", content: {} }),
    ]);

    expect(partsAt(view, 0)).toEqual([
      {
        type: "question",
        question: {
          request: "r1",
          message: "Set up the deploy.",
          title: "Deploy",
          description: "The settings of the deploy.",
          fields: [],
          state: "accepted",
          answer: {},
        },
      },
      { type: "question", question: { request: "r2", message: "Ready?", fields: [], state: "open" } },
    ]);
  });

  it("reads a question with no schema, no properties or no object as a question with no fields", () => {
    const view = foldEvents([
      questionRequest("r1", { message: "Ready?" }),
      questionRequest("r2", { message: 4, requestedSchema: { properties: [] } }),
      { kind: "question", request: "r3", question: null } as unknown as ChatEvent,
    ]);

    expect(partsAt(view, 0)).toEqual([
      { type: "question", question: { request: "r1", message: "Ready?", fields: [], state: "open" } },
      { type: "question", question: { request: "r2", message: "", fields: [], state: "open" } },
      { type: "question", question: { request: "r3", message: "", fields: [], state: "open" } },
    ]);
  });

  it("marks the question accepted with the answer", () => {
    const view = foldChatEntries(CHAT_VIEW_START, QUESTIONS_LOG);

    expect(toolOf(view, "toolu_06AskRelease").question).toMatchObject({
      state: "accepted",
      answer: { question_0: "2.0.0", question_1: ["lint", "test"] },
    });
    expect(questionsOf(foldChatEntries(CHAT_VIEW_START, REFUSAL_LOG))[0]).toMatchObject({
      state: "accepted",
      answer: { choice: "retry_fallback" },
    });
  });

  it("marks the question declined or cancelled, and keeps no earlier answer", () => {
    const states = [
      [{ action: "decline" }, "declined"],
      [{ action: "cancel" }, "cancelled"],
      [{ action: "close" }, "cancelled"],
      [null, "cancelled"],
    ] as const;

    for (const [answer, state] of states) {
      const view = foldEvents([
        userMessage("Name it."),
        questionRequest("r1", { message: "Which name?", requestedSchema: NAME_SCHEMA }),
        questionResolved("r1", { action: "accept", content: { name: "lexer" } }),
        { kind: "question-resolved", request: "r1", answer } as ChatEvent,
      ]);

      expect(partsAt(view, 1)).toEqual([
        {
          type: "question",
          question: {
            request: "r1",
            message: "Which name?",
            fields: [NAME_FIELD],
            state,
          },
        },
      ]);
    }
  });

  it("marks the question accepted with no answer when the answer has no content", () => {
    const view = foldEvents([
      questionRequest("r1", { toolCallId: "t1", message: "Ready?" }),
      questionResolved("r1", { action: "accept", content: "yes" }),
    ]);

    expect(toolOf(view, "t1").question).toEqual({ request: "r1", message: "Ready?", fields: [], state: "accepted" });
  });

  it("skips a resolution of a question that no message holds", () => {
    const before = foldEvents([textChunk("One question."), questionRequest("r1", { message: "Ready?" })]);
    const view = foldEvents([questionResolved("r9", { action: "accept" })], before);

    expect(view.messages[0]).toBe(before.messages[0]);
  });

  it("marks an open question ended when the turn ends, on a tool and as a part", () => {
    const view = foldEvents([
      userMessage("Name it."),
      questionRequest("r1", { toolCallId: "t1", message: "Which name?" }),
      questionRequest("r2", { message: "Which folder?" }),
      questionRequest("r3", { message: "Which test?" }),
      questionResolved("r3", { action: "decline" }),
      turnEnd(),
    ]);

    expect(toolOf(view, "t1").question?.state).toBe("ended");
    expect(partsAt(view, 1).flatMap((part) => (part.type === "question" ? [part.question.state] : []))).toEqual([
      "ended",
      "declined",
    ]);
  });
});

describe("foldChatEntries: the end of a turn and the notices", () => {
  it("closes the open message at turn-end with end_turn, and adds no notice", () => {
    const view = foldEvents([userMessage("Hi."), textChunk("Hello."), turnEnd()]);

    expect(agentAt(view, 1)).toMatchObject({ parts: [{ type: "text", text: "Hello." }], open: false, running: false });
  });

  it("adds a stopped notice for a turn that ends with another stop reason", () => {
    const view = foldEvents([userMessage("Hi."), textChunk("Hello."), turnEnd("cancelled")]);

    expect(partsAt(view, 1)).toEqual([
      { type: "text", text: "Hello." },
      { type: "notice", notice: { kind: "stopped", stopReason: "cancelled" } },
    ]);
  });

  it("adds a notice with no open message as a new closed message", () => {
    const view = foldEvents([userMessage("Hi."), textChunk("Hello."), turnEnd(), { kind: "failed", reason: "The agent exited." }]);

    expect(view.messages[2]).toEqual({
      role: "assistant",
      id: "a4",
      at: atSeq(4),
      parts: [{ type: "notice", notice: { kind: "failed", reason: "The agent exited." } }],
      open: false,
      running: false,
    });
    expect(view.fold.status).toEqual({ state: "failed" });
  });

  it("puts a failure during a turn in the open message, and stops each running tool of every message", () => {
    const view = foldEvents([
      toolCall({ toolCallId: "t1", status: "in_progress" }),
      userMessage("Go on."),
      toolCall({ toolCallId: "t2", status: "pending" }),
      toolCall({ toolCallId: "t3", status: "completed" }),
      toolCall({ toolCallId: "t4", status: "failed" }),
      { kind: "failed", reason: "The agent exited." },
    ]);

    expect(toolsOf(view).map(({ id, stopped }) => [id, stopped])).toEqual([
      ["t1", true],
      ["t2", true],
      ["t3", false],
      ["t4", false],
    ]);
    expect(agentAt(view, 2)).toMatchObject({ open: false, running: false });
    expect(partsAt(view, 2).at(-1)).toEqual({ type: "notice", notice: { kind: "failed", reason: "The agent exited." } });
  });

  it("keeps a stopped tool as it is at the next end of a turn", () => {
    const before = foldEvents([userMessage("Go."), toolCall({ toolCallId: "t1", status: "in_progress" }), turnEnd()]);
    const view = foldEvents([userMessage("Again."), turnEnd()], before);

    expect(view.messages[1]).toBe(before.messages[1]);
  });

  it("adds an interrupted notice and ends the turn", () => {
    const view = foldEvents([userMessage("Hi."), textChunk("Hello."), { kind: "interrupted" }]);

    expect(agentAt(view, 1)).toMatchObject({
      parts: [{ type: "text", text: "Hello." }, { type: "notice", notice: { kind: "interrupted" } }],
      open: false,
      running: false,
    });
  });

  it("adds a continued-outside notice with the place, and ends the turn", () => {
    const view = foldEvents([userMessage("Hi."), textChunk("Hello."), { kind: "continued-outside", where: "terminal" }]);

    expect(agentAt(view, 1)).toMatchObject({
      parts: [{ type: "text", text: "Hello." }, { type: "notice", notice: { kind: "continued-outside", where: "terminal" } }],
      open: false,
    });
    expect(view.fold.status).toEqual({ state: "continued-outside", where: "terminal" });
  });

  it("adds a resumed notice and keeps the turn running", () => {
    const view = foldEvents([userMessage("Hi."), textChunk("Hello."), { kind: "resumed" }, textChunk(" Again.")]);

    expect(agentAt(view, 1)).toEqual({
      role: "assistant",
      id: "a2",
      at: atSeq(2),
      parts: [
        { type: "text", text: "Hello." },
        { type: "notice", notice: { kind: "resumed" } },
        { type: "text", text: " Again." },
      ],
      open: true,
      running: true,
    });
  });
});

describe("foldChatEntries: running", () => {
  it("runs a message added during a turn until the turn ends", () => {
    const running = foldEvents([userMessage("Hi."), textChunk("Hello.")]);
    const ended = foldEvents([turnEnd()], running);

    expect(agentAt(running, 1)).toMatchObject({ open: true, running: true });
    expect(agentAt(ended, 1)).toMatchObject({ open: false, running: false });
  });

  it("opens a new message for updates after turn-end, which does not run", () => {
    const view = foldEvents([userMessage("Hi."), textChunk("Hello."), turnEnd(), textChunk("Late.")]);

    expect(agentAt(view, 1)).toMatchObject({ id: "a2", open: false, running: false });
    expect(agentAt(view, 2)).toMatchObject({ id: "a4", parts: [{ type: "text", text: "Late." }], open: true, running: false });
  });
});

describe("foldChatEntries: the view", () => {
  it.each(Object.entries(CHAT_FIXTURES))("keeps the fold of foldChat over the %s log", (_name, entries) => {
    expect(foldChatEntries(CHAT_VIEW_START, entries).fold).toEqual(foldOf(entries));
  });

  it.each(Object.entries(CHAT_FIXTURES))("gives the same view for the %s log in one call and one entry at a time", (_name, entries) => {
    const whole = foldChatEntries(CHAT_VIEW_START, entries);
    const single = entries.reduce((view, entry) => foldChatEntries(view, [entry]), CHAT_VIEW_START);

    expect(single).toEqual(whole);
    expect(whole.seq).toBe(entries.length);
  });

  it("skips an entry with a seq at or below the seq of the view", () => {
    const view = foldChatEntries(CHAT_VIEW_START, TEXT_LOG.slice(0, 5));
    const again = foldChatEntries(view, TEXT_LOG.slice(3, 6));

    expect(again.seq).toBe(6);
    expect(partsAt(again, 1).at(-1)).toEqual({ type: "text", text: "I renamed the module.", messageId: "msg_02" });
  });

  it("gives the same view object for a list with no new entry", () => {
    const view = foldChatEntries(CHAT_VIEW_START, TEXT_LOG);

    expect(foldChatEntries(view, [])).toBe(view);
    expect(foldChatEntries(view, TEXT_LOG.slice(2))).toBe(view);
  });

  it("keeps the identity of each message and part that one more chunk does not change", () => {
    const before = foldChatEntries(CHAT_VIEW_START, [
      ...TEXT_LOG,
      ...chatEntries([userMessage("Run it."), toolCall({ toolCallId: "t1", title: "Run" }), textChunk("Running")], TEXT_LOG.length + 1),
    ]);
    const view = foldEvents([textChunk(".")], before);

    expect(view.messages.slice(0, -1)).toEqual(before.messages.slice(0, -1));
    view.messages.slice(0, -1).forEach((message, index) => {
      expect(message).toBe(before.messages[index]);
    });
    expect(view.messages.at(-1)).not.toBe(before.messages.at(-1));
    expect(partsAt(view, 3)[0]).toBe(partsAt(before, 3)[0]);
    expect(partsAt(view, 3)[1]).toEqual({ type: "text", text: "Running." });
  });

  it("skips an event of a kind it does not know", () => {
    const before = foldEvents([userMessage("Hi.")]);
    const view = foldEvents([{ kind: "renamed", title: "New" } as unknown as ChatEvent], before);

    expect(view.messages).toEqual(before.messages);
    expect(view.fold).toBe(before.fold);
    expect(view.seq).toBe(2);
  });
});

describe("foldChatEntries: options", () => {
  const MODES: ChatOptionValue[] = [
    { value: "default", name: "Manual", description: "Always ask before making changes" },
    { value: "acceptEdits", name: "Accept edits", description: "Automatically accept all file edits" },
    { value: "plan", name: "Plan", description: "Create a plan before making changes" },
    { value: "auto", name: "Auto", description: "Claude handles permission decisions" },
    { value: "bypassPermissions", name: "Bypass permissions", description: "Accepts all permissions" },
  ];

  function mode(current: string): ChatOption {
    return { id: "mode", name: "Mode", description: "Session permission mode", category: "mode", current, values: MODES };
  }

  it("starts with no options", () => {
    expect(CHAT_VIEW_START.options).toEqual([]);
  });

  it("gives no options for a log with no option events", () => {
    const view = foldChatEntries(CHAT_VIEW_START, TEXT_LOG);

    expect(view.options).toEqual([]);
    expect(view.options).toBe(CHAT_VIEW_START.options);
  });

  it("takes the options of a config_option_update", () => {
    const view = foldEvents([optionsUpdate(modeOption("default"))]);

    expect(view.options).toEqual([mode("default")]);
  });

  it("replaces the whole list with the last config_option_update", () => {
    const view = foldEvents([optionsUpdate(modeOption("default"), MODEL_OPTION), optionsUpdate(modeOption("auto"))]);

    expect(view.options).toEqual([mode("auto")]);
  });

  it("takes the values of groups in their order, with no group names", () => {
    const view = foldEvents([optionsUpdate(MODEL_OPTION)]);

    expect(view.options).toEqual([
      {
        id: "model",
        name: "Model",
        category: "model",
        current: "model-a",
        values: [
          { value: "model-a", name: "Model A" },
          { value: "model-b", name: "Model B", description: "The larger model" },
          { value: "model-c", name: "Model C" },
        ],
      },
    ]);
  });

  it("sets the current value of the mode option with a current_mode_update", () => {
    const view = foldEvents([optionsUpdate(MODEL_OPTION, modeOption("default")), modeUpdate("acceptEdits")]);

    expect(view.options).toEqual([expect.objectContaining({ id: "model", current: "model-a" }), mode("acceptEdits")]);
  });

  it("keeps the options of a current_mode_update with no mode option", () => {
    const before = foldEvents([optionsUpdate(MODEL_OPTION)]);
    const view = foldEvents([modeUpdate("auto")], before);

    expect(view.options).toBe(before.options);
  });

  it("keeps the options of a current_mode_update to the current value", () => {
    const before = foldEvents([optionsUpdate(modeOption("auto"))]);
    const view = foldEvents([modeUpdate("auto")], before);

    expect(view.options).toBe(before.options);
  });

  it("keeps the options of a current_mode_update with no list", () => {
    expect(foldEvents([modeUpdate("auto")]).options).toEqual([]);
  });

  it("keeps the options of a current_mode_update whose id is not a string", () => {
    const before = foldEvents([optionsUpdate(modeOption("default"))]);
    const view = foldEvents([agentUpdate({ sessionUpdate: "current_mode_update", currentModeId: 3 })], before);

    expect(view.options).toBe(before.options);
  });

  it("keeps the options of a config_option_update with no list", () => {
    const before = foldEvents([optionsUpdate(modeOption("default"))]);
    const view = foldEvents([agentUpdate({ sessionUpdate: "config_option_update", configOptions: "mode" })], before);

    expect(view.options).toBe(before.options);
  });

  it("drops an item that is not a select", () => {
    const view = foldEvents([optionsUpdate(BOOLEAN_OPTION, modeOption("default"))]);

    expect(view.options).toEqual([mode("default")]);
  });

  it("drops an item with a field of a wrong type or an empty name", () => {
    const view = foldEvents([
      optionsUpdate(
        { ...modeOption("default"), id: 1 },
        { ...modeOption("default"), name: "" },
        { ...modeOption("default"), name: 2 },
        { ...modeOption("default"), currentValue: null },
        "mode",
        { ...modeOption("default"), options: "all" },
      ),
    ]);

    expect(view.options).toEqual([{ ...mode("default"), values: [] }]);
  });

  it("drops a value with a field of a wrong type or an empty name, and a description that is not a string", () => {
    const view = foldEvents([
      optionsUpdate(
        modeOption("default", [
          { value: 1, name: "One" },
          { value: "two", name: "" },
          { value: "three" },
          "four",
          { value: "five", name: "Five", description: 5 },
          { group: "more", name: "More", options: "six" },
        ]),
      ),
    ]);

    expect(view.options).toEqual([{ ...mode("default"), values: [{ value: "five", name: "Five" }] }]);
  });

  it("drops a description and a category of an option that are not strings", () => {
    const view = foldEvents([optionsUpdate({ ...modeOption("default"), description: 1, category: null })]);

    expect(view.options).toEqual([{ id: "mode", name: "Mode", current: "default", values: MODES }]);
  });

  it("keeps the same options array for an entry that does not change the options", () => {
    const before = foldEvents([optionsUpdate(modeOption("default"))]);
    const view = foldEvents([userMessage("Go on."), textChunk("Working.")], before);

    expect(view.options).toBe(before.options);
  });

  it("adds and changes no message", () => {
    const before = foldEvents([userMessage("Go on."), textChunk("Working.")]);
    const view = foldEvents([optionsUpdate(modeOption("default")), modeUpdate("auto")], before);

    expect(view.messages).toEqual(before.messages);
  });
});

describe("chatBusy", () => {
  const user = userMessage("Go");
  const question = questionRequest("q1", { message: "Which one?" });

  it.each<[string, ChatEvent[], boolean]>([
    ["a running turn", [user], true],
    ["a turn that waits at a question", [user, question], true],
    ["a request that is open outside a turn", [user, turnEnd(), question], true],
    ["an ended turn with no open request", [user, turnEnd()], false],
  ])("is %s busy", (_case, events, busy) => {
    expect(chatBusy(events.reduce(foldChat, CHAT_START))).toBe(busy);
  });
});
