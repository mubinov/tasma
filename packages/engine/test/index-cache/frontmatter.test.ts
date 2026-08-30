import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TaskParseError } from "@tasma/engine";
import {
  CHUNK_SIZE,
  FRONTMATTER_CAP,
  FrontmatterTooLong,
  openTaskFile,
  readFrontmatterText,
} from "../../src/index-cache/frontmatter.js";
import { parseRejection } from "../format/helpers.js";
import { plant, PROJECT, taskFile, tasksDir, taskText, tempRoot } from "../store/helpers.js";
import { BOM, chunks, type Source } from "./helpers.js";

const REGION = `---
id: ${PROJECT}-1
title: Planted
status: To Do
created: "2026-01-01T00:00:00+03:00"
updated: "2026-01-01T00:00:00+03:00"
next_comment_id: 1
---
`;

/** The `TaskParseError` the read of this source must raise. */
function readError(source: Source): Promise<TaskParseError> {
  return parseRejection(() => readFrontmatterText(source), "the read");
}

describe("readFrontmatterText", () => {
  it("returns the region with both delimiter lines", async () => {
    expect(await readFrontmatterText(chunks(`${REGION}\nA body.\n`))).toBe(REGION);
  });

  it("stops at the closing delimiter instead of reading the file", async () => {
    const source = chunks(`${REGION}${"a body line\n".repeat(4000)}`);

    await readFrontmatterText(source);

    expect(source.requested).toBeLessThanOrEqual(REGION.length + 16);
  });

  it("reads a region that ends at the last byte of the file", async () => {
    expect(await readFrontmatterText(chunks(REGION.slice(0, -1)))).toBe(REGION.slice(0, -1));
  });

  it("reads a region whose lines end with CRLF", async () => {
    const region = REGION.replaceAll("\n", "\r\n");

    expect(await readFrontmatterText(chunks(`${region}\r\nA body.\r\n`))).toBe(region);
  });

  it("joins a character the chunks split in two", async () => {
    const region = REGION.replace("Planted", "Planté — ok");

    expect(await readFrontmatterText(chunks(region, 3))).toBe(region);
  });

  it("closes the source it was handed", async () => {
    const source = chunks(REGION);

    await readFrontmatterText(source);

    expect(source.closed).toBe(1);
  });

  it("closes the source of a read that fails", async () => {
    const source = chunks("Not a task file.\n");

    await readError(source);

    expect(source.closed).toBe(1);
  });

  it("refuses a file that does not open with a delimiter", async () => {
    expect((await readError(chunks("Not a task file.\n---\n"))).code).toBe("frontmatter-missing");
  });

  it("refuses a file of one line that is not a delimiter", async () => {
    expect((await readError(chunks("Not a task file."))).code).toBe("frontmatter-missing");
  });

  it("refuses a region that never closes", async () => {
    expect((await readError(chunks(REGION.replace(/---\n$/, "")))).code).toBe("frontmatter-unterminated");
  });

  it("refuses a file that holds the opening delimiter alone", async () => {
    expect((await readError(chunks("---"))).code).toBe("frontmatter-unterminated");
  });

  it("refuses a file that opens with a byte-order mark, which the whole parse refuses too", async () => {
    expect((await readError(chunks(`${BOM}${REGION}`))).code).toBe("frontmatter-missing");
  });

  it("names the bound it stopped at for a delimiter that stands past the cap", async () => {
    const padded = REGION.replace("title: Planted\n", `title: Planted\nnote: ${"x".repeat(FRONTMATTER_CAP)}\n`);
    const source = chunks(padded, CHUNK_SIZE);

    // The closing delimiter is there, below what this reader takes, so the file
    // is refused for the bound rather than for a region that never closes.
    const raised = await readFrontmatterText(source, "TASM-1.md").catch((error: unknown) => error);

    expect(raised).toBeInstanceOf(FrontmatterTooLong);
    expect((raised as Error).message).toBe(
      `TASM-1.md: the frontmatter stands past the first ${FRONTMATTER_CAP} bytes, which is the most of one file the index reads`,
    );
    expect(source.requested).toBeLessThanOrEqual(FRONTMATTER_CAP + CHUNK_SIZE);
  });

  it("states the bound without a file name for a source that names no file", async () => {
    const padded = REGION.replace("title: Planted\n", `title: Planted\nnote: ${"x".repeat(FRONTMATTER_CAP)}\n`);

    await expect(readFrontmatterText(chunks(padded, CHUNK_SIZE))).rejects.toThrow(
      `the frontmatter stands past the first ${FRONTMATTER_CAP} bytes`,
    );
  });

  it("raises the fault of the region on the line the whole parse raises it on", async () => {
    const error = await readError(chunks("Not a task file.\n"));

    expect(error.line).toBe(1);
    expect(error.message).toContain('the file must start with a "---" line');
  });
});

describe("openTaskFile", () => {
  it("reads the frontmatter of a task file on disk", async () => {
    const root = await tempRoot();
    await plant(taskFile(root, "TASM-1"), taskText("TASM-1"));

    const source = await openTaskFile(taskFile(root, "TASM-1"));
    if (typeof source === "string") throw new Error(`the file did not open: ${source}`);

    expect(await readFrontmatterText(source)).toContain("id: TASM-1");
  });

  it("reports a name that holds nothing as absent", async () => {
    const root = await tempRoot();

    expect(await openTaskFile(taskFile(root, "TASM-1"))).toBe("absent");
  });

  it("reports a name that holds a directory as irregular", async () => {
    const root = await tempRoot();
    await mkdir(taskFile(root, "TASM-1"), { recursive: true });

    expect(await openTaskFile(taskFile(root, "TASM-1"))).toBe("irregular");
  });

  it("reports a symbolic link as irregular, rather than following it", async () => {
    const root = await tempRoot();
    await mkdir(tasksDir(root), { recursive: true });
    await plant(join(root, "outside.md"), taskText("TASM-1"));
    await symlink(join(root, "outside.md"), taskFile(root, "TASM-1"));

    expect(await openTaskFile(taskFile(root, "TASM-1"))).toBe("irregular");
  });
});
