import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const PACKAGE = "@assistant-ui/react";
export const PACKUMENT_URL = `https://registry.npmjs.org/${PACKAGE}`;
export const STABLE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

const SOURCE_REPOSITORY = "assistant-ui/assistant-ui";
const SLSA_PROVENANCE = "https://slsa.dev/provenance/v1";
const RELEASE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const COMMIT = /^[0-9a-f]{40}$/;

/** The fields of the npm packument that the selection reads. */
export type Packument = {
  time: Readonly<Record<string, string>>;
  versions: Readonly<Record<string, { deprecated?: string }>>;
};

function compareStable(left: string, right: string): number {
  const a = STABLE_VERSION.exec(left)!.slice(1).map(Number);
  const b = STABLE_VERSION.exec(right)!.slice(1).map(Number);
  return a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
}

/**
 * Why `version` cannot be built: it is not listed, it is deprecated, or it is
 * less than 7 days old. The `time` map also keeps the versions that were
 * unpublished, so only `versions` lists a release.
 */
function refusal(packument: Packument, now: number, version: string): string | undefined {
  if (!Object.hasOwn(packument.versions, version)) return `${PACKAGE} has no release ${version}`;
  const deprecated = packument.versions[version]?.deprecated;
  if (deprecated) return `${PACKAGE} ${version} is deprecated: ${deprecated}`;
  const published = packument.time[version];
  if (published === undefined) return `${PACKAGE} ${version} has no publish time`;
  if (now - Date.parse(published) < RELEASE_AGE_MS) return `${PACKAGE} ${version} is less than 7 days old`;
  return undefined;
}

/** `version`, when it is a listed release that is not deprecated and is 7 or more days old. */
export function acceptRelease(packument: Packument, now: number, version: string): string {
  const reason = refusal(packument, now, version);
  if (reason !== undefined) throw new Error(reason);
  return version;
}

/** The highest stable version that `acceptRelease` accepts, or `requested` when it accepts that one. */
export function selectRelease(packument: Packument, now: number, requested?: string): string {
  if (requested !== undefined) {
    if (!STABLE_VERSION.test(requested)) throw new Error(`--release takes a stable version, not ${requested}`);
    return acceptRelease(packument, now, requested);
  }

  const candidates = Object.keys(packument.versions)
    .filter((version) => STABLE_VERSION.test(version) && refusal(packument, now, version) === undefined);
  if (candidates.length === 0) {
    throw new Error(`no release of ${PACKAGE} is 7 or more days old`);
  }
  return candidates.reduce((highest, version) => (compareStable(version, highest) > 0 ? version : highest));
}

export function attestationsUrl(version: string): string {
  return `https://registry.npmjs.org/-/npm/v1/attestations/${PACKAGE.replace("/", "%2f")}@${version}`;
}

export function archiveUrl(commit: string): string {
  return `https://codeload.github.com/${SOURCE_REPOSITORY}/tar.gz/${commit}`;
}

type Attestation = { predicateType?: string; bundle?: { dsseEnvelope?: { payload?: string } } };

type Provenance = {
  predicate?: { buildDefinition?: { resolvedDependencies?: { uri?: string; digest?: { gitCommit?: string } }[] } };
};

/**
 * The commit that the npm provenance of the release names as its source, from
 * the attestations answer of the registry. A git tag can move after the
 * release; the commit cannot, so the 7-day rule covers the code built from it.
 */
export function sourceCommit(answer: unknown, version: string): string {
  const attestations = (answer as { attestations?: Attestation[] } | null)?.attestations ?? [];
  const payload = attestations
    .find(({ predicateType }) => predicateType === SLSA_PROVENANCE)?.bundle?.dsseEnvelope?.payload;
  const provenance = payload === undefined
    ? undefined
    : JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as Provenance;
  const commit = provenance?.predicate?.buildDefinition?.resolvedDependencies
    ?.find(({ uri }) => uri?.startsWith(`git+https://github.com/${SOURCE_REPOSITORY}@`))?.digest?.gitCommit;

  if (commit === undefined || !COMMIT.test(commit)) {
    throw new Error(`the npm provenance of ${PACKAGE} ${version} names no commit of ${SOURCE_REPOSITORY}`);
  }
  return commit;
}

/**
 * The names of the packages that the source repository releases: the public
 * packages under packages/. The registry build pins a dependency on each of
 * them to a caret range of its version, and on no other package.
 */
export function releasedPackages(repo: string): Set<string> {
  const packages = join(repo, "packages");
  return new Set(readdirSync(packages).flatMap((dir) => {
    const path = join(packages, dir, "package.json");
    if (!existsSync(path)) return [];
    const manifest = JSON.parse(readFileSync(path, "utf8")) as { name: string; private?: boolean };
    return manifest.private === true ? [] : [manifest.name];
  }));
}
