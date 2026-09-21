import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { expandRoot } from "@tasma/engine";
import { DAEMON_NAME, DAEMON_RECORD_FILE, DEFAULT_DAEMON_PORT } from "@tasma/protocol";
import { resolveConfig } from "vite";
import { describe, expect, it } from "vitest";
import { PROBE_BODY_LIMIT, PROBE_TIMEOUT_MS } from "../apps/cli/src/daemon/record.js";
import { START_BUDGET_MS, TICK_MS } from "../apps/cli/src/daemon/start.js";
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

const config = JSON.parse(readFileSync(join(CRATE, "tauri.conf.json"), "utf8")) as {
  build: { devUrl: string };
  bundle: { externalBin: string[] };
};

/** The script that compiles the daemon into the executable the app ships. */
const DAEMON_BINARY_SCRIPT = "scripts/daemon-binary.sh";

const daemonBinaryScript = readFileSync(join(workspaceRoot, DAEMON_BINARY_SCRIPT), "utf8");

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

  // The Tauri CLI probes this address and the window opens it, so a dev server
  // that moved would leave the app waiting on a port nothing binds. The literal
  // rather than localhost, for the reason @tasma/protocol states.
  it("opens the dev server where apps/web serves it", async () => {
    const web = await resolveConfig({ root: join(workspaceRoot, "apps", "web"), logLevel: "silent" }, "serve");

    expect(config.build.devUrl).toBe(`http://127.0.0.1:${web.server.port}`);
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
    expect(scripts["app:dev"]).toContain(`TAURI_APP_PATH=${CRATE_DIRECTORY}`);
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
  // the compiled daemon the crate does not build at all — `cargo test` included.
  // Before, not merely inside: the script placed after cargo or the Tauri CLI
  // would run once the build it feeds has already failed.
  it("compile the daemon before anything that builds the crate", () => {
    for (const name of ["app:dev", "app:start", "app:test"]) {
      const command = scripts[name] ?? "";
      const builds = /\b(?:cargo|tauri)\b/.exec(command)?.index ?? -1;

      expect(command, `${name} must compile the daemon`).toContain(DAEMON_BINARY_SCRIPT);
      expect(builds, `${name} must build the crate`).toBeGreaterThan(-1);
      expect(command.indexOf(DAEMON_BINARY_SCRIPT), `${name} must compile the daemon first`).toBeLessThan(builds);
    }
  });
});

describe("the daemon the app ships", () => {
  const name = rustConstant("supervisor.rs", "DAEMON_EXECUTABLE");

  // Tauri appends the target triple to what the configuration names and strips
  // it again when it places the file, so the name is spelled in three places
  // and a mismatch bundles cleanly and then finds no daemon at runtime.
  it("carries one name through the build, the bundle and the supervisor", () => {
    expect(config.bundle.externalBin).toContain(`binaries/${name}`);
    expect(daemonBinaryScript).toContain(`${CRATE_DIRECTORY}/binaries/${name}-$triple`);
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
    const shellVariable = (variable: string) => {
      const [, stated] = new RegExp(String.raw`^${variable}="([^"]+)"$`, "m").exec(daemonBinaryScript) ?? [];

      if (stated === undefined) {
        throw new Error(`${DAEMON_BINARY_SCRIPT} states no ${variable}`);
      }

      return stated;
    };
    const [out, scratch] = [shellVariable("out"), shellVariable("scratch")];

    expect(basename(scratch), "the scratch file must share the output's name").toBe(basename(out));
    expect(dirname(scratch)).not.toBe(dirname(out));
  });

  // The repository invokes its scripts by path, never through an interpreter.
  it("is compiled by a script that is executable", () => {
    expect(statSync(join(workspaceRoot, DAEMON_BINARY_SCRIPT)).mode & 0o111).toBeGreaterThan(0);
  });
});
