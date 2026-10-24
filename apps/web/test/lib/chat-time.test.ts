import { afterEach, describe, expect, it, vi } from "vitest";
import { fullChatTime, shortChatTime } from "../../src/lib/chat-time";

afterEach(() => {
  vi.unstubAllEnvs();
});

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);

function before(milliseconds: number): string {
  return new Date(NOW - milliseconds).toISOString();
}

/** 10:00 UTC of the day. */
function utcDay(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month, day, 10)).toISOString();
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("shortChatTime", () => {
  it.each<[string, number, string]>([
    ["no time", 0, "now"],
    ["59 seconds", 59 * SECOND, "now"],
    ["1 minute", MINUTE, "1m"],
    ["59 minutes and 59 seconds", HOUR - SECOND, "59m"],
    ["1 hour", HOUR, "1h"],
    ["23 hours and 59 minutes", DAY - MINUTE, "23h"],
    ["1 day", DAY, "1d"],
    ["6 days and 23 hours", 7 * DAY - HOUR, "6d"],
  ])("gives %s ago as %s", (_name, ago, text) => {
    expect(shortChatTime(before(ago), NOW)).toBe(text);
  });

  it("gives a time after now as now", () => {
    expect(shortChatTime(before(-5 * MINUTE), NOW)).toBe("now");
  });

  it("gives 7 days ago and older as the day and the month in the year of now", () => {
    vi.stubEnv("TZ", "UTC");

    expect(shortChatTime(before(7 * DAY), NOW)).toBe("15 Oct");
    expect(shortChatTime("2026-01-01T00:00:00.000Z", NOW)).toBe("1 Jan");
  });

  it("adds the year to a time of another year", () => {
    vi.stubEnv("TZ", "UTC");

    expect(shortChatTime("2025-12-31T23:59:00.000Z", NOW)).toBe("31 Dec 2025");
    expect(shortChatTime("2025-03-12T08:00:00.000Z", NOW)).toBe("12 Mar 2025");
  });

  it("reads the day and the year in the time zone of the browser", () => {
    const created = "2025-12-31T20:00:00.000Z";
    const now = Date.UTC(2026, 0, 10, 12, 0, 0);

    vi.stubEnv("TZ", "Asia/Tokyo");
    expect(shortChatTime(created, now)).toBe("1 Jan");

    vi.stubEnv("TZ", "America/New_York");
    expect(shortChatTime(created, now)).toBe("31 Dec 2025");
  });

  it("gives each month its fixed English name", () => {
    vi.stubEnv("TZ", "UTC");
    const months = Array.from({ length: 12 }, (_, month) => shortChatTime(utcDay(2024, month, 3), NOW));

    expect(months).toEqual([
      "3 Jan 2024",
      "3 Feb 2024",
      "3 Mar 2024",
      "3 Apr 2024",
      "3 May 2024",
      "3 Jun 2024",
      "3 Jul 2024",
      "3 Aug 2024",
      "3 Sep 2024",
      "3 Oct 2024",
      "3 Nov 2024",
      "3 Dec 2024",
    ]);
  });
});

describe("fullChatTime", () => {
  it("gives the day, the month name, the year and the 24-hour time", () => {
    vi.stubEnv("TZ", "UTC");

    expect(fullChatTime("2026-10-22T14:05:00.000Z")).toBe("22 October 2026 14:05");
    expect(fullChatTime("2026-03-01T09:07:00.000Z")).toBe("1 March 2026 09:07");
    expect(fullChatTime("2026-01-05T00:00:00.000Z")).toBe("5 January 2026 00:00");
  });

  it("reads the time in the time zone of the browser", () => {
    vi.stubEnv("TZ", "Asia/Tokyo");
    expect(fullChatTime("2026-12-31T20:30:00.000Z")).toBe("1 January 2027 05:30");

    vi.stubEnv("TZ", "America/New_York");
    expect(fullChatTime("2026-12-31T20:30:00.000Z")).toBe("31 December 2026 15:30");
  });

  it("gives each month its fixed English name", () => {
    vi.stubEnv("TZ", "UTC");
    const months = Array.from({ length: 12 }, (_, month) => fullChatTime(utcDay(2026, month, 3)));

    expect(months.map((text) => text.split(" ")[1])).toEqual([
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ]);
  });
});
