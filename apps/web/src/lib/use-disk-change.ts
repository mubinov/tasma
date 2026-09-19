import { useEffect, useEffectEvent, useLayoutEffect, useState } from "react";
import { useNoticeStore } from "../store/notices";
import { formatMinutes } from "./task-page";
import { changedOnDisk, type Draft } from "./text-draft";

/** The line is one per page, so its spoken message needs no id of the task in it. */
const SPOKEN_KEY = "disk-change";

export type DiskChangeOptions = {
  /** The text the editor opened with. */
  start: Draft;
  /** The text it holds now, `null` while the page is in reading. */
  draft: Draft | null;
  /** The text of the last read that landed. */
  disk: Draft;
  saving: boolean;
  /** The `updated` of that read. */
  updated: string;
};

export type DiskChange = {
  showing: boolean;
  /** `HH:MM` of the read that first differed. */
  at: string;
};

/**
 * The state of the "Changed on disk" line. Each read the page polls is compared
 * with the text the editor opened with.
 *
 * The change and the line are two things: a write hides the line without
 * settling the change, so the time and the announcement are held against the
 * change, not against the line. A later read therefore does not move the time,
 * and a refused write brings back the same line, neither re-timed nor said a
 * second time.
 *
 * The time is adjusted during render rather than in an effect: an effect would
 * draw the line for one commit with the time of the read that found it, and
 * then again with the time of a later one.
 */
export function useDiskChange({ start, draft, disk, saving, updated }: DiskChangeOptions): DiskChange {
  const differs = draft !== null && changedOnDisk({ start, draft, disk });
  const showing = differs && !saving;
  const [held, setHeld] = useState<{ differs: boolean; at: string | null; announced: boolean }>({
    differs: false,
    at: null,
    announced: false,
  });

  if (held.differs !== differs) {
    setHeld({ differs, at: differs ? (held.at ?? updated) : null, announced: false });
  }

  const at = formatMinutes(held.at ?? updated);
  const announce = useEffectEvent(() => {
    useNoticeStore.getState().say(`Changed on disk at ${at}. Saving overwrites that change.`, SPOKEN_KEY);
    setHeld((current) => ({ ...current, announced: true }));
  });

  // One frame after the commit that draws the line: a live message and a focus
  // announcement in the same commit compete, and the live one loses.
  useEffect(() => {
    if (!showing || held.announced) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      announce();
    });

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [showing, held.announced]);

  // Words a dialog still holds describe a line that is no longer on the page.
  // The layout phase is what makes the withdrawal reach them: a dialog releases
  // what it holds from the cleanup of a passive effect, and React runs every
  // passive cleanup of a commit before any passive effect of it, so a
  // withdrawal raised there would always arrive after the words were spoken.
  useLayoutEffect(() => {
    if (!showing) {
      useNoticeStore.getState().unsay(SPOKEN_KEY);
    }
  }, [showing]);

  return { showing, at };
}
