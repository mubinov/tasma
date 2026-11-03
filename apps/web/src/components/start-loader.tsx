import { useEffect, useState, type ReactNode } from "react";

const MARKS = [0, 1, 2, 3, 4, 5];

const MARK_DELAY_MS = 120;

const WORDS = "Checking the setup";

/**
 * The loading view of the whole first load. It renders in place of the shell,
 * with no `<main>`: the macOS shell holds a task link until a `<main>` mounts.
 */
export function StartLoader(): ReactNode {
  const [words, setWords] = useState("");

  // WebKit announces a status region only when its text changes after it mounts.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setWords(WORDS);
    });

    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div className="fixed inset-0 grid place-items-center bg-bg text-text">
      <div className="grid justify-items-center gap-3.5">
        <div aria-hidden="true" className="relative flex items-center gap-3.5 before:absolute before:inset-x-1.5 before:top-1/2 before:-mt-px before:h-0.5 before:bg-line">
          {MARKS.map((mark) => {
            const delay = { animationDelay: `${String(mark * MARK_DELAY_MS)}ms` };

            return (
              <span
                key={mark}
                style={delay}
                className="relative size-3 animate-step-mark rounded-full border-[1.5px] border-graphic bg-bg motion-reduce:animate-none"
              >
                <span
                  style={delay}
                  className="absolute inset-0.5 animate-step-light rounded-full bg-done opacity-0 motion-reduce:animate-none motion-reduce:opacity-35"
                />
              </span>
            );
          })}
        </div>
        <p role="status" className="min-h-5 text-sm text-subtle">{words}</p>
      </div>
    </div>
  );
}
