import { expect, it } from "vitest";
import { warningCount } from "../../src/lib/warning-count";

it.each([
  { count: 1, said: "1 warning" },
  { count: 2, said: "2 warnings" },
  { count: 12, said: "12 warnings" },
])("says $said for $count", ({ count, said }) => {
  expect(warningCount(count)).toBe(said);
});
