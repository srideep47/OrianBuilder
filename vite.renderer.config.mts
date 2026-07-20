import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const ReactCompilerConfig = {};

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler", ReactCompilerConfig]],
      },
    }),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    // Increase chunk-size warning threshold — lazy-loaded pages can be large
    chunkSizeWarningLimit: 1500,
    // Let Rollup derive safe shared chunks from route-level dynamic imports.
    // The old manual vendor buckets created a production-only circular import
    // (React -> 3D -> React), leaving packaged builds blank.
    // Use esbuild for minification — faster and produces smaller output
    minify: "esbuild",
    // Source maps only in development
    sourcemap: false,
    // CSS code splitting — each lazy chunk gets its own CSS file,
    // so only the CSS for the current page is loaded
    cssCodeSplit: true,
  },
  // Optimise pre-bundling: include heavy deps so Vite processes them once
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "three",
      "@react-three/fiber",
      "@react-three/drei",
      // @react-three/fiber's ESM event bundle imports the CommonJS scheduler
      // package as a default export. Because Fiber is lazy-loaded, Vite would
      // otherwise serve scheduler raw and omit its CJS default-export shim.
      // Pre-bundle it so the 3D Assets route can load in Electron.
      "scheduler",
      "@tanstack/react-router",
      "@tanstack/react-query",
      "jotai",
      "framer-motion",
      // @react-three/fiber + drei are excluded below (lazy per route), but they
      // depend on zustand, whose `traditional` entry does
      // `import useSyncExternalStoreWithSelector from 'use-sync-external-store/shim/with-selector'`.
      // That target is a CommonJS file with only named exports. Including just
      // the CJS leaf wasn't enough — when zustand itself loads raw (parents are
      // excluded) it sees the pre-bundled ESM wrapper without a default and
      // throws "does not provide an export named 'default'", breaking /3dassets.
      // Including zustand (+ its `traditional` subpath) here makes Vite
      // pre-bundle the whole chain with proper CJS→ESM interop applied to the
      // shim, restoring the default export the import expects.
      "zustand",
      "zustand/traditional",
      "use-sync-external-store/shim",
      "use-sync-external-store/shim/with-selector",
    ],
    // Exclude huge deps from pre-bundle — they're lazy-loaded per route
    exclude: ["konva"],
  },
});
