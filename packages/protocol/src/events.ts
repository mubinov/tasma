// The change feed of one daemon run: what changed, never the new content, so a
// client reads the data again after an event.

import type { ChatStatus } from "./chat.js";

/**
 * One change the daemon found or made, also by a hand edit of the tree. An
 * event can repeat, and one write can bring more events than its own. A hand
 * rename of a project folder comes as `deleted` and `created`. A `task` event
 * comes only from a project the daemon holds. `project` with `changed` also
 * comes when `live` changes. A `chat` event never carries the text, and a
 * rename or a delete of its project or task sends none.
 */
export type FeedEvent
  = | { kind: "task"; tag: string; id: string; change: "created" | "changed" | "deleted" }
    | { kind: "project"; tag: string; change: "created" | "changed" | "deleted" }
    | { kind: "project"; tag: string; change: "renamed"; to: string }
    | ({ kind: "chat"; tag: string; task: string; chat: number; step: string } & ChatStatus)
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
