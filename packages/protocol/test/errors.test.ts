import { describe, expect, it } from "vitest";
import { ProtocolError, TransportError } from "@tasma/protocol";
import type { Failure } from "@tasma/protocol";

/** The one reader that has to tell the four arms apart, written the way a client writes it. */
function describeFailure(failure: Failure): string {
  switch (failure.kind) {
    case "store":
      return `${failure.code} at ${failure.path ?? "no path"}`;
    case "parse":
      return `${failure.code} on line ${failure.line} of ${failure.filename ?? "no file"}`;
    case "serialize":
      return `${failure.code} on line ${failure.line} at ${failure.field ?? "no field"}`;
    case "daemon":
      return failure.code;
  }
}

describe("a failure", () => {
  it("reaches the path of a store refusal", () => {
    const failure: Failure = { kind: "store", code: "task-not-found", message: "no such task", path: "/tmp/a.md" };
    expect(describeFailure(failure)).toBe("task-not-found at /tmp/a.md");
  });

  it("reaches the line of a parse refusal", () => {
    const failure: Failure = { kind: "parse", code: "frontmatter-missing", message: "no frontmatter", line: 1 };
    expect(describeFailure(failure)).toBe("frontmatter-missing on line 1 of no file");
  });

  it("reaches the field of a serialize refusal", () => {
    const failure: Failure = {
      kind: "serialize",
      code: "label-invalid",
      message: "a label may not hold a space",
      line: 4,
      field: "labels",
    };
    expect(describeFailure(failure)).toBe("label-invalid on line 4 at labels");
  });

  it("carries a daemon fault with nothing but a code and a message", () => {
    const failure: Failure = { kind: "daemon", code: "malformed-request", message: "the body is not JSON" };
    expect(describeFailure(failure)).toBe("malformed-request");
  });

  it("reports the absent optional fields of each arm", () => {
    expect(describeFailure({ kind: "store", code: "index-closed", message: "closed" })).toBe(
      "index-closed at no path",
    );
    expect(describeFailure({ kind: "serialize", code: "key-missing", message: "no key", line: 2 })).toBe(
      "key-missing on line 2 at no field",
    );
  });
});

describe("ProtocolError", () => {
  const failure: Failure = { kind: "parse", code: "marker-invalid", message: "the marker is not readable", line: 9 };
  const error = new ProtocolError(failure, 422);

  it("is an Error", () => {
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ProtocolError);
  });

  it("is named after its class", () => {
    expect(error.name).toBe("ProtocolError");
  });

  it("carries the message of the failure", () => {
    expect(error.message).toBe("the marker is not readable");
  });

  it("carries the failure and the advisory status", () => {
    expect(error.failure).toBe(failure);
    expect(error.status).toBe(422);
  });
});

describe("TransportError", () => {
  it("is an Error named after its class", () => {
    const error = new TransportError("the daemon sent no envelope", 500);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(TransportError);
    expect(error.name).toBe("TransportError");
    expect(error.message).toBe("the daemon sent no envelope");
    expect(error.status).toBe(500);
  });

  it("leaves the status unset when no answer arrived", () => {
    const cause = new Error("connection refused");
    const error = new TransportError("the call reached no daemon", undefined, cause);
    expect(error.status).toBeUndefined();
    expect(error.cause).toBe(cause);
  });
});
