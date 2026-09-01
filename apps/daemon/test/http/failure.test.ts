import { describe, expect, it } from "vitest";
import { TaskParseError, TaskSerializeError, TaskStoreError } from "@tasma/engine";
import type { DaemonErrorCode, Failure, ParseErrorCode, SerializeErrorCode, StoreErrorCode } from "@tasma/protocol";
import { DaemonError, statusOf, toFailure } from "../../src/http/failure.js";

function statusOfStore(code: StoreErrorCode): number {
  return statusOf({ kind: "store", code, message: code });
}

function statusOfParse(code: ParseErrorCode): number {
  return statusOf({ kind: "parse", code, message: code, line: 1 });
}

function statusOfSerialize(code: SerializeErrorCode): number {
  return statusOf({ kind: "serialize", code, message: code, line: 1 });
}

describe("toFailure", () => {
  it("carries the code and the path of a store refusal", () => {
    const failure = toFailure(new TaskStoreError("task-not-found", "no such task", "/tmp/TASM-3.md"));

    expect(failure).toEqual({
      kind: "store",
      code: "task-not-found",
      message: "/tmp/TASM-3.md: no such task",
      path: "/tmp/TASM-3.md",
    });
  });

  it("leaves the path out where the store refusal names none", () => {
    expect(toFailure(new TaskStoreError("index-closed", "the index is closed"))).toEqual({
      kind: "store",
      code: "index-closed",
      message: "the index is closed",
      path: undefined,
    });
  });

  it("carries the line and the filename of a parse refusal", () => {
    const failure = toFailure(new TaskParseError("frontmatter-missing", 1, "no frontmatter", "TASM-3.md"));

    expect(failure).toEqual({
      kind: "parse",
      code: "frontmatter-missing",
      message: "TASM-3.md:1: no frontmatter",
      line: 1,
      filename: "TASM-3.md",
    });
  });

  it("carries the field of a serialize refusal, which no other arm has", () => {
    const failure = toFailure(new TaskSerializeError("label-invalid", 4, "a label may not hold a space", "labels"));

    expect(failure).toEqual({
      kind: "serialize",
      code: "label-invalid",
      message: "line 4: a label may not hold a space",
      line: 4,
      filename: undefined,
      field: "labels",
    });
  });

  it("carries the code of a refusal the daemon raised itself", () => {
    expect(toFailure(new DaemonError("request-too-large", "the body is over 8 MiB"))).toEqual({
      kind: "daemon",
      code: "request-too-large",
      message: "the body is over 8 MiB",
    });
  });

  it("reports anything else as internal, keeping its text", () => {
    expect(toFailure(new Error("the disk went away"))).toEqual({
      kind: "daemon",
      code: "internal",
      message: "the disk went away",
    });
  });

  it("reports a thrown value that is not an error as internal, keeping its text", () => {
    expect(toFailure("no")).toEqual({ kind: "daemon", code: "internal", message: "no" });
  });
});

describe("the status of a refusal", () => {
  it.each<StoreErrorCode>(["task-not-found", "comment-not-found", "project-not-found"])(
    "answers 404 for the store code %s",
    (code) => expect(statusOfStore(code)).toBe(404),
  );

  it.each<StoreErrorCode>(["task-exists", "comment-exists", "snapshot-lost"])(
    "answers 409 for the store code %s",
    (code) => expect(statusOfStore(code)).toBe(409),
  );

  it.each<StoreErrorCode>(["project-invalid", "config-invalid", "workflow-invalid", "step-file-unreadable"])(
    "answers 422 for the store code %s, which is a file on disk rather than a bad call",
    (code) => expect(statusOfStore(code)).toBe(422),
  );

  it("answers 503 for index-closed, which only a daemon on its way out raises", () => {
    expect(statusOfStore("index-closed")).toBe(503);
  });

  it.each<StoreErrorCode>([
    "status-unknown",
    "priority-unknown",
    "label-invalid",
    "workflow-unknown",
    "step-unknown",
    "field-not-writable",
    "field-required",
    "id-mismatch",
  ])("answers 400 for the store code %s", (code) => expect(statusOfStore(code)).toBe(400));

  it.each<ParseErrorCode>([
    "frontmatter-missing",
    "frontmatter-unterminated",
    "frontmatter-invalid",
    "frontmatter-key-missing",
    "frontmatter-key-type",
    "marker-unterminated",
    "marker-invalid",
    "marker-key-missing",
    "marker-key-type",
    "comment-id-duplicate",
  ])("answers 422 for every parse code, here %s", (code) => expect(statusOfParse(code)).toBe(422));

  it.each<SerializeErrorCode>([
    "key-missing",
    "key-type",
    "label-invalid",
    "value-contains-arrow",
    "frontmatter-collision",
    "marker-collision",
    "fence-unterminated",
    "comment-id-duplicate",
    "value-unwritable",
  ])("answers 400 for the serialize code %s, which rejects what the caller sent", (code) =>
    expect(statusOfSerialize(code)).toBe(400));

  it.each<SerializeErrorCode>(["anchor-aliased", "merge-key", "key-unaddressable"])(
    "answers 422 for the serialize code %s, which is a property of the YAML already in the file",
    (code) => expect(statusOfSerialize(code)).toBe(422),
  );

  it("answers 500 for region-unwritable, which is the daemon's own fault to report", () => {
    expect(statusOfSerialize("region-unwritable")).toBe(500);
  });

  it.each<[DaemonErrorCode, number]>([
    ["internal", 500],
    ["malformed-request", 400],
    ["route-not-found", 404],
    ["method-not-allowed", 405],
    ["unsupported-media-type", 415],
    ["request-too-large", 413],
  ])("answers the daemon code %s with %i", (code, status) => {
    const failure: Failure = { kind: "daemon", code, message: code };
    expect(statusOf(failure)).toBe(status);
  });
});
