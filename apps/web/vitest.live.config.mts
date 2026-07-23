import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { config as loadEnv } from "dotenv";

/**
 * The live screen suite — opt-in, and deliberately separate from `npm test`.
 *
 * It needs the API running on port 3000, the seed applied, and network access
 * to Supabase. That makes it unfit for the default suite, which must stay
 * hermetic and fast; it does not make it optional. This is the only place a
 * real React component meets a real API response, and the promotion rule in
 * `endpoint-status.ts` is satisfied by nothing else.
 *
 * Run it with `npm run test:live` from apps/web.
 */

loadEnv({ path: path.resolve(__dirname, "../../.env") });

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, ".") },
  },
  test: {
    environment: "jsdom",
    include: ["test/live/**/*.live.spec.tsx"],
    setupFiles: ["./test/setup.ts"],
    // Sequential: these share one API, one database and one seeded fixture
    // set, so parallel files would race each other's state.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
