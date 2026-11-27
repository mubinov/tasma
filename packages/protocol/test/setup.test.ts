import { describe, expect, it } from "vitest";
import { isAgentReady, type AgentSetup, type SetupCheck } from "@tasma/protocol";

const READY: AgentSetup = { agent: "codex", installed: "pass", loggedIn: "pass", skill: "fail" };

describe("a ready agent", () => {
  it("is installed and logged in, whatever its skill check gives", () => {
    expect(isAgentReady(READY)).toBe(true);
  });

  it("is not ready when the install check or the login check gives anything but pass", () => {
    for (const check of ["fail", "not-run", "unknown"] satisfies SetupCheck[]) {
      expect(isAgentReady({ ...READY, installed: check })).toBe(false);
      expect(isAgentReady({ ...READY, loggedIn: check })).toBe(false);
    }
  });
});
