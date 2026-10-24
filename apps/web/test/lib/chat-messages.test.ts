import { ProtocolError, type ChatEntry, type ChatEvent } from "@tasma/protocol";
import { describe, expect, it } from "vitest";
import {
  CHAT_VIEW_START,
  foldChatEntries,
  type ChatAgentMessage,
  type ChatNotice,
  type ChatPart,
  type ChatTool,
  type ChatView,
} from "../../src/lib/chat-fold";
import {
  chatAgentName,
  chatAnnouncements,
  chatAnswerText,
  chatDiff,
  chatNoticeText,
  chatOutsideName,
  chatStateText,
  chatTerminalView,
  chatThreadMessage,
  chatToolName,
  chatToolStatus,
  isChatMissing,
} from "../../src/lib/chat-messages";
import {
  atSeq,
  chatEntries,
  PERMISSION_LOG,
  permissionRequest,
  QUESTION_LOG,
  questionRequest,
  REFUSAL_LOG,
  textChunk,
  turnEnd,
  userMessage,
} from "../chat-fixtures";

const AT = atSeq(2);

const FOLDER = "/work/saga";

function tool(fields: Partial<ChatTool> = {}): ChatTool {
  return {
    id: "toolu_01",
    title: "Run the tests",
    kind: "execute",
    status: "pending",
    stopped: false,
    content: [],
    terminals: {},
    ...fields,
  };
}

function agentMessage(parts: readonly ChatPart[], fields: Partial<ChatAgentMessage> = {}): ChatAgentMessage {
  return { role: "assistant", id: "a2", at: AT, parts, open: false, running: false, ...fields };
}

function fold(entries: readonly ChatEntry[], view: ChatView = CHAT_VIEW_START): ChatView {
  return foldChatEntries(view, entries);
}

/** The view before and after the events, which follow the events of `start` in the log. */
function views(start: readonly ChatEvent[], events: readonly ChatEvent[]): [ChatView, ChatView] {
  const before = fold(chatEntries(start));
  return [before, fold(chatEntries(events, start.length + 1), before)];
}

describe("chatThreadMessage", () => {
  it("gives a user message its id, its time and its text", () => {
    expect(chatThreadMessage({ role: "user", id: "u1", at: AT, text: "Run the tests." }, FOLDER)).toEqual({
      role: "user",
      id: "u1",
      createdAt: new Date(AT),
      content: [{ type: "text", text: "Run the tests." }],
    });
  });

  it("maps each part of an assistant message in order", () => {
    const entries = [{ content: "Read the file", status: "completed" as const }];
    const notice: ChatNotice = { kind: "resumed" };
    const question = {
      request: "r1",
      message: "Which name?",
      fields: [],
      state: "accepted" as const,
    };
    const message = agentMessage([
      { type: "text", text: "I read it.", messageId: "msg_01" },
      { type: "reasoning", text: "Looking at the file." },
      { type: "plan", entries },
      { type: "notice", notice },
      { type: "question", question },
    ]);

    expect(chatThreadMessage(message, FOLDER)).toEqual({
      role: "assistant",
      id: "a2",
      createdAt: new Date(AT),
      content: [
        { type: "text", text: "I read it." },
        { type: "reasoning", text: "Looking at the file." },
        { type: "data-plan", data: entries },
        { type: "data-notice", data: notice },
        { type: "data-question", data: question },
      ],
      status: { type: "complete", reason: "stop" },
    });
  });

  it("gives a tool part its id, its name, its input and the tool with the folder", () => {
    const running = tool({ input: { command: "pnpm test" } });

    expect(chatThreadMessage(agentMessage([{ type: "tool", tool: running }]), FOLDER).content).toEqual([
      {
        type: "tool-call",
        toolCallId: "toolu_01",
        toolName: "Run the tests",
        args: { command: "pnpm test" },
        argsText: '{\n  "command": "pnpm test"\n}',
        isError: false,
        artifact: { tool: running, folder: FOLDER },
      },
    ]);
  });

  it("names a tool with no title by its kind, and gives empty arguments for an input that is not an object", () => {
    const [part] = chatThreadMessage(agentMessage([{ type: "tool", tool: tool({ title: "", input: ["a"] }) }]), FOLDER)
      .content as readonly Record<string, unknown>[];

    expect(part).toMatchObject({ toolName: "execute", args: {}, argsText: '[\n  "a"\n]' });
  });

  it("gives a tool with no input no arguments", () => {
    const [part] = chatThreadMessage(agentMessage([{ type: "tool", tool: tool() }]), FOLDER)
      .content as readonly Record<string, unknown>[];

    expect(part).toMatchObject({ args: {}, argsText: "" });
  });

  it("gives a result only to a completed or a failed tool", () => {
    const resultOf = (fields: Partial<ChatTool>) => {
      const [part] = chatThreadMessage(agentMessage([{ type: "tool", tool: tool(fields) }]), FOLDER)
        .content as readonly Record<string, unknown>[];
      return part?.result;
    };
    const texts = [
      { type: "text" as const, text: "12 passed" },
      { type: "diff" as const, path: "/work/saga/a.ts", oldText: null, newText: "a" },
      { type: "text" as const, text: "0 failed" },
    ];

    expect(resultOf({ status: "in_progress", output: "partial" })).toBeUndefined();
    expect(resultOf({ status: "pending", content: texts })).toBeUndefined();
    expect(resultOf({ status: "completed", content: texts, output: "ignored" })).toBe("12 passed\n\n0 failed");
    expect(resultOf({ status: "failed", output: "exit 1" })).toBe("exit 1");
    expect(resultOf({ status: "completed", output: { code: 1 } })).toBe('{\n  "code": 1\n}');
    expect(resultOf({ status: "completed" })).toBe("");
  });

  it("marks a failed tool as an error", () => {
    const [part] = chatThreadMessage(agentMessage([{ type: "tool", tool: tool({ status: "failed" }) }]), FOLDER)
      .content as readonly Record<string, unknown>[];

    expect(part?.isError).toBe(true);
  });

  it.each<[string, Partial<ChatAgentMessage>, readonly ChatPart[], unknown]>([
    [
      "running with an open permission",
      { running: true, open: true },
      [{ type: "tool", tool: tool({ permission: { request: "r1", options: [], state: "open" } }) }],
      { type: "requires-action", reason: "tool-calls" },
    ],
    [
      "running with an open question of a tool",
      { running: true, open: true },
      [{ type: "tool", tool: tool({ question: { request: "r1", message: "?", fields: [], state: "open" } }) }],
      { type: "requires-action", reason: "tool-calls" },
    ],
    [
      "running with an open question",
      { running: true, open: true },
      [{ type: "question", question: { request: "r1", message: "?", fields: [], state: "open" } }],
      { type: "requires-action", reason: "tool-calls" },
    ],
    [
      "running with a resolved permission",
      { running: true, open: true },
      [{ type: "tool", tool: tool({ permission: { request: "r1", options: [], state: "selected" } }) }],
      { type: "running" },
    ],
    ["cancelled", {}, [{ type: "notice", notice: { kind: "stopped", stopReason: "cancelled" } }], { type: "incomplete", reason: "cancelled" }],
    ["too long", {}, [{ type: "notice", notice: { kind: "stopped", stopReason: "max_tokens" } }], { type: "incomplete", reason: "length" }],
    ["refused", {}, [{ type: "notice", notice: { kind: "stopped", stopReason: "refusal" } }], { type: "incomplete", reason: "content-filter" }],
    [
      "stopped for another reason",
      {},
      [{ type: "notice", notice: { kind: "stopped", stopReason: "max_turn_requests" } }],
      { type: "incomplete", reason: "other" },
    ],
    ["failed", {}, [{ type: "notice", notice: { kind: "failed", reason: "boom" } }], { type: "incomplete", reason: "cancelled" }],
    ["interrupted", {}, [{ type: "notice", notice: { kind: "interrupted" } }], { type: "incomplete", reason: "cancelled" }],
    [
      "continued outside",
      {},
      [{ type: "notice", notice: { kind: "continued-outside", where: "vscode" } }],
      { type: "incomplete", reason: "cancelled" },
    ],
    ["resumed", {}, [{ type: "notice", notice: { kind: "resumed" } }], { type: "complete", reason: "stop" }],
    ["done", {}, [{ type: "text", text: "Done." }], { type: "complete", reason: "stop" }],
  ])("gives a message that is %s its status", (_name, fields, parts, status) => {
    expect(chatThreadMessage(agentMessage(parts, fields), FOLDER).status).toEqual(status);
  });

  it("gives an equal result for the same message", () => {
    const message = agentMessage([{ type: "tool", tool: tool({ input: { a: 1 } }) }, { type: "text", text: "Done." }]);

    expect(chatThreadMessage(message, FOLDER)).toEqual(chatThreadMessage(message, FOLDER));
  });
});

describe("chatAnnouncements", () => {
  it("announces nothing for a view that did not change", () => {
    const view = fold(PERMISSION_LOG);

    expect(chatAnnouncements(view, view, "claude")).toEqual([]);
  });

  it("announces a new permission request with the title of its tool", () => {
    const before = fold(PERMISSION_LOG.slice(0, 4));
    const after = fold(PERMISSION_LOG.slice(4, 5), before);

    expect(chatAnnouncements(before, after, "claude")).toEqual(["Claude asks for permission: pnpm build"]);
  });

  it("announces a new question", () => {
    const before = fold(QUESTION_LOG.slice(0, 3));
    const after = fold(QUESTION_LOG.slice(3, 4), before);

    expect(chatAnnouncements(before, after, "codex")).toEqual(["Codex asks a question"]);
  });

  it("announces a new question with no tool", () => {
    const before = fold(REFUSAL_LOG.slice(0, 1));
    const after = fold(REFUSAL_LOG.slice(1, 2), before);

    expect(chatAnnouncements(before, after, "claude")).toEqual(["Claude asks a question"]);
  });

  it("announces a new question that follows text in its message", () => {
    const [before, after] = views([userMessage("Pick a colour."), textChunk("Let me ask.")], [
      questionRequest("q1", { message: "Which colour?", requestedSchema: {} }),
    ]);

    expect(chatAnnouncements(before, after, "claude")).toEqual(["Claude asks a question"]);
  });

  it("does not announce a request that was open before", () => {
    const before = fold(PERMISSION_LOG.slice(0, 5));
    const after = fold([{ seq: 6, at: atSeq(6), event: textChunk("Waiting.") }], before);

    expect(chatAnnouncements(before, after, "claude")).toEqual([]);
  });

  it("announces only the request that a tool holds when a second request of the tool replaced the first", () => {
    const [before, after] = views([userMessage("Build.")], [
      permissionRequest("r1", { toolCallId: "t1", title: "pnpm build" }, []),
      permissionRequest("r2", { toolCallId: "t1" }, []),
    ]);

    expect(after.fold.open).toEqual(["r1", "r2"]);
    expect(chatAnnouncements(before, after, "claude")).toEqual(["Claude asks for permission: pnpm build"]);
  });

  it("names a tool with no title by its kind", () => {
    const [before, after] = views([userMessage("Build.")], [
      permissionRequest("r1", { toolCallId: "t1", kind: "execute" }, []),
    ]);

    expect(chatAnnouncements(before, after, "claude")).toEqual(["Claude asks for permission: execute"]);
  });

  it("cuts a title longer than 120 characters to 120, the last of them an ellipsis", () => {
    const title = "x".repeat(200);
    const [before, after] = views([userMessage("Build.")], [permissionRequest("r1", { toolCallId: "t1", title }, [])]);

    expect(chatAnnouncements(before, after, "claude")).toEqual([`Claude asks for permission: ${"x".repeat(119)}…`]);
  });

  it("keeps a title of 120 characters whole", () => {
    const title = "x".repeat(120);
    const [before, after] = views([userMessage("Build.")], [permissionRequest("r1", { toolCallId: "t1", title }, [])]);

    expect(chatAnnouncements(before, after, "claude")).toEqual([`Claude asks for permission: ${title}`]);
  });

  it("announces a failure with the reason of the last failed notice, and not the end of the turn", () => {
    const [before, after] = views([userMessage("Build.")], [{ kind: "failed", reason: `The agent ${"y".repeat(200)}` }]);

    expect(chatAnnouncements(before, after, "claude")).toEqual([`The chat failed: The agent ${"y".repeat(109)}…`]);
  });

  it.each([
    ["vscode", "The chat continued in VS Code"],
    ["terminal", "The chat continued in terminal"],
  ] as const)("announces a chat that continued in %s", (where, words) => {
    const [before, after] = views([userMessage("Build.")], [{ kind: "continued-outside", where }]);

    expect(chatAnnouncements(before, after, "claude")).toEqual([words]);
  });

  it.each([
    ["end_turn", "Claude finished the turn"],
    ["cancelled", "The turn was cancelled."],
    ["max_tokens", "The agent stopped: the answer was too long."],
    ["max_turn_requests", "The agent stopped: the turn made too many requests."],
    ["refusal", "The agent refused to continue."],
    ["pause", "The turn stopped: pause."],
  ])("announces the end of a turn with the stop reason %s", (stopReason, words) => {
    const [before, after] = views([userMessage("Build."), textChunk("Building.")], [turnEnd(stopReason)]);

    expect(chatAnnouncements(before, after, "claude")).toEqual([words]);
  });

  it("announces an interrupted turn", () => {
    const [before, after] = views([userMessage("Build.")], [{ kind: "interrupted" }]);

    expect(chatAnnouncements(before, after, "claude")).toEqual(["The turn was interrupted."]);
  });

  it("cuts a stop reason longer than 120 characters", () => {
    const [before, after] = views([userMessage("Build.")], [turnEnd("z".repeat(200))]);

    expect(chatAnnouncements(before, after, "claude")).toEqual([`The turn stopped: ${"z".repeat(119)}….`]);
  });

  it("takes the notice of the turn that ended, not of an earlier turn", () => {
    const [before, after] = views(
      [userMessage("Build."), turnEnd("cancelled"), userMessage("Build again.")],
      [turnEnd()],
    );

    expect(chatAnnouncements(before, after, "claude")).toEqual(["Claude finished the turn"]);
  });

  it("announces a new request before the end of a turn", () => {
    const [before, after] = views([userMessage("Build.")], [
      turnEnd(),
      permissionRequest("r1", { toolCallId: "t1", title: "pnpm build" }, []),
    ]);

    expect(chatAnnouncements(before, after, "claude")).toEqual([
      "Claude asks for permission: pnpm build",
      "Claude finished the turn",
    ]);
  });

  it("does not announce a turn that started", () => {
    const [before, after] = views([], [userMessage("Build.")]);

    expect(chatAnnouncements(before, after, "claude")).toEqual([]);
  });
});

describe("chatAgentName", () => {
  it("names the agents", () => {
    expect(chatAgentName("claude")).toBe("Claude");
    expect(chatAgentName("codex")).toBe("Codex");
  });
});

describe("chatOutsideName", () => {
  it("names the places", () => {
    expect(chatOutsideName("vscode")).toBe("VS Code");
    expect(chatOutsideName("terminal")).toBe("terminal");
  });
});

describe("chatStateText", () => {
  it("gives the text of each state", () => {
    expect(chatStateText({ state: "working" })).toBe("Agent works");
    expect(chatStateText({ state: "needs-you" })).toBe("Needs you");
    expect(chatStateText({ state: "failed" })).toBe("Failed");
    expect(chatStateText({ state: "continued-outside", where: "vscode" })).toBe("Continued in VS Code");
  });
});

describe("isChatMissing", () => {
  it("is true for a refusal that says the chat, its task or its project does not exist", () => {
    for (const code of ["chat-not-found", "task-not-found", "project-not-found"] as const) {
      expect(isChatMissing(new ProtocolError({ kind: "store", code, message: "gone" }, 404))).toBe(true);
    }
  });

  it("is false for another refusal, another error and no error", () => {
    expect(isChatMissing(new ProtocolError({ kind: "store", code: "chat-unreadable", message: "broken" }, 500))).toBe(false);
    expect(isChatMissing(new Error("chat-not-found"))).toBe(false);
    expect(isChatMissing(null)).toBe(false);
  });
});

describe("chatNoticeText", () => {
  it.each<[ChatNotice, string]>([
    [{ kind: "failed", reason: "x".repeat(200) }, `The chat failed: ${"x".repeat(200)}`],
    [{ kind: "stopped", stopReason: "cancelled" }, "The turn was cancelled."],
    [{ kind: "stopped", stopReason: "max_tokens" }, "The agent stopped: the answer was too long."],
    [{ kind: "stopped", stopReason: "max_turn_requests" }, "The agent stopped: the turn made too many requests."],
    [{ kind: "stopped", stopReason: "refusal" }, "The agent refused to continue."],
    [{ kind: "stopped", stopReason: "y".repeat(200) }, `The turn stopped: ${"y".repeat(200)}.`],
    [{ kind: "interrupted" }, "The turn was interrupted."],
    [{ kind: "resumed" }, "Continued in Tasma."],
    [{ kind: "continued-outside", where: "vscode" }, "Continued in VS Code."],
    [{ kind: "continued-outside", where: "terminal" }, "Continued in terminal."],
  ])("gives the notice %j its whole text", (notice, text) => {
    expect(chatNoticeText(notice)).toBe(text);
  });
});

describe("chatToolName", () => {
  it("is the title, else the kind", () => {
    expect(chatToolName(tool())).toBe("Run the tests");
    expect(chatToolName(tool({ title: "" }))).toBe("execute");
  });
});

describe("chatToolStatus", () => {
  it.each<[string, Partial<ChatTool>, unknown]>([
    [
      "has an open permission",
      { status: "completed", permission: { request: "r1", options: [], state: "open" } },
      { type: "requires-action", reason: "tool-calls" },
    ],
    [
      "has an open question",
      { stopped: true, question: { request: "r1", message: "?", fields: [], state: "open" } },
      { type: "requires-action", reason: "tool-calls" },
    ],
    ["was stopped", { stopped: true, status: "in_progress" }, { type: "incomplete", reason: "cancelled" }],
    ["failed", { status: "failed" }, { type: "incomplete", reason: "error" }],
    [
      "is completed with an answered permission",
      { status: "completed", permission: { request: "r1", options: [], state: "selected" } },
      { type: "complete" },
    ],
    ["is pending", { status: "pending" }, { type: "running" }],
    ["is in progress", { status: "in_progress" }, { type: "running" }],
  ])("gives a tool that %s its own status", (_name, fields, status) => {
    expect(chatToolStatus(tool(fields))).toEqual(status);
  });
});

describe("chatDiff", () => {
  it("names a file inside the folder by its path in the folder, and counts the lines", () => {
    expect(chatDiff({ path: "/work/saga/src/a.ts", oldText: "one\ntwo\nthree\n", newText: "one\n2\nthree\nfour\n" }, FOLDER))
      .toEqual({
        filename: "src/a.ts",
        additions: 2,
        deletions: 1,
        lines: [
          { kind: "context", text: "one" },
          { kind: "removed", text: "two" },
          { kind: "added", text: "2" },
          { kind: "context", text: "three" },
          { kind: "added", text: "four" },
        ],
      });
  });

  it("names a file outside the folder by its full path", () => {
    expect(chatDiff({ path: "/work/sagas/a.ts", oldText: "a", newText: "a" }, FOLDER).filename).toBe("/work/sagas/a.ts");
    expect(chatDiff({ path: "/work/saga", oldText: "a", newText: "a" }, FOLDER).filename).toBe("/work/saga");
  });

  it("reads a folder with a trailing slash", () => {
    expect(chatDiff({ path: "/work/saga/a.ts", oldText: "a", newText: "a" }, "/work/saga/").filename).toBe("a.ts");
  });

  it("shows each line of a new file as added, the last line with no line end too", () => {
    expect(chatDiff({ path: "/work/saga/a.ts", oldText: null, newText: "one\ntwo" }, FOLDER)).toMatchObject({
      additions: 2,
      deletions: 0,
      lines: [
        { kind: "added", text: "one" },
        { kind: "added", text: "two" },
      ],
    });
  });

  /** `length` lines, of which the first `changed` differ between the two texts. */
  function changedFile(changed: number, length = 1_000): { path: string; oldText: string; newText: string } {
    const text = (first: number) => Array.from({ length }, (_, index) => `${index < first ? "new" : "line"} ${String(index)}\n`).join("");
    return { path: "/work/saga/a.ts", oldText: text(0), newText: text(changed) };
  }

  function numbered(prefix: string, from: number, to: number): string[] {
    return Array.from({ length: to - from }, (_, index) => `${prefix} ${String(from + index)}`);
  }

  it("compares the texts of a change of 500 lines, and shows the first 100 lines of a longer run of changes", () => {
    const diff = chatDiff(changedFile(250), FOLDER);

    expect(diff).toMatchObject({ additions: 250, deletions: 250 });
    expect(diff.lines).toEqual([
      ...numbered("line", 0, 100).map((text) => ({ kind: "removed", text })),
      { kind: "removed", text: "⋯ 150 more removed lines" },
      ...numbered("new", 0, 100).map((text) => ({ kind: "added", text })),
      { kind: "added", text: "⋯ 150 more added lines" },
      ...numbered("line", 250, 253).map((text) => ({ kind: "context", text })),
      { kind: "context", text: "⋯ 747 unchanged lines" },
    ]);
  });

  it("shows the start of the whole old text as removed and of the whole new text as added for a larger change", () => {
    const diff = chatDiff(changedFile(251), FOLDER);

    expect(diff).toMatchObject({ additions: 1_000, deletions: 1_000 });
    expect(diff.lines).toEqual([
      ...numbered("line", 0, 100).map((text) => ({ kind: "removed", text })),
      { kind: "removed", text: "⋯ 900 more removed lines" },
      ...numbered("new", 0, 100).map((text) => ({ kind: "added", text })),
      { kind: "added", text: "⋯ 900 more added lines" },
    ]);
  });

  it("shows 101 changed lines whole: a mark stands for 2 lines or more", () => {
    const diff = chatDiff(changedFile(101, 101), FOLDER);

    expect(diff.lines.filter((line) => line.kind === "added")).toHaveLength(101);
    expect(diff.lines.some((line) => line.text.startsWith("⋯"))).toBe(false);
  });

  it("shows 3 unchanged lines on each side of a change, and a mark for the unchanged lines between", () => {
    const oldLines = numbered("line", 0, 30);
    const newLines = oldLines.map((line, index) => (index === 10 || index === 24 ? `new ${String(index)}` : line));
    const diff = chatDiff({ path: "/work/saga/a.ts", oldText: oldLines.join("\n"), newText: newLines.join("\n") }, FOLDER);

    expect(diff).toMatchObject({ additions: 2, deletions: 2 });
    expect(diff.lines).toEqual([
      { kind: "context", text: "⋯ 7 unchanged lines" },
      ...numbered("line", 7, 10).map((text) => ({ kind: "context", text })),
      { kind: "removed", text: "line 10" },
      { kind: "added", text: "new 10" },
      ...numbered("line", 11, 14).map((text) => ({ kind: "context", text })),
      { kind: "context", text: "⋯ 7 unchanged lines" },
      ...numbered("line", 21, 24).map((text) => ({ kind: "context", text })),
      { kind: "removed", text: "line 24" },
      { kind: "added", text: "new 24" },
      ...numbered("line", 25, 28).map((text) => ({ kind: "context", text })),
      { kind: "context", text: "⋯ 2 unchanged lines" },
    ]);
  });

  it("shows 7 unchanged lines between two changes whole", () => {
    const oldLines = numbered("line", 0, 9);
    const newLines = oldLines.map((line, index) => (index === 0 || index === 8 ? `new ${String(index)}` : line));
    const diff = chatDiff({ path: "/work/saga/a.ts", oldText: oldLines.join("\n"), newText: newLines.join("\n") }, FOLDER);

    expect(diff.lines.filter((line) => line.kind === "context")).toEqual(
      numbered("line", 1, 8).map((text) => ({ kind: "context", text })),
    );
  });

  it("shows a mark for a text with no change of 2 lines or more", () => {
    expect(chatDiff({ path: "/work/saga/a.ts", oldText: "a\nb\n", newText: "a\nb\n" }, FOLDER).lines).toEqual([
      { kind: "context", text: "⋯ 2 unchanged lines" },
    ]);
  });

  it("shows the first 299 lines of a longer diff, and a mark for the lines after them", () => {
    // Every second line changes, so no unchanged line is left out.
    const oldLines = numbered("line", 0, 400);
    const newLines = oldLines.map((line, index) => (index % 2 === 0 ? `new ${String(index)}` : line));
    const diff = chatDiff({ path: "/work/saga/a.ts", oldText: oldLines.join("\n"), newText: newLines.join("\n") }, FOLDER);

    expect(diff).toMatchObject({ additions: 200, deletions: 200 });
    expect(diff.lines).toHaveLength(300);
    expect(diff.lines.slice(0, 3)).toEqual([
      { kind: "removed", text: "line 0" },
      { kind: "added", text: "new 0" },
      { kind: "context", text: "line 1" },
    ]);
    expect(diff.lines.at(-1)).toEqual({ kind: "context", text: "⋯ 301 more lines" });
  });

  it("counts the lines that a mark stands for in the lines after the first 299", () => {
    // A change and its 10 unchanged lines give 9 rows for 12 lines: 299 rows hold 33 of them, then 2 lines.
    const oldLines = numbered("line", 0, 1_100);
    const newLines = oldLines.map((line, index) => (index % 11 === 0 ? `new ${String(index)}` : line));
    const diff = chatDiff({ path: "/work/saga/a.ts", oldText: oldLines.join("\n"), newText: newLines.join("\n") }, FOLDER);

    expect(diff.lines).toHaveLength(300);
    expect(diff.lines.at(-2)).toEqual({ kind: "added", text: "new 363" });
    expect(diff.lines.at(-1)).toEqual({ kind: "context", text: `⋯ ${String(1_100 + 100 - 398)} more lines` });
  });

  it("gives no lines for two empty texts", () => {
    expect(chatDiff({ path: "/work/saga/a.ts", oldText: "", newText: "" }, FOLDER)).toMatchObject({
      additions: 0,
      deletions: 0,
      lines: [],
    });
  });
});

describe("chatTerminalView", () => {
  const TERMINAL = "term_1";

  it("shows a running tool as a running terminal, with the command of the input and the lines of the output", () => {
    const running = tool({
      status: "in_progress",
      input: { command: "pnpm test" },
      terminals: { [TERMINAL]: { output: "one\r\ntwo\n" } },
    });

    expect(chatTerminalView(running, TERMINAL)).toEqual({
      kind: "block",
      command: "pnpm test",
      lines: ["one", "two"],
      done: false,
    });
  });

  it("gives a terminal with no output no lines, and the name of the tool as the command", () => {
    expect(chatTerminalView(tool({ title: "", status: "pending", input: { command: 3 } }), TERMINAL)).toEqual({
      kind: "block",
      command: "execute",
      lines: [],
      done: false,
    });
  });

  it.each<[string, Partial<ChatTool>]>([
    ["completed", { status: "completed" }],
    ["failed", { status: "failed" }],
    ["stopped", { status: "in_progress", stopped: true }],
    ["in progress", { status: "in_progress" }],
  ])("shows a %s tool with an exit code as a done terminal with that code", (_name, fields) => {
    const view = chatTerminalView(tool({ ...fields, terminals: { [TERMINAL]: { output: "x\n", exitCode: 2 } } }), TERMINAL);

    expect(view).toEqual({ kind: "block", command: "Run the tests", lines: ["x"], done: true, exitCode: 2 });
  });

  it("shows an ended tool with no exit code as the lines of its output", () => {
    const ended = tool({ status: "failed", terminals: { [TERMINAL]: { output: "error\r\nat line 2\n", exitCode: null } } });

    expect(chatTerminalView(ended, TERMINAL)).toEqual({ kind: "result", output: "error\nat line 2" });
  });

  const EARLIER = "⋯ The start of the output is not shown.";

  function linesOf(output: string, fields: Partial<ChatTool> = {}): string[] {
    const view = chatTerminalView(tool({ status: "in_progress", ...fields, terminals: { [TERMINAL]: { output } } }), TERMINAL);
    return view.kind === "block" ? view.lines : [];
  }

  it("shows the last 200 lines of a longer output, after a line that says that the start is not shown", () => {
    const lines = Array.from({ length: 250 }, (_, index) => `line ${String(index)}`);

    expect(linesOf(`${lines.join("\n")}\n`)).toEqual([EARLIER, ...lines.slice(50)]);
    expect(linesOf(`${lines.slice(50).join("\n")}\n`)).toEqual(lines.slice(50));
  });

  it("cuts a line longer than 1,000 characters to 1,000, the last of them an ellipsis", () => {
    expect(linesOf(`${"x".repeat(1_000)}\n${"y".repeat(1_001)}\n`)).toEqual(["x".repeat(1_000), `${"y".repeat(999)}…`]);
  });

  it("does not cut a character in two", () => {
    expect(linesOf(`${"x".repeat(998)}😀z\n`)).toEqual([`${"x".repeat(998)}…`]);
  });

  it("reads only the end of a long output, with no part of the line that the end starts in", () => {
    expect(linesOf(`${"x".repeat(300_000)}\nlast line\n`)).toEqual([EARLIER, "last line"]);
  });

  it("shows the end of a long output that has no line end", () => {
    expect(linesOf("z".repeat(300_000))).toEqual([EARLIER, `${"z".repeat(999)}…`]);
  });

  it("gives an ended tool with no exit code the same lines as a terminal", () => {
    const output = `${Array.from({ length: 201 }, (_, index) => `line ${String(index)}`).join("\n")}\n`;
    const view = chatTerminalView(tool({ status: "failed", terminals: { [TERMINAL]: { output } } }), TERMINAL);

    expect(linesOf(output).slice(0, 2)).toEqual([EARLIER, "line 1"]);
    expect(view).toEqual({ kind: "result", output: linesOf(output).join("\n") });
  });

  it("shows a stopped tool with no terminal output as the output of the tool", () => {
    const stopped = tool({ status: "in_progress", stopped: true, output: { stdout: "partial" } });

    expect(chatTerminalView(stopped, TERMINAL)).toEqual({ kind: "result", output: { stdout: "partial" } });
  });
});

describe("chatAnswerText", () => {
  it("joins the values with commas, the items of a list too", () => {
    expect(chatAnswerText({ question_0: "2.0.0", question_1: ["lint", "test"], count: 3, ok: true, extra: { a: 1 } }))
      .toBe('2.0.0, lint, test, 3, true, {"a":1}');
  });

  it("is empty for no answer", () => {
    expect(chatAnswerText(undefined)).toBe("");
  });
});
