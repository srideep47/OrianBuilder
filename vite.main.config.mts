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
      output: {
        // Main-process watch builds share .vite/build with preload/workers.
        // Stable root-level names overwrite prior chunks instead of leaving a
        // new hashed pair after every edit. Keeping chunks beside the entry is
        // important because Electron and several main-process utilities resolve
        // packaged resources relative to __dirname.
        chunkFileNames: "[name].js",
      },
      external: [
        "better-sqlite3",
        "node-pty",
        "node-llama-cpp",
        "playwright",
        "playwright-core",
        "dugite",
        // AST editing is an on-demand agent tool. Keep its large TypeScript
        // compiler graph out of the always-resident Vite watcher and let the
        // dynamic import load the packaged dependency only when the tool runs.
        "ts-morph",
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
