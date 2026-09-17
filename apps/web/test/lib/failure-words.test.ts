import { ProtocolError, TransportError } from "@tasma/protocol";
import { describe, expect, it } from "vitest";
import { DAEMON_URL } from "../../src/api/transport";
import { failureWords, joinFailureWords } from "../../src/lib/failure-words";

describe("failureWords", () => {
  it("gives a refusal's kind/code as the head and its message", () => {
    const refusal = new ProtocolError({ kind: "store", code: "status-unknown", message: "status \"Gone\" is not configured" }, 422);

    expect(failureWords(refusal)).toEqual({ head: "store/status-unknown", message: "status \"Gone\" is not configured" });
  });

  it("gives a refusal's message as text when it is not a string", () => {
    const refusal = new ProtocolError({ kind: "store", code: "config-invalid", message: { path: "config.yml" } } as never, 422);

    expect(failureWords(refusal).message).toBe("[object Object]");
  });

  it("gives the daemon's address alone when nothing answered", () => {
    expect(failureWords(new TransportError("GET /health reached no daemon"))).toEqual({ message: DAEMON_URL });
  });

  it("gives the address and the status as the head when something else answered", () => {
    expect(failureWords(new TransportError("GET /health answered with no envelope", 502))).toEqual({
      head: `${DAEMON_URL} · HTTP 502`,
      message: "GET /health answered with no envelope",
    });
  });

  it.each([
    { thrown: new Error("the write did not start"), message: "the write did not start" },
    { thrown: "a thrown string", message: "a thrown string" },
    { thrown: null, message: "null" },
  ])("gives the message of any other failure: $thrown", ({ thrown, message }) => {
    expect(failureWords(thrown)).toEqual({ message });
  });
});

describe("joinFailureWords", () => {
  it("joins the head and the message", () => {
    expect(joinFailureWords({ head: "store/status-unknown", message: "no such status" })).toBe("store/status-unknown · no such status");
  });

  it("gives the message alone when there is no head", () => {
    expect(joinFailureWords({ message: DAEMON_URL })).toBe(DAEMON_URL);
  });
});
