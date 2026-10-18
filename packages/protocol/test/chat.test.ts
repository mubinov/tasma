import { describe, expect, it } from "vitest";
import { CHAT_START, foldChat } from "@tasma/protocol";
import type { ChatEvent, ChatFold } from "@tasma/protocol";

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
