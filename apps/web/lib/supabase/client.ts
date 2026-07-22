import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Mock mode has no Supabase project to talk to, so a placeholder is correct
// there and only there. Anywhere else, falling back silently turns a missing
// env var into "invalid credentials" on a login that was never attempted —
// fail loudly at startup instead, naming the variable.
const MOCKING_ENABLED = process.env.NEXT_PUBLIC_API_MOCKING !== "disabled";

if (!MOCKING_ENABLED && (!url || !anonKey)) {
  throw new Error(
    "Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL and " +
      "NEXT_PUBLIC_SUPABASE_ANON_KEY (see .env.local.example). " +
      "Placeholders are only used when NEXT_PUBLIC_API_MOCKING is enabled."
  );
}

/**
 * Browser-only client. Registration/login/verification run directly against
 * Supabase Auth from the client (PA-04) — the NestJS API only sees the
 * resulting JWT via Authorization: Bearer, never handles credentials itself.
 */
export const supabase = createClient(
  url || "http://localhost:54321",
  anonKey || "placeholder-anon-key"
);
