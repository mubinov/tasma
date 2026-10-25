import { ProtocolError, TransportError } from "@tasma/protocol";
import { act } from "@testing-library/react";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createFeedNotice, FEED_NOTICE_KEY } from "../../src/api/feed-notice";
import { DAEMON_URL } from "../../src/api/transport";
import { useNoticeStore } from "../../src/store/notices";
import { frame } from "../setup/notice-store";

const TITLE = "Tasma does not get changes";

const LINE = "The pages can show old data. Tasma tries again.";

const RECOVERED = "Tasma gets changes again.";

const UNREADABLE = new TransportError("GET /events?after=c4 answered with no envelope", 502);

const UNREACHED = new TransportError("GET /events?after=c4 reached no daemon");

const REFUSED = new ProtocolError({ kind: "daemon", code: "malformed-request", message: "after=c4? is not a cursor" }, 400);

const UNREADABLE_WORDS = `${DAEMON_URL} · HTTP 502 · GET /events answered with no envelope`;

const UNREADABLE_TEXT = `${TITLE}. ${LINE} ${UNREADABLE_WORDS}.`;

/**
 * A window the reader is in, until the test moves the reader away. A hidden
 * page runs no animation frames: their callbacks wait for the first frame after
 * the page shows again.
 */
function stubWindow() {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const nativeFrame = window.requestAnimationFrame.bind(window);
  let held: FrameRequestCallback[] | null = null;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    if (held === null) {
      return nativeFrame(callback);
    }
    held.push(callback);
    return 0;
  });

  return {
    hide: () => {
      held = [];
      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    },
    show: () => {
      for (const callback of held ?? []) {
        nativeFrame(callback);
      }
      held = null;
      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    },
    blur: () => {
      focus.mockReturnValue(false);
      window.dispatchEvent(new Event("blur"));
    },
    focus: () => {
      focus.mockReturnValue(true);
      window.dispatchEvent(new Event("focus"));
    },
  };
}

function start() {
  const notice = createFeedNotice();
  onTestFinished(() => {
    notice.stop();
  });

  /** One read of the loop that fails with `error`, as the loop reports it. */
  function fail(failures: number, error: unknown = UNREADABLE): void {
    act(() => {
      notice.failed(error);
      notice.status(failures);
    });
  }

  function succeed(): void {
    act(() => {
      notice.status(0);
    });
  }

  return { notice, fail, succeed };
}

function openNotices() {
  return useNoticeStore.getState().notices.filter(({ key }) => key === FEED_NOTICE_KEY);
}

/** What the spoken region holds once a repeat on the return, a frame after the other lines, is raised. */
async function spoken(): Promise<string[]> {
  await frame();
  await frame();
  return useNoticeStore.getState().announced.map(({ words }) => words);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("opens no notice after two failed reads, and opens it after the third with the words of the first error", async () => {
  stubWindow();
  const { fail } = start();

  fail(1, UNREADABLE);
  fail(2, UNREACHED);
  expect(openNotices()).toEqual([]);

  fail(3, REFUSED);

  expect(openNotices()).toMatchObject([
    { key: FEED_NOTICE_KEY, form: "failure", title: TITLE, line: LINE, words: [UNREADABLE_WORDS] },
  ]);
  expect(await spoken()).toEqual([UNREADABLE_TEXT]);
});

it("removes the query from the path of a transport failure, and leaves the words of another failure as they are", () => {
  stubWindow();
  const { fail, succeed } = start();

  fail(1, new TransportError("GET /events?after=c4&run=r9 answered with no envelope", 502));
  fail(2);
  fail(3);
  expect(openNotices()[0]?.words).toEqual([UNREADABLE_WORDS]);

  succeed();
  fail(1, REFUSED);
  fail(2);
  fail(3);
  expect(openNotices()[0]?.words).toEqual(["daemon/malformed-request · after=c4? is not a cursor"]);
});

it("keeps the same notice and says it once on the fourth and fifth failed reads, also when their errors differ", async () => {
  stubWindow();
  const { fail } = start();
  fail(1);
  fail(2);
  fail(3);
  const [notice] = openNotices();

  fail(4, UNREACHED);
  fail(5, REFUSED);

  expect(openNotices()).toHaveLength(1);
  expect(openNotices()[0]).toBe(notice);
  expect(await spoken()).toEqual([UNREADABLE_TEXT]);
});

it("closes on a successful read and says the recovery line once", async () => {
  stubWindow();
  const { fail, succeed } = start();
  fail(1);
  fail(2);
  fail(3);
  await frame();

  succeed();
  succeed();

  expect(openNotices()).toEqual([]);
  expect(await spoken()).toEqual([UNREADABLE_TEXT, RECOVERED]);
});

it("says nothing on a successful read after one or two failed reads", async () => {
  stubWindow();
  const { fail, succeed } = start();

  fail(1);
  succeed();
  fail(1);
  fail(2);
  succeed();

  expect(openNotices()).toEqual([]);
  expect(await spoken()).toEqual([]);
});

it("stays closed after Dismiss while the reads fail, and ends the dismissal with the recovery line on a success", async () => {
  stubWindow();
  const { fail, succeed } = start();
  fail(1);
  fail(2);
  fail(3);
  act(() => {
    useNoticeStore.getState().dismissNotice(FEED_NOTICE_KEY);
  });

  fail(4);
  fail(5);
  expect(openNotices()).toEqual([]);
  expect(await spoken()).toEqual([UNREADABLE_TEXT]);

  succeed();
  expect(useNoticeStore.getState().dismissed.has(FEED_NOTICE_KEY)).toBe(false);
  expect(await spoken()).toEqual([UNREADABLE_TEXT, RECOVERED]);

  fail(1);
  fail(2);
  fail(3);
  expect(openNotices()).toHaveLength(1);
});

it("opens a new row of failed reads with the words of its own first error", () => {
  stubWindow();
  const { fail, succeed } = start();
  fail(1);
  fail(2);
  fail(3);
  succeed();

  fail(1, UNREACHED);
  fail(2);
  fail(3);

  expect(openNotices()[0]?.words).toEqual([DAEMON_URL]);
});

it("opens with no words when no read rejected, as when a handler of the loop throws", () => {
  stubWindow();
  const { notice } = start();

  act(() => {
    notice.status(1);
    notice.status(2);
    notice.status(3);
  });

  expect(openNotices()).toMatchObject([{ title: TITLE, words: [] }]);
});

it("keeps the notice it opened with no words when a later read of the row rejects", async () => {
  stubWindow();
  const { notice, fail } = start();
  act(() => {
    notice.status(1);
    notice.status(2);
    notice.status(3);
  });
  const [opened] = openNotices();

  fail(4);

  expect(openNotices()[0]).toBe(opened);
  expect(await spoken()).toEqual([`${TITLE}. ${LINE}`]);
});

it("does not ask for focus when it opens", () => {
  stubWindow();
  const { fail } = start();

  fail(1);
  fail(2);
  fail(3);

  expect(useNoticeStore.getState().noticeFocusRequested).toBe(false);
});

it("says the notice that waited while the page was hidden on the return, then once more, and not on a later return", async () => {
  const view = stubWindow();
  const { fail } = start();
  view.hide();

  fail(1);
  fail(2);
  fail(3);

  view.show();
  expect(await spoken()).toEqual([UNREADABLE_TEXT, UNREADABLE_TEXT]);

  view.hide();
  view.show();
  expect(await spoken()).toEqual([UNREADABLE_TEXT, UNREADABLE_TEXT]);
});

it("says the notice once more when the window gets focus, after it opened while the window had none", async () => {
  const view = stubWindow();
  const { fail } = start();
  view.blur();

  fail(1);
  fail(2);
  fail(3);
  expect(await spoken()).toEqual([UNREADABLE_TEXT]);

  view.focus();
  expect(await spoken()).toEqual([UNREADABLE_TEXT, UNREADABLE_TEXT]);
});

it("says nothing on the return when the reader dismissed the notice before it", async () => {
  const view = stubWindow();
  const { fail } = start();
  view.blur();
  fail(1);
  fail(2);
  fail(3);
  await frame();

  act(() => {
    useNoticeStore.getState().dismissNotice(FEED_NOTICE_KEY);
  });
  view.focus();

  expect(await spoken()).toEqual([UNREADABLE_TEXT]);
});

it("says the recovery line last on the return when the notice opened and closed while the page was hidden", async () => {
  const view = stubWindow();
  const { fail, succeed } = start();
  view.hide();
  fail(1);
  fail(2);
  fail(3);
  succeed();

  view.show();
  expect(await spoken()).toEqual([UNREADABLE_TEXT, RECOVERED, RECOVERED]);
});

it("says the recovery line once more on the return when the notice opened and closed while the window had no focus", async () => {
  const view = stubWindow();
  const { fail, succeed } = start();
  view.blur();
  fail(1);
  fail(2);
  fail(3);
  succeed();
  expect(await spoken()).toEqual([UNREADABLE_TEXT, RECOVERED]);

  view.focus();
  expect(await spoken()).toEqual([UNREADABLE_TEXT, RECOVERED, RECOVERED]);
});

it("says the recovery line twice when the feed works again while the page is hidden after the notice was heard", async () => {
  const view = stubWindow();
  const { fail, succeed } = start();
  fail(1);
  fail(2);
  fail(3);
  await frame();
  view.hide();

  succeed();
  view.show();

  expect(await spoken()).toEqual([UNREADABLE_TEXT, RECOVERED, RECOVERED]);
});

it("says the recovery line last on the return when the feed worked, failed and worked again while the page was hidden after the notice was heard", async () => {
  const view = stubWindow();
  const { fail, succeed } = start();
  fail(1);
  fail(2);
  fail(3);
  await frame();
  view.hide();

  succeed();
  fail(1);
  fail(2);
  fail(3);
  succeed();
  view.show();

  expect(await spoken()).toEqual([UNREADABLE_TEXT, RECOVERED, UNREADABLE_TEXT, RECOVERED]);
});

it("says the open notice last on the return when it opened, closed and opened again with the same words while the page was hidden", async () => {
  const view = stubWindow();
  const { fail, succeed } = start();
  view.hide();
  fail(1);
  fail(2);
  fail(3);
  succeed();
  fail(1);
  fail(2);
  fail(3);

  view.show();
  expect(await spoken()).toEqual([UNREADABLE_TEXT, RECOVERED, UNREADABLE_TEXT]);
});

it("says the recovery line once more on the return when the feed works again while the window has no focus", async () => {
  const view = stubWindow();
  const { fail, succeed } = start();
  fail(1);
  fail(2);
  fail(3);
  await frame();
  view.blur();

  succeed();
  expect(await spoken()).toEqual([UNREADABLE_TEXT, RECOVERED]);

  view.focus();
  expect(await spoken()).toEqual([UNREADABLE_TEXT, RECOVERED, RECOVERED]);

  view.blur();
  view.focus();
  expect(await spoken()).toEqual([UNREADABLE_TEXT, RECOVERED, RECOVERED]);
});

it("does not say the recovery line on the return when the notice opened again before it", async () => {
  const view = stubWindow();
  const { fail, succeed } = start();
  fail(1);
  fail(2);
  fail(3);
  await frame();
  view.blur();
  succeed();
  await frame();

  fail(1);
  fail(2);
  fail(3);
  await frame();
  view.focus();

  expect(await spoken()).toEqual([UNREADABLE_TEXT, RECOVERED, UNREADABLE_TEXT, UNREADABLE_TEXT]);
});

it("says no notice on the return when it closes before the frame of the repeat", async () => {
  const view = stubWindow();
  const { fail, succeed } = start();
  view.blur();
  fail(1);
  fail(2);
  fail(3);
  await frame();

  view.focus();
  succeed();

  expect(await spoken()).toEqual([UNREADABLE_TEXT, RECOVERED]);
});

it("says no recovery line on the return when the notice opens again before the frame of the repeat", async () => {
  const view = stubWindow();
  const { fail, succeed } = start();
  fail(1);
  fail(2);
  fail(3);
  await frame();
  view.blur();
  succeed();
  await frame();

  view.focus();
  fail(1, UNREACHED);
  fail(2);
  fail(3);

  expect(await spoken()).toEqual([UNREADABLE_TEXT, RECOVERED, `${TITLE}. ${LINE} ${DAEMON_URL}.`]);
});

it("says no recovery line on the return when the notice opens again and is dismissed before the frame of the repeat", async () => {
  const view = stubWindow();
  const { fail, succeed } = start();
  fail(1);
  fail(2);
  fail(3);
  await frame();
  view.blur();
  succeed();
  await frame();

  view.focus();
  fail(1, UNREACHED);
  fail(2);
  fail(3);
  act(() => {
    useNoticeStore.getState().dismissNotice(FEED_NOTICE_KEY);
  });

  expect(await spoken()).toEqual([UNREADABLE_TEXT, RECOVERED, `${TITLE}. ${LINE} ${DAEMON_URL}.`]);
});

it("closes the notice on stop and says nothing, then or on a later return", async () => {
  const view = stubWindow();
  const { notice, fail } = start();
  view.hide();
  fail(1);
  fail(2);
  fail(3);

  act(() => {
    notice.stop();
  });
  view.show();

  expect(openNotices()).toEqual([]);
  expect(await spoken()).toEqual([UNREADABLE_TEXT]);
});

it("does not say a repeat on the return that waits for its frame when it stops", async () => {
  const view = stubWindow();
  const { notice, fail } = start();
  view.blur();
  fail(1);
  fail(2);
  fail(3);
  await frame();

  view.focus();
  act(() => {
    notice.stop();
  });

  expect(await spoken()).toEqual([UNREADABLE_TEXT]);
});
