import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, realpathSync } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { AgentEnv } from "../../src/agents/adapter.js";
import { isExecutableFile } from "../../src/agents/process.js";
import { readShellEnv } from "../../src/agents/shell-env.js";
import type { ShellEnv } from "../../src/agents/shell-env.js";
import { target, until } from "../helpers.js";

/** A child that the next spawn gives in place of a real one. */
const spawning = vi.hoisted(() => ({ next: undefined as ChildProcess | undefined }));

vi.mock("node:child_process", async (importActual) => {
  const actual = await importActual<typeof import("node:child_process")>();

  return {
    ...actual,
    spawn(...args: Parameters<typeof actual.spawn>) {
      const { next } = spawning;
      spawning.next = undefined;
      return next ?? actual.spawn(...args);
    },
  };
});

type FakeShell = {
  shell: string;
  /** The directory where the shell writes what it got. */
  out: string;
  /** The process id of the shell, after it started. */
  pid(): Promise<number>;
  args(): Promise<string[]>;
};

/**
 * A login shell for the tests. It writes what it got into `$out`, runs
 * `before`, runs `run` (by default its last argument, with `/bin/sh -c`), and
 * then runs `after`. `$last` holds its last argument.
 */
async function fakeShell(
  options: { name?: string; before?: string; run?: string; after?: string } = {},
): Promise<FakeShell> {
  const dir = await target();
  const out = await target();
  const shell = join(dir, options.name ?? "zsh");
  await writeFile(shell, [
    "#!/bin/sh",
    `out='${out}'`,
    'printf "%s\\0" "$@" > "$out/args"',
    'pwd -P > "$out/cwd"',
    '/usr/bin/env -0 > "$out/env"',
    'if [ ! -t 0 ] && [ -c /dev/stdin ]; then echo null > "$out/stdin"; else echo other > "$out/stdin"; fi',
    '/bin/ps -o pgid= -p $$ > "$out/pgid"',
    'echo $$ > "$out/pid"',
    "for last; do :; done",
    options.before ?? "",
    options.run ?? '/bin/sh -c "$last"',
    options.after ?? "",
    "",
  ].join("\n"));
  await chmod(shell, 0o755);
  return {
    shell,
    out,
    pid: async () => Number(await readFile(join(out, "pid"), "utf8")),
    args: async () => (await readFile(join(out, "args"), "utf8")).split("\0").slice(0, -1),
  };
}

/** The environment the shell process got. */
async function shellGot(fake: FakeShell): Promise<Record<string, string>> {
  const text = await readFile(join(fake.out, "env"), "utf8");
  return Object.fromEntries(text.split("\0").filter((entry) => entry !== "").map((entry) => {
    const at = entry.indexOf("=");
    return [entry.slice(0, at), entry.slice(at + 1)];
  }));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits until each process is gone. */
async function gone(...pids: number[]): Promise<void> {
  await until(() => !pids.some(alive), `processes ${pids.join(", ")} are gone`);
}

/** The process id of the program that `BACKGROUND` started, which the test kills at its end. */
async function childOf(fake: FakeShell): Promise<number> {
  const path = join(fake.out, "child");
  await until(() => existsSync(path), "the shell started its child");
  const pid = Number(await readFile(path, "utf8"));
  onTestFinished(() => {
    if (alive(pid)) process.kill(pid, "SIGKILL");
  });
  return pid;
}

function envOf(result: ShellEnv): AgentEnv {
  if (!("env" in result)) throw new Error(`the read failed: ${result.failed}`);
  return result.env;
}

function failedWith(shell: string, cause: string): ShellEnv {
  return { failed: `Tasma could not read the environment of your login shell (${shell}): ${cause}` };
}

/** The timeout of a test that runs several shells. The first run of each new executable is slow on macOS. */
const SHELLS_MS = 20_000;

/** The script that the shell gets as its last argument. */
const SCRIPT = /^\/bin\/echo (TASMA_ENV_[0-9a-f]{16}); \/usr\/bin\/env -0; \/bin\/echo \1$/;

/** Prints the marker of the script in `$last`, in place of the script. */
const MARKER = 'marker=${last%%;*}; printf \'%s\\n\' "${marker#/bin/echo }"';

const OUTPUT_LIMIT = 4 * 1024 * 1024;

/**
 * Prints `before` bytes and then the closing marker, with one write of `cat`:
 * NUL bytes, the opening marker, `ONE=1`, the closing marker.
 */
function inOneWrite(before: number): string {
  // The opening marker is 27 bytes, and `ONE=1` is 5.
  const noise = before - 32;
  return [
    "marker=${last%%;*}; marker=${marker#/bin/echo }",
    `{ /usr/bin/head -c ${noise} /dev/zero; printf '%s\\nONE=1\\0%s\\n' "$marker" "$marker"; } > "$out/output"`,
    '/bin/cat "$out/output"',
  ].join("\n");
}

/** Starts a program that stays, and writes its process id into `$out/child`. */
const BACKGROUND = '/bin/sleep 30 & echo $! > "$out/child"';

describe("readShellEnv", () => {
  it("gives the environment between the markers, with the output of the init files around them", async () => {
    const home = await target();
    const fake = await fakeShell({
      before: [
        "echo 'Welcome back'",
        "printf 'no newline'",
        "export CHANGED=new EQUALS='a=b' OLDPWD=/old SHLVL=3",
        'export LINES_TWO="$(printf \'one\\ntwo\')"',
      ].join("\n"),
      after: "echo 'Goodbye'",
    });
    const base = {
      PATH: "/usr/bin:/bin",
      HOME: home,
      SHELL: fake.shell,
      KEPT: "same",
      CHANGED: "old",
      DISABLE_AUTO_UPDATE: "false",
    };

    const env = envOf(await readShellEnv(base));

    expect(env).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: home,
      SHELL: fake.shell,
      KEPT: "same",
      CHANGED: "new",
      EQUALS: "a=b",
      LINES_TWO: "one\ntwo",
      DISABLE_AUTO_UPDATE: "false",
    });
  });

  it("skips an entry with no = and an entry with an empty name", async () => {
    const fake = await fakeShell({ run: `${MARKER}; printf 'GOOD=1\\0no-equals\\0=empty\\0'; ${MARKER}` });
    const home = await target();

    const env = envOf(await readShellEnv({ HOME: home, SHELL: fake.shell }));

    expect(env).toEqual({ HOME: home, SHELL: fake.shell, GOOD: "1" });
  });

  it("gives the shell the probe variables, its home as the folder, no stdin and a process group of its own", async () => {
    const home = await target();
    const fake = await fakeShell();

    await readShellEnv({ PATH: "/usr/bin:/bin", HOME: home, SHELL: fake.shell, DISABLE_AUTO_UPDATE: "false" });

    expect(await shellGot(fake)).toMatchObject({
      PATH: "/usr/bin:/bin",
      TASMA_RESOLVING_ENVIRONMENT: "1",
      DISABLE_AUTO_UPDATE: "true",
      ZSH_TMUX_AUTOSTART: "false",
      ZSH_TMUX_AUTOSTARTED: "true",
    });
    expect((await readFile(join(fake.out, "cwd"), "utf8")).trim()).toBe(realpathSync(home));
    expect((await readFile(join(fake.out, "stdin"), "utf8")).trim()).toBe("null");
    expect(Number(await readFile(join(fake.out, "pgid"), "utf8"))).toBe(await fake.pid());
  });

  it("runs the shell in the home folder of the process when the environment has no HOME", async () => {
    const fake = await fakeShell();

    envOf(await readShellEnv({ SHELL: fake.shell }));

    expect((await readFile(join(fake.out, "cwd"), "utf8")).trim()).toBe(realpathSync(homedir()));
  });

  it("gives each kind of shell its arguments, and a new marker at each read", async () => {
    const markers = new Set<string>();
    for (const [name, flags] of [
      ["fish", ["-l", "-c"]],
      ["csh", ["-i", "-c"]],
      ["tcsh", ["-i", "-c"]],
      ["pwsh", ["-Login", "-Command"]],
      ["zsh", ["-l", "-i", "-c"]],
      ["bash", ["-l", "-i", "-c"]],
    ] as const) {
      const fake = await fakeShell({ name });

      envOf(await readShellEnv({ HOME: await target(), SHELL: fake.shell }));

      const args = await fake.args();
      expect(args.slice(0, -1), name).toEqual(flags);
      const script = SCRIPT.exec(args.at(-1) ?? "");
      expect(script, name).not.toBeNull();
      markers.add(script?.[1] ?? "");
    }
    expect(markers.size).toBe(6);
  }, SHELLS_MS);

  it("is a success when the shell exits with an error after the environment", async () => {
    const fake = await fakeShell({ before: "export AFTER_FAULT=1", after: "exit 1" });

    expect(envOf(await readShellEnv({ HOME: await target(), SHELL: fake.shell })).AFTER_FAULT).toBe("1");
  });

  it("is a success each time a shell prints the environment and exits at once", async () => {
    const fake = await fakeShell({ before: "export QUICK=1", run: 'exec /bin/sh -c "$last"' });
    const home = await target();

    for (let run = 0; run < 20; run += 1) {
      expect(envOf(await readShellEnv({ HOME: home, SHELL: fake.shell })).QUICK).toBe("1");
    }
  }, SHELLS_MS);

  it("ends the read at the closing marker while a program that the shell started keeps stdout open", async () => {
    const fake = await fakeShell({ before: "export HELD=1", after: BACKGROUND });

    const result = await readShellEnv({ HOME: await target(), SHELL: fake.shell }, { timeoutMs: 3000 });

    expect(envOf(result).HELD).toBe("1");
    expect(alive(await childOf(fake))).toBe(true);
  });

  it("fails after the timeout, and kills the process group of the shell", async () => {
    const fake = await fakeShell({ run: `${BACKGROUND}; wait` });

    // Long enough for the shell to start its child, as the first run of a new executable is slow on macOS.
    const result = await readShellEnv({ HOME: await target(), SHELL: fake.shell }, { timeoutMs: 2000 });

    expect(result).toEqual(failedWith(fake.shell, "it did not finish in 2 seconds"));
    await gone(await fake.pid(), await childOf(fake));
  });

  it("fails when the shell prints more than 4 MiB before the closing marker", async () => {
    const fake = await fakeShell({ before: "/usr/bin/head -c 5242880 /dev/zero" });

    const result = await readShellEnv({ HOME: await target(), SHELL: fake.shell });

    expect(result).toEqual(failedWith(fake.shell, "it printed more than 4 MiB"));
    await gone(await fake.pid());
  });

  it("applies the 4 MiB limit to the bytes before the closing marker when the markers come in the same write", async () => {
    const home = await target();
    for (const [extra, ok] of [[0, true], [1, false]] as const) {
      const fake = await fakeShell({ run: inOneWrite(OUTPUT_LIMIT + extra) });

      const result = await readShellEnv({ HOME: home, SHELL: fake.shell });

      if (ok) expect(envOf(result).ONE).toBe("1");
      else expect(result).toEqual(failedWith(fake.shell, "it printed more than 4 MiB"));
    }
  }, SHELLS_MS);

  it("fails when the shell ends with no environment, with its exit code or its signal", async () => {
    for (const [run, cause] of [
      ["exit 3", "it printed no environment (exit code 3)"],
      ["kill -KILL $$", "it printed no environment (signal SIGKILL)"],
      [`${MARKER}; printf 'NO_CLOSE=1\\0'`, "it printed no environment (exit code 0)"],
    ] as const) {
      const fake = await fakeShell({ run });

      expect(await readShellEnv({ HOME: await target(), SHELL: fake.shell })).toEqual(failedWith(fake.shell, cause));
    }
  }, SHELLS_MS);

  it("fails at an abort with the text of a daemon stop, and kills the process group of the shell", async () => {
    const fake = await fakeShell({ run: `${BACKGROUND}; wait` });
    const abort = new AbortController();

    const reading = readShellEnv({ HOME: await target(), SHELL: fake.shell }, { signal: abort.signal });
    const child = await childOf(fake);
    abort.abort();

    expect(await reading).toEqual(failedWith(fake.shell, "the daemon is stopping"));
    await gone(await fake.pid(), child);
  });

  it("starts no shell for a signal that is already aborted", async () => {
    const fake = await fakeShell();

    const result = await readShellEnv({ HOME: await target(), SHELL: fake.shell }, { signal: AbortSignal.abort() });

    expect(result).toEqual(failedWith(fake.shell, "the daemon is stopping"));
    expect(existsSync(join(fake.out, "pid"))).toBe(false);
  });

  it("uses the shell of the user record when SHELL is missing, is not absolute or cannot run", async () => {
    const fake = await fakeShell({ before: "export FROM_RECORD=1" });
    const plain = join(await target(), "plain");
    await writeFile(plain, "#!/bin/sh\n", { mode: 0o644 });

    for (const SHELL of [undefined, "zsh", plain, await target()]) {
      const result = await readShellEnv({ HOME: await target(), SHELL }, { userShell: () => fake.shell });

      expect(envOf(result).FROM_RECORD, String(SHELL)).toBe("1");
    }
  });

  it("uses /bin/zsh when neither SHELL nor the user record names a shell that can run", async () => {
    const missing = join(await target(), "missing");
    const noRecord = () => {
      throw new Error("no such user");
    };

    for (const userShell of [() => undefined, () => null, () => "/no/such/shell", noRecord]) {
      // A HOME that does not exist makes the spawn fail, so no real shell runs.
      const result = await readShellEnv({ HOME: missing }, { userShell });

      expect(result).toEqual(failedWith("/bin/zsh", "spawn /bin/zsh ENOENT"));
    }
  });

  it("uses the login shell of the user record by default", async () => {
    let shell = "/bin/zsh";
    try {
      const record = userInfo().shell;
      if (record !== null && isAbsolute(record) && isExecutableFile(record)) shell = record;
    } catch {
      // No entry for this user id, as in a container.
    }

    const result = await readShellEnv({ HOME: join(await target(), "missing") });

    expect(result).toEqual(failedWith(shell, `spawn ${shell} ENOENT`));
  });

  it("fails with the error that a started shell emits", async () => {
    spawning.next = Object.assign(new EventEmitter(), {
      // Above the largest process id, so that a kill reaches no real process.
      pid: 99_999_999,
      stdout: new PassThrough(),
      unref: vi.fn(),
      kill: vi.fn(),
    }) as unknown as ChildProcess;
    const child = spawning.next;

    const reading = readShellEnv({ HOME: await target(), SHELL: "/bin/sh" });
    child.emit("error", new Error("kill EPERM"));

    expect(await reading).toEqual(failedWith("/bin/sh", "kill EPERM"));
  });

  it("fails when the system refuses the spawn at once", async () => {
    const fake = await fakeShell();

    const result = await readShellEnv({ HOME: await target(), SHELL: fake.shell, PAD: "x".repeat(4 * 1024 * 1024) });

    expect(result).toEqual(failedWith(fake.shell, "spawn E2BIG"));
  });
});
