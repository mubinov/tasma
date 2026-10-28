import type { TransportReply } from "@tasma/protocol";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_CLIENT } from "../../src/api/mutations";
import { endInView, useChatSeen, type SeenWatch } from "../../src/lib/use-chat-seen";
import { refusalReply, routerWrapper, stubTransport, successReply } from "../helpers";
import { chatRecord } from "../chat-daemon";

const SEEN_PATH = "/projects/SAGA/tasks/SAGA-3/chats/2/seen";

type Box = { clientHeight: number; scrollHeight: number; scrollTop: number; bottom: number };

/** A box at the end of a chat, in a window of the jsdom height of 768. */
const AT_END: Box = { clientHeight: 600, scrollHeight: 2000, scrollTop: 1400, bottom: 700 };

/** A viewport whose measurements are read from `box` at each check, since jsdom has no layout. */
function viewportOf(box: Box): HTMLElement {
  const element = document.createElement("div");
  Object.defineProperties(element, {
    clientHeight: { get: () => box.clientHeight },
    scrollHeight: { get: () => box.scrollHeight },
    scrollTop: { get: () => box.scrollTop },
  });
  element.getBoundingClientRect = () => ({ bottom: box.bottom }) as DOMRect;
  return element;
}

describe("endInView", () => {
  it.each([
    ["at the end", 1400, true],
    ["half a screen above the end", 1100, true],
    ["more than half a screen above the end", 1099, false],
  ])("counts a view %s", (_case, scrollTop, inView) => {
    expect(endInView({ clientHeight: 600, scrollHeight: 2000, scrollTop })).toBe(inView);
  });

  it("counts a chat shorter than the view as in view", () => {
    expect(endInView({ clientHeight: 600, scrollHeight: 400, scrollTop: 0 })).toBe(true);
  });
});

describe("useChatSeen", () => {
  let focused: boolean;
  let visibility: DocumentVisibilityState;

  beforeEach(() => {
    vi.useFakeTimers();
    focused = true;
    visibility = "visible";
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** The hook for chat 2 of SAGA-3 under a router over the stub daemon, at `seq` 5 with an end in view. */
  function watch(input: Partial<SeenWatch> = {}, reply: TransportReply = successReply(chatRecord({ seen: 5 }))) {
    const stub = stubTransport({ [`POST ${SEEN_PATH}`]: reply });
    const box = { ...AT_END };
    const initialProps: SeenWatch = {
      tag: "SAGA",
      task: "SAGA-3",
      chat: 2,
      viewport: viewportOf(box),
      seq: 5,
      seen: undefined,
      busy: false,
      ...input,
    };
    const hook = renderHook((props: SeenWatch) => {
      useChatSeen(props);
    }, { initialProps, wrapper: routerWrapper(stub.transport) });

    return {
      box,
      rerender: (next: Partial<SeenWatch>) => {
        hook.rerender({ ...initialProps, ...next });
      },
      sent: () => stub.requests.filter(({ path }) => path === SEEN_PATH).map(({ body }) => body),
    };
  }

  it("writes the seq one time after the end is in view for 1 second", async () => {
    const { sent } = watch();

    await vi.advanceTimersByTimeAsync(900);
    expect(sent()).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(sent()).toEqual([{ seq: 5, client: CHAT_CLIENT }]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent()).toHaveLength(1);
  });

  it("starts the hold again at a new seq", async () => {
    const { rerender, sent } = watch();

    await vi.advanceTimersByTimeAsync(600);
    rerender({ seq: 6 });
    await vi.advanceTimersByTimeAsync(900);
    expect(sent()).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(sent()).toEqual([{ seq: 6, client: CHAT_CLIENT }]);
  });

  it("starts the hold again after a check that fails", async () => {
    const { sent } = watch();

    await vi.advanceTimersByTimeAsync(500);
    focused = false;
    await vi.advanceTimersByTimeAsync(250);
    focused = true;
    // The hold starts again at the check at 1000 ms.
    await vi.advanceTimersByTimeAsync(1_150);
    expect(sent()).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(sent()).toHaveLength(1);
  });

  it.each<[string, (box: Box) => void]>([
    ["without focus", () => {
      focused = false;
    }],
    ["while the document is hidden", () => {
      visibility = "hidden";
    }],
    ["with a viewport of no height", (box) => {
      box.clientHeight = 0;
    }],
    ["with the bottom of the viewport below the window", (box) => {
      box.bottom = 770;
    }],
    ["with the bottom of the viewport above the window", (box) => {
      box.bottom = 0;
    }],
    ["with the end more than half a screen below the view", (box) => {
      box.scrollTop = 1000;
    }],
  ])("writes nothing %s", async (_case, change) => {
    const { box, sent } = watch();
    change(box);

    await vi.advanceTimersByTimeAsync(3_000);

    expect(sent()).toEqual([]);
  });

  it("writes nothing with no viewport", async () => {
    const { sent } = watch({ viewport: null });

    await vi.advanceTimersByTimeAsync(3_000);

    expect(sent()).toEqual([]);
  });

  it("runs no timer while the chat is busy, and holds from the end of the busy time", async () => {
    const { rerender, sent } = watch({ busy: true });

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3_000);
    rerender({ busy: false });
    await vi.advanceTimersByTimeAsync(900);
    expect(sent()).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(sent()).toHaveLength(1);
  });

  it("runs no timer when the chat is seen to its seq", () => {
    watch({ seen: 5 });

    expect(vi.getTimerCount()).toBe(0);
  });

  it("writes a seq one time only, also after a failed write", async () => {
    const refused = refusalReply(404, { kind: "store", code: "chat-not-found", message: "there is no chat 2" });
    const { rerender, sent } = watch({}, refused);

    await vi.advanceTimersByTimeAsync(1_000);
    rerender({ seen: 3 });
    await vi.advanceTimersByTimeAsync(3_000);

    expect(sent()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
