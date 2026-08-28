import { defineConfig } from "vitest/config";

// Scopes `pnpm test` inside this package to its own tests; without a local
// config, vitest walks up to the root projects config and fails.
export default defineConfig({});
