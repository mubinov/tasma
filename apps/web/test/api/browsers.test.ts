import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserError, listBrowsers, openInBrowser, type Browser } from "../../src/api/browsers";

const BROWSERS: Browser[] = [
  { id: "com.example.browser", name: "Example Browser", default: true },
  { id: "com.example.dev-browser", name: "Example Dev Browser", default: false },
];

const LINK = "https://example.invalid/a?b=c";

function inTheApp() {
  vi.stubGlobal("location", { protocol: "tasma-app:" });
}

function answering(response: Response | Error) {
  const fetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(() =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response.clone()));
  vi.stubGlobal("fetch", fetch);

  return fetch;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the browser list", () => {
  it("asks the app for the installed browsers", async () => {
    inTheApp();
    const fetch = answering(json(BROWSERS));

    await expect(listBrowsers()).resolves.toEqual(BROWSERS);
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/app/browsers", { method: "GET" });
  });

  it("rejects with no request outside the app", async () => {
    const fetch = answering(json(BROWSERS));

    await expect(listBrowsers()).rejects.toBeInstanceOf(BrowserError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects when the request fails", async () => {
    inTheApp();
    const failure = new TypeError("Failed to fetch");
    answering(failure);

    await expect(listBrowsers()).rejects.toMatchObject({ name: "BrowserError", cause: failure });
  });

  it.each([201, 404, 405, 500])("rejects on status %i", async (status) => {
    inTheApp();
    answering(json(BROWSERS, status));

    await expect(listBrowsers()).rejects.toBeInstanceOf(BrowserError);
  });

  it("rejects on a page instead of an answer", async () => {
    inTheApp();
    answering(new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } }));

    await expect(listBrowsers()).rejects.toBeInstanceOf(BrowserError);
  });

  it.each([
    ["an object", { browsers: BROWSERS }],
    ["null", null],
    ["an entry that is null", [null]],
    ["an entry with no id", [{ name: "Example Browser", default: true }]],
    ["an entry with an id that is no string", [{ id: 7, name: "Example Browser", default: true }]],
    ["an entry with no name", [{ id: "com.example.browser", default: true }]],
    ["an entry with a name that is no string", [{ id: "com.example.browser", name: null, default: true }]],
    ["an entry with no default", [{ id: "com.example.browser", name: "Example Browser" }]],
    ["an entry with a default that is no boolean", [{ id: "com.example.browser", name: "Example Browser", default: "yes" }]],
  ])("rejects on a body that is %s", async (_, body) => {
    inTheApp();
    answering(json(body));

    await expect(listBrowsers()).rejects.toBeInstanceOf(BrowserError);
  });
});

describe("the open in a named browser", () => {
  it("sends the link and the browser to the app", async () => {
    inTheApp();
    const fetch = answering(new Response(null, { status: 204 }));

    await expect(openInBrowser(LINK, "com.example.browser")).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/app/open", {
      method: "POST",
      body: JSON.stringify({ url: LINK, browser: "com.example.browser" }),
    });
  });

  it("rejects with no request outside the app", async () => {
    const fetch = answering(new Response(null, { status: 204 }));

    await expect(openInBrowser(LINK, "com.example.browser")).rejects.toBeInstanceOf(BrowserError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects when the request fails", async () => {
    inTheApp();
    const failure = new TypeError("Failed to fetch");
    answering(failure);

    await expect(openInBrowser(LINK, "com.example.browser")).rejects.toMatchObject({
      name: "BrowserError",
      cause: failure,
    });
  });

  it.each([200, 400, 404, 500])("rejects on status %i with the status in the message", async (status) => {
    inTheApp();
    answering(new Response(null, { status }));

    const opening = openInBrowser(LINK, "com.example.browser");

    await expect(opening).rejects.toBeInstanceOf(BrowserError);
    await expect(opening).rejects.toThrow(`status ${status}`);
  });
});
