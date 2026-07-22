import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/**
 * Browser-only client. Registration/login/verification run directly against
 * Supabase Auth from the client (PA-04) — the NestJS API only sees the
 * resulting JWT via Authorization: Bearer, never handles credentials itself.
 */
export const supabase = createClient(url || "http://localhost:54321", anonKey || "placeholder-anon-key");
