import { describe, expect, it } from "vitest";
import { parseTask, serializeTask, type Task } from "@tasma/engine";
import { labelFault } from "../../src/format/schema.js";
import { fixture } from "./fixtures.js";
import { afterFrontmatter, newTask, serializeError } from "./tasks.js";

function withLabels(labels: string[]): Task {
  const task = newTask();
  return { ...task, frontmatter: { ...task.frontmatter, labels } };
}

/** The example, with a stored label the contract forbids a writer to write. */
function fileWithStoredLabel(): Task {
  return parseTask(fixture("valid/example.md").replace("labels: [import]", "labels: [Backend]")).task;
}

describe("labelFault", () => {
  it.each(["a", "backend", "customer-request", "b2b", "0", "a--b", "1-2"])("accepts %s", (label) => {
    expect(labelFault(label)).toBeUndefined();
  });

  it.each(["", "-backend", "backend-", "Backend", "customer request", "customer_request", "a:b", "a.b", "ä"])(
    "rejects %s",
    (label) => {
      expect(labelFault(label)).toBeTypeOf("string");
    },
  );

  it("names the character that failed", () => {
    expect(labelFault("customer request")).toContain('" "');
  });
});

describe("a label a write sets", () => {
  it("rejects a label that carries a character the form does not allow", () => {
    const error = serializeError(withLabels(["Customer Request"]));

    expect(error.code).toBe("label-invalid");
    expect(error.field).toBe("labels");
    expect(error.message).toContain("Customer Request");
  });

  it.each(["-backend", "backend-", ""])("rejects the label %s", (label) => {
    expect(serializeError(withLabels([label])).code).toBe("label-invalid");
  });

  it("names the label that failed, not the first label of the list", () => {
    expect(serializeError(withLabels(["backend", "Frontend"])).message).toContain("Frontend");
  });

  it("writes a list of conforming labels", () => {
    expect(serializeTask(withLabels(["backend", "customer-request"]))).toContain("labels:");
  });
});

describe("a label the file already carries", () => {
  it("is written back when the write changes another key", () => {
    const task = fileWithStoredLabel();

    const written = serializeTask({ ...task, frontmatter: { ...task.frontmatter, title: "Renamed" } });

    expect(parseTask(written).task.frontmatter.labels).toEqual(["Backend"]);
    expect(parseTask(written).task.frontmatter.title).toBe("Renamed");
  });

  it("leaves every region other than the frontmatter byte-identical", () => {
    const source = fixture("valid/example.md").replace("labels: [import]", "labels: [Backend]");
    const task = parseTask(source).task;

    const written = serializeTask({ ...task, frontmatter: { ...task.frontmatter, title: "Renamed" } });

    expect(afterFrontmatter(written)).toBe(afterFrontmatter(source));
  });

  it("is rejected once the write sets the labels themselves", () => {
    const task = fileWithStoredLabel();

    expect(serializeError({ ...task, frontmatter: { ...task.frontmatter, labels: ["Backend", "extra"] } }).code).toBe(
      "label-invalid",
    );
  });

  it("is checked again once a copy drops the text the writer would carry it over from", () => {
    // A writer carries a value over only while it holds the region the value was
    // read from. A copy that drops the source hands it a task it has never seen,
    // so every label in it is a label the writer is given.
    expect(serializeError(structuredClone(fileWithStoredLabel())).code).toBe("label-invalid");
  });
});
