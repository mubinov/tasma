import { afterEach, describe, expect, it } from "vitest";
import { commentIdOf, findRanges, matchPlace, type FindMatch } from "../../src/lib/page-find";

function root(html: string): HTMLElement {
  const element = document.createElement("div");
  element.innerHTML = html;
  document.body.append(element);
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
});

function texts(matches: readonly FindMatch[]): string[] {
  return matches.map(({ range }) => range.toString());
}

describe("the match rule", () => {
  it("ignores case and requires the full phrase", () => {
    const page = root('<div data-find-scope="body"><p>Parse the File, then parse it again.</p></div>');

    expect(texts(findRanges(page, "PARSE"))).toEqual(["Parse", "parse"]);
    expect(texts(findRanges(page, "the file"))).toEqual(["the File"]);
    expect(findRanges(page, "file parse")).toEqual([]);
  });

  it("counts a run of whitespace as one space, in the query and in the text", () => {
    const page = root('<div data-find-scope="body"><p>one\n  two\tthree</p></div>');

    expect(texts(findRanges(page, "one two"))).toEqual(["one\n  two"]);
    expect(texts(findRanges(page, "two   three"))).toEqual(["two\tthree"]);
  });

  it("finds nothing for an empty query or a query of spaces", () => {
    const page = root('<div data-find-scope="body"><p>a b</p></div>');

    expect(findRanges(page, "")).toEqual([]);
    expect(findRanges(page, "   ")).toEqual([]);
  });

  it("does not remove accents", () => {
    const page = root('<div data-find-scope="body"><p>café</p></div>');

    expect(findRanges(page, "cafe")).toEqual([]);
    expect(texts(findRanges(page, "CAFÉ"))).toEqual(["café"]);
  });

  it("keeps a character whose lower case is longer than itself, so later offsets stay right", () => {
    const page = root('<div data-find-scope="body"><p>İstanbul road</p></div>');

    expect(texts(findRanges(page, "road"))).toEqual(["road"]);
    expect(texts(findRanges(page, "İs"))).toEqual(["İs"]);
  });

  it("finds the matches of one block one after another, without overlap", () => {
    const page = root('<div data-find-scope="body"><p>aaaa</p></div>');

    expect(findRanges(page, "aa").map(({ index }) => index)).toEqual([0, 1]);
  });
});

describe("blocks", () => {
  it("crosses bold, a link and inline code inside one block", () => {
    const page = root(
      '<div data-find-scope="body"><p>run <strong>the</strong> <a href="#">fast</a> <code>parser</code> now</p></div>',
    );

    const [match] = findRanges(page, "run the fast parser now");
    expect(match?.range.toString()).toBe("run the fast parser now");
  });

  it("does not cross two paragraphs, two table cells or two list items", () => {
    const page = root(
      '<div data-find-scope="body"><p>alpha</p><p>beta</p>'
      + "<table><tbody><tr><td>gamma</td><td>delta</td></tr></tbody></table>"
      + "<ul><li>eps</li><li>zeta</li></ul></div>",
    );

    expect(findRanges(page, "alphabeta")).toEqual([]);
    expect(findRanges(page, "alpha beta")).toEqual([]);
    expect(findRanges(page, "gammadelta")).toEqual([]);
    expect(findRanges(page, "epszeta")).toEqual([]);
  });

  it("does not join the text before and after a nested block", () => {
    const page = root('<div data-find-scope="body"><ul><li>top<ul><li>inner</li></ul>tail</li></ul></div>');

    expect(findRanges(page, "toptail")).toEqual([]);
    expect(texts(findRanges(page, "tail"))).toEqual(["tail"]);
  });

  it("does not cross into a span whose display is block, as a browser computes it for a flex item", () => {
    const page = root('<h2 data-find-scope="comments">Comments <span style="display: block">3</span></h2>');

    expect(findRanges(page, "comments 3")).toEqual([]);
    expect(texts(findRanges(page, "comments"))).toEqual(["Comments"]);
  });

  it("finds in a block of a million characters, in time linear in its length", () => {
    const page = root(`<div data-find-scope="body"><pre>${"word \n".repeat(170_000)}needle</pre></div>`);

    const matches = findRanges(page, "word needle");

    expect(texts(matches)).toEqual(["word \nneedle"]);
    expect(matches[0]?.blockKey.length).toBeLessThan(64);
  });
});

describe("skipped text", () => {
  it.each([
    ['<span class="sr-only">secret</span>', "sr-only"],
    ["<span hidden>secret</span>", "hidden"],
    ['<span aria-hidden="true">secret</span>', "aria-hidden"],
    ["<span data-find-skip>secret</span>", "data-find-skip"],
    ["<button>secret</button>", "button"],
    ["<textarea>secret</textarea>", "textarea"],
    ["<form><span>secret</span></form>", "form"],
    ['<div role="menu">secret</div>', "menu"],
    ["<svg><text>secret</text></svg>", "svg"],
  ])("skips text in %s", (html) => {
    const page = root(`<div data-find-scope="body"><p>open ${html}</p></div>`);

    expect(findRanges(page, "secret")).toEqual([]);
    expect(texts(findRanges(page, "open"))).toEqual(["open"]);
  });

  it("searches a closed panel marked for find, and still skips the screen reader text inside it", () => {
    const page = root(
      '<article data-comment-id="2"><div hidden data-find-hidden><p>folded <span class="sr-only">words</span></p></div></article>',
    );

    expect(texts(findRanges(page, "folded"))).toEqual(["folded"]);
    expect(findRanges(page, "words")).toEqual([]);
  });

  it("skips nothing for an aria-hidden above the search root", () => {
    const outer = root('<div aria-hidden="true"><div id="inner"><div data-find-scope="body"><p>seen</p></div></div></div>');

    expect(texts(findRanges(outer.querySelector("#inner")!, "seen"))).toEqual(["seen"]);
  });

  it("skips text outside every scope", () => {
    const page = root('<p>loose</p><div data-find-scope="body"><p>loose</p></div>');

    expect(findRanges(page, "loose").map(({ scope }) => scope)).toEqual(["body"]);
  });
});

describe("the key of a match", () => {
  it("names the scope of each match", () => {
    const page = root(
      '<div data-find-scope="header"><h1>Word</h1></div><div data-find-scope="header">word meta</div>'
      + '<div data-find-scope="body"><p>word</p></div>'
      + '<h2 data-find-scope="comments">Word list</h2>'
      + '<article data-comment-id="7"><h3>word</h3></article>',
    );

    expect(findRanges(page, "word").map(({ scope }) => scope)).toEqual([
      "header",
      "header",
      "body",
      "comments",
      "comment:7",
    ]);
  });

  it("gives two blocks with the same text in one scope different places, and the same text in two scopes the same place", () => {
    const page = root(
      '<div data-find-scope="body"><p>same  text</p><p>same text</p></div>'
      + '<article data-comment-id="1"><p>same text</p></article>',
    );

    const [first, second, third] = findRanges(page, "text");
    expect(first?.blockKey).not.toBe(second?.blockKey);
    expect(first?.blockKey).toBe(findRanges(page, "same")[0]?.blockKey);
    expect(third?.blockKey).not.toBe(first?.blockKey);
    expect(third?.blockKey.endsWith("\u00000")).toBe(true);
  });

  it("counts the matches of each block from zero", () => {
    const page = root('<div data-find-scope="body"><p>x x</p><p>x</p></div>');

    expect(findRanges(page, "x").map(({ index }) => index)).toEqual([0, 1, 0]);
  });

  it("keeps the key of a later block when a skipped block comes before it", () => {
    const before = root('<div data-find-scope="body"><p>same</p><p>same</p></div>');
    const keys = findRanges(before, "same").map(({ blockKey }) => blockKey);
    before.remove();

    const after = root('<div data-find-scope="body"><div data-find-skip><p>same</p></div><p>same</p><p>same</p></div>');

    expect(findRanges(after, "same").map(({ blockKey }) => blockKey)).toEqual(keys);
  });

  it("does not count a block of whitespace alone", () => {
    const page = root('<div data-find-scope="body"><ul>\n<li>a</li>\n</ul></div>');

    expect(texts(findRanges(page, "a"))).toEqual(["a"]);
    expect(findRanges(page, "a")[0]?.blockKey.endsWith("\u00000")).toBe(true);
  });

  it("holds the block element of the match", () => {
    const page = root('<div data-find-scope="body"><p id="one">a <em>b</em></p></div>');

    expect(findRanges(page, "b")[0]?.element).toBe(page.querySelector("#one"));
  });
});

describe("the place words", () => {
  const comments = [{ id: 4, title: "Plan" }, { id: 5, title: "  " }];

  it.each([
    ["header", "in the header"],
    ["body", "in the body"],
    ["comments", "in the comment list"],
    ["comment:4", "in comment Plan"],
    ["comment:5", "in comment #5"],
    ["comment:9", "in comment #9"],
  ] as const)("says %s as %s", (scope, words) => {
    expect(matchPlace(scope, comments)).toBe(words);
  });
});

describe("the comment of a scope", () => {
  it.each([
    ["comment:7", 7],
    ["header", null],
    ["body", null],
    ["comments", null],
  ] as const)("is %s → %s", (scope, id) => {
    expect(commentIdOf(scope)).toBe(id);
  });
});
