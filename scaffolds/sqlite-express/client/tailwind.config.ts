import type { Config } from "tailwindcss";

export default {
  content: ["./client/src/**/*.{ts,tsx}", "./client/index.html"],
  theme: { extend: {} },
  plugins: [],
} satisfies Config;
