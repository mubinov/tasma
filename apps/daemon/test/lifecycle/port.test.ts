import { describe, expect, it } from "vitest";
import { DEFAULT_DAEMON_PORT } from "@tasma/protocol";
import { resolveDaemonPort } from "../../src/lifecycle/port.js";

describe("the port one daemon binds", () => {
  it("takes the flag over the variable, and the variable over the default", () => {
    expect(resolveDaemonPort("1234", { TASMA_DAEMON_PORT: "4321" })).toBe(1234);
    expect(resolveDaemonPort(undefined, { TASMA_DAEMON_PORT: "4321" })).toBe(4321);
    expect(resolveDaemonPort(undefined, {})).toBe(DEFAULT_DAEMON_PORT);
  });

  it("accepts every port number, the two ends of the range included", () => {
    for (const port of [0, 1, 8278, 65535]) {
      expect(resolveDaemonPort(String(port), {})).toBe(port);
    }
  });

  it("reads an empty value as no value, on either channel", () => {
    expect(resolveDaemonPort("", { TASMA_DAEMON_PORT: "4321" })).toBe(4321);
    expect(resolveDaemonPort(undefined, { TASMA_DAEMON_PORT: "" })).toBe(DEFAULT_DAEMON_PORT);
  });

  it("refuses a value that is not a run of decimal digits inside the range", () => {
    for (const value of ["+1", "-1", "1.0", " 1", "1 ", "65536", "nonsense", "0x10", "1e3"]) {
      expect(() => resolveDaemonPort(value, {})).toThrow(/from 0 to 65535/);
    }
  });

  it("names the channel that stated the value it refused", () => {
    expect(() => resolveDaemonPort("nonsense", {})).toThrow('--port must be a whole number from 0 to 65535: "nonsense"');
    expect(() => resolveDaemonPort(undefined, { TASMA_DAEMON_PORT: "nonsense" })).toThrow(
      'TASMA_DAEMON_PORT must be a whole number from 0 to 65535: "nonsense"',
    );
  });

  it("shows a value that carries a break as its escape, so the refusal stays one line", () => {
    expect(() => resolveDaemonPort("8278\nrest", {})).toThrow('--port must be a whole number from 0 to 65535: "8278\\nrest"');
  });
});
