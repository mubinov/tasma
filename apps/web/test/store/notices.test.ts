import type { Diagnostic } from "@tasma/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noticeWords, useNoticeStore, type Notice } from "../../src/store/notices";

const FIRST: Notice = {
  key: "task-read:SAGA-56",
  form: "warning",
  title: "1 warning about SAGA-56",
  words: ["label-case-converted · label \"Web\" was converted to \"web\""],
};

const SECOND: Notice = {
  key: "task-read:SAGA-57",
  form: "warning",
  title: "1 warning about SAGA-57",
  words: ["step-stale · step \"dev:doing\" is not a step of dev-personal"],
};

/** One animation frame of the fake clock, which is what an announcement waits for. */
const FRAME = 16;

function openKeys(): string[] {
  return useNoticeStore.getState().notices.map(({ key }) => key);
}

function announced(): string[] {
  return useNoticeStore.getState().announced.map(({ words }) => words);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("showNotice", () => {
  it("opens a notice at the bottom of the stack", () => {
    useNoticeStore.getState().showNotice(FIRST);
    useNoticeStore.getState().showNotice(SECOND);

    expect(useNoticeStore.getState().notices).toMatchObject([FIRST, SECOND]);
  });

  it("changes nothing when the open notice under the key has equal content", () => {
    useNoticeStore.getState().showNotice(FIRST);
    const before = useNoticeStore.getState();

    useNoticeStore.getState().showNotice({ ...FIRST, words: [...FIRST.words] });

    expect(useNoticeStore.getState()).toBe(before);
  });

  it("replaces the notice under the key and moves it to the bottom when the content differs", () => {
    const changed: Notice = { ...FIRST, title: "2 warnings about SAGA-56", words: [...FIRST.words, "unterminated-fence · a fence is not closed"] };
    useNoticeStore.getState().showNotice(FIRST);
    useNoticeStore.getState().showNotice(SECOND);

    useNoticeStore.getState().showNotice(changed);

    expect(useNoticeStore.getState().notices).toMatchObject([SECOND, changed]);
  });

  it("gives a new serial to each opening and each change, also to equal content closed and shown again", () => {
    const serial = () => useNoticeStore.getState().notices[0]!.serial;
    useNoticeStore.getState().showNotice(FIRST);
    const opened = serial();
    useNoticeStore.getState().showNotice({ ...FIRST, title: "2 warnings about SAGA-56" });
    const changed = serial();

    useNoticeStore.getState().closeNotice(FIRST.key);
    useNoticeStore.getState().showNotice({ ...FIRST, title: "2 warnings about SAGA-56" });

    expect(new Set([opened, changed, serial()]).size).toBe(3);
  });

  it.each([
    { name: "title", change: { title: "A different title" } },
    { name: "words", change: { words: ["temp-file-left · a temporary file was left"] } },
    { name: "word order", change: { words: ["b", "a"] } },
  ])("tells content apart by its $name", ({ change }) => {
    useNoticeStore.getState().showNotice({ ...FIRST, words: ["a", "b"] });

    useNoticeStore.getState().showNotice({ ...FIRST, words: ["a", "b"], ...change });

    expect(useNoticeStore.getState().notices).toMatchObject([{ ...FIRST, words: ["a", "b"], ...change }]);
  });
});

describe("dismissNotice", () => {
  it("removes the notice", () => {
    useNoticeStore.getState().showNotice(FIRST);
    useNoticeStore.getState().showNotice(SECOND);

    useNoticeStore.getState().dismissNotice(FIRST.key);

    expect(openKeys()).toEqual([SECOND.key]);
  });

  it("keeps a notice with equal content closed after it", () => {
    useNoticeStore.getState().showNotice(FIRST);
    useNoticeStore.getState().dismissNotice(FIRST.key);

    useNoticeStore.getState().showNotice({ ...FIRST, words: [...FIRST.words] });

    expect(openKeys()).toEqual([]);
  });

  it("opens a notice with different content after it", () => {
    const changed: Notice = { ...FIRST, words: ["temp-file-left · a temporary file was left"] };
    useNoticeStore.getState().showNotice(FIRST);
    useNoticeStore.getState().dismissNotice(FIRST.key);

    useNoticeStore.getState().showNotice(changed);

    expect(useNoticeStore.getState().notices).toMatchObject([changed]);
  });

  it("records only the key it dismisses", () => {
    useNoticeStore.getState().showNotice(FIRST);
    useNoticeStore.getState().dismissNotice(FIRST.key);

    useNoticeStore.getState().showNotice({ ...SECOND, form: FIRST.form, title: FIRST.title, words: FIRST.words });

    expect(openKeys()).toEqual([SECOND.key]);
  });

  it("changes nothing for a key that has no open notice", () => {
    useNoticeStore.getState().showNotice(FIRST);
    const before = useNoticeStore.getState();

    useNoticeStore.getState().dismissNotice(SECOND.key);

    expect(useNoticeStore.getState()).toBe(before);
  });
});

describe("closeNotice", () => {
  it("removes the notice", () => {
    useNoticeStore.getState().showNotice(FIRST);
    useNoticeStore.getState().showNotice(SECOND);

    useNoticeStore.getState().closeNotice(SECOND.key);

    expect(openKeys()).toEqual([FIRST.key]);
  });

  it("forgets the dismissed content, so equal content opens again", () => {
    useNoticeStore.getState().showNotice(FIRST);
    useNoticeStore.getState().dismissNotice(FIRST.key);

    useNoticeStore.getState().closeNotice(FIRST.key);
    useNoticeStore.getState().showNotice(FIRST);

    expect(useNoticeStore.getState().notices).toMatchObject([FIRST]);
  });

  it("forgets only the key it closes", () => {
    useNoticeStore.getState().showNotice(FIRST);
    useNoticeStore.getState().showNotice(SECOND);
    useNoticeStore.getState().dismissNotice(FIRST.key);
    useNoticeStore.getState().dismissNotice(SECOND.key);

    useNoticeStore.getState().closeNotice(SECOND.key);
    useNoticeStore.getState().showNotice(FIRST);
    useNoticeStore.getState().showNotice(SECOND);

    expect(openKeys()).toEqual([SECOND.key]);
  });

  it("changes nothing for a key that is neither open nor dismissed", () => {
    useNoticeStore.getState().showNotice(FIRST);
    const before = useNoticeStore.getState();

    useNoticeStore.getState().closeNotice(SECOND.key);

    expect(useNoticeStore.getState()).toBe(before);
  });
});

describe("noticeWords", () => {
  it("gives code · message for each diagnostic and leaves out the path and the line", () => {
    const diagnostics: Diagnostic[] = [
      { code: "unterminated-fence", message: "a fence is not closed", path: "/home/tasks/SAGA-56.md", line: 12 },
      { code: "label-case-converted", message: "label \"Web\" was converted to \"web\"" },
    ];

    expect(noticeWords(diagnostics)).toEqual([
      "unterminated-fence · a fence is not closed",
      "label-case-converted · label \"Web\" was converted to \"web\"",
    ]);
  });
});

describe("the muted line", () => {
  const FAILURE: Notice = {
    key: "task-write-failure:SAGA-56",
    form: "failure",
    title: "SAGA-56 was not moved",
    line: "The daemon refused the write, and the task is back where it was. Its own words are below.",
    words: ["store/status-unknown · status \"Gone\" is not configured"],
  };

  it("tells content apart", () => {
    useNoticeStore.getState().showNotice(FAILURE);

    useNoticeStore.getState().showNotice({ ...FAILURE, line: "No daemon answered, so nothing was written." });

    expect(useNoticeStore.getState().notices.map(({ line }) => line)).toEqual(["No daemon answered, so nothing was written."]);
  });

  it("is kept with the dismissed content", () => {
    useNoticeStore.getState().showNotice(FAILURE);
    useNoticeStore.getState().dismissNotice(FAILURE.key);

    useNoticeStore.getState().showNotice({ ...FAILURE, line: "No daemon answered, so nothing was written." });

    expect(openKeys()).toEqual([FAILURE.key]);
  });
});

describe("announce", () => {
  it("raises the words one frame after the call", () => {
    useNoticeStore.getState().announce("Saved.");

    expect(announced()).toEqual([]);

    vi.advanceTimersByTime(FRAME);

    expect(announced()).toEqual(["Saved."]);
  });

  it("adds a message node of its own for each call a frame apart, so the same words said twice are two nodes", () => {
    useNoticeStore.getState().announce("Saved.");
    vi.advanceTimersByTime(FRAME);
    useNoticeStore.getState().announce("Saved.");
    vi.advanceTimersByTime(FRAME);

    const messages = useNoticeStore.getState().announced;
    expect(messages.map(({ words }) => words)).toEqual(["Saved.", "Saved."]);
    expect(messages[0]!.serial).not.toBe(messages[1]!.serial);
  });

  it("keeps identical words raised inside one frame as one node", () => {
    useNoticeStore.getState().announce("Saved.");
    vi.advanceTimersByTime(FRAME / 2);
    useNoticeStore.getState().announce("Saved.");

    vi.advanceTimersByTime(FRAME);

    expect(announced()).toEqual(["Saved."]);
  });

  it("keeps two different messages raised in one frame, in the order they were raised", () => {
    useNoticeStore.getState().announce("Saving…");
    useNoticeStore.getState().announce("Saved.");
    useNoticeStore.getState().announce("Saving…");

    vi.advanceTimersByTime(FRAME);

    expect(announced()).toEqual(["Saving…", "Saved."]);
  });

  it("clears a message seven seconds after it is raised, and leaves a later one standing", () => {
    useNoticeStore.getState().announce("Saved.");
    vi.advanceTimersByTime(FRAME);
    vi.advanceTimersByTime(3_000);
    useNoticeStore.getState().announce("Changed on disk at 10:15. Saving overwrites that change.");
    vi.advanceTimersByTime(3_999);

    expect(announced()).toEqual(["Saved.", "Changed on disk at 10:15. Saving overwrites that change."]);

    vi.advanceTimersByTime(1);

    expect(announced()).toEqual(["Changed on disk at 10:15. Saving overwrites that change."]);

    vi.advanceTimersByTime(7_000);

    expect(announced()).toEqual([]);
  });
});

describe("what a notice announces", () => {
  const FAILURE: Notice = {
    key: "task-write-failure:SAGA-56",
    form: "failure",
    title: "SAGA-56 was not moved",
    line: "The daemon refused the write, and the task is back where it was. Its own words are below.",
    words: ["store/status-unknown · status \"Gone\" is not configured", "label-unknown · label \"x\" is not configured."],
  };

  it("says the title, the muted line and the words once, a frame after the notice opens", () => {
    useNoticeStore.getState().showNotice(FAILURE);

    expect(announced()).toEqual([]);

    vi.advanceTimersByTime(FRAME);

    expect(announced()).toEqual([
      "SAGA-56 was not moved. "
      + "The daemon refused the write, and the task is back where it was. Its own words are below. "
      + "store/status-unknown · status \"Gone\" is not configured. "
      + "label-unknown · label \"x\" is not configured.",
    ]);
  });

  it("says the title and the words of a notice with no muted line", () => {
    useNoticeStore.getState().showNotice(FIRST);
    vi.advanceTimersByTime(FRAME);

    expect(announced()).toEqual(["1 warning about SAGA-56. label-case-converted · label \"Web\" was converted to \"web\"."]);
  });

  it("says a replaced notice again", () => {
    useNoticeStore.getState().showNotice(FIRST);
    vi.advanceTimersByTime(FRAME);

    useNoticeStore.getState().showNotice({ ...FIRST, title: "2 warnings about SAGA-56" });
    vi.advanceTimersByTime(FRAME);

    expect(announced()).toEqual([
      "1 warning about SAGA-56. label-case-converted · label \"Web\" was converted to \"web\".",
      "2 warnings about SAGA-56. label-case-converted · label \"Web\" was converted to \"web\".",
    ]);
  });

  it("says nothing for content equal to the open notice", () => {
    useNoticeStore.getState().showNotice(FIRST);
    vi.advanceTimersByTime(FRAME);

    useNoticeStore.getState().showNotice({ ...FIRST, words: [...FIRST.words] });
    vi.advanceTimersByTime(FRAME);

    expect(announced()).toHaveLength(1);
  });

  it("says nothing for content equal to what the reader dismissed", () => {
    useNoticeStore.getState().showNotice(FIRST);
    useNoticeStore.getState().dismissNotice(FIRST.key);
    vi.advanceTimersByTime(FRAME);

    useNoticeStore.getState().showNotice({ ...FIRST, words: [...FIRST.words] });
    vi.advanceTimersByTime(FRAME);

    expect(announced()).toHaveLength(1);
  });

  it("says nothing when a notice is dismissed or closed", () => {
    useNoticeStore.getState().showNotice(FIRST);
    useNoticeStore.getState().showNotice(SECOND);
    vi.advanceTimersByTime(FRAME);

    useNoticeStore.getState().dismissNotice(FIRST.key);
    useNoticeStore.getState().closeNotice(SECOND.key);
    vi.advanceTimersByTime(FRAME);

    expect(announced()).toHaveLength(2);
  });

  it("says a notice and a message raised in one commit in the order they were raised", () => {
    useNoticeStore.getState().announce("Saving…");
    useNoticeStore.getState().showNotice(FIRST);

    vi.advanceTimersByTime(FRAME);

    expect(announced()).toEqual([
      "Saving…",
      "1 warning about SAGA-56. label-case-converted · label \"Web\" was converted to \"web\".",
    ]);
  });
});
