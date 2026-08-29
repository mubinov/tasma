import { isMap, isNode, type Document, parseDocument } from "yaml";
import { TaskParseError, type TaskParseErrorCode } from "./errors.js";
import { FenceTracker } from "./fences.js";
import { FRONTMATTER_DELIMITER, MARKER_PREFIX, MARKER_SUFFIX } from "./grammar.js";
import { COMMENT, type FieldSpec, FRONTMATTER, WRITABLE } from "./schema.js";
import { type Line, newlines, splitLines, stripCR } from "./text.js";
import {
  type CommentFields,
  type Diagnostic,
  type Frontmatter,
  type ParseOptions,
  type ParseResult,
  SNAPSHOT,
  type Task,
  type TaskComment,
} from "./types.js";
import { clone } from "./values.js";

/** A YAML mapping read out of one region, with the values and the position data a key lookup needs. */
type YamlRegion = {
  doc: Document;
  values: Record<string, unknown>;
  source: string;
  firstLine: number;
};

/**
 * One region as the field reader sees it: where its fields are, the schema they
 * follow, and how a fault in them is reported.
 */
type RegionFields = {
  region: YamlRegion;
  schema: Record<string, FieldSpec>;
  missingCode: TaskParseErrorCode;
  typeCode: TaskParseErrorCode;
  missingLine: number;
  label: string;
};

/** The explanation of a YAML fault, without the position the library appends to it. */
function describe(error: Error): string {
  return error.message.replace(/ at line \d+, column \d+:[\s\S]*$/, "");
}

class Parser {
  readonly #text: string;
  readonly #filename: string | undefined;
  readonly #lines: Line[];
  readonly #fences = new FenceTracker();
  readonly #diagnostics: Diagnostic[] = [];

  constructor(text: string, filename: string | undefined) {
    this.#text = text;
    this.#filename = filename;
    this.#lines = splitLines(text);
  }

  run(): ParseResult {
    const closing = this.#frontmatterEnd();
    const region = this.#readYaml(
      this.#text.slice(this.#lines[0]!.end, this.#lines[closing]!.start),
      2,
      "frontmatter-invalid",
      "the frontmatter must be a YAML mapping",
    );
    const frontmatter = this.#readFrontmatter(region);

    const bodyStart = this.#lines[closing]!.end;
    let index = this.#scanToMarker(closing + 1);
    const body = this.#text.slice(bodyStart, this.#startOf(index));

    const comments: TaskComment[] = [];
    while (index < this.#lines.length) {
      const read = this.#readComment(index);
      comments.push(read.comment);
      index = read.next;
    }

    this.#checkIds(comments);
    this.#checkCounter(region, frontmatter, comments);
    const openedAt = this.#fences.openedAt;
    if (openedAt !== undefined) {
      this.#diagnostics.push({
        code: "unterminated-fence",
        line: openedAt,
        message: "the fenced code block opened here never closes",
      });
    }

    const task: Task = {
      frontmatter,
      body,
      comments,
      [SNAPSHOT]: {
        raw: this.#text.slice(0, this.#lines[closing]!.end),
        doc: region.doc,
        values: clone(frontmatter),
      },
    };
    return { task, diagnostics: this.#diagnostics };
  }

  #fail(code: TaskParseErrorCode, line: number, description: string, cause?: unknown): never {
    throw new TaskParseError(code, line, description, this.#filename, cause);
  }

  /** The index of the line that closes the frontmatter. */
  #frontmatterEnd(): number {
    const first = this.#lines[0];
    if (first === undefined || stripCR(first.text) !== FRONTMATTER_DELIMITER) {
      this.#fail("frontmatter-missing", 1, 'the file must start with a "---" line');
    }
    for (let index = 1; index < this.#lines.length; index += 1) {
      if (stripCR(this.#lines[index]!.text) === FRONTMATTER_DELIMITER) return index;
    }
    this.#fail("frontmatter-unterminated", 1, 'the frontmatter has no closing "---" line');
  }

  /**
   * Reads one YAML mapping. The source is normalized to LF, which leaves every
   * line number unchanged and keeps a CRLF file out of the values.
   */
  #readYaml(source: string, firstLine: number, code: TaskParseErrorCode, notMapping: string): YamlRegion {
    const normalized = source.replaceAll("\r\n", "\n");
    const doc = this.#parseYaml(normalized, firstLine, code);
    if (!isMap(doc.contents)) this.#fail(code, firstLine, notMapping);
    return { doc, values: this.#toValues(doc, code, firstLine), source: normalized, firstLine };
  }

  /**
   * Parses one YAML region. The library reports a fault in the syntax through
   * `errors`, and throws on the limits it sets for itself.
   */
  #parseYaml(source: string, firstLine: number, code: TaskParseErrorCode): Document {
    let doc: Document;
    try {
      doc = parseDocument(source);
    } catch (thrown) {
      this.#fail(code, firstLine, String(thrown), thrown);
    }
    const error = doc.errors[0];
    if (error !== undefined) {
      this.#fail(code, firstLine + newlines(source.slice(0, error.pos[0])), describe(error), error);
    }
    return doc;
  }

  /** The plain values of a document. The library enforces its alias limit here, not in the parse. */
  #toValues(doc: Document, code: TaskParseErrorCode, line: number): Record<string, unknown> {
    try {
      return doc.toJS() as Record<string, unknown>;
    } catch (thrown) {
      this.#fail(code, line, String(thrown), thrown);
    }
  }

  /** The file line a key sits on, or `fallback` when the key carries no node with a position. */
  #lineOfKey(region: YamlRegion, key: string, fallback: number): number {
    const node = region.doc.get(key, true);
    if (!isNode(node) || node.range == null) return fallback;
    return region.firstLine + newlines(region.source.slice(0, node.range[0]));
  }

  /**
   * Rejects a key of the region the writer could not walk or write back, before
   * any value is read. It covers the keys this format does not define, which are
   * retained and written back like the ones it does.
   */
  #checkValues(source: RegionFields): void {
    for (const [key, value] of Object.entries(source.region.values)) {
      if (WRITABLE.holds(value)) continue;
      this.#fail(
        source.typeCode,
        this.#lineOfKey(source.region, key, source.missingLine),
        `${source.label} "${key}" ${WRITABLE.expectation}`,
      );
    }
  }

  /**
   * Reads the keys of one schema. A key written with no value counts as absent
   * when the schema makes it optional.
   */
  #readFields(source: RegionFields): Record<string, unknown> {
    this.#checkValues(source);
    const fields: Record<string, unknown> = {};
    for (const [key, spec] of Object.entries(source.schema)) {
      const value = source.region.values[key];
      if (value === undefined || (value === null && !spec.required)) {
        if (spec.required) {
          this.#fail(source.missingCode, source.missingLine, `${source.label} "${key}" is missing`);
        }
        continue;
      }
      if (!spec.check.holds(value)) {
        this.#fail(
          source.typeCode,
          this.#lineOfKey(source.region, key, source.missingLine),
          `${source.label} "${key}" ${spec.check.expectation}`,
        );
      }
      fields[key] = value;
    }
    return fields;
  }

  #readFrontmatter(region: YamlRegion): Frontmatter {
    const fields = this.#readFields({
      region,
      schema: FRONTMATTER,
      missingCode: "frontmatter-key-missing",
      typeCode: "frontmatter-key-type",
      missingLine: 1,
      label: "frontmatter key",
    });
    // Every key of the schema was checked, which is what makes the cast sound.
    return fields as Frontmatter;
  }

  #readCommentFields(region: YamlRegion, markerLine: number): CommentFields {
    const fields = this.#readFields({
      region,
      schema: COMMENT,
      missingCode: "marker-key-missing",
      typeCode: "marker-key-type",
      missingLine: markerLine,
      label: "marker key",
    });
    return fields as CommentFields;
  }

  /** The offset a line starts at, or the end of the file when the index is past the last line. */
  #startOf(index: number): number {
    const line = this.#lines[index];
    return line === undefined ? this.#text.length : line.start;
  }

  /**
   * Advances through markdown to the next real marker, feeding the fence
   * tracker on the way. The tracker runs across the body and every comment
   * body without a break, so every marker-shaped line after an unclosed fence
   * is text.
   */
  #scanToMarker(from: number): number {
    let index = from;
    while (index < this.#lines.length) {
      const line = this.#lines[index]!;
      const fenced = this.#fences.push(line.text, index + 1);
      if (!fenced && line.text.startsWith(MARKER_PREFIX)) return index;
      index += 1;
    }
    return index;
  }

  /** The index of the line that closes a block-style marker. */
  #markerEnd(index: number): number {
    for (let scan = index + 1; scan < this.#lines.length; scan += 1) {
      const text = this.#lines[scan]!.text;
      if (stripCR(text) === MARKER_SUFFIX) return scan;
      if (text.startsWith(MARKER_PREFIX)) break;
    }
    this.#fail("marker-unterminated", index + 1, 'the marker has no closing "-->" line');
  }

  /** The YAML a marker holds, and the index of the line that closes the marker. */
  #readMarker(index: number): { region: YamlRegion; last: number } {
    const marker = this.#lines[index]!;
    const markerLine = index + 1;
    const rest = stripCR(marker.text).slice(MARKER_PREFIX.length);
    const suffix = rest.indexOf(MARKER_SUFFIX);
    const notMapping = "a marker must hold a YAML mapping";

    if (suffix !== -1) {
      if (rest.slice(suffix + MARKER_SUFFIX.length).trim() !== "") {
        this.#fail("marker-invalid", markerLine, 'a flow-style marker carries no text after "-->"');
      }
      const region = this.#readYaml(rest.slice(0, suffix), markerLine, "marker-invalid", notMapping);
      return { region, last: index };
    }

    const last = this.#markerEnd(index);
    if (rest.trim() !== "") {
      this.#fail("marker-invalid", markerLine, "a block-style marker carries no text on its opening line");
    }
    const source = this.#text.slice(marker.end, this.#lines[last]!.start);
    // An HTML comment ends at the first "-->". A preview therefore shows the
    // text after it, and the writer rejects a marker that carries one.
    const early = source.indexOf(MARKER_SUFFIX);
    if (early !== -1) {
      this.#fail(
        "marker-invalid",
        markerLine + 1 + newlines(source.slice(0, early)),
        'a marker carries no "-->" before the line that closes it',
      );
    }
    return { region: this.#readYaml(source, markerLine + 1, "marker-invalid", notMapping), last };
  }

  /**
   * Rejects a marker key a writer would emit at column 0 in block style, where
   * it opens a new comment instead of naming a value.
   */
  #checkMarkerKeys(region: YamlRegion, markerLine: number): void {
    for (const key of Object.keys(region.values)) {
      if (!key.startsWith(MARKER_PREFIX)) continue;
      this.#fail(
        "marker-invalid",
        this.#lineOfKey(region, key, markerLine),
        `a marker key must not start with "${MARKER_PREFIX}"`,
      );
    }
  }

  #readComment(index: number): { comment: TaskComment; next: number } {
    const marker = this.#lines[index]!;
    const markerLine = index + 1;
    const { region, last } = this.#readMarker(index);
    this.#checkMarkerKeys(region, markerLine);

    const fields = this.#readCommentFields(region, markerLine);
    const bodyStart = this.#startOf(last + 1);
    const next = this.#scanToMarker(last + 1);
    const comment: TaskComment = {
      ...fields,
      body: this.#text.slice(bodyStart, this.#startOf(next)),
      lines: { start: markerLine, end: next },
      [SNAPSHOT]: {
        raw: this.#text.slice(marker.start, this.#lines[last]!.end),
        doc: region.doc,
        values: clone(fields),
      },
    };
    return { comment, next };
  }

  #checkIds(comments: TaskComment[]): void {
    const seen = new Set<number>();
    for (const comment of comments) {
      if (seen.has(comment.id)) {
        this.#fail("comment-id-duplicate", comment.lines!.start, `comment id ${comment.id} appears twice`);
      }
      seen.add(comment.id);
    }
  }

  #checkCounter(region: YamlRegion, frontmatter: Frontmatter, comments: TaskComment[]): void {
    const first = comments[0];
    if (first === undefined) return;
    const highest = comments.reduce((max, comment) => Math.max(max, comment.id), first.id);
    if (frontmatter.next_comment_id > highest) return;
    this.#diagnostics.push({
      code: "stale-next-comment-id",
      line: this.#lineOfKey(region, "next_comment_id", 1),
      message: `next_comment_id is ${frontmatter.next_comment_id}, but the file already uses comment id ${highest}`,
    });
  }
}

/**
 * Reads a task file. Throws `TaskParseError` on the first fault that makes the
 * file unreadable; everything the format declares legal but questionable comes
 * back as a diagnostic.
 */
export function parseTask(text: string, opts: ParseOptions = {}): ParseResult {
  return new Parser(text, opts.filename).run();
}
