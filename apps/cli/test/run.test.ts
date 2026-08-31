import { describe, expect, it } from "vitest";
import manifest from "../package.json" with { type: "json" };
// Relative: this package declares no exports, so its own name does not resolve.
import { dispatch, errorText, printable, run, splitInvocation } from "../src/run.js";
import type { Command, Io } from "../src/types.js";

function capture(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { stdout: { write: (text: string) => out.push(text) }, stderr: { write: (text: string) => err.push(text) } },
    out,
    err,
  };
}

describe("run", () => {
  it("writes the manifest version for --version and -v", () => {
    for (const flag of ["--version", "-v"]) {
      const { io, out, err } = capture();

      expect(run([flag], io)).toBe(0);
      expect(out.join("")).toBe(`tasma ${manifest.version}\n`);
      expect(err).toEqual([]);
    }
  });

  // A bare `tasma` is a request for orientation, not an error.
  it("writes the same help for --help, -h and no arguments at all", () => {
    const texts = [["--help"], ["-h"], []].map((args) => {
      const { io, out, err } = capture();

      expect(run(args, io)).toBe(0);
      expect(err).toEqual([]);
      return out.join("");
    });

    expect(texts[0]).toContain("Usage:");
    expect(new Set(texts).size).toBe(1);
  });

  it("reports an unknown option on stderr, writing nothing to stdout", () => {
    const { io, out, err } = capture();

    expect(run(["--nope"], io)).toBe(2);
    expect(out).toEqual([]);
    expect(err.join("")).toBe("tasma: Unknown option '--nope'\nRun 'tasma --help' for usage.\n");
  });

  // parseArgs rejects a bare - as an unexpected positional, not as an unknown
  // option; uncaught it would reach the caller as a stack trace.
  it("reports a bare - as a usage error", () => {
    const { io, err } = capture();

    expect(run(["-"], io)).toBe(2);
    expect(err.join("")).toContain("tasma: ");
  });

  it("reports an unknown command", () => {
    const { io, out, err } = capture();

    expect(run(["frobnicate"], io)).toBe(2);
    expect(out).toEqual([]);
    expect(err.join("")).toBe("tasma: unknown command: frobnicate\nRun 'tasma --help' for usage.\n");
  });

  // The guard on the argument split: a command's own flags must not reach the
  // global parser, which knows only --help and --version.
  it("takes a flag after the command name as the command's own", () => {
    const { io, err } = capture();

    expect(run(["frobnicate", "--json"], io)).toBe(2);
    expect(err.join("")).toContain("unknown command: frobnicate");
  });

  it("escapes a control character in a command name rather than writing it to the terminal", () => {
    const { io, err } = capture();

    expect(run(["\u001b[2Jfrobnicate"], io)).toBe(2);
    expect(err.join("")).toBe("tasma: unknown command: \\u001b[2Jfrobnicate\nRun 'tasma --help' for usage.\n");
  });

  // The parser embeds the offending token in its own message, so that path
  // needs the same escaping.
  it("escapes a control character the parser quotes back", () => {
    const { io, err } = capture();

    expect(run(["--no\u001bpe"], io)).toBe(2);
    expect(err.join("")).toContain("\\u001b");
    expect(err.join("")).not.toContain("\u001b");
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
  it("runs the named command with the arguments after it and returns its code", () => {
    const { io } = capture();
    const seen: string[][] = [];
    const commands: Command[] = [
      {
        name: "list",
        summary: "List the tasks",
        run: (args) => {
          seen.push(args);
          return 1;
        },
      },
    ];

    expect(dispatch(commands, "list", ["--json"], io)).toBe(1);
    expect(seen).toEqual([["--json"]]);
  });

  it("reports a name the registry does not hold", () => {
    const { io, err } = capture();

    expect(dispatch([], "list", [], io)).toBe(2);
    expect(err.join("")).toBe("tasma: unknown command: list\nRun 'tasma --help' for usage.\n");
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
