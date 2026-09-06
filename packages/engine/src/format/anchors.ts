/**
 * The rules a key of a user-placed YAML file is written under: the anchor it
 * carries, and whether a write reaches it by its name at all. They are stated
 * here because two writers of this engine meet them: the regions of a task file,
 * and a project's own configuration file.
 */

import { type Document, isAlias, isMap, isNode, isScalar, visit } from "yaml";

/** How a top-level key can stand so that no write reaches it by its name. */
export type UnaddressableKey = "merge-key" | "key-unaddressable";

/**
 * The first top-level key no write reaches by its name, or `undefined` where
 * every key is one a write reaches. A write addresses a key by a plain string,
 * so a key written as a number, a boolean or a null names no key it addresses
 * and is left where it stands. Two constructs are different, because either can
 * report the name of a key while the mapping carries no key written under it: a
 * merge key (`<<`) lends the mapping the keys of another one, and a key written
 * as an alias resolves to the text its anchor holds. A write over either loses a
 * removal, or states the key a second time.
 */
export function unaddressableKey(doc: Document): UnaddressableKey | undefined {
  if (!isMap(doc.contents)) return undefined;
  for (const { key } of doc.contents.items) {
    // A resolved merge key is the one key the library represents as a scalar
    // that holds a symbol.
    if (isScalar(key) && typeof key.value === "symbol") return "merge-key";
    if (isAlias(key)) return "key-unaddressable";
  }
  return undefined;
}

/** The anchors of one document that decide whether a key can be written. */
export type Anchors = {
  /** The anchor names an alias somewhere in the document reads. */
  read: Set<string>;
  /** The anchor each top-level key node carries, by the name of its key. */
  onKey: Map<unknown, string>;
};

export function anchorsOf(doc: Document): Anchors {
  const read = new Set<string>();
  visit(doc, {
    Alias: (_key, alias) => {
      read.add(alias.source);
    },
  });
  const onKey = new Map<unknown, string>();
  // A document holding no mapping names no key, so it carries no anchor a write
  // of one could break. A file the registry opens can be such a document: an
  // empty one takes its first key from the write.
  if (isMap(doc.contents)) {
    for (const { key } of doc.contents.items) {
      if (isScalar(key) && key.anchor !== undefined) onKey.set(key.value, key.anchor);
    }
  }
  return { read, onKey };
}

/**
 * Whether writing `key` would break an alias. A change replaces the value node,
 * which leaves an alias that reads an anchor inside it unresolved, or rewrites
 * the anchored value in place, which changes what the alias reads. A removal
 * takes the key node away with the value, so an anchor the key node carries
 * counts for a removal as well.
 */
export function anchorIsRead(doc: Document, key: string, anchors: Anchors, removing: boolean): boolean {
  if (anchors.read.size === 0) return false;
  const onKey = anchors.onKey.get(key);
  if (removing && onKey !== undefined && anchors.read.has(onKey)) return true;
  const node = doc.get(key, true);
  if (!isNode(node)) return false;
  let read = false;
  visit(node, (_key, child) => {
    if (!isNode(child) || child.anchor === undefined || !anchors.read.has(child.anchor)) return undefined;
    read = true;
    return visit.BREAK;
  });
  return read;
}
