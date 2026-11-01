import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../src/lib/chat-fold";
import { chatOpenMessageId, useChatScroll } from "../../src/lib/use-chat-scroll";
import { atSeq } from "../chat-fixtures";
import { stubFocusVisible } from "../helpers";

function userAt(seq: number): ChatMessage {
  return { role: "user", id: `u${seq}`, seq, at: atSeq(seq), text: "Rename the parser." };
}

function agentAt(seq: number): ChatMessage {
  return { role: "assistant", id: `a${seq}`, seq, at: atSeq(seq), parts: [], open: false, running: false };
}

describe("chatOpenMessageId", () => {
  const MESSAGES = [userAt(1), agentAt(2), userAt(5), agentAt(6)];

  it("opens a busy chat at its end, also with messages after seen", () => {
    expect(chatOpenMessageId(MESSAGES, 2, true)).toBeUndefined();
  });

  it("opens a chat with no seen at its end", () => {
    expect(chatOpenMessageId(MESSAGES, undefined, false)).toBeUndefined();
  });

  it("opens a chat with no messages at its end", () => {
    expect(chatOpenMessageId([], 2, false)).toBeUndefined();
  });

  it("opens a chat seen to its last message at its end", () => {
    expect(chatOpenMessageId(MESSAGES, 6, false)).toBeUndefined();
  });

  it("opens a chat seen past the seq of its last message at its end", () => {
    expect(chatOpenMessageId(MESSAGES, 9, false)).toBeUndefined();
  });

  it("opens at the first agent message after seen", () => {
    expect(chatOpenMessageId(MESSAGES, 5, false)).toBe("a6");
  });

  it("opens at the first user message after seen", () => {
    expect(chatOpenMessageId(MESSAGES, 2, false)).toBe("u5");
  });

  it("opens at the first message when seen is below all of them", () => {
    expect(chatOpenMessageId(MESSAGES, 0, false)).toBe("u1");
  });
});

describe("useChatScroll", () => {
  type Box = { clientHeight: number; scrollHeight: number; scrollTop: number };

  type Input = Parameters<typeof useChatScroll>[0];

  const OPEN_TOP = 700;

  let focused: boolean;
  let box: Box;
  let viewport: HTMLElement;
  let scrollTo: ReturnType<typeof vi.fn<(options: ScrollToOptions) => void>>;
  const scrollToBottom = vi.fn<(config: { behavior: ScrollBehavior }) => void>();
  const onFollow = vi.fn<(follow: boolean) => void>();

  /** A message of the viewport, with a button, at `top` in the content of the viewport. */
  function addMessage(id: string, top = OPEN_TOP): { message: HTMLElement; control: HTMLButtonElement } {
    const message = document.createElement("div");
    const control = document.createElement("button");
    message.dataset.messageId = id;
    message.append(control);
    Object.defineProperties(message, {
      offsetTop: { value: top },
      offsetParent: { configurable: true, value: viewport },
    });
    viewport.append(message);
    return { message, control };
  }

  /** A control of the composer: inside the viewport, outside each message. */
  function addComposerControl(): HTMLButtonElement {
    const control = document.createElement("button");
    viewport.append(control);
    return control;
  }

  function mount(input: Partial<Input> = {}) {
    const initialProps: Input = {
      viewport,
      openId: undefined,
      lastId: "a2",
      messages: [{ id: "u1" }, { id: "a2" }],
      scrollToBottom,
      onFollow,
      ...input,
    };
    const hook = renderHook((props: Input) => useChatScroll(props), { initialProps });

    return {
      ...hook,
      rerender: (next: Partial<Input>) => {
        hook.rerender({ ...initialProps, ...next });
      },
    };
  }

  function fire(type: "scroll" | "focusin" | "focusout"): void {
    act(() => {
      viewport.dispatchEvent(new Event(type));
    });
  }

  function focus(control: HTMLElement): void {
    act(() => {
      control.focus();
    });
  }

  function runTimers(): void {
    act(() => {
      vi.runOnlyPendingTimers();
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    focused = true;
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
    box = { clientHeight: 600, scrollHeight: 2000, scrollTop: 0 };
    viewport = document.createElement("div");
    scrollTo = vi.fn<(options: ScrollToOptions) => void>((options) => {
      box.scrollTop = options.top ?? box.scrollTop;
    });
    Object.defineProperties(viewport, {
      clientHeight: { get: () => box.clientHeight },
      scrollHeight: { get: () => box.scrollHeight },
      scrollTop: { get: () => box.scrollTop },
      scrollTo: { value: scrollTo },
    });
    document.body.append(viewport);
    scrollToBottom.mockClear();
    onFollow.mockClear();
  });

  afterEach(() => {
    cleanup();
    viewport.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("open scroll to the end", () => {
    it("waits for the last message, also when the thread holds earlier messages", () => {
      const { rerender } = mount({ messages: [] });

      rerender({ messages: [{ id: "u1" }] });

      expect(scrollTo).not.toHaveBeenCalled();
    });

    it("scrolls one time to the height of the content when the thread holds the last message", () => {
      const { rerender } = mount({ messages: [{ id: "u1" }] });

      rerender({ messages: [{ id: "u1" }, { id: "a2" }] });
      rerender({ messages: [{ id: "u1" }, { id: "a2" }, { id: "u3" }] });

      expect(scrollTo.mock.calls).toEqual([[{ top: 2000, behavior: "instant" }]]);
    });

    it("waits for the viewport", () => {
      const { rerender } = mount({ viewport: null });

      expect(scrollTo).not.toHaveBeenCalled();

      rerender({ viewport });

      expect(scrollTo).toHaveBeenCalledTimes(1);
    });

    it("does not scroll a chat that had no messages when it was ready", () => {
      const { rerender } = mount({ lastId: undefined, messages: [] });

      rerender({ messages: [{ id: "u1" }] });

      expect(scrollTo).not.toHaveBeenCalled();
    });
  });

  describe("open scroll to a message", () => {
    it("waits for the last message, also when the thread holds the open message", () => {
      addMessage("a2");
      const { rerender } = mount({ openId: "a2", lastId: "a4", messages: [{ id: "a2" }] });

      rerender({ messages: [{ id: "a2" }, { id: "u3" }] });

      expect(scrollTo).not.toHaveBeenCalled();
    });

    it("scrolls one time to the top of the message when the thread holds the last message", () => {
      addMessage("a2");
      const { rerender } = mount({ openId: "a2", lastId: "a4", messages: [{ id: "a2" }] });

      rerender({ messages: [{ id: "a2" }, { id: "a4" }] });
      rerender({ messages: [{ id: "a2" }, { id: "a4" }, { id: "u5" }] });

      expect(scrollTo.mock.calls).toEqual([[{ top: OPEN_TOP, behavior: "instant" }]]);
    });

    it("measures from the view when the viewport is not the offset parent of the message", () => {
      const { message } = addMessage("a2");
      Object.defineProperty(message, "offsetParent", { value: document.body });
      message.getBoundingClientRect = () => ({ top: 450 }) as DOMRect;
      viewport.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
      box.scrollTop = 50;

      mount({ openId: "a2" });

      expect(scrollTo.mock.calls).toEqual([[{ top: 400, behavior: "instant" }]]);
    });

    it("scrolls to the end through the kit when the message has no element", () => {
      mount({ openId: "a2" });

      expect(scrollTo).not.toHaveBeenCalled();
      expect(scrollToBottom.mock.calls).toEqual([[{ behavior: "instant" }]]);
    });
  });

  describe("the follow", () => {
    it("reports the follow of a chat that opens at its end on mount, one time", () => {
      const { rerender } = mount();

      rerender({ messages: [{ id: "u1" }, { id: "a2" }, { id: "u3" }] });

      expect(onFollow.mock.calls).toEqual([[true]]);
    });

    it("reports the follow of a chat that opens at its end also before the open scroll", () => {
      mount({ messages: [] });

      expect(scrollTo).not.toHaveBeenCalled();
      expect(onFollow.mock.calls).toEqual([[true]]);
    });

    it("reports no follow of a chat that opens at a message until the open scroll", () => {
      addMessage("a2");
      const { rerender } = mount({ openId: "a2", lastId: "a4", messages: [{ id: "a2" }] });

      fire("scroll");
      expect(onFollow.mock.calls).toEqual([[false]]);

      rerender({ messages: [{ id: "a2" }, { id: "a4" }] });
      expect(onFollow.mock.calls).toEqual([[false], [true]]);
    });

    it("reports the follow after the fallback to the end", () => {
      mount({ openId: "a2" });

      expect(onFollow).toHaveBeenLastCalledWith(true);
    });
  });

  describe("the focus pause", () => {
    /** A mount that clears the record of the first report of the follow. */
    function mountFollowing(input: Partial<Input> = {}) {
      const hook = mount(input);
      onFollow.mockClear();
      return hook;
    }

    /** `stubFocusVisible` wraps the `matches` that it finds, so a second stub starts from the real one. */
    function changeFocusVisible(visible: boolean): void {
      vi.restoreAllMocks();
      vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
      stubFocusVisible(visible);
    }

    it("stops the follow on keyboard focus in a message", () => {
      const { control } = addMessage("a2");
      stubFocusVisible(true);
      mountFollowing();

      focus(control);

      expect(onFollow.mock.calls).toEqual([[false]]);
    });

    it("ends the pause when the document has no active element", () => {
      const { control } = addMessage("a2");
      stubFocusVisible(true);
      mountFollowing();
      focus(control);
      onFollow.mockClear();

      vi.spyOn(document, "activeElement", "get").mockReturnValue(null);
      fire("scroll");

      expect(onFollow.mock.calls).toEqual([[true]]);
    });

    it("keeps the follow on focus in a message that is not keyboard focus", () => {
      const { control } = addMessage("a2");
      stubFocusVisible(false);
      mountFollowing();

      focus(control);

      expect(onFollow).not.toHaveBeenCalled();
    });

    it("keeps the follow on keyboard focus in the composer", () => {
      const control = addComposerControl();
      stubFocusVisible(true);
      mountFollowing();

      focus(control);

      expect(onFollow).not.toHaveBeenCalled();
    });

    it("keeps the follow on keyboard focus in a message of another viewport", () => {
      const other = document.createElement("div");
      other.dataset.messageId = "a9";
      const control = document.createElement("button");
      other.append(control);
      document.body.append(other);
      stubFocusVisible(true);
      mountFollowing();

      focus(control);
      fire("scroll");

      expect(onFollow).not.toHaveBeenCalled();
      other.remove();
    });

    it("starts the follow again when focus moves to the composer", () => {
      const { control } = addMessage("a2");
      const composer = addComposerControl();
      stubFocusVisible(true);
      mountFollowing();

      focus(control);
      focus(composer);

      expect(onFollow.mock.calls).toEqual([[false], [true]]);
    });

    it("waits for the next task after a focusout, when the new focus is known", () => {
      const { control } = addMessage("a2");
      stubFocusVisible(true);
      mountFollowing();
      focus(control);
      onFollow.mockClear();

      act(() => {
        control.blur();
      });
      expect(onFollow).not.toHaveBeenCalled();

      runTimers();
      expect(onFollow.mock.calls).toEqual([[true]]);
    });

    it("sets one timer for focusout events in a row", () => {
      mountFollowing();

      fire("focusout");
      fire("focusout");

      expect(vi.getTimerCount()).toBe(1);
    });

    it("keeps the pause while the window has no focus", () => {
      const { control } = addMessage("a2");
      stubFocusVisible(true);
      const { rerender } = mountFollowing();
      focus(control);
      onFollow.mockClear();

      focused = false;
      changeFocusVisible(false);
      fire("focusout");
      runTimers();
      fire("scroll");
      rerender({ messages: [{ id: "u1" }, { id: "a2" }, { id: "u3" }] });

      expect(document.activeElement).toBe(control);
      expect(onFollow).not.toHaveBeenCalled();
    });

    it("computes the pause again when the window gets focus back", () => {
      const { control } = addMessage("a2");
      stubFocusVisible(true);
      mountFollowing();
      focus(control);
      focused = false;
      fire("focusout");
      runTimers();
      onFollow.mockClear();

      focused = true;
      changeFocusVisible(false);
      fire("focusin");

      expect(onFollow.mock.calls).toEqual([[true]]);
    });

    it("ends the pause on a change of messages when the focused element went away with no focusout", () => {
      const { message, control } = addMessage("a2");
      stubFocusVisible(true);
      const { rerender } = mountFollowing();
      focus(control);
      onFollow.mockClear();

      message.remove();
      expect(document.activeElement).toBe(document.body);
      rerender({ messages: [{ id: "u1" }, { id: "u3" }] });

      expect(onFollow.mock.calls).toEqual([[true]]);
    });

    it("ends the pause on a scroll event when the focused element went away", () => {
      const { message, control } = addMessage("a2");
      stubFocusVisible(true);
      mountFollowing();
      focus(control);
      onFollow.mockClear();

      message.remove();
      fire("scroll");

      expect(onFollow.mock.calls).toEqual([[true]]);
    });

    it("holds the follow of a chat that opened at a message while focus is in it", () => {
      const { control } = addMessage("a2");
      stubFocusVisible(true);
      mountFollowing({ openId: "a2" });

      focus(control);
      expect(onFollow.mock.calls).toEqual([[false]]);

      act(() => {
        control.blur();
      });
      runTimers();
      expect(onFollow.mock.calls).toEqual([[false], [true]]);
    });
  });

  describe("unmount", () => {
    it("removes its listeners and its timer", () => {
      const { control } = addMessage("a2");
      stubFocusVisible(true);
      const { unmount } = mount();
      focus(control);
      onFollow.mockClear();
      const timers = vi.getTimerCount();
      fire("focusout");
      expect(vi.getTimerCount()).toBe(timers + 1);

      unmount();

      expect(vi.getTimerCount()).toBe(timers);
      fire("scroll");
      fire("focusout");
      expect(vi.getTimerCount()).toBe(timers);
      expect(onFollow).not.toHaveBeenCalled();
    });
  });
});
