/** A part of a text, from `start` up to `end`, in code units. */
export type MatchRange = { start: number; end: number };

/** The words of a search as the daemon splits them: on whitespace, in lower case. */
export function searchWords(q: string): string[] {
  return q.toLowerCase().split(/\s+/).filter((word) => word !== "");
}

/**
 * The lower case of `text` as the daemon makes it, and for each code unit of it
 * the place in `text` of the character it comes from.
 */
function lowerWithPlaces(text: string): { lower: string; starts: number[]; ends: number[] } {
  const starts: number[] = [];
  const ends: number[] = [];
  let at = 0;
  // Only the final sigma lowers by its context, and to one unit as without it,
  // so the lower case of the whole text is the lower case of each character in turn.
  for (const char of text) {
    const end = at + char.length;
    for (let unit = char.toLowerCase().length; unit > 0; unit -= 1) {
      starts.push(at);
      ends.push(end);
    }
    at = end;
  }
  return { lower: text.toLowerCase(), starts, ends };
}

/**
 * Each place of each word in `text`, ignoring case, sorted, with the places
 * that overlap or touch merged.
 */
export function matchRanges(text: string, words: readonly string[]): MatchRange[] {
  const { lower, starts, ends } = lowerWithPlaces(text);
  const found: MatchRange[] = [];

  for (const word of words) {
    if (word === "") {
      continue;
    }
    for (let at = lower.indexOf(word); at !== -1; at = lower.indexOf(word, at + 1)) {
      found.push({ start: starts[at]!, end: ends[at + word.length - 1]! });
    }
  }
  found.sort((one, other) => one.start - other.start);

  const merged: MatchRange[] = [];
  for (const { start, end } of found) {
    const last = merged.at(-1);
    if (last !== undefined && start <= last.end) {
      last.end = Math.max(last.end, end);
    } else {
      merged.push({ start, end });
    }
  }
  return merged;
}
