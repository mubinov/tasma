import { describe, expect, it } from "vitest";
import {
  reloadLabel,
  savedStatus,
  savedWords,
  savingWords,
  subjectWords,
  unsavedDescription,
  type UnsavedEditor,
} from "../../src/lib/unsaved-words";

const TASK: UnsavedEditor = { subject: { kind: "task" }, removed: false };

const NEW: UnsavedEditor = { subject: { kind: "new" }, removed: false };

function commentEditor(id: number, removed = false): UnsavedEditor {
  return { subject: { kind: "comment", id }, removed };
}

describe("unsavedDescription", () => {
  it("is nothing where no editor is registered", () => {
    expect(unsavedDescription([])).toBeNull();
  });

  it("names the task text alone", () => {
    expect(unsavedDescription([TASK])).toBe("The task text is not saved. There is no undo.");
  });

  it("names one comment by its id", () => {
    expect(unsavedDescription([commentEditor(3)])).toBe("Comment #3 is not saved. There is no undo.");
  });

  it("names the add form", () => {
    expect(unsavedDescription([NEW])).toBe("The new comment is not saved. There is no undo.");
  });

  it("names the task text and every comment together", () => {
    expect(unsavedDescription([TASK, commentEditor(3), commentEditor(5)]))
      .toBe("The task text and comments #3 and #5 are not saved. There is no undo.");
  });

  it("lists three comments with a comma before the last", () => {
    expect(unsavedDescription([commentEditor(3), commentEditor(5), commentEditor(7)]))
      .toBe("Comments #3, #5 and #7 are not saved. There is no undo.");
  });

  it("orders the comments by id whatever order they registered in", () => {
    expect(unsavedDescription([commentEditor(5), commentEditor(3)]))
      .toBe("Comments #3 and #5 are not saved. There is no undo.");
  });

  it("puts the new comment last", () => {
    expect(unsavedDescription([NEW, TASK]))
      .toBe("The task text and the new comment are not saved. There is no undo.");
  });

  it("gives a comment removed on disk its own clause", () => {
    expect(unsavedDescription([TASK, commentEditor(3, true)])).toBe(
      "The task text is not saved. Comment #3 was removed on disk and cannot be saved. There is no undo.",
    );
  });

  it("says nothing is saveable where every editor lost its comment on disk", () => {
    expect(unsavedDescription([commentEditor(3, true)]))
      .toBe("Comment #3 was removed on disk and cannot be saved. There is no undo.");
  });
});

describe("savedStatus", () => {
  it("names what was saved and what is still not", () => {
    expect(savedStatus({ kind: "comment", id: 3 }, [TASK, commentEditor(5)]))
      .toBe("Comment #3 saved. The task text and comment #5 are still not saved.");
  });

  it("names the add form's completion", () => {
    expect(savedStatus({ kind: "new" }, [TASK])).toBe("Comment added. The task text is still not saved.");
  });

  it("keeps the removed-on-disk clause beside the rest", () => {
    expect(savedStatus({ kind: "task" }, [commentEditor(3, true)]))
      .toBe("Saved. Comment #3 was removed on disk and cannot be saved.");
  });

  it("says what was saved alone where the registry emptied", () => {
    expect(savedStatus({ kind: "comment", id: 3 }, [])).toBe("Comment #3 saved.");
  });
});

describe("the words an editor speaks", () => {
  it("names the subject at the start of a write", () => {
    expect(savingWords({ kind: "task" })).toBe("Saving…");
    expect(savingWords({ kind: "comment", id: 3 })).toBe("Saving comment #3…");
    expect(savingWords({ kind: "new" })).toBe("Adding the new comment…");
  });

  it("names the subject at the end of a write", () => {
    expect(savedWords({ kind: "task" })).toBe("Saved.");
    expect(savedWords({ kind: "comment", id: 3 })).toBe("Comment #3 saved.");
    expect(savedWords({ kind: "new" })).toBe("Comment added.");
  });

  it("heads a sentence with the subject", () => {
    expect(subjectWords({ kind: "comment", id: 3 })).toBe("Comment #3");
    expect(subjectWords({ kind: "task" })).toBe("The task text");
  });

  it("names the comment a reload control belongs to, and nothing where the page draws one", () => {
    expect(reloadLabel({ kind: "comment", id: 3 })).toBe("Discard and reload comment #3");
    expect(reloadLabel({ kind: "task" })).toBe("Discard and reload");
  });
});
