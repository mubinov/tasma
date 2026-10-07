// The task link page: `GET /task/<TAG>-<number>` answers with an HTML page that
// sends the browser on to `tasma://task/<TAG>-<number>`, for places that open
// only `http` links. It needs no token and is no protocol route: the page holds
// only an id that passed the check.

import type { OutgoingHttpHeaders, ServerResponse } from "node:http";
import { isTag } from "@tasma/engine";
import { DEFAULT_DAEMON_URL } from "@tasma/protocol";

/** The link the macOS application opens a task under. Held to `deeplink.rs` by a repo test. */
export const TASK_LINK_PREFIX = "tasma://task/";

/** The path of a task link, with one trailing `/` that link detectors add. */
const LINK_PATH = /^\/task\/([^/]+)\/?$/;

/**
 * Checked before the tag is uppercased: `toUpperCase` maps some non-ASCII
 * letters to ASCII ones (`ß` to `SS`). A `%` fails here too, so an encoded
 * separator cannot form an id.
 */
const LINK_CHARACTERS = /^[A-Za-z0-9-]+$/;

const NUMBER = /^[0-9]+$/;

const HEADERS: OutgoingHttpHeaders = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  // CSP does not govern a top-level navigation, so the refresh still leaves.
  "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
};

/** The segment of a task link the request names, or `undefined` for a request the router serves. */
export function taskLinkSegment(method: string, target: string): string | undefined {
  if (method !== "GET") return undefined;

  const query = target.indexOf("?");
  const path = query < 0 ? target : target.slice(0, query);
  return LINK_PATH.exec(path)?.[1];
}

/** The id a segment names, with its tag uppercased, or `undefined` for a segment outside the grammar. */
export function taskIdOf(segment: string): string | undefined {
  if (!LINK_CHARACTERS.test(segment)) return undefined;

  const dash = segment.indexOf("-");
  if (dash < 0) return undefined;

  const tag = segment.slice(0, dash).toUpperCase();
  const number = segment.slice(dash + 1);
  if (!isTag(tag) || !NUMBER.test(number)) return undefined;

  return `${tag}-${number}`;
}

/** The page for a segment: one that opens the task, or a 404 that holds no text of the request. */
export function writeTaskLinkPage(response: ServerResponse, segment: string): void {
  const id = taskIdOf(segment);
  const [status, html] = id === undefined ? [404, notALinkPage()] : [200, openPage(id)];
  const body = Buffer.from(html, "utf8");

  response.writeHead(status, { ...HEADERS, "content-length": body.byteLength });
  response.end(body);
}

/**
 * The refresh must stay the only automatic navigation: two navigations to
 * `tasma://` make Arc show two dialogs and close both.
 */
function openPage(id: string): string {
  const link = `${TASK_LINK_PREFIX}${id}`;
  const title = `Open ${id} in Tasma`;

  return page(title, [`<meta http-equiv="refresh" content="0; url=${link}">`], [
    `<p>The browser asks to open Tasma. If Tasma did not open, use this link: <a href="${link}">${title}</a></p>`,
    "<p>You can close this tab.</p>",
  ]);
}

function notALinkPage(): string {
  return page("Not a Tasma task link", [], [`<p>A Tasma task link has the form ${DEFAULT_DAEMON_URL}/task/XY-7.</p>`]);
}

function page(title: string, head: string[], body: string[]): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="color-scheme" content="light dark">',
    ...head,
    `<title>${title}</title>`,
    "</head>",
    "<body>",
    "<main>",
    `<h1>${title}</h1>`,
    ...body,
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
