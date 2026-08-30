import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

// Scopes `pnpm test` inside this package to its own tests; without a local
// config, vitest walks up to the root projects config and fails.
//
// Vitest loads this file *instead of* vite.config.ts rather than merging the
// two, so the build config is merged in by hand: declared separately, the tests
// would run code the React Compiler never touched while the build ships code it
// did. The build-only plugins in there stay inert under a test run.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
    },
  }),
);
