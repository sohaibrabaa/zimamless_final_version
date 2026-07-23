import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, ".") },
  },
  test: {
    environment: "jsdom",
    include: ["**/*.spec.ts", "**/*.spec.tsx"],
    // `test/live` needs a running API, the seed, and network access to
    // Supabase. The default suite stays hermetic; see vitest.live.config.mts.
    exclude: ["node_modules/**", ".next/**", "test/live/**"],
    setupFiles: ["./test/setup.ts"],
  },
});
