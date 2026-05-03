import { defineConfig } from "vite";
import path from "path";

// https://vitejs.dev/config
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      external: [
        "better-sqlite3",
        "node-pty",
        "node-llama-cpp",
        "playwright",
        "playwright-core",
        /^chromium-bidi(\/.*)?$/,
        /^node:/,
        /^@node-llama-cpp\//,
      ],
    },
  },
  plugins: [
    {
      name: "restart",
      closeBundle() {
        process.stdin.emit("data", "rs");
      },
    },
  ],
});
