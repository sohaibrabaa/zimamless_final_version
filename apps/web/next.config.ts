import type { NextConfig } from "next";
import path from "node:path";

// The repo root is the npm workspace root: its lockfile covers apps/web too,
// so file tracing must start there or hoisted dependencies are excluded.
const repoRoot = path.resolve(__dirname, "../..");

// `npm run dev` runs with --webpack (see package.json): Turbopack dev on
// Next.js 16.2.11 throws "TypeError: adapterFn is not a function" on every
// request once a proxy.ts (formerly middleware.ts) file is present — a
// Turbopack/Node-middleware-adapter bug in this exact release, reproduced
// with a minimal proxy.ts. `next build` (webpack) and `next dev --webpack`
// are both unaffected. Revisit when upgrading next past 16.2.11.
const nextConfig: NextConfig = {
  turbopack: {
    root: repoRoot,
  },
  outputFileTracingRoot: repoRoot,
};

export default nextConfig;
