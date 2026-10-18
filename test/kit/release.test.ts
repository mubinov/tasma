import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acceptRelease,
  archiveUrl,
  attestationsUrl,
  releasedPackages,
  selectRelease,
  sourceCommit,
  type Packument,
} from "../../scripts/kit/release.ts";
import { attestationsAnswer, before, NOW, put, scratch, sourceDependency } from "./helpers.ts";

/** A packument that lists each version of `time` that is a version, with the deprecation of `deprecated`. */
function packument(time: Record<string, string>, deprecated: Record<string, string> = {}): Packument {
  const versions = Object.keys(time)
    .filter((key) => key !== "created" && key !== "modified")
    .map((version) => [version, version in deprecated ? { deprecated: deprecated[version] } : {}] as const);
  return { time, versions: Object.fromEntries(versions) };
}

describe("selectRelease", () => {
  it("selects a version that is exactly 7 days old", () => {
    expect(selectRelease(packument({ "1.0.0": before(7) }), NOW)).toBe("1.0.0");
  });

  it("does not select a version one minute younger than 7 days", () => {
    expect(selectRelease(packument({ "1.0.0": before(30), "1.1.0": before(7, 1) }), NOW)).toBe("1.0.0");
  });

  it("skips a prerelease", () => {
    expect(selectRelease(packument({ "1.0.0": before(30), "1.1.0-beta.1": before(20) }), NOW)).toBe("1.0.0");
  });

  it("selects the highest old enough version, also when a lower version was released later", () => {
    const time = { "1.2.0": before(20), "1.10.0": before(15), "1.9.9": before(10), "2.0.0": before(1) };

    expect(selectRelease(packument(time), NOW)).toBe("1.10.0");
  });

  it("compares versions that differ in the patch number alone", () => {
    expect(selectRelease(packument({ "0.15.25": before(20), "0.15.26": before(10) }), NOW)).toBe("0.15.26");
    expect(selectRelease(packument({ "0.15.9": before(20), "0.15.10": before(10) }), NOW)).toBe("0.15.10");
  });

  it("ignores the entries of the time map that are not versions", () => {
    const time = { "created": before(400), "modified": before(400), "0.1.0": before(9) };

    expect(selectRelease(packument(time), NOW)).toBe("0.1.0");
  });

  it("skips a version that the time map keeps after it was unpublished", () => {
    const listed = packument({ "1.0.0": before(30) });
    const unpublished = { ...listed, time: { ...listed.time, "1.1.0": before(20) } };

    expect(selectRelease(unpublished, NOW)).toBe("1.0.0");
    expect(() => selectRelease(unpublished, NOW, "1.1.0")).toThrow("has no release 1.1.0");
  });

  it("skips a deprecated version, and refuses it with --release", () => {
    const deprecated = packument({ "1.0.0": before(30), "1.1.0": before(20) }, { "1.1.0": "broken build" });

    expect(selectRelease(deprecated, NOW)).toBe("1.0.0");
    expect(() => selectRelease(deprecated, NOW, "1.1.0")).toThrow("1.1.0 is deprecated: broken build");
  });

  it("selects a version whose deprecation was taken back", () => {
    expect(selectRelease(packument({ "1.0.0": before(30) }, { "1.0.0": "" }), NOW)).toBe("1.0.0");
  });

  it("refuses when no version is 7 or more days old", () => {
    expect(() => selectRelease(packument({ "1.0.0": before(2) }), NOW)).toThrow("7 or more days old");
  });

  it("does not select a version that has no publish time, and refuses it with --release", () => {
    const untimed = { time: { "1.0.0": before(30) }, versions: { "1.0.0": {}, "1.1.0": {} } };

    expect(selectRelease(untimed, NOW)).toBe("1.0.0");
    expect(() => selectRelease(untimed, NOW, "1.1.0")).toThrow("1.1.0 has no publish time");
  });

  it("takes the version that --release names, also when a higher one is old enough", () => {
    expect(selectRelease(packument({ "1.0.0": before(30), "1.1.0": before(20) }), NOW, "1.0.0")).toBe("1.0.0");
  });

  it("refuses a --release version that is less than 7 days old", () => {
    expect(() => selectRelease(packument({ "1.0.0": before(7, 1) }), NOW, "1.0.0")).toThrow("less than 7 days old");
  });

  it("refuses a --release version that is not a release", () => {
    expect(() => selectRelease(packument({ "1.0.0": before(30) }), NOW, "1.0.1")).toThrow("no release 1.0.1");
  });

  it("refuses a --release value that is not a stable version", () => {
    const time = { "created": before(30), "1.1.0-beta.1": before(20) };

    expect(() => selectRelease(packument(time), NOW, "1.1.0-beta.1")).toThrow("stable version, not 1.1.0-beta.1");
    expect(() => selectRelease(packument(time), NOW, "created")).toThrow("stable version, not created");
  });
});

describe("acceptRelease", () => {
  const time = { "1.0.0": before(30), "1.1.0": before(20), "1.2.0": before(1) };
  const releases = packument(time, { "1.1.0": "broken build" });

  it("accepts a listed release that is not deprecated and is 7 or more days old", () => {
    expect(acceptRelease(releases, NOW, "1.0.0")).toBe("1.0.0");
  });

  it("refuses a release that is unlisted, deprecated or less than 7 days old", () => {
    expect(() => acceptRelease(releases, NOW, "0.9.0")).toThrow("has no release 0.9.0");
    expect(() => acceptRelease(releases, NOW, "1.1.0")).toThrow("1.1.0 is deprecated: broken build");
    expect(() => acceptRelease(releases, NOW, "1.2.0")).toThrow("1.2.0 is less than 7 days old");
  });
});

describe("the source of a release", () => {
  const commit = "d90bf230a319eb6ea285d98cda60eaad61428e8a";

  it("is the commit that the SLSA provenance names in the assistant-ui repository", () => {
    const answer = attestationsAnswer([{ uri: "git+https://github.com/acme/tools@refs/heads/main" }, sourceDependency(commit)]);

    expect(sourceCommit(answer, "0.15.26")).toBe(commit);
  });

  it("is refused when the provenance names no commit of the assistant-ui repository", () => {
    const fork = { uri: "git+https://github.com/acme/assistant-ui@refs/heads/main", digest: { gitCommit: commit } };
    const answers = [
      null,
      {},
      { attestations: [{ predicateType: "https://slsa.dev/provenance/v1" }] },
      attestationsAnswer([]),
      attestationsAnswer([fork]),
      attestationsAnswer([{ uri: sourceDependency(commit).uri }]),
      attestationsAnswer([sourceDependency("main")]),
    ];

    for (const answer of answers) {
      expect(() => sourceCommit(answer, "0.15.26"), JSON.stringify(answer))
        .toThrow("the npm provenance of @assistant-ui/react 0.15.26 names no commit");
    }
  });

  it("is read from the attestations of the version, and downloaded by its commit", () => {
    expect(attestationsUrl("0.15.26")).toBe("https://registry.npmjs.org/-/npm/v1/attestations/@assistant-ui%2freact@0.15.26");
    expect(archiveUrl(commit)).toBe(`https://codeload.github.com/assistant-ui/assistant-ui/tar.gz/${commit}`);
  });
});

describe("releasedPackages", () => {
  it("are the public packages under packages/ of the source repository", () => {
    const repo = scratch();
    put(repo, "packages/react/package.json", JSON.stringify({ name: "@assistant-ui/react", version: "0.2.3" }));
    put(repo, "packages/shimmer/package.json", JSON.stringify({ name: "tw-shimmer", version: "0.4.13" }));
    put(repo, "packages/internal/package.json", JSON.stringify({ name: "@assistant-ui/internal", private: true }));
    put(repo, "packages/README.md", "Packages.\n");
    put(repo, "apps/docs/package.json", JSON.stringify({ name: "docs", version: "1.0.0" }));
    mkdirSync(join(repo, "packages", "empty"));

    expect(releasedPackages(repo)).toEqual(new Set(["@assistant-ui/react", "tw-shimmer"]));
  });
});
