import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DAEMON_NAME, DAEMON_RECORD_FILE } from "@tasma/protocol";
import { describe, expect, it } from "vitest";
// Relative: this package declares no exports, so its own name does not resolve.
import {
  daemonAnswers, daemonUrl, probe, readRecord, RECORD_LIMIT, recordPath, TREE_DIRNAME,
} from "../../src/daemon/record.js";
import { seedRecord, serveHealth, startServer, tasmaHealth, treeHome, unusedUrl } from "../helpers.js";

describe("recordPath", () => {
  it("names the record inside the tree of the given home", () => {
    expect(recordPath("/tmp/home")).toBe(join("/tmp/home", TREE_DIRNAME, DAEMON_RECORD_FILE));
  });
});

describe("readRecord", () => {
  it("reads the port and the process a record states", async () => {
    const home = treeHome();

    expect(await readRecord(seedRecord(home, { port: 9000, pid: 4242 }))).toEqual({ port: 9000, pid: 4242 });
    expect(await readRecord(seedRecord(home, { port: 0, pid: 2_147_483_647 })))
      .toEqual({ port: 0, pid: 2_147_483_647 });
  });

  it("answers nothing for a name that holds no file", async () => {
    expect(await readRecord(recordPath(treeHome()))).toBeUndefined();
  });

  // The record is a hint about where to look, so every way it states nothing is
  // the same case: the daemon replaces it at its next start.
  it("answers nothing for text that states no record", async () => {
    const home = treeHome();

    for (const content of [
      "",
      "{",
      "null",
      "[]",
      '"text"',
      JSON.stringify({ pid: 4242 }),
      JSON.stringify({ port: 9000 }),
      JSON.stringify({ port: 70000, pid: 4242 }),
      JSON.stringify({ port: -1, pid: 4242 }),
      JSON.stringify({ port: 9000.5, pid: 4242 }),
      JSON.stringify({ port: "9000", pid: 4242 }),
      JSON.stringify({ port: 9000, pid: 0 }),
      JSON.stringify({ port: 9000, pid: -4242 }),
      JSON.stringify({ port: 9000, pid: 42.5 }),
      JSON.stringify({ port: 9000, pid: "4242" }),
      // Above the range a signal can name, which `process.kill` refuses by type.
      JSON.stringify({ port: 9000, pid: 2_147_483_648 }),
      JSON.stringify({ port: 9000, pid: Number.MAX_SAFE_INTEGER }),
    ]) {
      expect(await readRecord(seedRecord(home, content)), content).toBeUndefined();
    }
  });

  // A process that can write into the tree root could otherwise force the whole
  // of a very long file into memory on every command.
  it("answers nothing for a file longer than a record can be", async () => {
    const home = treeHome();
    const record = JSON.stringify({ port: 9000, pid: 4242 });

    expect(await readRecord(seedRecord(home, record.padEnd(RECORD_LIMIT, " ")))).toEqual({ port: 9000, pid: 4242 });
    expect(await readRecord(seedRecord(home, record.padEnd(RECORD_LIMIT + 1, " ")))).toBeUndefined();
  });

  it("answers nothing for a name that holds a directory", async () => {
    const home = treeHome();

    mkdirSync(recordPath(home), { recursive: true });

    expect(await readRecord(recordPath(home))).toBeUndefined();
  });

  // A link under the name points outside the tree, and following one would read
  // a file no daemon of this tree wrote.
  it("answers nothing for a name that holds a symbolic link", async () => {
    const home = treeHome();
    const elsewhere = join(home, "elsewhere.json");

    writeFileSync(elsewhere, JSON.stringify({ port: 9000, pid: 4242 }));
    mkdirSync(join(home, TREE_DIRNAME), { recursive: true });
    symlinkSync(elsewhere, recordPath(home));

    expect(await readRecord(recordPath(home))).toBeUndefined();
  });
});

describe("daemonUrl", () => {
  it("names the loopback address every daemon binds", () => {
    expect(daemonUrl(9000)).toBe("http://127.0.0.1:9000");
  });
});

describe("probe", () => {
  it("names a Tasma daemon where one replies", async () => {
    const server = await startServer(tasmaHealth);

    try {
      expect(await probe(server.url)).toBe("daemon");
    } finally {
      await server.close();
    }
  });

  // Another program can hold the recorded port, and answer well-formed JSON on
  // it, so the one field that identifies a Tasma daemon decides.
  it("finds none in an answer that is not a Tasma daemon's", async () => {
    for (const data of [{ name: "other-daemon", version: "1" }, {}, null, 7]) {
      const server = await startServer(serveHealth(data));

      try {
        expect(await probe(server.url), JSON.stringify(data)).toBe("none");
      } finally {
        await server.close();
      }
    }
  });

  it("finds none in an answer carrying no envelope", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(502, { "content-type": "text/html" });
      response.end("<html>bad gateway</html>");
    });

    try {
      expect(await probe(server.url)).toBe("none");
    } finally {
      await server.close();
    }
  });

  it("finds none where nothing listens", async () => {
    expect(await probe(await unusedUrl())).toBe("none");
  });

  // A stale record names a port whatever program now holds it, and the budget
  // alone would let one that answers send for a whole second.
  it("finds none in a reply longer than a health answer can be", async () => {
    const server = await startServer(serveHealth({ name: DAEMON_NAME, version: "v".repeat(128 * 1024) }));

    try {
      expect(await probe(server.url)).toBe("none");
    } finally {
      await server.close();
    }
  });

  it("finds none in a status that carries no body at all", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(204);
      response.end();
    });

    try {
      expect(await probe(server.url)).toBe("none");
    } finally {
      await server.close();
    }
  });

  // A process that accepts the connection and never replies is the one case a
  // loopback call does not settle at once, and it is not an absent daemon: it
  // is told apart so that nothing starts a second daemon over the tree a slow
  // one already serves.
  it("calls a server that accepts and never replies late, within the budget it is given", async () => {
    const server = await startServer(() => {});

    try {
      expect(await probe(server.url, 50)).toBe("late");
    } finally {
      await server.close();
    }
  });

  // A stall after the headers is the same budget running out as one before them.
  it("calls a server that answers its headers and stalls late", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"ok":true,');
    });

    try {
      expect(await probe(server.url, 50)).toBe("late");
    } finally {
      await server.close();
    }
  });
});

describe("daemonAnswers", () => {
  it("answers true for a Tasma daemon alone", async () => {
    const server = await startServer(tasmaHealth);

    try {
      expect(await daemonAnswers(server.url)).toBe(true);
    } finally {
      await server.close();
    }
  });

  // A daemon too slow to answer within the budget is one a caller waiting for a
  // start cannot act on yet.
  it("answers false for an address nothing answered and for one that answered late", async () => {
    const slow = await startServer(() => {});

    try {
      expect(await daemonAnswers(await unusedUrl())).toBe(false);
      expect(await daemonAnswers(slow.url, 50)).toBe(false);
    } finally {
      await slow.close();
    }
  });
});
