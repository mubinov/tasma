import { Input } from "@base-ui/react/input";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { boardValue, readBoard } from "../lib/board";
import { CircleNotchIcon, MagnifyingGlassIcon, XIcon } from "../lib/icons";
import { useFindRequest } from "../store/ui";
import { GROUP_CLASS, LABEL_CLASS } from "./control-classes";

export const SEARCH_DELAY = 300;

/** The name of the input: the id of a visible label, or a text. */
type SearchBoxName = { labelledBy: string; label?: never } | { labelledBy?: never; label: string };

type SearchBoxProps = SearchBoxName & {
  /** The `q` of the address. */
  q: string | undefined;
  /** A change sets the text to `q` again. */
  resetKey: string;
  /** Writes the trimmed text. */
  onWrite: (text: string) => void;
  /** Checked before a write after the delay. */
  canWriteDelayed: () => boolean;
  /** A search request for `q` runs, and the screen has no result for it yet. */
  busy: boolean;
  /** The id of the line that reports a failed search, while it shows. */
  describedBy: string | undefined;
  placeholder: string;
  clearLabel: string;
  /** The width of the box. */
  className: string;
  inputRef?: RefObject<HTMLInputElement | null>;
};

/**
 * The text of a search. It writes the text and fetches nothing: the screen
 * reads the search for `q`.
 *
 * `aria-busy` is not used for the wait: the results stay operable during it,
 * and the attribute asks a reader to hold them back.
 */
export function SearchBox({
  q,
  resetKey,
  onWrite,
  canWriteDelayed,
  busy,
  describedBy,
  placeholder,
  clearLabel,
  className,
  labelledBy,
  label,
  inputRef,
}: SearchBoxProps): ReactNode {
  const ownRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? ownRef;
  const current = q ?? "";
  const [text, setText] = useState(current);
  // Never copied into `text`: the trim of a write would take a space typed between two words.
  const [written, setWritten] = useState(current);
  // A new object on each change, so the delay starts again on each key.
  const [pending, setPending] = useState<{ value: string } | null>(null);
  const [seen, setSeen] = useState({ resetKey, q: current });

  if (seen.resetKey !== resetKey || seen.q !== current) {
    setSeen({ resetKey, q: current });
    if (seen.resetKey !== resetKey || current !== written) {
      setText(current);
      setWritten(current);
      setPending(null);
    }
  }

  function write(value: string): void {
    const trimmed = value.trim();

    setPending(null);
    setWritten(trimmed);
    onWrite(trimmed);
  }

  const writeDelayed = useEffectEvent((value: string) => {
    if (canWriteDelayed()) {
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

  useFindRequest(() => {
    ref.current?.focus();
    ref.current?.select();
  });

  function clear(): void {
    setText("");
    write("");
  }

  const Icon = busy ? CircleNotchIcon : MagnifyingGlassIcon;

  return (
    // The input draws no ring of its own: the row's border takes the focus colour, and the caret shows focus.
    <div className={`flex h-8 ${className} min-w-0 items-center gap-2 rounded-control border border-graphic bg-bg pr-1 pl-2 text-sm focus-within:border-focus`}>
      <Icon
        size={14}
        aria-hidden="true"
        className={`shrink-0 text-dim ${busy ? "animate-spin motion-reduce:animate-none" : ""}`}
      />
      <Input
        ref={ref}
        type="text"
        role="searchbox"
        autoComplete="off"
        spellCheck={false}
        aria-labelledby={labelledBy}
        aria-label={label}
        aria-describedby={describedBy}
        placeholder={placeholder}
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
          aria-label={clearLabel}
          onClick={() => {
            clear();
            ref.current?.focus();
          }}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-control border border-transparent text-dim hover:border-line hover:text-text"
        >
          <XIcon size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

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

/** The board's search, with its visible label. It writes `q` to the address of the board. */
export function SearchField({ tag, q, busy, describedBy }: SearchFieldProps): ReactNode {
  const navigate = useNavigate();
  const router = useRouter();
  const labelId = useId();

  return (
    <div className={GROUP_CLASS}>
      <span id={labelId} className={LABEL_CLASS}>
        Search
      </span>
      <SearchBox
        labelledBy={labelId}
        q={q}
        resetKey={tag}
        onWrite={(text) => {
          void navigate({
            to: "/tasks",
            search: (previous) => ({ ...previous, q: text === "" ? undefined : text }),
            replace: true,
            resetScroll: false,
          });
        }}
        // The address changes before the board renders the next board, while its
        // loader runs, so a delayed write checks it first.
        canWriteDelayed={() => boardValue(readBoard(router.latestLocation.search.projects)) === tag}
        busy={busy}
        describedBy={describedBy}
        placeholder="Id, title, body, comments"
        clearLabel="Clear search"
        className="w-60"
      />
    </div>
  );
}
