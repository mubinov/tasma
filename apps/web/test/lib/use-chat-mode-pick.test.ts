import type { ChatEvent } from "@tasma/protocol";
import { describe, expect, it } from "vitest";
import { CHAT_VIEW_START, foldChatEntries, type ChatView } from "../../src/lib/chat-fold";
import {
  KEPT_LOG_START,
  nextChatLogAnnouncement,
  withPickSuccess,
  type ChatLogRender,
} from "../../src/lib/use-chat-mode-pick";
import { chatEntries, modeOption, modeUpdate, optionsUpdate, turnEnd, userMessage } from "../chat-fixtures";

/** The view after the events, which follow the entries of `view` in the log. */
function after(view: ChatView, ...events: readonly ChatEvent[]): ChatView {
  return foldChatEntries(view, chatEntries(events, view.seq + 1));
}

const MANUAL = after(CHAT_VIEW_START, optionsUpdate(modeOption("default")));
const BASE: ChatLogRender = { view: MANUAL, agent: "claude", ready: true, picking: false };

/** A render of these inputs over the base inputs, or the success of a pick with the `seq` of its answer. */
type Step = Partial<ChatLogRender> | { success: number };

/** The words of each render. */
function spoken(...steps: readonly Step[]): string[][] {
  let kept = KEPT_LOG_START;
  const words: string[][] = [];

  for (const step of steps) {
    if ("success" in step) {
      kept = withPickSuccess(kept, step.success);
      continue;
    }
    const next = nextChatLogAnnouncement(kept, { ...BASE, ...step });
    kept = next.kept;
    words.push(next.words);
  }
  return words;
}

describe("nextChatLogAnnouncement", () => {
  it("announces nothing at the first ready render, and then a change of the mode", () => {
    expect(spoken({}, { view: after(MANUAL, modeUpdate("acceptEdits")) })).toEqual([[], ["Mode: Accept edits"]]);
  });

  it("announces nothing while the log is not ready, and counts from the next ready render", () => {
    const accept = after(MANUAL, modeUpdate("acceptEdits"));
    const auto = after(accept, modeUpdate("auto"));

    expect(spoken({}, { view: accept, ready: false }, { view: auto }, { view: after(auto, modeUpdate("default")) }))
      .toEqual([[], [], [], ["Mode: Manual"]]);
  });

  it("announces the mode one time at the end of a period, and not its change inside the period", () => {
    const accept = after(MANUAL, modeUpdate("acceptEdits"));
    const listed = after(accept, optionsUpdate(modeOption("acceptEdits")));

    expect(spoken(
      {},
      { picking: true },
      { view: accept, picking: true },
      { success: listed.seq },
      { view: listed },
    )).toEqual([[], [], [], ["Mode: Accept edits"]]);
  });

  it("announces the mode at the end of a period with a successful pick that did not change it", () => {
    expect(spoken(
      {},
      { picking: true },
      { success: 2 },
      { view: after(MANUAL, optionsUpdate(modeOption("default"))) },
    )).toEqual([[], [], ["Mode: Manual"]]);
  });

  it("announces nothing at the end of a period whose picks all failed, when the mode did not change", () => {
    expect(spoken({}, { picking: true }, {})).toEqual([[], [], []]);
  });

  it("announces a mode that the log changed during a period whose picks all failed", () => {
    const accept = after(MANUAL, modeUpdate("acceptEdits"));

    expect(spoken({}, { picking: true }, { view: accept, picking: true }, { view: accept }))
      .toEqual([[], [], [], ["Mode: Accept edits"]]);
  });

  it("announces nothing at the end of a period with no mode option in the view", () => {
    expect(spoken({}, { picking: true }, { success: 2 }, { view: after(MANUAL, optionsUpdate()) }))
      .toEqual([[], [], []]);
  });

  it("makes one period of overlapping picks", () => {
    const auto = after(MANUAL, optionsUpdate(modeOption("auto")));
    const accept = after(auto, optionsUpdate(modeOption("acceptEdits")));

    expect(spoken(
      {},
      { picking: true },
      { success: auto.seq },
      { view: auto, picking: true },
      { success: accept.seq },
      { view: accept },
    )).toEqual([[], [], [], ["Mode: Accept edits"]]);
  });

  it("starts a period at the first ready render while a pick is in progress, from the mode of that view", () => {
    const accept = after(MANUAL, modeUpdate("acceptEdits"));

    expect(spoken({ picking: true }, { view: accept, picking: true }, { view: accept }))
      .toEqual([[], [], ["Mode: Accept edits"]]);
    expect(spoken({ picking: true }, {})).toEqual([[], []]);
  });

  it("gives a success that comes before its period to that period", () => {
    expect(spoken({}, { success: 2 }, { picking: true }, { view: after(MANUAL, optionsUpdate(modeOption("default"))) }))
      .toEqual([[], [], ["Mode: Manual"]]);
  });

  it("drops a success whose answer the log reached outside a period", () => {
    expect(spoken({}, { success: MANUAL.seq }, {}, { picking: true }, {})).toEqual([[], [], [], []]);
  });

  it("announces the other changes of the log during a period, without the mode", () => {
    const working = after(MANUAL, userMessage("Build."));
    const ended = after(working, turnEnd(), modeUpdate("acceptEdits"));

    expect(spoken({ view: working }, { view: working, picking: true }, { view: ended, picking: true }, { view: ended }))
      .toEqual([[], [], ["Claude finished the turn"], ["Mode: Accept edits"]]);
  });
});
