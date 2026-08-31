import { defineConfig } from "vite";

export default defineConfig({
  build: {
    // The string form names the entry and selects the Node environment
    // together: builtins and real dependencies stay external, workspace source
    // is inlined. An SSR build needs no index.html.
    ssr: "src/main.ts",
    target: "node24",
    // rolldownOptions, not rollupOptions: Vite 8 is rolldown-based and marks
    // rollupOptions deprecated in its own types.
    rolldownOptions: { output: { entryFileNames: "tasma.js" } },
  },
});
