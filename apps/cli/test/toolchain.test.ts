import { expect, it } from "vitest";
// Relative: this package declares no exports, so its own name does not resolve.
import { cliName } from "../src/index.js";

it("runs a TypeScript test through vitest", () => {
  expect(cliName()).toBe("@tasma/cli");
});
