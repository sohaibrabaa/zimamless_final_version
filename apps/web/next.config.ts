import type { NextConfig } from "next";
import path from "node:path";

// `npm run dev` runs with --webpack (see package.json): Turbopack dev on
// Next.js 16.2.11 throws "TypeError: adapterFn is not a function" on every
// request once a proxy.ts (formerly middleware.ts) file is present — a
// Turbopack/Node-middleware-adapter bug in this exact release, reproduced
// with a minimal proxy.ts. `next build` (webpack) and `next dev --webpack`
// are both unaffected. Revisit when upgrading next past 16.2.11.
const nextConfig: NextConfig = {
  // Pin explicitly: this worktree is nested under the main repo checkout,
  // which has its own root-level lockfile — without this, Turbopack's
  // upward directory walk finds that unrelated lockfile and misinfers the
  // workspace root.
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
