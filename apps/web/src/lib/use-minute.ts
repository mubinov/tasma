import { useEffect, useState } from "react";

const MINUTE = 60_000;

/** The current time, a new value each minute. */
export function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, MINUTE);
    return () => {
      clearInterval(timer);
    };
  }, []);

  return now;
}
