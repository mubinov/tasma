import { afterEach, describe, expect, it, vi } from "vitest";
import { FileActionError, listEditors, openFile, revealFile, type Editor } from "../../src/api/files";

const EDITORS: Editor[] = [
  { id: "com.example.editor", name: "Example Editor" },
  { id: "com.example.other-editor", name: "Example Other Editor" },
];

const FILE = "/Users/someone/proj/a b.ts";

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

describe("the editor list", () => {
  it("asks the app for the installed editors", async () => {
    inTheApp();
    const fetch = answering(json(EDITORS));

    await expect(listEditors()).resolves.toEqual(EDITORS);
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/app/editors", { method: "GET" });
  });

  it("rejects with no status and no request outside the app", async () => {
    const fetch = answering(json(EDITORS));

    await expect(listEditors()).rejects.toMatchObject({ name: "FileActionError", status: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects with no status when the request fails", async () => {
    inTheApp();
    const failure = new TypeError("Failed to fetch");
    answering(failure);

    await expect(listEditors()).rejects.toMatchObject({ name: "FileActionError", status: null, cause: failure });
  });

  it.each([201, 404, 405, 500])("rejects on status %i with that status", async (status) => {
    inTheApp();
    answering(json(EDITORS, status));

    await expect(listEditors()).rejects.toMatchObject({ name: "FileActionError", status });
  });

  it("rejects with no status on a page instead of an answer", async () => {
    inTheApp();
    answering(new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } }));

    await expect(listEditors()).rejects.toMatchObject({ name: "FileActionError", status: null });
  });

  it.each([
    ["an object", { editors: EDITORS }],
    ["null", null],
    ["an entry that is null", [null]],
    ["an entry with no id", [{ name: "Example Editor" }]],
    ["an entry with an id that is no string", [{ id: 7, name: "Example Editor" }]],
    ["an entry with no name", [{ id: "com.example.editor" }]],
    ["an entry with a name that is no string", [{ id: "com.example.editor", name: null }]],
  ])("rejects with no status on a body that is %s", async (_, body) => {
    inTheApp();
    answering(json(body));

    await expect(listEditors()).rejects.toMatchObject({ name: "FileActionError", status: null });
  });
});

describe.each([
  ["the open of a file", () => openFile(FILE), "/app/files/open", { path: FILE }],
  ["the open of a file at a line", () => openFile(FILE, 42), "/app/files/open", { path: FILE, line: 42 }],
  ["the reveal of a file", () => revealFile(FILE), "/app/files/reveal", { path: FILE }],
])("%s", (_, call, route, sent) => {
  it("sends the path to the app", async () => {
    inTheApp();
    const fetch = answering(new Response(null, { status: 204 }));

    await expect(call()).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledExactlyOnceWith(route, { method: "POST", body: JSON.stringify(sent) });
  });

  it("rejects with no status and no request outside the app", async () => {
    const fetch = answering(new Response(null, { status: 204 }));

    await expect(call()).rejects.toMatchObject({ name: "FileActionError", status: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects with no status when the request fails", async () => {
    inTheApp();
    const failure = new TypeError("Failed to fetch");
    answering(failure);

    await expect(call()).rejects.toMatchObject({ name: "FileActionError", status: null, cause: failure });
  });

  it.each([200, 400, 404, 500])("rejects on status %i with that status", async (status) => {
    inTheApp();
    answering(new Response(null, { status }));

    const calling = call();

    await expect(calling).rejects.toBeInstanceOf(FileActionError);
    await expect(calling).rejects.toMatchObject({ status });
    await expect(calling).rejects.toThrow(`status ${status}`);
  });
});
