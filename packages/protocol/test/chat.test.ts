import { describe, expect, it } from "vitest";
import { CHAT_START, chatMark, currentStep, foldChat, isActiveChat } from "@tasma/protocol";
import type { Chat, ChatEvent, ChatFold, ChatStatus, Workflow } from "@tasma/protocol";

const USER: ChatEvent = { kind: "user", text: "Start", client: "app" };

function fold(...events: ChatEvent[]): ChatFold {
  return events.reduce(foldChat, CHAT_START);
}

function permission(request: string): ChatEvent {
  return { kind: "permission", request, permission: { toolCall: { title: "Edit" } } };
}

function permissionResolved(request: string): ChatEvent {
  return { kind: "permission-resolved", request, outcome: { outcome: "selected", optionId: "allow" }, client: "cli" };
}

function question(request: string): ChatEvent {
  return { kind: "question", request, question: { message: "Which one?" } };
}

function questionResolved(request: string): ChatEvent {
  return { kind: "question-resolved", request, answer: { action: "accept" } };
}

describe("foldChat", () => {
  it("starts in needs-you with no turn and no open request", () => {
    expect(CHAT_START).toEqual({ turn: false, open: [], status: { state: "needs-you" } });
  });

  it("starts a turn at a user message", () => {
    expect(fold(USER)).toEqual({ turn: true, open: [], status: { state: "working" } });
  });

  it("changes nothing at an update", () => {
    const working = fold(USER);

    expect(foldChat(working, { kind: "update", update: { sessionUpdate: "agent_message_chunk" } })).toBe(working);
  });

  it("changes nothing at an event of a kind it does not know", () => {
    const working = fold(USER);
    const unknown = { kind: "later-kind", detail: 1 } as unknown as ChatEvent;

    expect(foldChat(working, unknown)).toBe(working);
  });

  it("opens a permission request, which needs the user", () => {
    expect(fold(USER, permission("r1"))).toEqual({ turn: true, open: ["r1"], status: { state: "needs-you" } });
  });

  it("opens a question, which needs the user", () => {
    expect(fold(USER, question("r1"))).toEqual({ turn: true, open: ["r1"], status: { state: "needs-you" } });
  });

  it("closes a resolved permission request, and the turn works again", () => {
    expect(fold(USER, permission("r1"), permissionResolved("r1"))).toEqual({
      turn: true,
      open: [],
      status: { state: "working" },
    });
  });

  it("closes an answered question, and the turn works again", () => {
    expect(fold(USER, question("r1"), questionResolved("r1"))).toEqual({
      turn: true,
      open: [],
      status: { state: "working" },
    });
  });

  it("holds one request id once", () => {
    expect(fold(USER, permission("r1"), permission("r1")).open).toEqual(["r1"]);
  });

  it("stays in needs-you until both of two open requests are resolved", () => {
    const both = fold(USER, permission("r1"), question("r2"));
    const one = foldChat(both, permissionResolved("r1"));

    expect(both.status).toEqual({ state: "needs-you" });
    expect(one).toEqual({ turn: true, open: ["r2"], status: { state: "needs-you" } });
    expect(foldChat(one, questionResolved("r2")).status).toEqual({ state: "working" });
  });

  it("ends the turn at turn-end, and clears an open request", () => {
    expect(fold(USER, permission("r1"), { kind: "turn-end", stopReason: "end_turn" })).toEqual({
      turn: false,
      open: [],
      status: { state: "needs-you" },
    });
  });

  it("ends the turn at interrupted, and clears an open request", () => {
    expect(fold(USER, question("r1"), { kind: "interrupted" })).toEqual({
      turn: false,
      open: [],
      status: { state: "needs-you" },
    });
  });

  it("changes nothing at a late resolution of a request that an ended turn cleared", () => {
    const ended = fold(USER, permission("r1"), { kind: "interrupted" });

    expect(foldChat(ended, permissionResolved("r1"))).toEqual(ended);
  });

  it("stops in failed, which a resolution does not leave", () => {
    const failed = fold(USER, permission("r1"), { kind: "failed", reason: "the agent process ended" });

    expect(failed).toEqual({ turn: false, open: [], stopped: { state: "failed" }, status: { state: "failed" } });
    expect(foldChat(failed, permissionResolved("r1")).status).toEqual({ state: "failed" });
  });

  it("works again at a user message after failed", () => {
    const failed = fold(USER, { kind: "failed", reason: "the agent process ended" });

    expect(foldChat(failed, USER)).toEqual({ turn: true, open: [], status: { state: "working" } });
  });

  it("needs the user at resumed after failed", () => {
    expect(fold(USER, { kind: "failed", reason: "the agent process ended" }, { kind: "resumed" })).toEqual({
      turn: false,
      open: [],
      status: { state: "needs-you" },
    });
  });

  it("stops in continued-outside with where the chat continues", () => {
    const outside = fold(USER, permission("r1"), { kind: "continued-outside", where: "terminal" });

    expect(outside).toEqual({
      turn: false,
      open: [],
      stopped: { state: "continued-outside", where: "terminal" },
      status: { state: "continued-outside", where: "terminal" },
    });
  });

  it("needs the user at resumed after continued-outside", () => {
    expect(fold(USER, { kind: "continued-outside", where: "vscode" }, { kind: "resumed" }).status).toEqual({
      state: "needs-you",
    });
  });

  it("keeps a running turn at resumed", () => {
    expect(fold(USER, { kind: "resumed" })).toEqual({ turn: true, open: [], status: { state: "working" } });
  });
});

describe("chatMark", () => {
  const base: Chat = {
    task: "ALPHA-3",
    chat: 1,
    step: "dev:research",
    agent: "claude",
    folder: "/work/alpha",
    created: "2026-01-02T10:00:00Z",
    seq: 6,
    stateSeq: 4,
    state: "needs-you",
  };

  it.each<[string, Chat, string | undefined, ChatStatus | undefined]>([
    ["working on a past step", { ...base, state: "working", seen: 4 }, "dev:plan", { state: "working" }],
    ["needs-you on the current step that the user saw", { ...base, seen: 4 }, "dev:research", { state: "needs-you" }],
    ["needs-you on a past step that the user did not see to the end", { ...base, seen: 3 }, "dev:plan", { state: "needs-you" }],
    ["a past step seen to its state, with later entries", { ...base, seen: 4 }, "dev:plan", undefined],
    ["a past step that nobody saw", base, "dev:plan", { state: "needs-you" }],
    ["no current step, not seen", { ...base, seen: 3 }, undefined, { state: "needs-you" }],
    ["no current step, seen", { ...base, seen: 6 }, undefined, undefined],
    ["failed on a past step", { ...base, state: "failed" }, "dev:plan", { state: "failed" }],
    [
      "continued-outside on a past step",
      { ...base, state: "continued-outside", where: "terminal" },
      "dev:plan",
      { state: "continued-outside", where: "terminal" },
    ],
  ])("gives the mark of %s", (_case, chat, step, mark) => {
    expect(chatMark(chat, step)).toEqual(mark);
  });

  it("gives a new object, not the chat", () => {
    const chat: Chat = { ...base, state: "working" };

    expect(chatMark(chat, chat.step)).not.toBe(chat);
  });
});

describe("isActiveChat", () => {
  it.each<[string, ChatStatus | undefined, boolean]>([
    ["working", { state: "working" }, true],
    ["needs-you", { state: "needs-you" }, true],
    ["failed", { state: "failed" }, false],
    ["continued-outside", { state: "continued-outside", where: "vscode" }, false],
    ["no mark", undefined, false],
  ])("counts a row with the mark %s as active: %s", (_case, status, active) => {
    expect(isActiveChat(status)).toBe(active);
  });
});

describe("currentStep", () => {
  const dev: Pick<Workflow, "steps"> = {
    steps: [
      { name: "dev:research", file: "/flows/dev/research.md", owner: "human" },
      { name: "dev:plan", file: "/flows/dev/plan.md", owner: "agent" },
    ],
  };

  it.each<[string, { workflow?: string; step?: string }, Pick<Workflow, "steps"> | null | undefined, string | undefined]>([
    ["the step of the task", { workflow: "dev", step: "dev:plan" }, dev, "dev:plan"],
    ["the step of the task while its workflow is not read", { workflow: "dev", step: "dev:plan" }, undefined, "dev:plan"],
    ["the step of a task with no workflow", { step: "dev:plan" }, undefined, "dev:plan"],
    ["the first step of the workflow for a task with no step", { workflow: "dev" }, dev, "dev:research"],
    ["no step while the workflow is not read", { workflow: "dev" }, undefined, undefined],
    ["no step when the workflow read failed", { workflow: "dev" }, null, undefined],
    ["no step for a task with no workflow", {}, dev, undefined],
  ])("gives %s", (_case, task, workflow, step) => {
    expect(currentStep(task, workflow)).toBe(step);
  });
});
