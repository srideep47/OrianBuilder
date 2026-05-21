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
        "dugite",
        /^chromium-bidi(\/.*)?$/,
        /^node:/,
        /^@node-llama-cpp\//,
        "@noble/ed25519",
        /^@noble\//,
        "hyperswarm",
        "b4a",
        /^hyperswarm\//,
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
