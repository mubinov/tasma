import { homedir, tmpdir, userInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { expandRoot } from "@tasma/engine";

describe("the test home", () => {
  it("stands under the temporary directory", () => {
    expect(homedir().startsWith(tmpdir())).toBe(true);
  });

  // userInfo reads the passwd entry, which no environment variable moves, so a
  // redirect that failed would show up as these two agreeing.
  it("is not the real home directory", () => {
    expect(homedir()).not.toBe(userInfo().homedir);
  });

  // The assertion that matters: this is the function every store path is built
  // on, so a test that stubs nothing writes here.
  it("is where the engine puts its tree", () => {
    expect(expandRoot().startsWith(tmpdir())).toBe(true);
  });
});
