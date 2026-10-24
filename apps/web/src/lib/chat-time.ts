const MONTHS = [
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
] as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function monthName(date: Date): string {
  // getMonth() is always 0 to 11.
  return MONTHS[date.getMonth()]!;
}

/** "now", "12m", "5h", "3d", then "12 Mar", or "12 Mar 2025" in another year than `now`. */
export function shortChatTime(created: string, now: number): string {
  const date = new Date(created);
  const ago = now - date.getTime();

  if (ago < MINUTE) {
    return "now";
  }
  if (ago < HOUR) {
    return `${String(Math.floor(ago / MINUTE))}m`;
  }
  if (ago < DAY) {
    return `${String(Math.floor(ago / HOUR))}h`;
  }
  if (ago < 7 * DAY) {
    return `${String(Math.floor(ago / DAY))}d`;
  }

  const day = `${String(date.getDate())} ${monthName(date).slice(0, 3)}`;
  return date.getFullYear() === new Date(now).getFullYear() ? day : `${day} ${String(date.getFullYear())}`;
}

/** "22 October 2026 14:05". */
export function fullChatTime(created: string): string {
  const date = new Date(created);
  const time = [date.getHours(), date.getMinutes()].map((part) => String(part).padStart(2, "0")).join(":");

  return `${String(date.getDate())} ${monthName(date)} ${String(date.getFullYear())} ${time}`;
}
