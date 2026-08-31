import { defineConfig } from "vite";

export default defineConfig({
  // The mechanism is the CLI's; see apps/cli/vite.config.ts for why each option
  // is what it is.
  build: {
    ssr: "src/main.ts",
    target: "node24",
    rolldownOptions: { output: { entryFileNames: "tasma-daemon.js" } },
  },
});
