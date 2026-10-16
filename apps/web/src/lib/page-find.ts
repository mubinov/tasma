/** The part of the task page a match is in. */
export type FindScope = "header" | "body" | "comments" | `comment:${string}`;

export type FindMatch = {
  range: Range;
  scope: FindScope;
  /** The scope, a hash of the block's text, and the place of the block among the blocks of the scope with that text. */
  blockKey: string;
  /** The block element that holds the match. */
  element: Element;
  /** The place of the match among the matches of its block. */
  index: number;
};

/** The text that is not on the screen: the words only a screen reader hears, and hidden or decorative text. */
export const HIDDEN_TEXT = '.sr-only, [hidden], [aria-hidden="true"]';

// `[hidden]` also holds a closed comment panel, which `data-find-hidden` lets through.
const SKIPPED = `button, input, textarea, form, [role="menu"], svg, [data-find-skip], ${HIDDEN_TEXT}`;

/** The displays that keep an element inside the text of its block. */
const FLOWING = new Set(["inline", "contents"]);

const WHITESPACE = /\s/;

const COMMENT_SCOPE = "comment:";

/** The id of the comment a scope names, or null for the other scopes. */
export function commentIdOf(scope: FindScope): number | null {
  return scope.startsWith(COMMENT_SCOPE) ? Number(scope.slice(COMMENT_SCOPE.length)) : null;
}

/** The lower case of one code unit, or the unit itself where the lower case is longer, so offsets map one to one. */
function lowerUnit(unit: string): string {
  const lower = unit.toLowerCase();
  return lower.length === 1 ? lower : unit;
}

function lowerUnits(text: string): string {
  let lower = "";
  for (const unit of text.split("")) {
    lower += lowerUnit(unit);
  }
  return lower;
}

/** A 53-bit hash, so a block key stays short however long the block is. */
function hashText(text: string): string {
  let first = 0xdeadbeef;
  let second = 0x41c6ce57;
  for (let at = 0; at < text.length; at += 1) {
    const unit = text.charCodeAt(at);
    first = Math.imul(first ^ unit, 2654435761);
    second = Math.imul(second ^ unit, 1597334677);
  }
  first = Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909);
  second = Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909);
  return (4294967296 * (2097151 & second) + (first >>> 0)).toString(36);
}

type Run = {
  element: Element;
  scope: FindScope;
  text: string;
  lower: string;
  /** The last unit of `text` is a space, so the next whitespace adds nothing. */
  spaced: boolean;
  /** The text node and the offset of each unit of `text`. */
  points: [Text, number][];
};

function scopeOf(element: Element): FindScope | null {
  const comment = element.getAttribute("data-comment-id");
  if (comment !== null) {
    return `${COMMENT_SCOPE}${comment}`;
  }
  const scope = element.getAttribute("data-find-scope");
  return scope === "header" || scope === "body" || scope === "comments" ? scope : null;
}

/**
 * Every match of the query in the visible text under `root`, in document order.
 * A match ignores case, takes a run of whitespace as one space, and does not
 * cross the border of a block.
 */
export function findRanges(root: Element, query: string): FindMatch[] {
  if (query.trim() === "") {
    return [];
  }

  const needle = lowerUnits(query.replace(/\s+/g, " "));
  const view = root.ownerDocument.defaultView!;
  const blocks = new Map<Element, Element>();
  const scopes = new Map<Element, FindScope | null>();
  const places = new Map<string, number>();
  const matches: FindMatch[] = [];

  function blockOf(element: Element): Element {
    const known = blocks.get(element);
    if (known !== undefined) {
      return known;
    }
    const parent = element.parentElement;
    const block = element === root || parent === null || !FLOWING.has(view.getComputedStyle(element).display)
      ? element
      : blockOf(parent);
    blocks.set(element, block);
    return block;
  }

  function scopeAbove(element: Element): FindScope | null {
    const known = scopes.get(element);
    if (known !== undefined) {
      return known;
    }
    const parent = element.parentElement;
    const scope = scopeOf(element) ?? (element === root || parent === null ? null : scopeAbove(parent));
    scopes.set(element, scope);
    return scope;
  }

  function collectMatches(run: Run): void {
    if (run.text.trim() === "") {
      return;
    }

    const name = `${run.scope}\u0000${hashText(run.text)}`;
    const place = places.get(name) ?? 0;
    places.set(name, place + 1);
    const blockKey = `${name}\u0000${String(place)}`;
    let index = 0;

    for (let at = run.lower.indexOf(needle); at !== -1; at = run.lower.indexOf(needle, at + needle.length)) {
      const [startNode, startOffset] = run.points[at]!;
      const [endNode, endOffset] = run.points[at + needle.length - 1]!;
      const range = root.ownerDocument.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset + 1);
      matches.push({ range, scope: run.scope, blockKey, element: run.element, index });
      index += 1;
    }
  }

  const walker = root.ownerDocument.createTreeWalker(root, view.NodeFilter.SHOW_ELEMENT | view.NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === view.Node.TEXT_NODE) {
        return view.NodeFilter.FILTER_ACCEPT;
      }
      const element = node as Element;
      return element.matches(SKIPPED) && !element.hasAttribute("data-find-hidden")
        ? view.NodeFilter.FILTER_REJECT
        : view.NodeFilter.FILTER_SKIP;
    },
  });

  const runs: Run[] = [];

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text;
    const parent = text.parentElement!;
    const scope = scopeAbove(parent);
    if (scope === null) {
      continue;
    }

    const element = blockOf(parent);
    let run = runs.at(-1);
    if (run?.element !== element || run.scope !== scope) {
      run = { element, scope, text: "", lower: "", spaced: false, points: [] };
      runs.push(run);
    }

    const { data } = text;
    for (let offset = 0; offset < data.length; offset += 1) {
      const unit = data[offset]!;
      if (WHITESPACE.test(unit)) {
        if (run.spaced) {
          continue;
        }
        run.text += " ";
        run.lower += " ";
        run.spaced = true;
      } else {
        run.text += unit;
        run.lower += lowerUnit(unit);
        run.spaced = false;
      }
      run.points.push([text, offset]);
    }
  }

  for (const run of runs) {
    collectMatches(run);
  }

  return matches;
}

/** Where a match is, as an announcement says it. A comment with no title is named by its id. */
export function matchPlace(scope: FindScope, comments: readonly { id: number; title: string }[]): string {
  if (scope === "header") {
    return "in the header";
  }
  if (scope === "body") {
    return "in the body";
  }
  if (scope === "comments") {
    return "in the comment list";
  }

  const id = commentIdOf(scope);
  const title = comments.find((comment) => comment.id === id)?.title.trim() ?? "";
  return title === "" ? `in comment #${String(id)}` : `in comment ${title}`;
}
