import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Library build (`npm run build:lib`): `@katatan/csv4test` (mount + backends,
 * React and the grid bundled in) and `@katatan/csv4test/core` (no React, no DOM).
 * The standalone app is built by vite.config.ts.
 */
export default defineConfig({
  plugins: [react()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  // The sample under public/ belongs to the standalone app.
  publicDir: false,
  build: {
    outDir: "dist-lib",
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
    lib: {
      entry: { index: "src/lib/index.tsx", core: "src/lib/core.ts" },
      formats: ["es"],
    },
    rollupOptions: {
      output: { chunkFileNames: "chunks/[name]-[hash].js" },
    },
  },
});
