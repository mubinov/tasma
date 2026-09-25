import { Document, isAlias, isNode, isScalar, isSeq, type Node, parseDocument } from "yaml";
import { anchorIsRead, anchorsOf, type UnaddressableKey, unaddressableKey } from "../format/anchors.js";
import { isPlainMapping } from "../format/values.js";
import { readRegularFile } from "./atomic.js";
import { fail } from "./errors.js";

/** What a refusal states about a file whose key no write reaches by its name. */
const UNADDRESSABLE: Record<UnaddressableKey, string> = {
  "merge-key": "the file resolves a YAML merge key, so a key of it cannot be written",
  "key-unaddressable": "the file carries a key written as an alias, so a key of it cannot be written",
};

/** The code a file on disk that no write can use is refused with: a configuration file, or a workflow file. */
export type DeclarationFault = "config-invalid" | "workflow-invalid";

/**
 * How one file is opened for a write. `required` refuses an absent file rather
 * than answering an empty document.
 */
export type DeclarationOptions = { code?: DeclarationFault; required?: boolean };

/**
 * One file the user places as a document this layer can write back, or an
 * empty one where the file is absent and not `required`, which is how a file
 * takes its first key.
 *
 * A symbolic link is refused although the reader follows one on purpose: this
 * write installs the new text by rename, which would replace the link with a
 * plain file and leave the linked file stale. A file the parser refuses is
 * refused for the same reason — the rename would take it with it.
 */
export async function openDeclaration(filename: string, options: DeclarationOptions = {}): Promise<Document> {
  const code = options.code ?? "config-invalid";
  const read = await readRegularFile(filename);
  if (read === "absent") {
    if (options.required === true) fail(code, "there is no file under this name", filename);
    return new Document({});
  }
  if (read === "irregular") {
    fail(code, "this name holds no regular file this layer can write", filename);
  }
  const doc = parseDocument(read.text);
  if (doc.errors.length > 0) fail(code, "the file is not valid YAML", filename);
  // Both tests are needed. The node says whether the document holds anything at
  // all: a file holding nothing, or nothing but comments, carries none and takes
  // its first key. The value it resolves to says whether a write reaches a key:
  // an explicit null and a `!!set` each carry a node no key can be set on, and
  // both resolve to something `isPlainMapping` refuses.
  if (doc.contents !== null && !isPlainMapping(resolvedValue(doc, filename, code))) {
    fail(code, "the file must hold a YAML mapping", filename);
  }
  // The reader resolves a name such a file gives while no key of it carries that
  // text, so a write here would state the key a second time, or take nothing
  // away and report that it did.
  const unaddressable = unaddressableKey(doc);
  if (unaddressable !== undefined) fail(code, UNADDRESSABLE[unaddressable], filename);
  return doc;
}

/**
 * The value a document resolves to. An alias reading an anchor the file never
 * sets is accepted by the parser and resolved by nothing, so the fault it raises
 * is about the file rather than about this call — the shape `readLevel` answers
 * a parse fault of the same file in.
 */
function resolvedValue(doc: Document, filename: string, code: DeclarationFault): unknown {
  try {
    return doc.toJS();
  } catch (error) {
    fail(code, "this file holds an alias that resolves to no anchor", filename, error);
  }
}

/** The mapping a document opened by `openDeclaration` holds. */
export function storedValues(doc: Document): Record<string, unknown> {
  return doc.contents === null ? {} : { ...(doc.toJS() as Record<string, unknown>) };
}

/** The same mapping once `writes` is applied, where `undefined` clears a key. */
export function appliedValues(doc: Document, writes: Map<string, unknown>): Record<string, unknown> {
  const values = storedValues(doc);
  for (const [key, value] of writes) {
    if (value === undefined) delete values[key];
    else values[key] = value;
  }
  return values;
}

/**
 * Refuses a key whose write would change a value the change never named. An
 * anchor another value of the file reads stands on the node a write replaces, so
 * setting the key rewrites what those aliases read and clearing it leaves them
 * resolving to nothing. It is the condition the task writer refuses as
 * `anchor-aliased`.
 */
export function checkAnchor(
  doc: Document,
  key: string,
  removing: boolean,
  filename: string,
  code: DeclarationFault = "config-invalid",
): void {
  if (!anchorIsRead(doc, key, anchorsOf(doc), removing)) return;
  const description = `the key "${key}" carries a YAML anchor another value points at, so it cannot be changed`;
  fail(code, description, filename);
}

/** The value of a key that clears its field: none at all, or `null`. */
export function cleared(value: unknown): boolean {
  return value === undefined || value === null;
}

/**
 * A list a caller stated for one key: text entries that are never empty and
 * never repeated, and at least one of them unless `emptyAllowed`.
 */
export function checkedList(key: string, stated: unknown, emptyAllowed: boolean): string[] {
  if (!Array.isArray(stated)) fail("config-change-invalid", `"${key}" must be a list of strings`);
  if (!emptyAllowed && stated.length === 0) fail("config-change-invalid", `"${key}" must hold at least one entry`);
  const seen = new Set<unknown>();
  for (const entry of stated) {
    if (typeof entry !== "string" || entry === "") {
      fail("config-change-invalid", `every entry of "${key}" must be a string that is not empty`);
    }
    if (seen.has(entry)) fail("config-change-invalid", `"${key}" holds "${entry}" more than once`);
    seen.add(entry);
  }
  return stated as string[];
}

/** The status a caller stated for `default_status`, which is text and never the empty string. */
export function checkedDefaultStatus(stated: unknown): string {
  if (typeof stated !== "string" || stated === "") {
    fail("config-change-invalid", '"default_status" must be a string that is not empty');
  }
  return stated;
}

/**
 * The node that writes `value` over the value `key` holds now. It keeps the
 * comments and the anchor of the old node, and its quotes or flow style where
 * the new node is of the same kind, but never its tag: a kept tag would store
 * another value than the one given.
 */
function replacement(doc: Document, key: string, value: unknown): Node {
  const node = doc.createNode(value);
  const old = doc.get(key, true);
  if (!isNode(old)) return node;
  node.commentBefore = old.commentBefore;
  node.comment = old.comment;
  if (!isAlias(old)) node.anchor = old.anchor;
  if (isScalar(old) && isScalar(node)) node.type = old.type;
  if (isSeq(old) && isSeq(node)) node.flow = old.flow;
  return node;
}

/**
 * Sets and clears the keys of one change on the document, leaving every other
 * key and every comment of the file alone. The comments inside a list it
 * replaces go with the entries they stand beside. True when the document
 * changed, which is when the file has to be written.
 */
export function applyWrites(doc: Document, writes: Map<string, unknown>): boolean {
  let written = false;
  for (const [key, value] of writes) {
    if (value !== undefined) {
      doc.set(key, replacement(doc, key, value));
      written = true;
      // A document that holds no collection — an empty file, or one carrying
      // nothing but comments — has no key to take away, and `delete` refuses it
      // outright.
    } else if (doc.contents !== null && doc.delete(key)) {
      written = true;
    }
  }
  return written;
}
