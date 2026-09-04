import { DAEMON_NAME } from "@tasma/protocol";
import { describe, expect, it } from "vitest";
import manifest from "../package.json" with { type: "json" };
// Relative: this package declares no exports, so its own name does not resolve.
import { run, splitInvocation } from "../src/run.js";
import { dispatch, errorText, printable, reportUsage } from "../src/shell.js";
import type { Command } from "../src/types.js";
import { capture, startServer } from "./helpers.js";

/*
 * A refused address, passed as the environment to the paths that answer above
 * the address is resolved. Documentation stays reachable on a machine exporting
 * a variable the CLI would refuse, which holds only while those three paths
 * return before `resolveDaemonUrl`.
 */
const REFUSED_ENV = { TASMA_DAEMON_URL: "nonsense" };

describe("run", () => {
  it("writes the manifest version for --version and -v", async () => {
    for (const flag of ["--version", "-v"]) {
      const { io, out, err } = capture();

      expect(await run([flag], io, REFUSED_ENV)).toBe(0);
      expect(out.join("")).toBe(`tasma ${manifest.version}\n`);
      expect(err).toEqual([]);
    }
  });

  // A bare `tasma` is a request for orientation, not an error.
  it("writes the same help for --help, -h and no arguments at all", async () => {
    const texts: string[] = [];

    for (const args of [["--help"], ["-h"], []]) {
      const { io, out, err } = capture();

      expect(await run(args, io, REFUSED_ENV)).toBe(0);
      expect(err).toEqual([]);
      texts.push(out.join(""));
    }

    expect(texts[0]).toContain("Usage:");
    expect(new Set(texts).size).toBe(1);
  });

  it("reports an unknown option on stderr, writing nothing to stdout", async () => {
    const { io, out, err } = capture();

    expect(await run(["--nope"], io, {})).toBe(2);
    expect(out).toEqual([]);
    expect(err.join("")).toBe("tasma: Unknown option '--nope'\nRun 'tasma --help' for usage.\n");
  });

  // parseArgs rejects a bare - as an unexpected positional, not as an unknown
  // option; uncaught it would reach the caller as a stack trace.
  it("reports a bare - as a usage error", async () => {
    const { io, err } = capture();

    expect(await run(["-"], io, {})).toBe(2);
    expect(err.join("")).toContain("tasma: ");
  });

  it("reports an unknown command", async () => {
    const { io, out, err } = capture();

    expect(await run(["frobnicate"], io, {})).toBe(2);
    expect(out).toEqual([]);
    expect(err.join("")).toBe("tasma: unknown command: frobnicate\nRun 'tasma --help' for usage.\n");
  });

  // The guard on the argument split: a command's own flags must not reach the
  // global parser, which knows only --help, --version and --daemon.
  it("takes a flag after the command name as the command's own", async () => {
    const { io, err } = capture();

    expect(await run(["frobnicate", "--json"], io, {})).toBe(2);
    expect(err.join("")).toContain("unknown command: frobnicate");
  });

  it("escapes a control character in a command name rather than writing it to the terminal", async () => {
    const { io, err } = capture();

    expect(await run(["\u001b[2Jfrobnicate"], io, {})).toBe(2);
    expect(err.join("")).toBe("tasma: unknown command: \\u001b[2Jfrobnicate\nRun 'tasma --help' for usage.\n");
  });

  // The parser embeds the offending token in its own message, so that path
  // needs the same escaping.
  it("escapes a control character the parser quotes back", async () => {
    const { io, err } = capture();

    expect(await run(["--no\u001bpe"], io, {})).toBe(2);
    expect(err.join("")).toContain("\\u001b");
    expect(err.join("")).not.toContain("\u001b");
  });

  // A break that survives is a second, well-formed `tasma: ` line, which reads
  // as a diagnostic the CLI never wrote. Every caller that quotes an argument
  // back is a way in, so each is pinned.
  it("escapes a line break an argument carried, through every caller that quotes one back", async () => {
    const refused = "not a daemon address: 1\\u000atasma: forged";

    for (const { argv, env, detail } of [
      { argv: ["\ndaemon status: forged"], env: {}, detail: "unknown command: \\u000adaemon status: forged" },
      {
        argv: ["daemon", "status", "x\ntasma: forged"],
        env: {},
        detail: "daemon status takes no arguments: x\\u000atasma: forged",
      },
      { argv: ["--\ntasma: forged"], env: {}, detail: "Unknown option '--\\u000atasma: forged'" },
      { argv: ["--daemon", "1\ntasma: forged", "daemon", "status"], env: {}, detail: refused },
      { argv: ["daemon", "status"], env: { TASMA_DAEMON_URL: "1\ntasma: forged" }, detail: refused },
    ]) {
      const { io, out, err } = capture();

      expect(await run(argv, io, env)).toBe(2);
      expect(out).toEqual([]);
      expect(err.join("")).toBe(`tasma: ${detail}\nRun 'tasma --help' for usage.\n`);
    }
  });

  it("reads the token after a value-taking global as its value, not as the command", async () => {
    const { io, err } = capture();

    expect(await run(["--daemon", "http://127.0.0.1:9000", "daemon", "frobnicate"], io, {})).toBe(2);
    expect(err.join("")).toContain("unknown command: daemon frobnicate");
  });

  // The address is resolved once above and handed down, so what the command
  // reports is the proof that it arrived.
  it("carries the resolved address to the command, from the flag and from the variable", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, data: { name: DAEMON_NAME, version: "1.2.3" }, diagnostics: [] }));
    });

    try {
      for (const invocation of [
        { argv: ["--daemon", server.url, "daemon", "status"], env: {} },
        { argv: ["daemon", "status"], env: { TASMA_DAEMON_URL: server.url } },
      ]) {
        const { io, out, err } = capture();

        expect(await run(invocation.argv, io, invocation.env)).toBe(0);
        expect(out.join("")).toBe(`${DAEMON_NAME} 1.2.3 at ${server.url}\n`);
        expect(err).toEqual([]);
      }
    } finally {
      await server.close();
    }
  });

  it("reports an address it refuses as a usage error, not as a daemon that is down", async () => {
    const { io, out, err } = capture();

    expect(await run(["--daemon", "nonsense", "daemon", "status"], io, {})).toBe(2);
    expect(out).toEqual([]);
    expect(err.join("")).toBe("tasma: not a daemon address: nonsense\nRun 'tasma --help' for usage.\n");
  });

  // The parser writes several sentences for an option that takes a value, and
  // escaping its breaks with the rest would print them inside a run-on line.
  it("breaks a parser message that carries line breaks rather than escaping them", async () => {
    const { io, err } = capture();

    expect(await run(["--daemon", "-h"], io, {})).toBe(2);
    expect(err.join("")).not.toContain("\\u000a");
    expect(err.join("").split("\n").filter((line) => line !== "").length).toBeGreaterThan(2);
  });
});

describe("reportUsage", () => {
  it("writes a detail as one line, escaping a break it carries, then the hint", () => {
    const { io, err } = capture();

    expect(reportUsage(io, "first.\nsecond.")).toBe(2);
    expect(err.join("")).toBe("tasma: first.\\u000asecond.\nRun 'tasma --help' for usage.\n");
  });

  it("writes one prefixed line per part where the caller states the parts", () => {
    const { io, err } = capture();

    expect(reportUsage(io, ["first.", "second."])).toBe(2);
    expect(err.join("")).toBe("tasma: first.\ntasma: second.\nRun 'tasma --help' for usage.\n");
  });
});

describe("splitInvocation", () => {
  it("takes the first non-flag token as the command and everything after it as its arguments", () => {
    expect(splitInvocation(["-v", "list", "--json", "x"])).toEqual({
      globals: ["-v"],
      name: "list",
      args: ["--json", "x"],
    });
  });

  it("names no command when every token is a flag", () => {
    expect(splitInvocation(["--help"])).toEqual({ globals: ["--help"], args: [] });
    expect(splitInvocation([])).toEqual({ globals: [], args: [] });
  });

  // Without this the URL is read as the command name.
  it("walks past the value of a global that takes one", () => {
    expect(splitInvocation(["--daemon", "http://127.0.0.1:9000", "daemon", "status"])).toEqual({
      globals: ["--daemon", "http://127.0.0.1:9000"],
      name: "daemon",
      args: ["status"],
    });
  });

  // The joined form carries its own value, so the walk must not consume the
  // token after it as well.
  it("leaves the token after a joined --daemon=<url> as the command", () => {
    expect(splitInvocation(["--daemon=http://127.0.0.1:9000", "daemon"])).toEqual({
      globals: ["--daemon=http://127.0.0.1:9000"],
      name: "daemon",
      args: [],
    });
  });

  it("names no command when a valued global ends the arguments", () => {
    expect(splitInvocation(["--daemon"])).toEqual({ globals: ["--daemon"], args: [] });
  });
});

describe("printable", () => {
  it("leaves ordinary text alone", () => {
    expect(printable("unknown command: frobnicate")).toBe("unknown command: frobnicate");
  });

  it("escapes a control or format character, an astral one by both its code units", () => {
    expect(printable("a\u001b\u200eb")).toBe("a\\u001b\\u200eb");
    expect(printable("\u{110bd}")).toBe("\\ud804\\udcbd");
  });

  // No terminal acts on these, but a consumer splitting the output into lines
  // does, so an argument carrying one forges a line the CLI never wrote.
  it("escapes the two Unicode line separators", () => {
    expect(printable("a\u2028b\u2029c")).toBe("a\\u2028b\\u2029c");
  });
});

describe("dispatch", () => {
  it("runs the named command with the arguments after it, the io and the address", async () => {
    const { io } = capture();
    const seen: { args: string[]; daemonUrl: string }[] = [];
    const commands: Command[] = [
      {
        name: "list",
        summary: "List the tasks",
        run: (args, _io, daemonUrl) => {
          seen.push({ args, daemonUrl });
          return Promise.resolve(1);
        },
      },
    ];

    expect(await dispatch(commands, "", "list", ["--json"], io, "http://127.0.0.1:9000")).toBe(1);
    expect(seen).toEqual([{ args: ["--json"], daemonUrl: "http://127.0.0.1:9000" }]);
  });

  it("reports a name the registry does not hold", async () => {
    const { io, err } = capture();

    expect(await dispatch([], "", "list", [], io, "http://127.0.0.1:8278")).toBe(2);
    expect(err.join("")).toBe("tasma: unknown command: list\nRun 'tasma --help' for usage.\n");
  });

  // Reported as the whole invocation: `frobnicate` is no top-level command and
  // saying so would send the reader looking for one.
  it("names the parent noun in front of a verb the table does not hold", async () => {
    const { io, err } = capture();

    expect(await dispatch([], "daemon", "frobnicate", [], io, "http://127.0.0.1:8278")).toBe(2);
    expect(err.join("")).toBe("tasma: unknown command: daemon frobnicate\nRun 'tasma --help' for usage.\n");
  });
});

describe("errorText", () => {
  it("takes the text off an Error", () => {
    expect(errorText(new TypeError("Unknown option '--nope'"))).toBe("Unknown option '--nope'");
  });

  it("names the fault itself for a throw that is not an Error", () => {
    expect(errorText("boom")).toBe("invalid arguments");
  });
});
