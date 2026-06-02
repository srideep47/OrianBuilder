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
    rollupOptions: {
      output: {
        // Split vendor code into separate cacheable chunks.
        // Heavy deps (three, monaco, recharts, konva) land in their own chunks
        // and are only downloaded when the user visits the page that needs them.
        manualChunks(id) {
          if (id.includes("node_modules")) {
            // 3D / design studio
            if (
              id.includes("three") ||
              id.includes("@react-three") ||
              id.includes("konva") ||
              id.includes("react-konva")
            ) {
              return "vendor-3d";
            }
            // Code editor
            if (id.includes("monaco-editor") || id.includes("@monaco-editor")) {
              return "vendor-monaco";
            }
            // Charts / analytics
            if (id.includes("recharts") || id.includes("d3-")) {
              return "vendor-charts";
            }
            // Animation
            if (id.includes("framer-motion")) {
              return "vendor-motion";
            }
            // React core — always cached after first load
            if (id.includes("react-dom") || id.includes("react/")) {
              return "vendor-react";
            }
            // Router + query
            if (
              id.includes("@tanstack/react-router") ||
              id.includes("@tanstack/react-query")
            ) {
              return "vendor-router";
            }
          }
        },
      },
    },
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
      "@tanstack/react-router",
      "@tanstack/react-query",
      "jotai",
      "framer-motion",
    ],
    // Exclude huge deps from pre-bundle — they're lazy-loaded per route
    exclude: ["three", "@react-three/fiber", "@react-three/drei", "konva"],
  },
});
