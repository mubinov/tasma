import { describe, expect, it } from "vitest";
import { editorKey } from "../../src/lib/editor-subject";

describe("editorKey", () => {
  it("gives each editor of the page a key of its own", () => {
    expect(editorKey({ kind: "task" })).toBe("task");
    expect(editorKey({ kind: "new" })).toBe("new");
    expect(editorKey({ kind: "comment", id: 3 })).toBe("comment:3");
  });
});
