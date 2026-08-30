import { TaskParseError } from "./errors.js";
import { FRONTMATTER_DELIMITER } from "./grammar.js";
import { stripCR } from "./text.js";

const DESCRIPTIONS = {
  "frontmatter-missing": 'the file must start with a "---" line',
  "frontmatter-unterminated": 'the frontmatter has no closing "---" line',
};

/**
 * Where the frontmatter region of a task file ends, in text that may arrive in
 * pieces. The region is the opening delimiter, the fields and the closing
 * delimiter, with nothing under it: a reader of the region reads its first line
 * as the opening one and then searches for the closing one, so a region cut
 * short of that line would be read as unterminated.
 *
 * The boundary rule stands here rather than in each reader, so the whole parse
 * and a reader that holds the region alone cannot drift apart on where a region
 * ends or on how a file that carries none is refused.
 */
export class FrontmatterScanner {
  readonly #filename: string | undefined;
  #text = "";
  /** Where the line under examination begins, and its number from zero. */
  #start = 0;
  #line = 0;

  constructor(filename?: string) {
    this.#filename = filename;
  }

  /** The line the region closes on, once one of the two readers below returned it. */
  get closing(): number {
    return this.#line;
  }

  /** The region, once the text handed over so far holds all of it. */
  push(text: string): string | undefined {
    this.#text += text;
    for (;;) {
      const newline = this.#text.indexOf("\n", this.#start);
      if (newline === -1) return undefined;
      const delimiter = stripCR(this.#text.slice(this.#start, newline)) === FRONTMATTER_DELIMITER;
      // A file that opens with anything else is not a task file, and the scan
      // stops on that line rather than searching the rest of it.
      if (this.#line === 0 && !delimiter) this.#fail("frontmatter-missing");
      if (this.#line > 0 && delimiter) return this.#text.slice(0, newline + 1);
      this.#start = newline + 1;
      this.#line += 1;
    }
  }

  /**
   * The region, for a source that has no more text. A file that ends without a
   * line break still closes its region on its last line.
   */
  end(): string {
    const last = this.#start < this.#text.length ? stripCR(this.#text.slice(this.#start)) : undefined;
    const closes = last === FRONTMATTER_DELIMITER;
    // Either a delimiter line stands above this one, or this one is the
    // delimiter the text opened with and never closed.
    const opened = this.#line > 0 || closes;
    if (!opened) this.#fail("frontmatter-missing");
    if (this.#line > 0 && closes) return this.#text;
    this.#fail("frontmatter-unterminated");
  }

  #fail(code: keyof typeof DESCRIPTIONS): never {
    throw new TaskParseError(code, 1, DESCRIPTIONS[code], this.#filename);
  }
}
