import { FrontmatterScanner } from "../format/region.js";
import { openRegularFile } from "../store/atomic.js";

/**
 * The most one frontmatter region may take. Without a cap, a file whose closing
 * delimiter is missing would be read to its end, which is the whole-file read
 * this reader exists to avoid.
 *
 * Nothing on the write path bounds the text of a region — a mapping is bounded
 * by its depth and its node count alone — so a region that reaches the cap is a
 * region this reader declines rather than a file that is damaged, and it is
 * refused as exactly that.
 */
export const FRONTMATTER_CAP = 64 * 1024;

/**
 * A region that stands past what this reader takes of one file. The closing
 * delimiter may well be there, below the cap, so this is no fault of the format
 * and carries no parse code: it states the bound that stopped the read.
 */
export class FrontmatterTooLong extends Error {
  constructor(filename?: string) {
    const description = `the frontmatter stands past the first ${FRONTMATTER_CAP} bytes, which is the most of one file the index reads`;
    super(filename === undefined ? description : `${filename}: ${description}`);
    this.name = "FrontmatterTooLong";
  }
}

/** The size of one read. A region almost always arrives in the first of them. */
export const CHUNK_SIZE = 4096;

/**
 * The bytes of one file in order, an empty chunk at its end. The reader takes a
 * source rather than a path so that a test can hand it bytes and count what the
 * read asked for.
 *
 * A chunk is valid until the next call: a source may hand out one buffer over
 * and over, and the reader decodes each chunk before it asks for another.
 */
export type ChunkSource = {
  next(): Promise<Uint8Array>;
  close(): Promise<void>;
};

/**
 * The frontmatter region of a task file, read from the front of the file and no
 * further: nothing under the closing delimiter is asked of the source, so a task
 * file of two megabytes costs what one of two kilobytes costs.
 *
 * Where the region ends is the format layer's rule, and the faults it raises are
 * the ones the whole parse raises, so a caller sees one vocabulary whichever
 * reader refused the file.
 *
 * The decoder keeps a byte-order mark rather than dropping it, so the text this
 * reader hands the format layer is the text a whole-file read hands it. A mark
 * dropped here would admit a file whose every other read refuses it.
 */
export async function readFrontmatterText(source: ChunkSource, filename?: string): Promise<string> {
  const decoder = new TextDecoder("utf8", { ignoreBOM: true });
  const scanner = new FrontmatterScanner(filename);
  let read = 0;
  try {
    for (;;) {
      const chunk = await source.next();
      if (chunk.length === 0) {
        // The flush of the decoder, for a file that ends mid-character.
        scanner.push(decoder.decode());
        return scanner.end();
      }
      read += chunk.length;
      const region = scanner.push(decoder.decode(chunk, { stream: true }));
      if (region !== undefined) return region;
      if (read >= FRONTMATTER_CAP) throw new FrontmatterTooLong(filename);
    }
  } finally {
    await source.close();
  }
}

/** A source over one task file, opened under the rules the store reads a task file by. */
export async function openTaskFile(path: string): Promise<ChunkSource | "absent" | "irregular"> {
  const handle = await openRegularFile(path);
  if (typeof handle === "string") return handle;
  const buffer = new Uint8Array(CHUNK_SIZE);
  return {
    async next() {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length);
      return buffer.subarray(0, bytesRead);
    },
    close: () => handle.close(),
  };
}
