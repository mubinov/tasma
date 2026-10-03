import { Input } from "@base-ui/react/input";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useId, useRef, useState, type ReactNode } from "react";
import { splitList } from "../lib/board";
import { CircleNotchIcon, MagnifyingGlassIcon, XIcon } from "../lib/icons";
import { GROUP_CLASS, LABEL_CLASS } from "./control-classes";

export const SEARCH_DELAY = 300;

type SearchFieldProps = {
  /** The project the board shows. */
  tag: string;
  /** The `q` of the board's address. */
  q: string | undefined;
  /** A search request for `q` runs, and the board has no result for it yet. */
  busy: boolean;
  /** The id of the line that reports a failed search, while it shows. */
  describedBy: string | undefined;
};

/**
 * The text of the board's search. It writes `q` to the address and fetches
 * nothing: the board reads the search for `q`.
 *
 * `aria-busy` is not used for the wait: the cards stay operable during it, and
 * the attribute asks a reader to hold them back.
 */
export function SearchField({ tag, q, busy, describedBy }: SearchFieldProps): ReactNode {
  const navigate = useNavigate();
  const router = useRouter();
  const labelId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const current = q ?? "";
  const [text, setText] = useState(current);
  // Never copied into `text`: the trim of a write would take a space typed between two words.
  const [written, setWritten] = useState(current);
  // A new object on each change, so the delay starts again on each key.
  const [pending, setPending] = useState<{ value: string } | null>(null);
  const [seen, setSeen] = useState({ tag, q: current });

  if (seen.tag !== tag || seen.q !== current) {
    setSeen({ tag, q: current });
    if (seen.tag !== tag || current !== written) {
      setText(current);
      setWritten(current);
      setPending(null);
    }
  }

  function write(value: string): void {
    const trimmed = value.trim();

    setPending(null);
    setWritten(trimmed);
    void navigate({
      to: "/tasks",
      search: (previous) => ({ ...previous, q: trimmed === "" ? undefined : trimmed }),
      replace: true,
      resetScroll: false,
    });
  }

  // The address changes before the board renders the next project, while its
  // loader runs, so a delayed write checks it first.
  const writeDelayed = useEffectEvent((value: string) => {
    if (splitList(router.latestLocation.search.projects)[0] === tag) {
      write(value);
    }
  });

  useEffect(() => {
    if (pending === null) {
      return;
    }

    const timer = setTimeout(() => {
      writeDelayed(pending.value);
    }, SEARCH_DELAY);

    return () => {
      clearTimeout(timer);
    };
  }, [pending]);

  function clear(): void {
    setText("");
    write("");
  }

  const Icon = busy ? CircleNotchIcon : MagnifyingGlassIcon;

  return (
    <div className={GROUP_CLASS}>
      <span id={labelId} className={LABEL_CLASS}>
        Search
      </span>
      {/* The input draws no ring of its own: the row's border takes the focus colour, and the caret shows focus. */}
      <div className="flex h-8 w-60 min-w-0 items-center gap-2 rounded-control border border-graphic bg-bg pr-1 pl-2 text-sm focus-within:border-focus">
        <Icon
          size={14}
          aria-hidden="true"
          className={`shrink-0 text-dim ${busy ? "animate-spin motion-reduce:animate-none" : ""}`}
        />
        <Input
          ref={inputRef}
          type="text"
          role="searchbox"
          autoComplete="off"
          spellCheck={false}
          aria-labelledby={labelId}
          aria-describedby={describedBy}
          placeholder="Id, title, body, comments"
          value={text}
          onValueChange={(next: string) => {
            setText(next);
            setPending({ value: next });
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) {
              return;
            }
            if (event.key === "Enter") {
              write(text);
            } else if (event.key === "Escape" && text !== "") {
              event.stopPropagation();
              clear();
            }
          }}
          className="h-full min-w-0 flex-1 bg-transparent placeholder:text-dim focus-visible:outline-none"
        />
        {text !== "" && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              clear();
              inputRef.current?.focus();
            }}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-control border border-transparent text-dim hover:border-line hover:text-text"
          >
            <XIcon size={14} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
