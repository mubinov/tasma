import { DAEMON_NAME } from "@tasma/protocol";
import { describe, expect, it } from "vitest";
// Relative: this package declares no exports, so its own name does not resolve.
import { daemon } from "../../src/commands/daemon.js";
import { capture, startServer, unusedUrl } from "../helpers.js";
import type { Handler } from "../helpers.js";

/** A wire field that refuses to coerce, as JSON.parse builds it, and how it prints. */
const HOSTILE = { toString: "x" };
const HOSTILE_TEXT = '{"toString":"x"}';

/** A server answering `GET /health` with the envelope it is given. */
function serveHealth(data: unknown): Handler {
  return (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, data, diagnostics: [] }));
  };
}

describe("daemon status", () => {
  it("names the daemon, its version and where it answered, at exit 0", async () => {
    const server = await startServer(serveHealth({ name: DAEMON_NAME, version: "1.2.3" }));
    const { io, out, err } = capture();

    try {
      expect(await daemon.run(["status"], io, server.url)).toBe(0);
    } finally {
      await server.close();
    }

    expect(out.join("")).toBe(`${DAEMON_NAME} 1.2.3 at ${server.url}\n`);
    expect(err).toEqual([]);
  });

  // A foreign server can answer a well-formed envelope, so the one field that
  // identifies a Tasma daemon is compared rather than assumed.
  it("refuses a well-formed answer naming another process", async () => {
    const server = await startServer(serveHealth({ name: "other-daemon", version: "1.0.0" }));
    const { io, out, err } = capture();

    try {
      expect(await daemon.run(["status"], io, server.url)).toBe(3);
    } finally {
      await server.close();
    }

    expect(out).toEqual([]);
    expect(err.join("")).toBe(`tasma: ${server.url} answered as "other-daemon", not a Tasma daemon\n`);
  });

  // The field is whatever answered the port, so a name that is missing and one
  // that refuses to coerce are the same case.
  it("refuses an envelope whose data carries no name it can print, without throwing", async () => {
    for (const [data, quoted] of [[{}, "undefined"], [{ name: HOSTILE }, HOSTILE_TEXT]] as const) {
      const server = await startServer(serveHealth(data));
      const { io, err } = capture();

      try {
        expect(await daemon.run(["status"], io, server.url)).toBe(3);
      } finally {
        await server.close();
      }

      expect(err.join("")).toBe(`tasma: ${server.url} answered as "${quoted}", not a Tasma daemon\n`);
    }
  });

  // `null` and a scalar are shapes the envelope check passes and the type does
  // not describe, so the answer is refused before a field is read off it.
  it("refuses an envelope whose data is not an object, without throwing", async () => {
    for (const [data, quoted] of [[null, "null"], [DAEMON_NAME, DAEMON_NAME], [7, "7"]] as const) {
      const server = await startServer(serveHealth(data));
      const { io, out, err } = capture();

      try {
        expect(await daemon.run(["status"], io, server.url)).toBe(3);
      } finally {
        await server.close();
      }

      expect(out).toEqual([]);
      expect(err.join("")).toBe(`tasma: ${server.url} answered as "${quoted}", not a Tasma daemon\n`);
    }
  });

  // The version is whatever answered the port, so it is escaped like every
  // other string the wire supplies.
  it("escapes a version carrying a control character rather than writing it to the terminal", async () => {
    const server = await startServer(serveHealth({ name: DAEMON_NAME, version: "0.0.0\u001b[2K\rtasma: fine" }));
    const { io, out } = capture();

    try {
      expect(await daemon.run(["status"], io, server.url)).toBe(0);
    } finally {
      await server.close();
    }

    expect(out.join("")).toBe(`${DAEMON_NAME} 0.0.0\\u001b[2K\\u000dtasma: fine at ${server.url}\n`);
  });

  it("prints a version that refuses to coerce rather than dying on it", async () => {
    const server = await startServer(serveHealth({ name: DAEMON_NAME, version: HOSTILE }));
    const { io, out, err } = capture();

    try {
      expect(await daemon.run(["status"], io, server.url)).toBe(0);
    } finally {
      await server.close();
    }

    expect(out.join("")).toBe(`${DAEMON_NAME} ${HOSTILE_TEXT} at ${server.url}\n`);
    expect(err).toEqual([]);
  });

  // The wire is read by a parser that nests iteratively and printed by a
  // renderer that recurses, so an answer can arrive at a depth no rendering of
  // it survives.
  it("prints a version too deeply nested to render rather than dying on it", async () => {
    const deep = `${"[".repeat(30_000)}${"]".repeat(30_000)}`;
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`{"ok":true,"data":{"name":"${DAEMON_NAME}","version":${deep}},"diagnostics":[]}`);
    });
    const { io, out, err } = capture();

    try {
      expect(await daemon.run(["status"], io, server.url)).toBe(0);
    } finally {
      await server.close();
    }

    expect(out.join("")).toBe(`${DAEMON_NAME} [unprintable] at ${server.url}\n`);
    expect(err).toEqual([]);
  });

  it("refuses an argument of its own rather than ignoring it", async () => {
    const { io, out, err } = capture();

    expect(await daemon.run(["status", "--daemon", "http://127.0.0.1:9000"], io, "http://127.0.0.1:8278")).toBe(2);
    expect(out).toEqual([]);
    expect(err.join("")).toBe("tasma: daemon status takes no arguments: --daemon\nRun 'tasma --help' for usage.\n");
  });

  it("reports a port nothing listens on", async () => {
    const url = await unusedUrl();
    const { io, out, err } = capture();

    expect(await daemon.run(["status"], io, url)).toBe(3);
    expect(out).toEqual([]);
    expect(err.join("")).toBe(`tasma: no daemon answered at ${url}\n`);
  });
});

describe("the daemon noun", () => {
  // A bare `tasma daemon` is a request for orientation, one level below a bare
  // `tasma`.
  it("lists its verbs and exits 0 when no verb follows it", async () => {
    const { io, out, err } = capture();

    expect(await daemon.run([], io, "http://127.0.0.1:8278")).toBe(0);
    expect(out.join("")).toContain("status");
    expect(err).toEqual([]);
  });

  // The same request spelled the way the top level accepts it, so the two
  // levels answer the same two spellings.
  it("lists its verbs for --help and -h as well", async () => {
    for (const flag of ["--help", "-h"]) {
      const { io, out, err } = capture();

      expect(await daemon.run([flag], io, "http://127.0.0.1:8278")).toBe(0);
      expect(out.join("")).toContain("status");
      expect(err).toEqual([]);
    }
  });

  it("reports an unknown verb as the whole invocation, not as a top-level command", async () => {
    const { io, out, err } = capture();

    expect(await daemon.run(["frobnicate"], io, "http://127.0.0.1:8278")).toBe(2);
    expect(out).toEqual([]);
    expect(err.join("")).toBe("tasma: unknown command: daemon frobnicate\nRun 'tasma --help' for usage.\n");
  });
});
