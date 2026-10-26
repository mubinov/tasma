import { describe, expect, it } from "vitest";
import { applyPlan, isHidden, wanted } from "../../src/chats/options.js";
import { modelOption, modeOption } from "../agents/fake-agent.js";

const OPTIONS = [modeOption(), modelOption()];

describe("applyPlan", () => {
  it("puts the model first, then the other options in list order, and an option the list lacks last", () => {
    const plan = applyPlan(OPTIONS, { defaults: { effort: "high", mode: "auto", model: "large" }, chosen: {}, waiting: [] });

    expect(plan).toEqual([
      { configId: "model", value: "large" },
      { configId: "mode", value: "auto" },
      { configId: "effort", value: "high" },
    ]);
  });

  it("takes a pick of the chat over a default, and a waiting pick over both", () => {
    const first = { configId: "mode", value: "acceptEdits" };
    const second = { configId: "mode", value: "auto" };

    const plan = applyPlan(OPTIONS, {
      defaults: { mode: "default", model: "large" },
      chosen: { mode: "bypassPermissions", model: "small" },
      waiting: [first, second],
    });

    expect(plan).toEqual([
      { configId: "model", value: "small" },
      { ...first, pick: first },
      { ...second, pick: second },
    ]);
  });
});

describe("wanted", () => {
  it.each([
    ["an offered value that is not current", "mode", "auto", true],
    ["a value in a group", "model", "large", true],
    ["the current value", "mode", "default", false],
    ["a hidden value", "mode", "plan", false],
    ["a value the option does not offer", "mode", "fast", false],
    ["an option the list lacks", "effort", "high", false],
  ])("gives whether to send %s", (_case, configId, value, expected) => {
    expect(wanted("claude", OPTIONS, configId, value)).toBe(expected);
  });
});

describe("isHidden", () => {
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])("finds no rule for an option named %s", (configId) => {
    expect(isHidden("claude", configId, "plan")).toBe(false);
  });

  it("finds the hidden values of the agent alone", () => {
    expect(isHidden("claude", "mode", "plan")).toBe(true);
    expect(isHidden("codex", "mode", "plan")).toBe(false);
  });
});
