import type { Health, Success } from "@tasma/protocol";
import manifest from "../../../../package.json" with { type: "json" };

/** The liveness answer, whose version is the release version of the root manifest. */
export function readHealth(): Promise<Success<Health>> {
  return Promise.resolve({ data: { name: "tasma-daemon", version: manifest.version }, diagnostics: [] });
}
