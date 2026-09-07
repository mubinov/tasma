import { describe, expect, it } from "vitest";
import { openIndexedProject } from "@tasma/engine";
import { bareRoot, codes, plant, project, read, storeError, taskFile, tempRoot, TIMESTAMP } from "./helpers.js";

/**
 * A planted task carrying two comments, the second of them collapsed and
 * closing the file. `counter` is the `next_comment_id` the frontmatter states,
 * so a test can plant the stale one a read reports.
 */
function taskWithComments(id: string, counter = 3): string {
  return `---
id: ${id}
title: Planted
status: To Do
created: "${TIMESTAMP}"
updated: "${TIMESTAMP}"
next_comment_id: ${counter}
---

Body.

<!-- task:comment {id: 1, title: "First", created: "${TIMESTAMP}"} -->

First body.

<!-- task:comment
id: 2
title: "Second"
created: "${TIMESTAMP}"
collapsed: true
-->

Second body.
`;
}

/** A tree holding one planted task, and the path it stands under. */
async function planted(counter?: number): Promise<{ root: string; path: string }> {
  const root = await tempRoot();
  const path = taskFile(root, "TASM-1");
  await plant(path, taskWithComments("TASM-1", counter));
  return { root, path };
}

describe("readTaskText", () => {
  it("answers with the bytes on disk when the selection states nothing", async () => {
    const { root, path } = await planted();

    const result = await project(root).readTaskText("TASM-1");

    expect(result.text).toBe(await read(path));
    expect(result.hidden).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it("answers with the same bytes under collapsed=true", async () => {
    const { root, path } = await planted();

    const result = await project(root).readTaskText("TASM-1", { collapsed: true });

    expect(result.text).toBe(await read(path));
    expect(result.hidden).toEqual([]);
  });

  it("leaves the body of a collapsed comment out under collapsed=false, and names it", async () => {
    const { root, path } = await planted();

    const result = await project(root).readTaskText("TASM-1", { collapsed: false });

    expect(result.text).toBe((await read(path)).replace("\nSecond body.\n", ""));
    expect(result.text).toContain("First body.");
    expect(result.hidden).toEqual([2]);
  });

  it("answers with one comment alone, its marker and its body", async () => {
    const { root } = await planted();

    const result = await project(root).readTaskText("TASM-1", { comment: 1 });

    expect(result.text).toBe(`<!-- task:comment {id: 1, title: "First", created: "${TIMESTAMP}"} -->\n\nFirst body.\n\n`);
    expect(result.hidden).toEqual([]);
  });

  it("answers with a collapsed comment in full where the selection names it", async () => {
    const { root } = await planted();

    const result = await project(root).readTaskText("TASM-1", { comment: 2 });

    expect(result.text).toContain("Second body.");
  });

  it("refuses a comment id the file carries no comment under", async () => {
    const { root, path } = await planted();

    const error = await storeError(project(root).readTaskText("TASM-1", { comment: 9 }));

    expect(error.code).toBe("comment-not-found");
    expect(error.message).toContain("9");
    expect(error.path).toBe(path);
  });

  it("refuses a task that does not exist", async () => {
    const root = await tempRoot();

    expect((await storeError(project(root).readTaskText("TASM-9"))).code).toBe("task-not-found");
  });

  it("refuses a project with no directory", async () => {
    const root = await bareRoot();

    expect((await storeError(project(root).readTaskText("TASM-1"))).code).toBe("project-not-found");
  });

  it("reports what a read of the same file reports", async () => {
    const { root } = await planted(2);
    const handle = project(root);

    const { diagnostics } = await handle.readTaskText("TASM-1", { collapsed: false });

    expect(codes(diagnostics)).toContain("stale-next-comment-id");
    expect(diagnostics).toEqual((await handle.readTask("TASM-1")).diagnostics);
  });

  it("answers through an index, and refuses once it is closed", async () => {
    const { root, path } = await planted();
    const indexed = await openIndexedProject(project(root));

    expect((await indexed.readTaskText("TASM-1")).text).toBe(await read(path));

    await indexed.close();
    expect((await storeError(indexed.readTaskText("TASM-1"))).code).toBe("index-closed");
  });
});
