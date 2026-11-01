import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderDialogError, folderDialogAvailable, pickFolder } from "../../src/api/folder-dialog";
import { useUiStore } from "../../src/store/ui";

const FOLDER = "/Users/someone/Projects/alpha";

function inTheApp() {
  vi.stubGlobal("location", { protocol: "tasma-app:" });
}

function answering(response: Response | Error) {
  const fetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(() =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response.clone()));
  vi.stubGlobal("fetch", fetch);

  return fetch;
}

/** A request that stays open until the test answers it. */
function held() {
  let resolve: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((settle) => {
    resolve = settle;
  });
  const fetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(() => promise);
  vi.stubGlobal("fetch", fetch);

  return { fetch, answer: { resolve: (response: Response) => resolve(response) } };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function modalDialogs() {
  return useUiStore.getState().modalDialogs;
}

beforeEach(() => {
  useUiStore.setState({ modalDialogs: 0 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the folder dialog", () => {
  it("is available only on the origin the macOS app serves", () => {
    expect(folderDialogAvailable()).toBe(false);

    inTheApp();

    expect(folderDialogAvailable()).toBe(true);
  });

  it("asks the app for a folder and gives its path", async () => {
    inTheApp();
    const fetch = answering(json({ path: FOLDER }));

    await expect(pickFolder()).resolves.toBe(FOLDER);
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/app/folder", { method: "POST" });
  });

  it("gives null when the user cancels", async () => {
    inTheApp();
    answering(json({ path: null }));

    await expect(pickFolder()).resolves.toBeNull();
  });

  it("rejects with no request where the dialog is not available", async () => {
    const fetch = answering(json({ path: FOLDER }));

    await expect(pickFolder()).rejects.toBeInstanceOf(FolderDialogError);
    expect(fetch).not.toHaveBeenCalled();
    expect(modalDialogs()).toBe(0);
  });

  it("rejects when the request fails", async () => {
    inTheApp();
    const failure = new TypeError("Failed to fetch");
    answering(failure);

    const pick = pickFolder();

    await expect(pick).rejects.toBeInstanceOf(FolderDialogError);
    await expect(pick).rejects.toMatchObject({ name: "FolderDialogError", cause: failure });
  });

  it.each([500, 409, 405])("rejects on status %i", async (status) => {
    inTheApp();
    answering(new Response(null, { status }));

    await expect(pickFolder()).rejects.toBeInstanceOf(FolderDialogError);
  });

  it("rejects a success status other than 200 even with a valid body", async () => {
    inTheApp();
    answering(json({ path: FOLDER }, 201));

    await expect(pickFolder()).rejects.toBeInstanceOf(FolderDialogError);
  });

  it("rejects on a page instead of an answer", async () => {
    inTheApp();
    answering(new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } }));

    await expect(pickFolder()).rejects.toBeInstanceOf(FolderDialogError);
  });

  it.each([
    ["no path", {}],
    ["a path that is no string", { path: 42 }],
    ["null", null],
    ["a list", [FOLDER]],
    ["a bare string", FOLDER],
  ])("rejects on a body with %s", async (_, body) => {
    inTheApp();
    answering(json(body));

    await expect(pickFolder()).rejects.toBeInstanceOf(FolderDialogError);
  });

  it("shares one pending pick between two calls", async () => {
    inTheApp();
    const { fetch, answer } = held();

    const first = pickFolder();
    const second = pickFolder();
    answer.resolve(json({ path: FOLDER }));

    expect(second).toBe(first);
    await expect(first).resolves.toBe(FOLDER);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("sends a new request for a pick after the last one settled", async () => {
    inTheApp();
    const fetch = answering(json({ path: null }));

    await pickFolder();
    await pickFolder();

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("counts a pending pick as one open modal dialog until it resolves", async () => {
    inTheApp();
    const { answer } = held();

    const pick = pickFolder();
    void pickFolder();

    expect(modalDialogs()).toBe(1);

    answer.resolve(json({ path: FOLDER }));
    await pick;

    expect(modalDialogs()).toBe(0);
  });

  it("counts a pending pick as one open modal dialog until it rejects", async () => {
    inTheApp();
    const { answer } = held();

    const pick = pickFolder();

    expect(modalDialogs()).toBe(1);

    answer.resolve(new Response(null, { status: 500 }));
    await expect(pick).rejects.toBeInstanceOf(FolderDialogError);

    expect(modalDialogs()).toBe(0);
  });
});
