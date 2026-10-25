import type { Chat, Workflow } from "@tasma/protocol";
import { describe, expect, it } from "vitest";
import { actionStep, stepAction, stepActionVerb } from "../../src/lib/step-action";
import { chatRecord } from "../chat-daemon";
import { WORKFLOW } from "../task-screen-fixtures";

function chat(number: number, fields: Partial<Chat> = {}): Chat {
  return chatRecord({ chat: number, step: "research", seq: 4, state: "working", ...fields });
}

describe("actionStep", () => {
  it("gives null for a task with no workflow", () => {
    expect(actionStep({ step: "research" }, WORKFLOW)).toBeNull();
  });

  it.each([undefined, null])("gives null while the workflow is %s", (workflow) => {
    expect(actionStep({ workflow: "dev", step: "research" }, workflow)).toBeNull();
  });

  it("gives null for a step that the workflow does not have", () => {
    expect(actionStep({ workflow: "dev", step: "deploy" }, WORKFLOW)).toBeNull();
  });

  it("gives the first step of the workflow for a task with no step", () => {
    expect(actionStep({ workflow: "dev" }, WORKFLOW)).toBe("research");
  });

  it("gives null for a task with no step when the workflow has no step", () => {
    const empty: Workflow = { ...WORKFLOW, steps: [] };

    expect(actionStep({ workflow: "dev" }, empty)).toBeNull();
  });

  it("gives the step of the task", () => {
    expect(actionStep({ workflow: "dev", step: "approve" }, WORKFLOW)).toBe("approve");
  });
});

describe("stepAction", () => {
  it("starts when the task has no chat", () => {
    expect(stepAction("research", [])).toEqual({ kind: "start", step: "research" });
  });

  it.each([
    ["working", { state: "working" }],
    ["needs-you", { state: "needs-you" }],
    ["continued-outside", { state: "continued-outside", where: "vscode" }],
  ] as const)("opens the latest chat of the step when it is %s", (_name, status) => {
    expect(stepAction("research", [chat(1), chat(2, status)])).toEqual({ kind: "open", step: "research", chat: 2 });
  });

  it("starts when the latest chat of the step failed", () => {
    expect(stepAction("research", [chat(1), chat(2, { state: "failed" })])).toEqual({ kind: "start", step: "research" });
  });

  it("starts when the latest chat of the step has no first message", () => {
    expect(stepAction("research", [chat(1, { seq: 0 })])).toEqual({ kind: "start", step: "research" });
  });

  it("starts when the latest chat is of another step, also when an older chat is of the step", () => {
    expect(stepAction("research", [chat(1), chat(2, { step: "approve" })])).toEqual({ kind: "start", step: "research" });
  });
});

describe("stepActionVerb", () => {
  it("says Start for a start and Open for an open", () => {
    expect(stepActionVerb({ kind: "start", step: "research" })).toBe("Start");
    expect(stepActionVerb({ kind: "open", step: "research", chat: 2 })).toBe("Open");
  });
});
