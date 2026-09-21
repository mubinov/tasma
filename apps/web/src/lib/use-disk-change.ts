import { useEffect, useEffectEvent, useState } from "react";
import { useNoticeStore } from "../store/notices";
import { formatMinutes } from "./task-page";
import { changedOnDisk, type Draft } from "./text-draft";

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
 * The held state is adjusted during render rather than in an effect: an effect
 * would draw the line for one commit with the time of the read that found it,
 * and then again with the time of a later one. The effect only announces, in
 * the commit where the line first shows for the change.
 */
export function useDiskChange({ start, draft, disk, saving, updated }: DiskChangeOptions): DiskChange {
  const differs = draft !== null && changedOnDisk({ start, draft, disk });
  const showing = differs && !saving;
  const [held, setHeld] = useState<{ differs: boolean; at: string | null; shown: boolean }>({
    differs: false,
    at: null,
    shown: false,
  });

  if (held.differs !== differs) {
    setHeld({ differs, at: differs ? (held.at ?? updated) : null, shown: false });
  } else if (showing && !held.shown) {
    setHeld({ ...held, shown: true });
  }

  const at = formatMinutes(held.at ?? updated);
  const announce = useEffectEvent(() => {
    useNoticeStore.getState().announce(`Changed on disk at ${at}. Saving overwrites that change.`);
  });

  useEffect(() => {
    if (held.shown) {
      announce();
    }
  }, [held.shown]);

  return { showing, at };
}
