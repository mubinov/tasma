import { expect, it } from "vitest";
// Relative: this package declares no exports, so its own name does not resolve.
import { daemonName } from "../src/index.js";

it("runs a TypeScript test through vitest", () => {
  expect(daemonName()).toBe("@tasma/daemon");
});
