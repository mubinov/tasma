import { afterEach, expect, it, vi } from "vitest";
import { sendLinkSettings } from "../../src/api/link-settings";
import { DEFAULT_LINK_SETTINGS, type LinkSettings } from "../../src/lib/link-settings";
import { stubShell } from "../helpers";

const SETTINGS: LinkSettings = {
  browser: "com.example.browser",
  devBrowser: "com.example.dev-browser",
  devDomains: ["example.test"],
  fileApp: "com.example.editor",
};

function sentBodies(): unknown[] {
  return vi.mocked(fetch).mock.calls.map(([, init]) => init?.body);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("posts the settings as JSON to the app", async () => {
  const shell = stubShell();

  await sendLinkSettings(SETTINGS);

  expect(shell.posted()).toEqual(["POST /app/links"]);
  expect(sentBodies()).toEqual([JSON.stringify(SETTINGS)]);
});

it("ignores a request the app does not answer", async () => {
  stubShell(() => Promise.reject(new TypeError("Load failed")));

  await expect(sendLinkSettings(SETTINGS)).resolves.toBeUndefined();
});

it("ignores a request the app refuses", async () => {
  stubShell(() => Promise.resolve(new Response(null, { status: 400 })));

  await expect(sendLinkSettings(SETTINGS)).resolves.toBeUndefined();
});

it("starts a send only after the previous one has settled", async () => {
  const answers: ((answer: Response) => void)[] = [];
  const shell = stubShell(() => new Promise((resolve) => answers.push(resolve)));

  const first = sendLinkSettings(DEFAULT_LINK_SETTINGS);
  const second = sendLinkSettings(SETTINGS);
  await vi.waitFor(() => {
    expect(shell.posted()).toEqual(["POST /app/links"]);
  });

  answers[0]!(new Response(null, { status: 204 }));
  await first;
  await vi.waitFor(() => {
    expect(shell.posted()).toEqual(["POST /app/links", "POST /app/links"]);
  });

  answers[1]!(new Response(null, { status: 204 }));
  await second;
  expect(sentBodies()).toEqual([JSON.stringify(DEFAULT_LINK_SETTINGS), JSON.stringify(SETTINGS)]);
});

it("sends the next settings after a send that failed", async () => {
  stubShell(() => Promise.reject(new TypeError("Load failed")));

  void sendLinkSettings(DEFAULT_LINK_SETTINGS);
  await sendLinkSettings(SETTINGS);

  expect(sentBodies()).toEqual([JSON.stringify(DEFAULT_LINK_SETTINGS), JSON.stringify(SETTINGS)]);
});
