import { expect, it } from "vitest";
import { engineName } from "@tasma/engine";

it("runs a TypeScript test through vitest", () => {
  expect(engineName()).toBe("@tasma/engine");
});
