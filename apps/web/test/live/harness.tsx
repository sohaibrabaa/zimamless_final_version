import { render, type RenderResult } from "@testing-library/react";
import en from "@/messages/en.json";
import ar from "@/messages/ar.json";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { I18nProvider } from "@/lib/i18n/dictionary-context";
import { configureApiClient } from "@/lib/api/client";

/**
 * Shared harness for the **live** screen tests.
 *
 * These tests exist because of a gap the promotion rule names precisely: an
 * integration test proves the endpoint, and proves nothing about the screen
 * that consumes it. Every Phase 5–8 endpoint is proved live by a jest suite,
 * and every screen still runs on MSW mocks — so the two halves of this product
 * have never met. A field the API renames, an error shape a hook does not
 * expect, a money string parsed into a number: none of that is visible to
 * either suite alone.
 *
 * So: real Supabase login, real JWT, real HTTP to the running API, real React
 * components rendering the real response. No MSW is installed in this config,
 * so anything that tries to reach the network reaches the network.
 *
 * `messages/*.json` is imported directly rather than through `getDictionary`,
 * which is `server-only` and refuses to load in jsdom.
 */

const SUPABASE = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
const ANON = process.env.SUPABASE_ANON_KEY ?? "";
const PASSWORD = process.env.SEED_USER_PASSWORD ?? "Zimmamless#2026";

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000/v1";

export const PERSONAS = {
  supplier: "owner@alnoor.zimmamless.test",
  bankOps: "ops@jnb.zimmamless.test",
  /** BANK_ANALYST + BANK_OFFER_MAKER — the marketplace and offer roles. */
  bankMaker: "maker@jnb.zimmamless.test",
  platformOps: "admin@platform.zimmamless.test",
  compliance: "compliance@platform.zimmamless.test",
} as const;

export type Persona = keyof typeof PERSONAS;

export interface Session {
  token: string;
  userId: string;
  organizationId: string;
  organizationType: string;
}

const sessions = new Map<Persona, Session>();

/** Real password-grant login, then the real `/auth/me` to find the membership. */
export async function signIn(persona: Persona): Promise<Session> {
  const cached = sessions.get(persona);
  if (cached) return cached;

  const res = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email: PERSONAS[persona], password: PASSWORD }),
  });
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) {
    throw new Error(
      `Could not sign in as ${PERSONAS[persona]}. Is the seed applied and SUPABASE_* set?`
    );
  }

  const me = await fetch(`${API_BASE}/auth/me`, {
    headers: { Authorization: `Bearer ${body.access_token}` },
  });
  if (!me.ok) {
    throw new Error(
      `GET /auth/me returned ${me.status} for ${persona}. Is the API running on ${API_BASE}?`
    );
  }
  const profile = (await me.json()) as {
    user: { id: string };
    memberships: { organizationId: string; organizationType: string }[];
  };

  // The first membership is the working one for every seeded persona except
  // the deliberately multi-org support user, which these tests do not use.
  const membership = profile.memberships[0];
  if (!membership) throw new Error(`${persona} has no membership.`);

  const session: Session = {
    token: body.access_token,
    userId: profile.user.id,
    organizationId: membership.organizationId,
    organizationType: membership.organizationType,
  };
  sessions.set(persona, session);
  return session;
}

/**
 * Points the shared api client at a real session.
 *
 * This is the same `configureApiClient` the browser calls from
 * `SessionProvider`, so the request the component makes here carries exactly
 * the headers it carries in the app — including `X-Organization-Id`, whose
 * absence was a real Phase 1 bug that mocks could not see.
 */
export function useSessionForApi(session: Session, locale: "en" | "ar" = "en"): void {
  configureApiClient({
    getAccessToken: () => session.token,
    getActiveOrganizationId: () => session.organizationId,
    getLocale: () => locale,
  });
}

export function renderLive(ui: React.ReactNode, locale: "en" | "ar" = "en"): RenderResult {
  const dictionary = (locale === "ar" ? ar : en) as unknown as Dictionary;
  return render(<I18nProvider locale={locale} dictionary={dictionary}>{ui}</I18nProvider>);
}

/** A direct authenticated call, for arranging or reading state around a render. */
export async function apiFetch(
  session: Session,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${session.token}`,
      "X-Organization-Id": session.organizationId,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}
