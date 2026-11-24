import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { daemonUrl, probeDaemon } from "../../src/lifecycle/probe.js";
import {
  fakeDaemonPort, foreignPort, freePort, listening, OTHER_UID, stalledPort, startTestServer,
} from "../helpers.js";

describe("the address a daemon is reached at", () => {
  it("is the loopback host every bind uses", () => {
    expect(daemonUrl(8278)).toBe("http://127.0.0.1:8278");
  });
});

describe("the probe of a port", () => {
  it("answers mine for a Tasma daemon of this OS user", async () => {
    const server = await startTestServer([]);

    expect(await probeDaemon(Number(new URL(server.url).port))).toBe("mine");
  });

  it("answers mine for a Tasma daemon that gives no user id, as one of an earlier version", async () => {
    expect(await probeDaemon(await fakeDaemonPort({ uid: undefined }))).toBe("mine");
  });

  it("answers foreign for a Tasma daemon of another OS user", async () => {
    expect(await probeDaemon(await fakeDaemonPort({ uid: OTHER_UID }))).toBe("foreign");
  });

  it("answers late for a process that accepts the call and does not reply within 1 second", async () => {
    expect(await probeDaemon(await stalledPort())).toBe("late");
  });

  it("answers late for a process that sends the head of its reply and stalls", async () => {
    const port = await listening(createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"ok":true,');
    }));

    expect(await probeDaemon(port)).toBe("late");
  });

  it("answers none for a process answering under another name", async () => {
    expect(await probeDaemon(await fakeDaemonPort({ name: "other" }))).toBe("none");
  });

  it("answers none for a process whose envelope carries no health at all", async () => {
    const body = JSON.stringify({ ok: true, data: null, diagnostics: [] });

    expect(await probeDaemon(await foreignPort(body))).toBe("none");
  });

  it("answers none for a process that answers with a refusal", async () => {
    const body = JSON.stringify({ ok: false, error: { kind: "daemon", code: "internal", message: "no" } });

    expect(await probeDaemon(await foreignPort(body, 500))).toBe("none");
  });

  it("answers none for a process whose answer is no envelope", async () => {
    expect(await probeDaemon(await foreignPort('"hello"'))).toBe("none");
  });

  it("answers none for a process that answers with no body at all", async () => {
    expect(await probeDaemon(await foreignPort("", 204))).toBe("none");
  });

  it("answers none for a reply longer than a health answer can be", async () => {
    expect(await probeDaemon(await fakeDaemonPort({ version: "9".repeat(70_000) }))).toBe("none");
  });

  it("answers none where nothing listens", async () => {
    expect(await probeDaemon(await freePort())).toBe("none");
  });
});
