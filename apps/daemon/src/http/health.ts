import type { Health, Success } from "@tasma/protocol";
import manifest from "../../package.json" with { type: "json" };

/** The liveness answer, whose version is this package's own. */
export function readHealth(): Promise<Success<Health>> {
  return Promise.resolve({ data: { name: "tasma-daemon", version: manifest.version }, diagnostics: [] });
}
