import { describe, expect, it, vi } from "vitest";
import { updateUserConfig } from "@tasma/engine";
import { read, tempRoot, userConfig } from "./helpers.js";

// A read of a project file raises a store refusal or a fault of the file system
// alone, so a fault of any other kind is injected.
vi.mock("../../src/store/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/store/config.js")>();
  return {
    ...actual,
    readDeclared: (path: string, level: "user" | "project") => {
      if (level === "project") throw new Error("the reader gave up");
      return actual.readDeclared(path, level);
    },
  };
});

describe("a fault of a project read that is no refusal", () => {
  it("reaches the caller, and the user's file is not written", async () => {
    const root = await tempRoot();

    await expect(updateUserConfig(root, { priorities: ["urgent"] })).rejects.toThrow("the reader gave up");
    await expect(read(userConfig(root))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
