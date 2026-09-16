function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** `YYYY-MM-DD HH:mm` in the browser's time zone. A value that is no date is returned as written. */
export function formatStamp(iso: string): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  const day = `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
