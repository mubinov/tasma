// The four routes over the comments of one task: the map, and the three writes.

import { routes } from "@tasma/protocol";
import type { CommentHeader, Success, WriteResult } from "@tasma/protocol";
import type { RouteEntry } from "../http/router.js";
import type { ProjectHost } from "../projects/host.js";
import { assertNoQuery } from "./filter.js";
import { commentIdOf, toChange } from "./input.js";
import { taskKey } from "./serialize.js";
import type { WriteQueue } from "./serialize.js";

/**
 * The comment routes, for `taskRoutes` to return alongside the task routes.
 *
 * The map is read through `readTask`, the same call the whole task goes out on,
 * because the engine offers no cheaper path and should not: `lines` exists only
 * because the parser recorded where each comment sat while reading the file.
 * What the map saves is wire volume, not daemon work — a caller sees forty
 * comments as forty short records and then fetches the one it wants.
 *
 * The three writes go through the queue the task routes built: a comment is
 * written into the file of its task, so it takes its turn among the writes of
 * that task rather than among the writes of comments.
 */
export function commentRoutes(host: ProjectHost, writes: WriteQueue): RouteEntry[] {
  return [
    {
      route: routes.listComments,
      handler: async (request): Promise<Success<CommentHeader[]>> => {
        assertNoQuery(request.query);
        const { index } = await host.open(request.params.project!);
        const { task, diagnostics } = await index.readTask(request.params.id!);
        const data = task.comments.map(({ body, ...fields }) => ({
          ...fields,
          bytes: Buffer.byteLength(body, "utf8"),
        }));
        return { data, diagnostics };
      },
    },
    {
      route: routes.addComment,
      handler: async (request): Promise<Success<WriteResult>> => {
        assertNoQuery(request.query);
        const project = request.params.project!;
        const id = request.params.id!;
        const change = toChange(request.body);
        const { index } = await host.open(project);
        const { diagnostics, ...data } = await writes.run(taskKey(project, id), () => index.addComment(id, change));
        return { data, diagnostics };
      },
    },
    {
      route: routes.updateComment,
      handler: async (request): Promise<Success<WriteResult>> => {
        assertNoQuery(request.query);
        const project = request.params.project!;
        const id = request.params.id!;
        const commentId = commentIdOf(request.params.commentId!);
        const change = toChange(request.body);
        const { index } = await host.open(project);
        const write = () => index.updateComment(id, commentId, change);
        const { diagnostics, ...data } = await writes.run(taskKey(project, id), write);
        return { data, diagnostics };
      },
    },
    {
      route: routes.deleteComment,
      handler: async (request): Promise<Success<WriteResult>> => {
        assertNoQuery(request.query);
        const project = request.params.project!;
        const id = request.params.id!;
        const commentId = commentIdOf(request.params.commentId!);
        const { index } = await host.open(project);
        const write = () => index.deleteComment(id, commentId);
        const { diagnostics, ...data } = await writes.run(taskKey(project, id), write);
        return { data, diagnostics };
      },
    },
  ];
}
