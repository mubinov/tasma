import { expect, it } from "vitest";
import { protocolName } from "@tasma/protocol";

it("runs a TypeScript test through vitest", () => {
  expect(protocolName()).toBe("@tasma/protocol");
});
