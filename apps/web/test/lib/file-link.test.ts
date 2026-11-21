import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileUrl, openFileLink } from "../../src/lib/file-link";
import { FILE_OPEN_FAILURE_KEY } from "../../src/lib/write-failure";
import { useNoticeStore } from "../../src/store/notices";

const FILE = "/work/saga/notes.md";

function inTheApp() {
  vi.stubGlobal("location", { protocol: "tasma-app:" });
}

function answering(response: Response | Error) {
  const fetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(() =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response.clone()));
  vi.stubGlobal("fetch", fetch);

  return fetch;
}

function notices() {
  return useNoticeStore.getState().notices.map(
    ({ key, form, title, line, words }) => ({ key, form, title, line, words }),
  );
}

const GENERAL_FAILURE = {
  key: FILE_OPEN_FAILURE_KEY,
  form: "failure",
  title: "Tasma cannot open the file.",
  line: "Try again. If the file does not open, restart Tasma.",
  words: [FILE],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fileUrl", () => {
  it.each([
    { path: "/work/saga/a b.md", url: "file:///work/saga/a%20b.md" },
    { path: "/work/saga/c#1.md", url: "file:///work/saga/c%231.md" },
    { path: "/work/saga/why?.md", url: "file:///work/saga/why%3F.md" },
    { path: "/work/sága/ö.md", url: "file:///work/s%C3%A1ga/%C3%B6.md" },
  ])("keeps each character of $path in the path", ({ path, url }) => {
    expect(fileUrl(path)).toBe(url);
  });
});

describe("openFileLink", () => {
  beforeEach(inTheApp);

  it("asks the app to open the file, and shows no notice when it opens", async () => {
    const fetch = answering(new Response(null, { status: 204 }));

    await openFileLink(FILE, undefined);

    expect(fetch).toHaveBeenCalledExactlyOnceWith("/app/files/open", { method: "POST", body: JSON.stringify({ path: FILE }) });
    expect(notices()).toEqual([]);
  });

  it("sends the line", async () => {
    const fetch = answering(new Response(null, { status: 204 }));

    await openFileLink(FILE, 42);

    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "/app/files/open",
      { method: "POST", body: JSON.stringify({ path: FILE, line: 42 }) },
    );
  });

  it("says that a file that does not resolve does not exist", async () => {
    answering(new Response(null, { status: 404 }));

    await openFileLink(FILE, undefined);

    expect(notices()).toEqual([{ ...GENERAL_FAILURE, line: "The file does not exist." }]);
  });

  it.each([
    ["status 400", new Response(null, { status: 400 })],
    ["status 500", new Response(null, { status: 500 })],
    ["a network failure", new TypeError("Failed to fetch")],
  ])("shows the general notice on %s", async (_, response) => {
    answering(response);

    await openFileLink(FILE, undefined);

    expect(notices()).toEqual([GENERAL_FAILURE]);
  });

  it("shows the notice again after a dismiss", async () => {
    answering(new Response(null, { status: 500 }));
    await openFileLink(FILE, undefined);
    useNoticeStore.getState().dismissNotice(FILE_OPEN_FAILURE_KEY);

    await openFileLink(FILE, undefined);

    expect(notices()).toEqual([GENERAL_FAILURE]);
  });

  it("replaces an older failure with a newer one", async () => {
    answering(new Response(null, { status: 404 }));
    await openFileLink("/work/saga/old.md", undefined);
    answering(new Response(null, { status: 500 }));

    await openFileLink(FILE, undefined);

    expect(notices()).toEqual([GENERAL_FAILURE]);
  });
});
