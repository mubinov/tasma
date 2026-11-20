import { describe, expect, it } from "vitest";
import { EDITOR_SCHEMES, linkKind } from "../../src/lib/link-kind";

function taskIdOf(href: string): string | undefined {
  const kind = linkKind(href);
  return kind?.kind === "task" ? kind.id : undefined;
}

describe("a task link", () => {
  it.each([
    "http://127.0.0.1:8278/task/AB-1",
    "http://localhost:8278/task/AB-1",
    "http://[::1]:8278/task/AB-1",
    "http://LOCALHOST:8278/task/AB-1",
    "tasma://task/AB-1",
  ])("names its task: %s", (href) => {
    expect(linkKind(href)).toEqual({ kind: "task", id: "AB-1" });
  });

  it.each(["http://127.0.0.1:8278/task/", "tasma://task/"])("reads a lower-case tag upper case: %s", (prefix) => {
    expect(taskIdOf(`${prefix}saga-1`)).toBe("SAGA-1");
    expect(taskIdOf(`${prefix}Saga7-9999`)).toBe("SAGA7-9999");
  });

  it.each(["http://127.0.0.1:8278/task/", "tasma://task/"])("tolerates one trailing separator: %s", (prefix) => {
    expect(taskIdOf(`${prefix}AB-1/`)).toBe("AB-1");
    expect(taskIdOf(`${prefix}AB-1//`)).toBeUndefined();
    expect(taskIdOf(`${prefix}AB-1/extra`)).toBeUndefined();
  });

  it.each(["http://127.0.0.1:8278/task/", "tasma://task/"])("refuses a tag outside the rule: %s", (prefix) => {
    expect(taskIdOf(`${prefix}ABCDEFGH-1`)).toBe("ABCDEFGH-1");
    expect(taskIdOf(`${prefix}A1-1`)).toBe("A1-1");
    for (const segment of ["-1", "S-1", "SAGABOOKS-1", "1SAGA-1", "SA_GA-1", "SAG%C3%80-1", "%C5%BFaga-1", "SAGA1"]) {
      expect(taskIdOf(`${prefix}${segment}`), segment).toBeUndefined();
    }
  });

  it.each(["http://127.0.0.1:8278/task/", "tasma://task/"])("refuses a number that is not ASCII digits: %s", (prefix) => {
    for (const segment of ["SAGA-", "SAGA-1a", "SAGA--1", "SAGA-+1", "SAGA-%D9%A1"]) {
      expect(taskIdOf(`${prefix}${segment}`), segment).toBeUndefined();
    }
  });

  it.each(["http://127.0.0.1:8278/task/", "tasma://task/"])("refuses a user or a password: %s", (prefix) => {
    const [scheme, rest] = prefix.split("://") as [string, string];

    expect(taskIdOf(`${scheme}://someone@${rest}AB-1`)).toBeUndefined();
    expect(taskIdOf(`${scheme}://:secret@${rest}AB-1`)).toBeUndefined();
  });
});

describe("a task link of the http form", () => {
  it.each([
    "http://localhost:3000/task/AB-1",
    "http://127.0.0.1/task/AB-1",
    "https://127.0.0.1:8278/task/AB-1",
    "http://example.com:8278/task/AB-1",
    "http://127.0.0.1:8278/tasks/AB-1",
    "http://127.0.0.1:8278/task/AB%2D1",
    "http://127.0.0.1:8278/task/",
  ])("is a web link when it is outside the grammar of the daemon page: %s", (href) => {
    expect(linkKind(href)).toEqual({ kind: "web", url: href });
  });

  it.each([
    "http://127.0.0.1:8278/task/AB-1?x=1",
    "http://127.0.0.1:8278/task/AB-1?",
    "http://127.0.0.1:8278/task/AB-1#c3",
    "http://127.0.0.1:8278/task/AB-1#",
  ])("ignores the query and the fragment: %s", (href) => {
    expect(taskIdOf(href)).toBe("AB-1");
  });
});

describe("a task link of the tasma form", () => {
  it("reads the host in any case", () => {
    expect(taskIdOf("tasma://TASK/AB-1")).toBe("AB-1");
  });

  it("reads the segment decoded", () => {
    expect(taskIdOf("tasma://task/SAGA%2D1")).toBe("SAGA-1");
    expect(taskIdOf("tasma://task/SAGA%2F1")).toBeUndefined();
    expect(taskIdOf("tasma://task/SAGA-1%2Fextra")).toBeUndefined();
    expect(taskIdOf("tasma://task/SAGA-%FF")).toBeUndefined();
  });

  it.each([
    "tasma://task/SAGA-1?x=1",
    "tasma://task/SAGA-1?",
    "tasma://task/SAGA-1#c3",
    "tasma://task/SAGA-1#",
    "tasma://task:1/SAGA-1",
    "tasma://task/",
    "tasma://task",
    "tasma://project/SAGA",
    "tasma://SAGA-1",
    "tasma:task/SAGA-1",
    "tasma-app://task/SAGA-1",
  ])("has no kind outside the grammar of the macOS part: %s", (href) => {
    expect(linkKind(href)).toBeUndefined();
  });
});

describe("a web or a mail link", () => {
  it.each(["https://example.com/a?b#c", "http://example.com/", "http://[::1]:8080/a"])("is a web link: %s", (href) => {
    expect(linkKind(href)).toEqual({ kind: "web", url: href });
  });

  it.each([
    { href: "mailto:someone@example.com", address: "someone@example.com" },
    { href: "mailto:some%20one@example.com", address: "some one@example.com" },
    { href: "mailto:some%FFone@example.com", address: "some%FFone@example.com" },
  ])("gives its decoded address: $href", ({ href, address }) => {
    expect(linkKind(href)).toEqual({ kind: "mail", address });
  });
});

describe("an editor link", () => {
  it("has the five schemes", () => {
    expect([...EDITOR_SCHEMES]).toEqual(["vscode:", "vscode-insiders:", "cursor:", "vscodium:", "zed:"]);
  });

  it.each([...EDITOR_SCHEMES])("of %s in the file form is an editor link", (scheme) => {
    const href = `${scheme}//file/Users/x/proj/a.ts`;

    expect(linkKind(href)).toEqual({ kind: "editor", url: href });
  });

  it.each([
    "vscode://file/Users/x/proj/a.ts:3",
    "vscode://file/Users/x/proj/a.ts:3:5",
    "vscode://file/x/proj%3A3",
    "vscode://file/x/a%2Fb.ts",
    "vscode://file/x/my%20notes.md",
    "zed://file/x/a.ts:12",
  ])("keeps a path that every editor reads as one file: %s", (href) => {
    expect(linkKind(href)).toEqual({ kind: "editor", url: href });
  });

  it.each([
    "vscode://FILE/x/a.ts",
    "vscode://vscode.git/clone?url=https://example.com/r.git",
    "vscode://publisher.extension/x/a.ts",
    "cursor://anysphere.cursor-deeplink/mcp/install?name=x",
    "vscode://file/x/a.ts?line=3",
    "vscode://file/x/a.ts?",
    "vscode://file/x/a.ts#L3",
    "vscode://file/x/a.ts#",
    "vscode://file:1/x/a.ts",
    "vscode://someone@file/x/a.ts",
    "vscode://:secret@file/x/a.ts",
    "vscode:/file/x/a.ts",
  ])("has no kind in a form other than the file form: %s", (href) => {
    expect(linkKind(href)).toBeUndefined();
  });

  it.each([
    "vscode://file",
    "vscode://file/",
    "vscode://file/x/proj/",
    "vscode://file/x//a.ts",
    "vscode://file/x/proj:",
    "vscode://file/x/proj:0x1",
    "vscode://file/x/proj::3",
    "vscode://file/x/proj:3:5:7",
    "vscode://file/x/proj:a",
    "vscode://file/x/proj(3)",
    "vscode://file/x/proj(3,5)",
    "vscode://file/x/a%2F..%2Fb",
    "vscode://file/x/a%2F.%2Fb",
    "vscode://file/x/a.ts%20",
    "vscode://file/x/a.ts%C2%A0",
    "vscode://file/x/a.ts%C2%85",
    "vscode://file/x/a.ts%20:3",
    "vscode://file/x/a.ts%FF",
    "vscode://file/x/w.code-workspace",
    "vscode://file/x/w.CODE-Workspace",
    "vscode://file/x/w.code-workspace:3",
    "vscode://file/x/w.code-wor%E2%84%AAspace",
  ])("has no kind for a path that an editor can read in another way: %s", (href) => {
    expect(linkKind(href)).toBeUndefined();
  });
});

describe("another link", () => {
  it.each(["foo://x", "javascript:alert(1)", "file:///etc/passwd", "not a url"])("has no kind: %s", (href) => {
    expect(linkKind(href)).toBeUndefined();
  });
});
