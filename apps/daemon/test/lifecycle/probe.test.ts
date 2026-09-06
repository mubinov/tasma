import { describe, expect, it } from "vitest";
import { readHealth } from "../../src/http/health.js";
import { daemonAnswers, daemonUrl } from "../../src/lifecycle/probe.js";
import { foreignPort, freePort, startTestServer } from "../helpers.js";

/** An envelope carrying a health answer with one field replaced. */
async function healthBody(field: Partial<Record<"name" | "version", string>>): Promise<string> {
  const { data } = await readHealth();

  return JSON.stringify({ ok: true, data: { ...data, ...field }, diagnostics: [] });
}

describe("the address a daemon is reached at", () => {
  it("is the loopback host every bind uses", () => {
    expect(daemonUrl(8278)).toBe("http://127.0.0.1:8278");
  });
});

describe("the probe of a port", () => {
  it("answers true for a Tasma daemon", async () => {
    const server = await startTestServer([]);

    expect(await daemonAnswers(Number(new URL(server.url).port))).toBe(true);
  });

  it("answers false for a process answering under another name", async () => {
    expect(await daemonAnswers(await foreignPort(await healthBody({ name: "other" })))).toBe(false);
  });

  it("answers false for a process whose envelope carries no health at all", async () => {
    const body = JSON.stringify({ ok: true, data: null, diagnostics: [] });

    expect(await daemonAnswers(await foreignPort(body))).toBe(false);
  });

  it("answers false for a process whose answer is no envelope", async () => {
    expect(await daemonAnswers(await foreignPort('"hello"'))).toBe(false);
  });

  it("answers false for a process that answers with no body at all", async () => {
    expect(await daemonAnswers(await foreignPort("", 204))).toBe(false);
  });

  it("answers false for a reply longer than a health answer can be", async () => {
    expect(await daemonAnswers(await foreignPort(await healthBody({ version: "9".repeat(70_000) })))).toBe(false);
  });

  it("answers false where nothing listens", async () => {
    expect(await daemonAnswers(await freePort())).toBe(false);
  });
});
