// The change feed of one daemon run: what changed, never the new content, so a
// client reads the data again after an event.

/**
 * One change the daemon found or made. A `task` event comes from a project the
 * daemon holds an index for, and covers a direct edit of the file on disk. A
 * `project` event with `changed` also comes when the index of a held project
 * stops following the disk, and when a repair makes it follow the disk again.
 * The other events come from the daemon's own writes alone: a hand edit of a
 * project's registry entry, of a configuration file or of a workflow file sends
 * no event.
 */
export type FeedEvent
  = | { kind: "task"; tag: string; id: string; change: "created" | "changed" | "deleted" }
    | { kind: "project"; tag: string; change: "created" | "changed" | "deleted" }
    | { kind: "project"; tag: string; change: "renamed"; to: string }
    | { kind: "config" }
    | { kind: "workflow"; name: string; change: "created" | "changed" | "deleted" };

/**
 * The answer to a read of the feed.
 *
 * `cursor` names the last event the answer covers, and the next read passes it
 * back as `after`. It is opaque: a client compares it with nothing and builds
 * none. `reset` answers a cursor the feed cannot continue from — one of another
 * daemon run, one older than the events the feed keeps, or text that is no
 * cursor — and the client then reads all of its data again.
 */
export type EventsReply
  = | { cursor: string; events: FeedEvent[] }
    | { reset: true; cursor: string };
