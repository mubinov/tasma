import { describe, expect, it } from "vitest";
import { formatStamp } from "../../src/lib/task-page";

describe("formatStamp", () => {
  it("writes the date and the minute in the local time zone", () => {
    const local = new Date(2026, 8, 13, 16, 42, 59);

    expect(formatStamp(local.toISOString())).toBe("2026-09-13 16:42");
  });

  it("pads a month, a day, an hour and a minute of one digit", () => {
    const local = new Date(2026, 0, 5, 7, 3);

    expect(formatStamp(local.toISOString())).toBe("2026-01-05 07:03");
  });

  it.each([{ value: "" }, { value: "yesterday" }, { value: "2026-13-45T99:00:00Z" }])(
    "returns \"$value\" as written, since it is no date",
    ({ value }) => {
      expect(formatStamp(value)).toBe(value);
    },
  );
});
