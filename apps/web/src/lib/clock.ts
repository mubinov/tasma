/** `HH:MM:SS` in the browser's time zone. */
export function formatClock(time: number): string {
  const date = new Date(time);

  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
}
