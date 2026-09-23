import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import { expandRoot, TAG_RULE } from "@tasma/engine";
import { DAEMON_NAME, DAEMON_RECORD_FILE, DEFAULT_DAEMON_PORT } from "@tasma/protocol";
import { resolveConfig } from "vite";
import { describe, expect, it } from "vitest";
import { PROBE_BODY_LIMIT, PROBE_TIMEOUT_MS } from "../apps/cli/src/daemon/record.js";
import { DAEMON_BIN, START_BUDGET_MS, TICK_MS } from "../apps/cli/src/daemon/start.js";
import { DAEMON_PATH_PREFIX } from "../apps/web/src/api/paths.js";
import { readManifest, workspaceRoot } from "../workspace.js";

/** The crate's location, as the root scripts have to spell it. */
const CRATE_DIRECTORY = "apps/macos";

const CRATE = join(workspaceRoot, CRATE_DIRECTORY);

/**
 * What a `const` in the crate is set to, with the quotes of a string literal
 * dropped.
 *
 * The shell is Rust, so it cannot import the packages that declare the daemon's
 * address, its record and the prefix the renderer writes: it restates each as a
 * literal. Reading them back is what holds the two sides together, so a change
 * on the TypeScript side fails here rather than at runtime in a window.
 */
function rustConstant(file: string, name: string): string {
  const source = readFileSync(join(CRATE, "src", file), "utf8");
  const [, stated] = new RegExp(String.raw`(?:pub )?const ${name}: [^=]+= ([^;]+);`).exec(source) ?? [];

  if (stated === undefined) {
    throw new Error(`apps/macos/src/${file} states no ${name}`);
  }

  return stated.trim().replaceAll('"', "");
}

/** What a `Duration` the crate states comes to in milliseconds. */
function rustDuration(file: string, name: string): number {
  const stated = rustConstant(file, name);
  const [, unit, amount] = /^Duration::from_(secs|millis)\((\d+)\)$/.exec(stated) ?? [];

  if (amount === undefined) {
    throw new Error(`apps/macos/src/${file} states ${name} as ${stated}, which is no plain Duration`);
  }

  return unit === "secs" ? Number(amount) * 1000 : Number(amount);
}

/** What a size the crate states comes to, written there as a product of literals. */
function rustSize(file: string, name: string): number {
  const factors = rustConstant(file, name)
    .split("*")
    .map((factor) => Number(factor.trim()));

  if (factors.some(Number.isNaN)) {
    throw new Error(`apps/macos/src/${file} states ${name} as no product of literals`);
  }

  return factors.reduce((product, factor) => product * factor, 1);
}

/** The bounds of an inclusive range the crate states, written there as two literals. */
function rustRange(file: string, name: string): [number, number] {
  const stated = rustConstant(file, name);
  const [, low, high] = /^(\d+)\.\.=(\d+)$/.exec(stated) ?? [];

  if (low === undefined || high === undefined) {
    throw new Error(`apps/macos/src/${file} states ${name} as ${stated}, which is no inclusive range of literals`);
  }

  return [Number(low), Number(high)];
}

/** The text of a raw string literal the crate states. */
function rustRawString(file: string, name: string): string {
  const source = readFileSync(join(CRATE, "src", file), "utf8");
  const [, stated] = new RegExp(String.raw`const ${name}: &str = r#"([\s\S]*?)"#;`).exec(source) ?? [];

  if (stated === undefined) {
    throw new Error(`apps/macos/src/${file} states no raw string ${name}`);
  }

  return stated;
}

const config = JSON.parse(readFileSync(join(CRATE, "tauri.conf.json"), "utf8")) as {
  build: { devUrl: string };
  bundle: { externalBin: string[] };
};

/** The script that compiles the daemon and the CLI into the executables the app ships. */
const APP_BINARIES_SCRIPT = "scripts/app-binaries.sh";

const appBinariesScript = readFileSync(join(workspaceRoot, APP_BINARIES_SCRIPT), "utf8");

/** The outputs the script's `compile` call sites write, in order. */
const compiledOutputs = [...appBinariesScript.matchAll(/^compile \S+ "([^"]+)"$/gm)].map(([, output = ""]) => output);

/** The CLI's file in the bundle. `tasma` would be the app's own `Tasma` on a case-insensitive disk. */
const CLI_EXECUTABLE = "tasma-cli";

describe("the macOS shell", () => {
  it("dials the port the daemon binds", () => {
    expect(rustConstant("record.rs", "DEFAULT_PORT")).toBe(String(DEFAULT_DAEMON_PORT));
  });

  it("reads the record the daemon writes", () => {
    expect(rustConstant("record.rs", "RECORD")).toBe(DAEMON_RECORD_FILE);
  });

  // The engine's own root rather than a name repeated here: the tree the shell
  // looks in has to be the tree the daemon wrote its record into.
  it("looks in the tree the engine stores under", () => {
    expect(rustConstant("record.rs", "TREE")).toBe(basename(expandRoot()));
  });

  it("forwards the prefix the renderer writes", () => {
    expect(rustConstant("protocol.rs", "PREFIX")).toBe(DAEMON_PATH_PREFIX);
  });

  // macOS hands the application a link only under a scheme the bundle declares.
  it("declares the scheme it reads a link under", () => {
    const plist = readFileSync(join(CRATE, "Info.plist"), "utf8");
    const [, declared = ""] = /<key>CFBundleURLSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist) ?? [];
    const schemes = [...declared.matchAll(/<string>([^<]*)<\/string>/g)].map(([, scheme]) => scheme);

    expect(schemes).toEqual([rustConstant("main.rs", "LINK_SCHEME")]);
  });

  it("reads the tag of a link under the length a project is created under", () => {
    const [shortest, longest] = rustRange("deeplink.rs", "TAG_LENGTH");

    expect(TAG_RULE.test("A".repeat(shortest))).toBe(true);
    expect(TAG_RULE.test("A".repeat(shortest - 1))).toBe(false);
    expect(TAG_RULE.test("A".repeat(longest))).toBe(true);
    expect(TAG_RULE.test("A".repeat(longest + 1))).toBe(false);
  });

  it("reads the tag of a link under the alphabet a project is created under", () => {
    const [shortest] = rustRange("deeplink.rs", "TAG_LENGTH");
    const rest = (character: string) => character.repeat(shortest - 1);

    expect(TAG_RULE.test(`A${rest("1")}`)).toBe(true);
    expect(TAG_RULE.test(`1${rest("A")}`)).toBe(false);
    expect(TAG_RULE.test(`a${rest("A")}`)).toBe(false);
    expect(TAG_RULE.test(`${rest("A")}a`)).toBe(false);
    expect(TAG_RULE.test(`${rest("A")}_`)).toBe(false);
    expect(TAG_RULE.test(`${rest("A")}À`)).toBe(false);
  });

  it("moves the board to the route the board declares for a task", () => {
    const routes = readFileSync(join(workspaceRoot, "apps", "web", "src", "routes.tsx"), "utf8");

    expect(routes).toContain(`path: "${rustConstant("deeplink.rs", "TASK_ROUTE")}"`);
  });

  // The Tauri CLI probes this address and the window opens it, so a dev server
  // that moved would leave the app waiting on a port nothing binds. The literal
  // rather than localhost, for the reason @tasma/protocol states.
  it("opens the dev server where apps/web serves it", async () => {
    const web = await resolveConfig({ root: join(workspaceRoot, "apps", "web"), logLevel: "silent" }, "serve");

    expect(config.build.devUrl).toBe(`http://127.0.0.1:${web.server.port}`);
  });
});

/** A link's route, as `route()` in `deeplink.rs` writes it. */
const LINKED_ROUTE = "/tasks/SAGA/SAGA-1";

type Board = {
  /** What the script did to the document, in order. */
  calls: string[];
  /** Mutates the document, with the board's `<main>` in it or not. */
  mutate: (mounted: boolean) => void;
  /** Runs every timer the script has set. */
  elapse: () => void;
  /** How many observers and timers the script still holds. */
  held: () => number;
};

/**
 * Runs the script a link runs, against a document that holds only what the
 * script reads: `<main>`, the element with focus, the address and its history.
 */
function openLink({ mounted = true, hash = "#/", focusOnMain = false } = {}): Board {
  const calls: string[] = [];
  const body = {};
  const main = {
    blur: () => {
      calls.push("blur");
      document.activeElement = body;
    },
  };
  let present = mounted;
  const document = {
    activeElement: focusOnMain ? main : body,
    querySelector: (selector: string) => (selector === "main" && present ? main : null),
  };
  const location = { hash };
  const history = {
    pushState: (_state: unknown, _unused: string, url: string) => {
      calls.push(`push ${url}`);
      location.hash = url;
    },
  };
  const observers = new Set<() => void>();
  const timers = new Map<number, () => void>();
  let timersSet = 0;

  class MutationObserver {
    readonly #callback: () => void;

    constructor(callback: () => void) {
      this.#callback = callback;
    }

    observe(): void {
      observers.add(this.#callback);
    }

    disconnect(): void {
      observers.delete(this.#callback);
    }
  }

  const setTimeout = (callback: () => void) => {
    timersSet += 1;
    timers.set(timersSet, callback);

    return timersSet;
  };
  const clearTimeout = (id: number) => timers.delete(id);

  runInNewContext(`(${rustRawString("deeplink.rs", "OPEN_ROUTE")})(${JSON.stringify(LINKED_ROUTE)})`, {
    document,
    location,
    history,
    MutationObserver,
    setTimeout,
    clearTimeout,
  });

  return {
    calls,
    mutate: (mountedNow) => {
      present = mountedNow;
      [...observers].forEach((callback) => callback());
    },
    elapse: () => [...timers.values()].forEach((callback) => callback()),
    held: () => observers.size + timers.size,
  };
}

describe("the script a link runs in the board", () => {
  const pushed = `push #${LINKED_ROUTE}`;

  it("moves a board that has mounted at once", () => {
    const board = openLink();

    expect(board.calls).toEqual([pushed]);
    expect(board.held()).toBe(0);
  });

  it("waits for the board to mount before it moves it", () => {
    const board = openLink({ mounted: false });

    expect(board.calls).toEqual([]);

    board.mutate(false);

    expect(board.calls).toEqual([]);

    board.mutate(true);
    board.mutate(true);

    expect(board.calls).toEqual([pushed]);
    expect(board.held()).toBe(0);
  });

  it("moves a board that never mounts once the wait runs out", () => {
    const board = openLink({ mounted: false });

    board.elapse();

    expect(board.calls).toEqual([pushed]);
    expect(board.held()).toBe(0);
  });

  it("takes focus off <main> before it moves the board", () => {
    const board = openLink({ hash: "#/tasks/SAGA/SAGA-2", focusOnMain: true });

    expect(board.calls).toEqual(["blur", pushed]);
  });

  it("leaves focus on <main> when the board already shows the route", () => {
    expect(openLink({ hash: `#${LINKED_ROUTE}`, focusOnMain: true }).calls).toEqual([pushed]);
    expect(openLink({ hash: `#${LINKED_ROUTE}?projects=SAGA`, focusOnMain: true }).calls).toEqual([pushed]);
  });

  it("leaves focus that is not on <main> where it is", () => {
    expect(openLink({ hash: "#/tasks/SAGA/SAGA-2" }).calls).toEqual([pushed]);
  });
});

describe("the macOS commands", () => {
  const scripts = readManifest(".").scripts ?? {};

  // The crate carries no package.json, so `pnpm test` never reaches it and
  // these are the only way it is built and run.
  it("name the crate's own manifest", () => {
    for (const name of ["app:start", "app:test"]) {
      expect(scripts[name], `${name} must name the crate manifest`).toContain(`${CRATE_DIRECTORY}/Cargo.toml`);
    }
  });

  // The Tauri CLI accepts no --manifest-path and cargo accepts no
  // TAURI_APP_PATH, so the crate's location is spelled two ways and both are
  // read back here.
  it("point the Tauri CLI at the crate", () => {
    for (const name of ["app:dev", "app:build"]) {
      expect(scripts[name], `${name} must name the crate`).toContain(`TAURI_APP_PATH=${CRATE_DIRECTORY}`);
    }
  });

  // Unset, the window opens the custom scheme instead, and a development run
  // would serve a bundle the dev server is meant to be serving.
  it("set the flag a development run opens the dev server by", () => {
    expect(scripts["app:dev"]).toContain(`${rustConstant("main.rs", "DEV_SERVER")}=1`);
  });

  // Tauri reads dev mode from the feature and not from the build profile: a run
  // that serves the bundle without it embeds no assets at all.
  it("pass the feature that embeds the bundle when they serve it", () => {
    expect(scripts["app:start"]).toContain("--features custom-protocol");
  });

  // With the feature the context macro embeds apps/web/dist, which no clone
  // carries: the tests mock their own bundle and need none.
  it("leave the feature off the tests, which need no built bundle", () => {
    expect(scripts["app:test"]).not.toContain("custom-protocol");
  });

  // Rather than the Tauri CLI, which always runs beforeDevCommand and then
  // probes devUrl: a second dev server cannot bind 8276 under strictPort, so the
  // probe passes against the first one and the window opens that.
  it("build the bundle themselves rather than through the Tauri CLI", () => {
    expect(scripts["app:start"]).toContain("--filter @tasma/web build");
    expect(scripts["app:start"]).toContain("cargo run");
  });

  // tauri_build refuses a declared external binary that is absent, so without
  // the compiled binaries the crate does not build at all — `cargo test` included.
  // Before, not merely inside: the script placed after cargo or the Tauri CLI
  // would run once the build it feeds has already failed.
  it("compile the daemon and the CLI before anything that builds the crate", () => {
    for (const name of ["app:dev", "app:start", "app:test", "app:build"]) {
      const command = scripts[name] ?? "";
      const builds = /\b(?:cargo|tauri)\b/.exec(command)?.index ?? -1;

      expect(command, `${name} must compile the binaries`).toContain(APP_BINARIES_SCRIPT);
      expect(builds, `${name} must build the crate`).toBeGreaterThan(-1);
      expect(command.indexOf(APP_BINARIES_SCRIPT), `${name} must compile the binaries first`).toBeLessThan(builds);
    }
  });
});

describe("the daemon the app ships", () => {
  const name = rustConstant("supervisor.rs", "DAEMON_EXECUTABLE");

  // Tauri appends the target triple to what the configuration names and strips
  // it again when it places the file, so the name is spelled in four places
  // and a mismatch bundles cleanly and then finds no daemon at runtime.
  it("carries one name through the build, the bundle, the supervisor and the CLI", () => {
    expect(config.bundle.externalBin).toContain(`binaries/${name}`);
    expect(compiledOutputs).toContain(`${CRATE_DIRECTORY}/binaries/${name}-$triple`);
    expect(DAEMON_BIN).toBe(name);
  });

  it("is told from anything else holding the port by the name it answers with", () => {
    expect(rustConstant("supervisor.rs", "HEALTH_NAME")).toBe(DAEMON_NAME);
  });

  // The supervisor waits on a daemon the way `tasma daemon start` does, and
  // restates each budget as a literal of its own.
  it("is probed and waited for on the budgets the CLI holds", () => {
    expect(rustDuration("supervisor.rs", "PROBE_TIMEOUT")).toBe(PROBE_TIMEOUT_MS);
    expect(rustSize("supervisor.rs", "PROBE_LIMIT")).toBe(PROBE_BODY_LIMIT);
    expect(rustDuration("supervisor.rs", "READY_BUDGET")).toBe(START_BUDGET_MS);
    expect(rustDuration("supervisor.rs", "TICK")).toBe(TICK_MS);
  });

  // The script's own header holds why.
  it("compiles to a scratch file that differs from the output by directory alone", () => {
    const [, directory] = /^\s*scratch="([^"$]+)\/\$\(basename "\$2"\)"$/m.exec(appBinariesScript) ?? [];

    if (directory === undefined) {
      throw new Error(`${APP_BINARIES_SCRIPT} derives no scratch file from the output's name`);
    }

    expect(compiledOutputs).not.toEqual([]);

    for (const output of compiledOutputs) {
      expect(directory, output).not.toBe(dirname(output));
    }
  });

  // The script's own comment holds why.
  it("compiles executables that read no bunfig.toml or .env from the working directory", () => {
    const builds = [...appBinariesScript.matchAll(/^\s*bun build .*$/gm)].map(([line]) => line);

    expect(builds).toHaveLength(1);
    expect(builds[0]).toContain("--no-compile-autoload-bunfig");
    expect(builds[0]).toContain("--no-compile-autoload-dotenv");
  });

  // The repository invokes its scripts by path, never through an interpreter.
  it("is compiled by a script that is executable", () => {
    expect(statSync(join(workspaceRoot, APP_BINARIES_SCRIPT)).mode & 0o111).toBeGreaterThan(0);
  });
});

describe("the CLI the app ships", () => {
  it("is compiled to the name the bundle declares", () => {
    expect(config.bundle.externalBin).toContain(`binaries/${CLI_EXECUTABLE}`);
    expect(compiledOutputs).toContain(`${CRATE_DIRECTORY}/binaries/${CLI_EXECUTABLE}-$triple`);
  });
});
