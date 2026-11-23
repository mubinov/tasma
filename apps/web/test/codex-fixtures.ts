import type { AcpObject, ChatEntry, ChatEvent } from "@tasma/protocol";
import {
  agentUpdate,
  chatEntries,
  permissionRequest,
  permissionResolved,
  questionRequest,
  questionResolved,
  textChunk,
  toolCall,
  toolCallUpdate,
  turnEnd,
  userMessage,
} from "./chat-fixtures";

// Chat logs that codex-acp 2.6.0 with Codex 0.171.0 sent to the daemon in a
// live chat. The recording keeps the events of each log in their order, with
// these edits:
// - ids, paths, times and client ids are invented ones in the same form;
// - the commands of `available_commands_update`, and the models, the effort
//   levels and the fast mode texts of `config_option_update`, are invented,
//   as they come from the skills and the account of the machine;
// - the text chunks of one message are joined;
// - of the `usage_update` events of a turn only the last is kept, and of its
//   `session_info_update` events only those that change the status;
// - the first log starts with the option and command updates that the chat
//   sent at its start.
// Codex offered no plan tool in the chat, so no log holds a plan.

export const CODEX_FOLDER = "/work/saga";

const MODES: readonly AcpObject[] = [
  { value: "read-only", name: "Read-only", description: "Requires approval to edit files and access the internet." },
  {
    value: "workspace-write",
    name: "Workspace access",
    description: "Edit workspace files; ask before writing outside the workspace or accessing the network.",
  },
  { value: "agent", name: "Auto review", description: "Only ask for actions detected as potentially unsafe" },
  { value: "agent-full-access", name: "Full access", description: "Unrestricted access to the internet and any file on your computer" },
];

function codexOptions(mode: string): ChatEvent {
  return agentUpdate({
    sessionUpdate: "config_option_update",
    configOptions: [
      {
        id: "mode",
        name: "Mode",
        description: "Approval and sandboxing preset for the session",
        category: "mode",
        type: "select",
        currentValue: mode,
        options: MODES,
      },
      {
        id: "collaboration_mode",
        name: "Collaboration mode",
        description: "How Codex collaborates for subsequent turns",
        category: "collaboration_mode",
        type: "select",
        currentValue: "default",
        options: [{ value: "default", name: "Default" }, { value: "plan", name: "Plan", description: "Plan before making changes" }],
      },
      {
        id: "model",
        name: "Model",
        description: "Model Codex uses for the session",
        category: "model",
        type: "select",
        currentValue: "model-b",
        options: [
          { value: "model-a", name: "Model A", description: "The fast model for everyday work." },
          { value: "model-b", name: "Model B", description: "The model for complex work." },
        ],
      },
      {
        id: "reasoning_effort",
        name: "Reasoning effort",
        description: "How much reasoning effort the model should use",
        category: "thought_level",
        type: "select",
        currentValue: "medium",
        options: [
          { value: "low", name: "Low", description: "Short reasoning" },
          { value: "medium", name: "Medium", description: "Some reasoning" },
          { value: "high", name: "High", description: "Long reasoning" },
        ],
      },
      {
        id: "fast-mode",
        name: "Fast mode",
        description: "Faster answers, more usage",
        category: "model_config",
        type: "select",
        currentValue: "off",
        options: [{ value: "off", name: "Off", description: "Normal speed" }, { value: "on", name: "On", description: "Faster answers" }],
      },
    ],
  });
}

const COMMANDS_UPDATE = agentUpdate({
  sessionUpdate: "available_commands_update",
  availableCommands: [
    { name: "review", description: "Review the open changes.", input: { hint: "optional instructions" } },
    { name: "status", description: "Show the settings of the session.", input: null },
    { name: "$release-notes", description: "Write the release notes of a version.", input: null },
  ],
});

function threadStatus(type: "active" | "idle", activeFlags?: readonly string[]): ChatEvent {
  const status = type === "active" ? { type, activeFlags: activeFlags ?? [] } : { type };
  return agentUpdate({ sessionUpdate: "session_info_update", _meta: { codex: { threadStatus: status } } });
}

function usage(used: number): ChatEvent {
  return agentUpdate({ sessionUpdate: "usage_update", used, size: 258_400 });
}

function terminalOutput(toolCallId: string, data: string): ChatEvent {
  return toolCallUpdate({ toolCallId, _meta: { terminal_output: { data, terminal_id: toolCallId } } });
}

function terminalExit(toolCallId: string, fields: AcpObject = {}): ChatEvent {
  return toolCallUpdate({
    toolCallId,
    status: "completed",
    ...fields,
    _meta: { terminal_exit: { exit_code: 0, signal: null, terminal_id: toolCallId } },
  });
}

/** The tool call of a shell command, which shows a terminal. */
function commandCall(toolCallId: string, command: string, fields: AcpObject = {}): ChatEvent {
  return toolCall({
    toolCallId,
    title: command,
    ...fields,
    kind: "execute",
    status: "in_progress",
    content: [{ terminalId: toolCallId, type: "terminal" }],
    rawInput: { command, cwd: CODEX_FOLDER },
    _meta: { terminal_info: { cwd: CODEX_FOLDER, terminal_id: toolCallId } },
  });
}

const LOOP_ID = "exec-5d2e8f14-7b3a-4c6e-9f01-2a8b6c4d3e17";

export const LOOP_COMMAND = 'sleep 3; for i in 1 2 3; do echo "line $i"; sleep 2; done';

/** A shell command whose output comes in three parts. */
export const CODEX_COMMAND_LOG: readonly ChatEntry[] = chatEntries([
  userMessage(`Run exactly this shell command, once: ${LOOP_COMMAND}. Then reply with the single word Done.`),
  codexOptions("agent"),
  COMMANDS_UPDATE,
  threadStatus("active"),
  textChunk("I’ll run the command once.", "msg_0c4b7e29a1f6d3850e2b947c6a1d5f83e07b2c49d618a5f3e2"),
  commandCall(LOOP_ID, LOOP_COMMAND, { name: "exec_command" }),
  terminalOutput(LOOP_ID, "line 1\n"),
  terminalOutput(LOOP_ID, "line 2\n"),
  terminalOutput(LOOP_ID, "line 3\n"),
  terminalExit(LOOP_ID),
  textChunk("Done", "msg_0c4b7e29a1f6d3850e2b947d1f8a6c20b5e93d74a2c61f0b8d"),
  usage(20_588),
  threadStatus("idle"),
  turnEnd(),
]);

const READ_ID = "exec-8a1f3c52-6e0d-4b79-a2c4-5f9e1d7b3a60";

const BETA_ID = "exec-2c7e9b41-0f5a-4d36-8e1b-7a3d6c9f2e05";

const OMEGA_ID = "exec-e4b06d9a-3c21-4f8e-b5a7-1d2c8e6f9a34";

/** A read command and two search commands, the last with no output. */
export const CODEX_READ_LOG: readonly ChatEntry[] = chatEntries([
  userMessage(
    "Run these three shell commands, as three separate commands, one after the other: cat notes.txt, then rg -n beta notes.txt, then rg -n omega notes.txt. Then reply with the single word Done.",
  ),
  threadStatus("active"),
  textChunk("I’ll run the three commands in order.", "msg_0c4b7e29a1f6d3850e2b947e3a6d9f15c84b2e07a1d5c3f962"),
  toolCall({
    toolCallId: READ_ID,
    title: `Read file '${CODEX_FOLDER}/notes.txt'`,
    name: "exec_command",
    kind: "read",
    status: "in_progress",
    locations: [{ path: `${CODEX_FOLDER}/notes.txt` }],
  }),
  toolCallUpdate({
    toolCallId: READ_ID,
    status: "completed",
    content: [{ content: { text: "alpha build\nbeta deploy\ngamma review\n", type: "text" }, type: "content" }],
    rawOutput: { exit_code: 0 },
  }),
  toolCall({ toolCallId: BETA_ID, title: "Search for 'beta' in notes.txt", name: "exec_command", kind: "search", status: "in_progress" }),
  toolCallUpdate({
    toolCallId: BETA_ID,
    status: "completed",
    content: [{ content: { text: "2:beta deploy\n", type: "text" }, type: "content" }],
    rawOutput: { exit_code: 0 },
  }),
  toolCall({ toolCallId: OMEGA_ID, title: "Search for 'omega' in notes.txt", name: "exec_command", kind: "search", status: "in_progress" }),
  toolCallUpdate({ toolCallId: OMEGA_ID, status: "failed", rawOutput: { exit_code: 1 } }),
  textChunk("Done", "msg_0c4b7e29a1f6d3850e2b947f5b2e8a07d39c6f14b0a2e7d851"),
  usage(20_838),
  threadStatus("idle"),
  turnEnd(),
]);

const EDIT_ID = "exec-7f3a9d06-2b8e-4c51-a6f4-0e9c2b7d5a83";

/** A change of an existing file and a new file, in one tool call. */
export const CODEX_EDIT_LOG: readonly ChatEntry[] = chatEntries([
  userMessage(
    'With your file edit tool, not a shell command: change the second line of notes.txt to "beta release", and create a new file todo.txt with the single line "check the build". Then reply with the single word Done.',
  ),
  threadStatus("active"),
  textChunk("I’ll use the file edit tool for both changes.", "msg_0c4b7e29a1f6d3850e2b9480c7f3a1e6b25d9e08f4c1a6b3d7"),
  toolCall({
    toolCallId: EDIT_ID,
    title: "Editing files",
    kind: "edit",
    status: "in_progress",
    content: [
      {
        path: `${CODEX_FOLDER}/notes.txt`,
        oldText: "alpha build\nbeta deploy\ngamma review\n",
        newText: "alpha build\nbeta release\ngamma review\n",
        _meta: { kind: "update" },
        type: "diff",
      },
      { path: `${CODEX_FOLDER}/todo.txt`, oldText: null, newText: "check the build\n", _meta: { kind: "add" }, type: "diff" },
    ],
  }),
  toolCallUpdate({ toolCallId: EDIT_ID, status: "completed" }),
  textChunk("Done", "msg_0c4b7e29a1f6d3850e2b9481d8a4b2f7c36e0f19a5d2b7c4e8"),
  usage(20_996),
  threadStatus("idle"),
  turnEnd(),
]);

const WRITE_ID = "exec-1b6d4e83-9a2f-4c07-b8e5-3f0a7c2d9e61";

export const WRITE_COMMAND = "echo ready > out.txt";

export const PERMISSION_REQUEST = "6e2a9c14-5d8b-4f37-a0e6-9b3c1d7f2a85";

/** In Read-only, a command that writes a file: a permission request, answered with the first option. */
export const CODEX_PERMISSION_LOG: readonly ChatEntry[] = chatEntries([
  codexOptions("read-only"),
  codexOptions("read-only"),
  userMessage(`Run exactly this shell command: ${WRITE_COMMAND}. Then reply with the single word Done.`),
  threadStatus("active"),
  textChunk("Writing `out.txt` requires approval in this read-only workspace.", "msg_0c4b7e29a1f6d3850e2b9482e9b5c3a8d47f1a20b6e3c8d5f9"),
  threadStatus("active", ["waitingOnApproval"]),
  commandCall(WRITE_ID, WRITE_COMMAND),
  permissionRequest(
    PERMISSION_REQUEST,
    {
      toolCallId: WRITE_ID,
      kind: "execute",
      status: "pending",
      title: WRITE_COMMAND,
      rawInput: { command: WRITE_COMMAND, cwd: CODEX_FOLDER },
    },
    [
      { optionId: "allow_once", name: "Yes, proceed", kind: "allow_once" },
      {
        optionId: "accept_execpolicy_amendment",
        name: `Yes, and don't ask again for commands that start with \`${WRITE_COMMAND}\``,
        kind: "allow_always",
      },
      { optionId: "cancel", name: "No, and tell Codex what to do differently", kind: "reject_once" },
    ],
  ),
  permissionResolved(PERMISSION_REQUEST, { outcome: "selected", optionId: "allow_once" }),
  threadStatus("active"),
  terminalExit(WRITE_ID, { name: "exec_command" }),
  textChunk("Done", "msg_0c4b7e29a1f6d3850e2b9483f0c6d4b9e58a2b31c7f4d9e6a0"),
  usage(22_338),
  threadStatus("idle"),
  turnEnd(),
]);

export const QUESTION_REQUEST = "3f8b1d62-0c4e-4a95-b7d3-e1a6c9f4b208";

/** A question with two options and the Other choice, with no tool call, answered with typed text alone. */
export const CODEX_QUESTION_LOG: readonly ChatEntry[] = chatEntries([
  userMessage(
    'Use the request_user_input tool to ask me one question: which host the deploy should use, with the header "Host" and two options, "preview" and "staging". Do not run any command. After my answer, reply with my answer only.',
  ),
  threadStatus("active"),
  textChunk("I’ll ask for the deploy host.", "msg_0c4b7e29a1f6d3850e2b9484a1d7e5c0f69b3c42d8a5e0f7b1"),
  threadStatus("active", ["waitingOnUserInput"]),
  questionRequest(QUESTION_REQUEST, {
    toolCallId: "call_7a2e5c9f1b4d48e6a03f6b8c2d9e1a57",
    requestedSchema: {
      type: "object",
      properties: {
        host: {
          title: "Which host should the deploy use?",
          description: "Host",
          oneOf: [
            { const: "preview", title: "preview", description: "Use the preview host." },
            { const: "staging", title: "staging", description: "Use the staging host." },
            { const: "None of the above", title: "None of the above", description: "Provide a different answer in the note field." },
          ],
          _meta: { codex: { isOther: true, isSecret: false } },
          type: "string",
        },
        host_note: {
          title: "Additional answer or note",
          _meta: { codex: { questionId: "host", role: "user_note", isSecret: false } },
          type: "string",
        },
      },
      required: ["host"],
    },
    message: "Codex needs your input to continue.",
    _meta: { codex: { autoResolutionMs: null } },
  }),
  questionResolved(QUESTION_REQUEST, { action: "accept", content: { host: "None of the above", host_note: "the canary host" } }),
  threadStatus("active"),
  textChunk("the canary host", "msg_0c4b7e29a1f6d3850e2b9485b2e8f6d1a70c4d53e9b6f1a8c2"),
  usage(22_520),
  threadStatus("idle"),
  turnEnd(),
]);

export const CODEX_FIXTURES: Readonly<Record<string, readonly ChatEntry[]>> = {
  "Codex command": CODEX_COMMAND_LOG,
  "Codex read": CODEX_READ_LOG,
  "Codex edit": CODEX_EDIT_LOG,
  "Codex permission": CODEX_PERMISSION_LOG,
  "Codex question": CODEX_QUESTION_LOG,
};
