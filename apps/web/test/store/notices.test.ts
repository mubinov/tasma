import type { Diagnostic } from "@tasma/protocol";
import { beforeEach, describe, expect, it } from "vitest";
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

function openKeys(): string[] {
  return useNoticeStore.getState().notices.map(({ key }) => key);
}

beforeEach(() => {
  useNoticeStore.setState({ notices: [], dismissed: new Map() });
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
