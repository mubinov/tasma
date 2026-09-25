// The routes over the user's configuration file of the tree: its read and its
// write.

import { readUserConfig, updateUserConfig } from "@tasma/engine";
import { routes } from "@tasma/protocol";
import type { Success, UserConfig, UserConfigChange } from "@tasma/protocol";
import type { RouteEntry } from "../http/router.js";
import { assertNoQuery } from "../tasks/filter.js";
import { toChange } from "../tasks/input.js";
import { CONFIG_KEY, type WriteQueue } from "../tasks/serialize.js";

/**
 * The configuration routes, against the entries the contract declares.
 *
 * A write takes the configuration turn, which a project write that states a key
 * the user's file also holds takes too: each checks the other file as it stands
 * on disk, so two such writes overlapping could each pass against a file the
 * other is about to replace.
 */
export function configRoutes(options: { root?: string; writes: WriteQueue }): RouteEntry[] {
  const { root, writes } = options;

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
        // The engine checks every key and every value at run time.
        const change = toChange(request.body) as UserConfigChange;
        const { diagnostics, ...data } = await writes.run(CONFIG_KEY, () => updateUserConfig(root, change));
        return { data, diagnostics };
      },
    },
  ];
}
