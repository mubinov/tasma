import { describe, expect, it } from "vitest";
import { ofAnotherUser } from "@tasma/protocol";

describe("the owner of a health answer", () => {
  it("is the caller when the answer gives the user id of the caller", () => {
    expect(ofAnotherUser({ uid: 501 }, 501)).toBe(false);
  });

  it("is the caller when the answer gives no user id, as a daemon of an earlier version", () => {
    expect(ofAnotherUser({}, 501)).toBe(false);
  });

  it("is another user for every other value of the user id", () => {
    for (const uid of [502, 0, "501", null]) {
      expect(ofAnotherUser({ uid }, 501)).toBe(true);
    }
  });
});
