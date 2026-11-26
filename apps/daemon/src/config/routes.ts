// The routes over the user's configuration file of the tree: its read and its
// write.

import { readUserConfig, TaskStoreError, updateUserConfig } from "@tasma/engine";
import { routes } from "@tasma/protocol";
import type { ChatAgent, Success, UserConfig, UserConfigChange } from "@tasma/protocol";
import type { Publish } from "../events/feed.js";
import type { RouteEntry } from "../http/router.js";
import { assertNoQuery } from "../tasks/filter.js";
import { toChange } from "../tasks/input.js";
import { CONFIG_KEY, type WriteQueue } from "../tasks/serialize.js";

/**
 * Refuses a `default_agent` that names no agent of `agents`. The engine does
 * not know the agents, and refuses a value that is not a string itself.
 */
function checkDefaultAgent(change: Record<string, unknown>, agents: readonly ChatAgent[]): void {
  const stated = change.default_agent;
  if (typeof stated !== "string" || (agents as readonly string[]).includes(stated)) return;
  throw new TaskStoreError(
    "config-change-invalid",
    `"default_agent" must be an agent that Tasma runs: ${agents.join(", ")}`,
  );
}

/**
 * The configuration routes, against the entries the contract declares.
 *
 * A write takes the configuration turn, which a project write that states a key
 * the user's file also holds takes too: each checks the other file as it stands
 * on disk, so two such writes overlapping could each pass against a file the
 * other is about to replace.
 */
export function configRoutes(options: {
  root?: string;
  writes: WriteQueue;
  publish?: Publish;
  /** The agents that the daemon offers, the only values a write of `default_agent` takes. */
  agents: readonly ChatAgent[];
}): RouteEntry[] {
  const { root, writes, publish, agents } = options;

  return [
    {
      route: routes.readUserConfig,
      handler: async (request): Promise<Success<UserConfig>> => {
        assertNoQuery(request.query);
        const { diagnostics, ...data } = await readUserConfig(root);
        return { data, diagnostics };
      },
    },
    {
      route: routes.updateUserConfig,
      handler: async (request): Promise<Success<UserConfig>> => {
        assertNoQuery(request.query);
        const fields = toChange(request.body);
        checkDefaultAgent(fields, agents);
        // The engine checks every key and every value at run time.
        const change = fields as UserConfigChange;
        const { diagnostics, ...data } = await writes.run(CONFIG_KEY, () => updateUserConfig(root, change));
        publish?.({ kind: "config" });
        return { data, diagnostics };
      },
    },
  ];
}
