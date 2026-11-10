import { describe, expect, it } from "vitest";
import {
  agentActive,
  agentState,
  CHAT_START,
  chatBusy,
  chatInactive,
  chatMark,
  currentStep,
  foldChat,
  isActiveChat,
  PROJECT_CHAT_ACTIVE_MS,
  projectChatMark,
  projectChatSettled,
  turnRuns,
} from "@tasma/protocol";
import type { AgentState, Chat, ChatEvent, ChatFold, ChatStatus, ProjectChat, Workflow } from "@tasma/protocol";

const USER: ChatEvent = { kind: "user", text: "Start", client: "app" };

const TURN_END: ChatEvent = { kind: "turn-end", stopReason: "end_turn" };

const WAIT: ChatEvent = { kind: "background", job: true, ownTurn: false };

const OWN_TURN: ChatEvent = { kind: "background", job: false, ownTurn: true };

const OWN_TURN_WITH_JOB: ChatEvent = { kind: "background", job: true, ownTurn: true };

const CLEAR: ChatEvent = { kind: "background", job: false, ownTurn: false };

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
    expect(CHAT_START).toEqual({ turn: false, job: false, ownTurn: false, open: [], status: { state: "needs-you" } });
  });

  it("starts a turn at a user message", () => {
    expect(fold(USER)).toEqual({ turn: true, job: false, ownTurn: false, open: [], status: { state: "working" } });
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
    expect(fold(USER, permission("r1"))).toEqual({ turn: true, job: false, ownTurn: false, open: ["r1"], status: { state: "needs-you" } });
  });

  it("opens a question, which needs the user", () => {
    expect(fold(USER, question("r1"))).toEqual({ turn: true, job: false, ownTurn: false, open: ["r1"], status: { state: "needs-you" } });
  });

  it("closes a resolved permission request, and the turn works again", () => {
    expect(fold(USER, permission("r1"), permissionResolved("r1"))).toEqual({
      turn: true,
      job: false,
      ownTurn: false,
      open: [],
      status: { state: "working" },
    });
  });

  it("closes an answered question, and the turn works again", () => {
    expect(fold(USER, question("r1"), questionResolved("r1"))).toEqual({
      turn: true,
      job: false,
      ownTurn: false,
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
    expect(one).toEqual({ turn: true, job: false, ownTurn: false, open: ["r2"], status: { state: "needs-you" } });
    expect(foldChat(one, questionResolved("r2")).status).toEqual({ state: "working" });
  });

  it("ends the turn at turn-end, and clears an open request", () => {
    expect(fold(USER, permission("r1"), { kind: "turn-end", stopReason: "end_turn" })).toEqual({
      turn: false,
      job: false,
      ownTurn: false,
      open: [],
      status: { state: "needs-you" },
    });
  });

  it("ends the turn at interrupted, and clears an open request", () => {
    expect(fold(USER, question("r1"), { kind: "interrupted" })).toEqual({
      turn: false,
      job: false,
      ownTurn: false,
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

    expect(failed).toEqual({ turn: false, job: false, ownTurn: false, open: [], stopped: { state: "failed" }, status: { state: "failed" } });
    expect(foldChat(failed, permissionResolved("r1")).status).toEqual({ state: "failed" });
  });

  it("works again at a user message after failed", () => {
    const failed = fold(USER, { kind: "failed", reason: "the agent process ended" });

    expect(foldChat(failed, USER)).toEqual({ turn: true, job: false, ownTurn: false, open: [], status: { state: "working" } });
  });

  it("needs the user at resumed after failed", () => {
    expect(fold(USER, { kind: "failed", reason: "the agent process ended" }, { kind: "resumed" })).toEqual({
      turn: false,
      job: false,
      ownTurn: false,
      open: [],
      status: { state: "needs-you" },
    });
  });

  it("stops in continued-outside with where the chat continues", () => {
    const outside = fold(USER, permission("r1"), { kind: "continued-outside", where: "terminal" });

    expect(outside).toEqual({
      turn: false,
      job: false,
      ownTurn: false,
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
    expect(fold(USER, { kind: "resumed" })).toEqual({ turn: true, job: false, ownTurn: false, open: [], status: { state: "working" } });
  });
});

describe("what the agent runs", () => {
  it.each<[string, ChatEvent[], boolean, boolean, boolean]>([
    ["a running turn", [USER], true, true, true],
    ["a turn that waits at a question", [USER, question("r1")], true, true, true],
    ["a request that is open outside a turn", [USER, TURN_END, question("r1")], false, false, true],
    ["a job wait", [USER, WAIT, TURN_END], false, true, true],
    ["an own turn", [USER, TURN_END, OWN_TURN], true, true, true],
    ["an ended turn", [USER, TURN_END], false, false, false],
    ["a job wait that ended", [USER, WAIT, TURN_END, CLEAR], false, false, false],
  ])("for %s", (_case, events, runs, active, busy) => {
    const state = fold(...events);

    expect(turnRuns(state)).toBe(runs);
    expect(agentActive(state)).toBe(active);
    expect(chatBusy(state)).toBe(busy);
  });
});

describe("foldChat with a background job and an own turn", () => {
  const FAILED: ChatEvent = { kind: "failed", reason: "the agent process ended" };

  it("starts with no job and no own turn", () => {
    expect(CHAT_START.job).toBe(false);
    expect(CHAT_START.ownTurn).toBe(false);
  });

  it("clears both values and starts a turn at a user message", () => {
    expect(fold(OWN_TURN_WITH_JOB, USER)).toEqual({ turn: true, job: false, ownTurn: false, open: [], status: { state: "working" } });
  });

  it("takes both values from a background event, and keeps the turn", () => {
    expect(fold(USER, WAIT)).toEqual({ turn: true, job: true, ownTurn: false, open: [], status: { state: "working" } });
    expect(fold(OWN_TURN_WITH_JOB)).toEqual({ turn: false, job: true, ownTurn: true, open: [], status: { state: "working" } });
    expect(fold(OWN_TURN_WITH_JOB, CLEAR)).toEqual({ turn: false, job: false, ownTurn: false, open: [], status: { state: "needs-you" } });
  });

  it("does not read the stop reason of a background event", () => {
    const stopped: ChatEvent = { kind: "background", job: false, ownTurn: false, stopReason: "cancelled" };

    expect(fold(OWN_TURN_WITH_JOB, stopped)).toEqual(fold(OWN_TURN_WITH_JOB, CLEAR));
  });

  it("keeps both values at turn-end, so the chat stays working while a job runs", () => {
    expect(fold(USER, WAIT, TURN_END)).toEqual({ turn: false, job: true, ownTurn: false, open: [], status: { state: "working" } });
    expect(fold(USER, OWN_TURN_WITH_JOB, TURN_END)).toEqual({ turn: false, job: true, ownTurn: true, open: [], status: { state: "working" } });
  });

  it.each<[string, ChatEvent, ChatFold["stopped"]]>([
    ["interrupted", { kind: "interrupted" }, undefined],
    ["failed", FAILED, { state: "failed" }],
    ["continued-outside", { kind: "continued-outside", where: "terminal" }, { state: "continued-outside", where: "terminal" }],
  ])("clears both values at %s", (_case, event, stopped) => {
    const after = fold(USER, OWN_TURN_WITH_JOB, event);

    expect(after.turn).toBe(false);
    expect(after.job).toBe(false);
    expect(after.ownTurn).toBe(false);
    expect(after.stopped).toEqual(stopped);
    expect(after.status).toEqual(stopped ?? { state: "needs-you" });
  });

  it.each<[string, ChatEvent]>([
    ["permission", permission("r1")],
    ["question", question("r1")],
    ["permission-resolved", permissionResolved("r1")],
    ["question-resolved", questionResolved("r1")],
    ["resumed", { kind: "resumed" }],
    ["update", { kind: "update", update: { sessionUpdate: "agent_message_chunk" } }],
  ])("keeps both values at %s", (_case, event) => {
    const after = fold(OWN_TURN_WITH_JOB, event);

    expect(after.job).toBe(true);
    expect(after.ownTurn).toBe(true);
  });

  it("needs the user at a request of an own turn, and works again at its answer", () => {
    const asked = fold(OWN_TURN_WITH_JOB, permission("r1"));

    expect(asked.status).toEqual({ state: "needs-you" });
    expect(foldChat(asked, permissionResolved("r1")).status).toEqual({ state: "working" });
  });

  it("needs the user at a request during a job wait, and works again at its answer", () => {
    const asked = fold(WAIT, question("r1"));

    expect(asked.status).toEqual({ state: "needs-you" });
    expect(foldChat(asked, questionResolved("r1")).status).toEqual({ state: "working" });
  });

  it("gives a stop priority over a job", () => {
    const failed = fold(USER, FAILED, WAIT);

    expect(failed.job).toBe(true);
    expect(failed.status).toEqual({ state: "failed" });
  });

  it("works at resumed after a stop when a background event came after the stop", () => {
    expect(fold(USER, FAILED, WAIT, { kind: "resumed" }).status).toEqual({ state: "working" });
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
    ["failed on a past step that the user saw to its state", { ...base, state: "failed", seen: 4 }, "dev:plan", undefined],
    [
      "continued-outside on a past step",
      { ...base, state: "continued-outside", where: "terminal" },
      "dev:plan",
      { state: "continued-outside", where: "terminal" },
    ],
    ["needs-you on the current step, marked inactive at its state", { ...base, inactive: 4 }, "dev:research", undefined],
    ["needs-you on the current step, marked inactive after its state", { ...base, inactive: 6 }, "dev:research", undefined],
    ["failed on the current step, marked inactive", { ...base, state: "failed", inactive: 4 }, "dev:research", undefined],
    [
      "continued-outside on the current step, marked inactive",
      { ...base, state: "continued-outside", where: "vscode", inactive: 4 },
      "dev:research",
      undefined,
    ],
    ["a state after the inactive mark", { ...base, inactive: 3 }, "dev:research", { state: "needs-you" }],
    ["working, marked inactive", { ...base, state: "working", inactive: 6 }, "dev:research", { state: "working" }],
  ])("gives the mark of %s", (_case, chat, step, mark) => {
    expect(chatMark(chat, step)).toEqual(mark);
  });

  it("gives a new object, not the chat", () => {
    const chat: Chat = { ...base, state: "working" };

    expect(chatMark(chat, chat.step)).not.toBe(chat);
  });
});

const LAST_EVENT = "2026-01-02T10:00:00Z";
const recent = Date.parse(LAST_EVENT) + PROJECT_CHAT_ACTIVE_MS - 1;
const old = Date.parse(LAST_EVENT) + PROJECT_CHAT_ACTIVE_MS;

describe("projectChatMark", () => {
  const base: ProjectChat = {
    chat: 1,
    title: "Plan the release",
    agent: "claude",
    folder: "/work/alpha",
    created: "2026-01-02T09:00:00Z",
    seq: 6,
    stateSeq: 4,
    seen: 6,
    state: "needs-you",
  };

  it.each<[string, ProjectChat, boolean, string, number, ChatStatus | undefined]>([
    ["a working chat, old", { ...base, state: "working" }, true, LAST_EVENT, old, { state: "working" }],
    ["a chat with a waiting request, old", base, true, LAST_EVENT, old, { state: "needs-you" }],
    ["an unseen answer, old", { ...base, seen: 3 }, false, LAST_EVENT, old, { state: "needs-you" }],
    ["a chat nobody saw, old", { ...base, seen: undefined }, false, LAST_EVENT, old, { state: "needs-you" }],
    ["a seen chat 1 ms before 2 days", base, false, LAST_EVENT, recent, { state: "needs-you" }],
    ["a seen chat at exactly 2 days", base, false, LAST_EVENT, old, undefined],
    ["a chat with an empty log, old", { ...base, seq: 0, stateSeq: 0, seen: undefined }, false, LAST_EVENT, old, undefined],
    ["a seen failed chat, old", { ...base, state: "failed" }, false, LAST_EVENT, old, undefined],
    [
      "a seen continued-outside chat, recent",
      { ...base, state: "continued-outside", where: "terminal" },
      false,
      LAST_EVENT,
      recent,
      { state: "continued-outside", where: "terminal" },
    ],
    ["a seen chat whose time cannot be read", base, false, "not a time", old, { state: "needs-you" }],
    ["a busy chat marked inactive", { ...base, state: "working", inactive: 6 }, true, LAST_EVENT, recent, { state: "working" }],
    ["a chat nobody saw, marked inactive, recent", { ...base, seen: undefined, inactive: 4 }, false, LAST_EVENT, recent, undefined],
    ["a failed chat marked inactive, recent", { ...base, state: "failed", inactive: 6 }, false, LAST_EVENT, recent, undefined],
    ["a state after the inactive mark, recent", { ...base, inactive: 3 }, false, LAST_EVENT, recent, { state: "needs-you" }],
  ])("gives the mark of %s", (_case, chat, busy, lastEvent, now, mark) => {
    expect(projectChatMark(chat, busy, lastEvent, now)).toEqual(mark);
  });

  it("gives a new object, not the chat", () => {
    expect(projectChatMark(base, true, LAST_EVENT, old)).not.toBe(base);
  });
});

describe("chatInactive", () => {
  it.each<[string, boolean, number | undefined, number]>([
    ["no mark", false, undefined, 4],
    ["a mark before the state", false, 3, 4],
    ["a mark at the state", true, 4, 4],
    ["a mark after the state", true, 6, 4],
    ["no mark on an empty log", false, undefined, 0],
    ["a mark on an empty log", true, 0, 0],
  ])("counts %s as inactive: %s", (_case, inactive, mark, upTo) => {
    expect(chatInactive(mark, upTo)).toBe(inactive);
  });
});

describe("projectChatSettled", () => {
  it.each<[string, boolean, Pick<ProjectChat, "seen" | "inactive">, number, string, number]>([
    ["a chat seen up to its seq, 1 ms before 2 days", false, { seen: 4 }, 4, LAST_EVENT, recent],
    ["a chat seen up to its seq, exactly 2 days", true, { seen: 4 }, 4, LAST_EVENT, old],
    ["a chat seen past its seq, old", true, { seen: 6 }, 4, LAST_EVENT, old],
    ["a chat seen before its seq, old", false, { seen: 3 }, 4, LAST_EVENT, old],
    ["a chat nobody saw, with no seq, old", true, {}, 0, LAST_EVENT, old],
    ["a chat nobody saw, old", false, {}, 1, LAST_EVENT, old],
    ["2 days in another offset", true, { seen: 4 }, 4, "2026-01-02T12:00:00+02:00", Date.parse("2026-01-04T10:00:00Z")],
    ["a time that cannot be read", false, { seen: 4 }, 4, "", old],
    ["a chat marked as not active at its seq, recent", true, { inactive: 4 }, 4, LAST_EVENT, recent],
    ["a chat marked as not active past its seq, recent", true, { inactive: 6 }, 4, LAST_EVENT, recent],
    ["a chat marked as not active before its seq, old", false, { inactive: 3 }, 4, LAST_EVENT, old],
    ["a chat marked as not active before its seq and seen up to it, old", true, { seen: 4, inactive: 3 }, 4, LAST_EVENT, old],
    ["a chat marked as not active on an empty log, recent", true, { inactive: 0 }, 0, LAST_EVENT, recent],
  ])("counts %s as settled: %s", (_case, settled, chat, upTo, lastEvent, now) => {
    expect(projectChatSettled(chat, upTo, lastEvent, now)).toBe(settled);
  });

  it("holds 2 days", () => {
    expect(PROJECT_CHAT_ACTIVE_MS).toBe(2 * 24 * 60 * 60 * 1000);
  });
});

describe("isActiveChat", () => {
  it.each<[string, ChatStatus | undefined, boolean]>([
    ["working", { state: "working" }, true],
    ["needs-you", { state: "needs-you" }, true],
    ["failed", { state: "failed" }, true],
    ["continued-outside", { state: "continued-outside", where: "vscode" }, false],
    ["no mark", undefined, false],
  ])("counts a row with the mark %s as active: %s", (_case, status, active) => {
    expect(isActiveChat(status)).toBe(active);
  });
});

describe("agentState", () => {
  const WORKING: ChatStatus = { state: "working" };
  const NEEDS_YOU: ChatStatus = { state: "needs-you" };
  const FAILED: ChatStatus = { state: "failed" };
  const OUTSIDE: ChatStatus = { state: "continued-outside", where: "terminal" };

  it.each<[string, (ChatStatus | undefined)[], AgentState]>([
    ["no rows", [], "off"],
    ["a row with no mark", [undefined], "off"],
    ["a chat continued outside", [OUTSIDE], "off"],
    ["a working row", [WORKING], "running"],
    ["a working row beside rows out of the Active group", [undefined, OUTSIDE, WORKING], "running"],
    ["a needs-you row", [NEEDS_YOU], "needs-you"],
    ["a failed row", [FAILED], "needs-you"],
    ["a working row before a needs-you row", [WORKING, NEEDS_YOU], "needs-you"],
    ["a needs-you row before a working row", [NEEDS_YOU, WORKING], "needs-you"],
    ["a working row before a failed row", [WORKING, FAILED], "needs-you"],
  ])("gives %s the state of the Active group", (_case, statuses, state) => {
    expect(agentState(statuses)).toBe(state);
  });

  it("reads any iterable", () => {
    expect(agentState(new Set([WORKING]))).toBe("running");
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
