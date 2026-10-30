import { describe, expect, it } from "vitest";
import { projectQuery, tasksQuery } from "../../src/api/queries";
import { cachedShownTags } from "../../src/lib/use-board-projects";
import { daemon } from "../board-fixtures";
import { refusalReply, testContext } from "../helpers";

const INVALID = refusalReply(422, { kind: "store", code: "config-invalid", message: "statuses is empty" });

describe("cachedShownTags", () => {
  /** The cache after one read of the project and of the tasks of DELTA and SAGA. */
  async function readBoth(replies: Parameters<typeof daemon>[0]) {
    const { client, queryClient } = testContext(daemon(replies).transport);
    for (const tag of ["DELTA", "SAGA"]) {
      await queryClient.query(projectQuery(client, tag)).catch(() => {});
      await queryClient.query(tasksQuery(client, tag)).catch(() => {});
    }

    return { client, queryClient };
  }

  it("leaves out, on a board of several projects, a project whose read of the project or of its tasks is refused", async () => {
    const { client, queryClient } = await readBoth({ "/projects/DELTA/tasks": INVALID });
    const { client: projectClient, queryClient: projectCache } = await readBoth({ "/projects/SAGA": INVALID });

    expect(cachedShownTags(queryClient, client, { tags: ["DELTA", "SAGA"], several: true })).toEqual(["SAGA"]);
    expect(cachedShownTags(projectCache, projectClient, { tags: ["DELTA", "SAGA"], several: true })).toEqual(["DELTA"]);
  });

  it("keeps every tag on a board of one project", async () => {
    const { client, queryClient } = await readBoth({ "/projects/SAGA/tasks": INVALID });

    expect(cachedShownTags(queryClient, client, { tags: ["SAGA"], several: false })).toEqual(["SAGA"]);
  });
});
