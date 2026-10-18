import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { onTestFinished } from "vitest";

export const NOW = Date.parse("2030-06-15T12:00:00.000Z");
export const DAY_MS = 24 * 60 * 60 * 1000;

/** The time `days` days and `minutes` minutes before `NOW`, as the npm registry writes it. */
export const before = (days: number, minutes = 0) => new Date(NOW - days * DAY_MS + minutes * 60_000).toISOString();

/** A new empty folder that is removed when the test ends. */
export function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-update-test-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

export function put(root: string, file: string, text: string): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}

const envelope = (statement: unknown) => ({
  dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64") },
});

/** The attestations answer of the npm registry, with an SLSA provenance that names `dependencies` as its sources. */
export function attestationsAnswer(dependencies: readonly unknown[]) {
  return {
    attestations: [
      {
        predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
        bundle: envelope({ predicate: { name: "@assistant-ui/react" } }),
      },
      {
        predicateType: "https://slsa.dev/provenance/v1",
        bundle: envelope({ predicate: { buildDefinition: { resolvedDependencies: dependencies } } }),
      },
    ],
  };
}

/** The source of a release in the assistant-ui repository, as its provenance names it. */
export function sourceDependency(commit: string) {
  return { uri: "git+https://github.com/assistant-ui/assistant-ui@refs/heads/main", digest: { gitCommit: commit } };
}
