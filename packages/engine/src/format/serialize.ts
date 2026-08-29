import { Document, isCollection, isNode, isScalar, Scalar, visit, type YAMLMap } from "yaml";
import { TaskFormatError, TaskSerializeError, type TaskSerializeErrorCode } from "./errors.js";
import { FenceTracker } from "./fences.js";
import { FRONTMATTER_DELIMITER, MARKER_PREFIX, MARKER_SUFFIX } from "./grammar.js";
import { COMMENT, commentFields, type FieldSpec, FRONTMATTER } from "./schema.js";
import { newlines, regionLines, stripCR } from "./text.js";
import { SNAPSHOT, type SerializeOptions, type Task, type TaskComment } from "./types.js";
import { deepEqual, isRecord } from "./values.js";

type FrontmatterPiece = { kind: "frontmatter"; text: string };
type BodyPiece = { kind: "body"; text: string };
/** `values` holds the marker as a reader of the written file finds it. */
type MarkerPiece = { kind: "marker"; text: string; id: number; values: Record<string, unknown> };

type Piece = FrontmatterPiece | BodyPiece | MarkerPiece;

/** A piece of output with the file line it starts on. */
type Located<T> = T & { line: number };
type Region = Located<FrontmatterPiece> | Located<BodyPiece> | Located<MarkerPiece>;

/** How a fault in one region is reported: the name of the region, and the file it came from. */
type Faults = { label: "frontmatter" | "marker"; filename: string | undefined };

function fail(
  code: TaskSerializeErrorCode,
  line: number,
  description: string,
  field: string | undefined,
  filename: string | undefined,
  cause?: unknown,
): never {
  throw new TaskSerializeError(code, line, description, field, filename, cause);
}

/**
 * Builds one region, converting a fault the YAML library raises into a
 * serialize error. Callers match on the code of a format error, so no other
 * exception type leaves this module.
 */
function written<T>(faults: Faults, build: () => T): T {
  try {
    return build();
  } catch (thrown) {
    if (thrown instanceof TaskFormatError) throw thrown;
    const description = `the ${faults.label} cannot be written: ${String(thrown)}`;
    fail("region-unwritable", 1, description, undefined, faults.filename, thrown);
  }
}

function doubleQuoted(value: string): Scalar {
  const scalar = new Scalar(value);
  scalar.type = Scalar.QUOTE_DOUBLE;
  return scalar;
}

function nodeFor(doc: Document, spec: FieldSpec, value: unknown): unknown {
  if (spec.quoted === true) return doubleQuoted(value as string);
  // A collection becomes a node, so that the marker style rule sees that it
  // nests. A scalar stays a raw value, which lets the library keep the quoting
  // style of the node it replaces.
  //
  // The writer creates no anchor of its own: an object the caller placed twice
  // is written twice. An anchor here would lock the key against every later
  // change, and enough of them would push the file past the alias limit the
  // reader sets.
  if (typeof value === "object" && value !== null) return doc.createNode(value, { aliasDuplicateObjects: false });
  return value;
}

/** The anchor names that an alias somewhere in the document reads. */
function aliasedAnchors(doc: Document): Set<string> {
  const names = new Set<string>();
  visit(doc, {
    Alias: (_key, alias) => {
      names.add(alias.source);
    },
  });
  return names;
}

/**
 * Whether the value at `key` carries an anchor an alias reads. Writing such a
 * key either replaces the anchored node, which leaves the alias unresolved, or
 * rewrites the anchored value in place, which changes what the alias reads.
 */
function anchorIsRead(doc: Document, key: string, aliased: Set<string>): boolean {
  if (aliased.size === 0) return false;
  const node = doc.get(key, true);
  if (!isNode(node)) return false;
  let read = false;
  visit(node, (_key, child) => {
    if (!isNode(child) || child.anchor === undefined || !aliased.has(child.anchor)) return undefined;
    read = true;
    return visit.BREAK;
  });
  return read;
}

/**
 * Rejects a region the writer cannot address key by key. The writer reaches a
 * key by its name, which finds a key written as a string and nothing else, while
 * the value reader reports every key the document resolves. Two constructs part
 * the two sets: a merge key (`<<`) lends the region the keys of another mapping,
 * and a key written as an alias resolves to a name the region carries nowhere. A
 * change to such a region loses a removal, or writes the key a second time.
 */
function checkAddressable(doc: Document, faults: Faults): void {
  for (const { key } of (doc.contents as YAMLMap).items) {
    // The name of a key is a string, held either raw or by a scalar node. Every
    // other key node names no key the writer can reach.
    const name = isScalar(key) ? key.value : key;
    if (typeof name === "string") continue;
    // A resolved merge key is the one key the library represents as a scalar
    // that holds a symbol.
    const merges = typeof name === "symbol";
    const reason = merges ? "resolves a YAML merge key" : "carries a key the writer cannot address";
    fail(
      merges ? "merge-key" : "key-unaddressable",
      1,
      `the ${faults.label} ${reason}, so a change to it cannot be written`,
      undefined,
      faults.filename,
    );
  }
}

/**
 * Writes the changed fields into a YAML document. Every key it leaves alone
 * keeps its node, which is what carries `#` comments, key order, quoting style
 * and the keys this format does not define.
 */
function applyFields(
  doc: Document,
  schema: Record<string, FieldSpec>,
  values: Record<string, unknown>,
  previous: Record<string, unknown> | undefined,
  faults: Faults,
): void {
  checkAddressable(doc, faults);
  const aliased = aliasedAnchors(doc);
  for (const [key, spec] of Object.entries(schema)) {
    const value = values[key];
    if (previous !== undefined && deepEqual(previous[key], value)) continue;
    if (anchorIsRead(doc, key, aliased)) {
      const description = `${faults.label} key "${key}" carries a YAML anchor another value points at, so it cannot be changed`;
      fail("anchor-aliased", 1, description, key, faults.filename);
    }
    if (value === undefined) doc.delete(key);
    else doc.set(key, nodeFor(doc, spec, value));
  }
}

function frontmatterRegion(task: Task, filename: string | undefined): string {
  const snapshot = task[SNAPSHOT];
  if (snapshot !== undefined && deepEqual(snapshot.values, task.frontmatter)) return snapshot.raw;

  const faults: Faults = { label: "frontmatter", filename };
  return written(faults, () => {
    const doc = snapshot === undefined ? new Document({}) : snapshot.doc.clone();
    applyFields(doc, FRONTMATTER, task.frontmatter, snapshot?.values, faults);
    return `${FRONTMATTER_DELIMITER}\n${doc.toString({ lineWidth: 0 })}${FRONTMATTER_DELIMITER}\n`;
  });
}

/** One marker: flow style while the mapping is flat and fits one line, block style otherwise. */
function markerText(doc: Document): string {
  // The parser rejects a marker that is not a mapping, and a new document starts as one.
  const map = doc.contents as YAMLMap;

  if (map.items.every((item) => !isCollection(item.value))) {
    map.flow = true;
    const single = doc.toString({ lineWidth: 0 }).trimEnd();
    // A YAML comment or a value that spans lines cannot be held by one line.
    if (!single.includes("\n")) return `${MARKER_PREFIX} ${single} ${MARKER_SUFFIX}\n`;
  }
  map.flow = false;
  return `${MARKER_PREFIX}\n${doc.toString({ lineWidth: 0 })}${MARKER_SUFFIX}\n`;
}

/**
 * The marker text, with the values a reader finds in it so that a check can name
 * a key. Both come out of the converter, so the YAML library raises no exception
 * of its own once the region is built.
 */
function markerRegion(
  comment: TaskComment,
  filename: string | undefined,
): { text: string; values: Record<string, unknown> } {
  const snapshot = comment[SNAPSHOT];
  const fields = commentFields(comment);
  const faults: Faults = { label: "marker", filename };
  return written(faults, () => {
    if (snapshot !== undefined && deepEqual(snapshot.values, fields)) {
      return { text: snapshot.raw, values: snapshot.doc.toJS() as Record<string, unknown> };
    }
    const doc = snapshot === undefined ? new Document({}) : snapshot.doc.clone();
    applyFields(doc, COMMENT, fields, snapshot?.values, faults);
    return { text: markerText(doc), values: doc.toJS() as Record<string, unknown> };
  });
}

/** The text a marker carries between its opening keyword and the `-->` that closes it. */
function markerContent(text: string): string {
  return text.slice(MARKER_PREFIX.length, text.lastIndexOf(MARKER_SUFFIX));
}

/**
 * The path of the first value or key that carries `-->`, in dotted form. `seen`
 * holds the values already walked, so a document that carries an anchor
 * pointing at itself is walked once.
 */
function fieldWithSuffix(value: unknown, path: string, seen: Set<unknown>): string | undefined {
  if (typeof value === "string") return value.includes(MARKER_SUFFIX) ? path : undefined;
  if (typeof value !== "object" || value === null || seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = fieldWithSuffix(item, `${path}[${index}]`, seen);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  for (const [key, nested] of Object.entries(value)) {
    const next = path === "" ? key : `${path}.${key}`;
    if (key.includes(MARKER_SUFFIX)) return next;
    const found = fieldWithSuffix(nested, next, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Rejects a region whose keys would not pass the reader that opens the file next. */
function checkFields(schema: Record<string, FieldSpec>, values: Record<string, unknown>, faults: Faults): void {
  for (const [key, spec] of Object.entries(schema)) {
    const value = values[key];
    if (value === undefined) {
      if (spec.required) fail("key-missing", 1, `${faults.label} key "${key}" is missing`, key, faults.filename);
      continue;
    }
    if (!spec.check.holds(value)) {
      fail("key-type", 1, `${faults.label} key "${key}" ${spec.check.expectation}`, key, faults.filename);
    }
  }
}

/**
 * Rejects a task whose shape or field values the writer cannot work with. It
 * runs before any region is built, because a caller outside TypeScript can hand
 * over any value and every step below reads the fields as the types declare
 * them.
 */
function checkTask(task: Task, filename: string | undefined): void {
  if (!isRecord(task)) fail("key-type", 1, "the task must be a mapping", undefined, filename);
  if (!isRecord(task.frontmatter)) {
    fail("key-type", 1, 'task key "frontmatter" must be a mapping', "frontmatter", filename);
  }
  if (typeof task.body !== "string") fail("key-type", 1, 'task key "body" must be a string', "body", filename);
  if (!Array.isArray(task.comments)) fail("key-type", 1, 'task key "comments" must be a list', "comments", filename);

  checkFields(FRONTMATTER, task.frontmatter, { label: "frontmatter", filename });
  for (const [index, comment] of task.comments.entries()) {
    const path = `comments[${index}]`;
    if (!isRecord(comment)) fail("key-type", 1, `task key "${path}" must be a mapping`, path, filename);
    if (typeof comment.body !== "string") {
      fail("key-type", 1, `task key "${path}.body" must be a string`, `${path}.body`, filename);
    }
    checkFields(COMMENT, commentFields(comment), { label: "marker", filename });
  }
}

/**
 * Rejects a frontmatter region that does not read back as one region. The two
 * `---` lines are its border, and a third one inside it closes it early.
 */
function checkFrontmatter(region: Located<FrontmatterPiece>, filename: string | undefined): void {
  const lines = regionLines(region.text).map(stripCR);
  const closing = lines.length - 1;
  if (closing < 1 || lines[0] !== FRONTMATTER_DELIMITER || lines[closing] !== FRONTMATTER_DELIMITER) {
    const description = `the frontmatter must open and close with a "${FRONTMATTER_DELIMITER}" line`;
    fail("frontmatter-collision", region.line, description, undefined, filename);
  }
  for (let index = 1; index < closing; index += 1) {
    if (lines[index] !== FRONTMATTER_DELIMITER) continue;
    const description = `a "${FRONTMATTER_DELIMITER}" line inside the frontmatter would close it early`;
    fail("frontmatter-collision", region.line + index, description, undefined, filename);
  }
}

/** Rejects a body line that would read as a marker, and carries the fences the body opens. */
function checkBody(region: Located<BodyPiece>, fences: FenceTracker, filename: string | undefined): void {
  let line = region.line;
  for (const text of regionLines(region.text)) {
    const fenced = fences.push(text, line);
    if (!fenced && text.startsWith(MARKER_PREFIX)) {
      const description = "a marker-shaped line at column 0 would read as a comment";
      fail("marker-collision", line, description, undefined, filename);
    }
    line += 1;
  }
}

/**
 * Rejects a marker key that opens another marker. Block style writes a
 * top-level key at column 0, where such a key reads as the start of a new
 * comment, and the reader rejects the key in either style.
 */
function checkMarkerKeys(region: Located<MarkerPiece>, filename: string | undefined): void {
  for (const key of Object.keys(region.values)) {
    if (!key.startsWith(MARKER_PREFIX)) continue;
    const description = `a marker key must not start with "${MARKER_PREFIX}"`;
    fail("marker-collision", region.line, description, key, filename);
  }
}

/** Rejects a marker that carries `-->` anywhere before the sequence that closes it. */
function checkSuffix(region: Located<MarkerPiece>, filename: string | undefined): void {
  if (!markerContent(region.text).includes(MARKER_SUFFIX)) return;
  const field = fieldWithSuffix(region.values, "", new Set());
  const description =
    field === undefined
      ? `a marker must not contain "${MARKER_SUFFIX}"`
      : `marker key "${field}" must not contain "${MARKER_SUFFIX}"`;
  fail("value-contains-arrow", region.line, description, field, filename);
}

function checkMarker(
  region: Located<MarkerPiece>,
  fences: FenceTracker,
  ids: Set<number>,
  filename: string | undefined,
): void {
  const opened = fences.openedAt;
  if (opened !== undefined) {
    const description = `the fenced code block opened here never closes, so the marker on line ${region.line} would read as text`;
    fail("fence-unterminated", opened, description, undefined, filename);
  }
  if (ids.has(region.id)) {
    fail("comment-id-duplicate", region.line, `comment id ${region.id} appears twice`, undefined, filename);
  }
  ids.add(region.id);
  checkMarkerKeys(region, filename);
  checkSuffix(region, filename);
}

/** Rejects output that would not read back as the regions the caller supplied. */
function validate(regions: Region[], filename: string | undefined): void {
  const ids = new Set<number>();
  const fences = new FenceTracker();
  for (const region of regions) {
    switch (region.kind) {
      case "frontmatter":
        checkFrontmatter(region, filename);
        break;
      case "body":
        checkBody(region, fences, filename);
        break;
      case "marker":
        checkMarker(region, fences, ids, filename);
        break;
    }
  }
}

/**
 * Writes a task file. A region the caller did not change is written back from
 * the text it was read from; a changed or newly built region is generated.
 */
export function serializeTask(task: Task, opts: SerializeOptions = {}): string {
  checkTask(task, opts.filename);

  const pieces: Piece[] = [
    { kind: "frontmatter", text: frontmatterRegion(task, opts.filename) },
    { kind: "body", text: task.body },
  ];
  for (const comment of task.comments) {
    pieces.push({ kind: "marker", id: comment.id, ...markerRegion(comment, opts.filename) });
    pieces.push({ kind: "body", text: comment.body });
  }

  const parts: string[] = [];
  const regions: Region[] = [];
  let line = 1;
  // A marker reads as a marker only at column 0, so no region starts in the
  // middle of a line.
  let atLineStart = true;
  for (const piece of pieces) {
    if (piece.text === "") continue;
    if (!atLineStart) {
      parts.push("\n");
      line += 1;
    }
    regions.push({ ...piece, line });
    parts.push(piece.text);
    line += newlines(piece.text);
    atLineStart = piece.text.endsWith("\n");
  }

  validate(regions, opts.filename);
  return parts.join("");
}
