import { defineConfig } from "vitest/config";
import { packageDirs, packageGlobs } from "./workspace.js";

export default defineConfig({
  test: {
    projects: [
      ...packageDirs,
      // Repo-level checks that belong to no single package.
      { test: { name: "repo", include: ["test/**/*.test.ts"] } },
    ],
    coverage: {
      include: packageGlobs.map((glob) => `${glob}/src/**`),
    },
  },
});
