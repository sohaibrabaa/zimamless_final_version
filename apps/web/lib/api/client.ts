import createClient from "openapi-fetch";
import type { paths } from "./generated/schema";
import type { Locale } from "@/lib/i18n/locales";

export type { paths } from "./generated/schema";

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  correlationId?: string;
  /**
   * A few endpoints declare an inline error schema rather than the Error
   * envelope and put a field beside `code` — the funding confirm 401's
   * `attemptsRemaining` is the one that exists today. Left open so those
   * fields survive onto `ApiError.body` instead of being dropped here.
   */
  [key: string]: unknown;
}

export class ApiError extends Error {
  code: string;
  details?: Record<string, unknown>;
  correlationId?: string;
  status: number;
  /** The response body verbatim, for endpoints declaring fields outside the envelope. */
  body: ApiErrorBody;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = "ApiError";
    this.status = status;
    this.code = body.code;
    this.details = body.details;
    this.correlationId = body.correlationId;
    this.body = body;
  }
}

interface ClientContext {
  getAccessToken: () => string | null;
  getActiveOrganizationId: () => string | null;
  getLocale: () => Locale;
  /** Dev-only: selects which seeded persona MSW returns from /auth/me. No-op against a real API. */
  getMockPersona?: () => string | null;
}

let context: ClientContext = {
  getAccessToken: () => null,
  getActiveOrganizationId: () => null,
  getLocale: () => "en",
};

/** Wired once from a client-side auth/org provider (Phase 1: Supabase session + org switcher). */
export function configureApiClient(next: ClientContext) {
  context = next;
}

const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000/v1";

export const apiClient = createClient<paths>({ baseUrl });

apiClient.use({
  onRequest({ request }) {
    const token = context.getAccessToken();
    if (token) request.headers.set("Authorization", `Bearer ${token}`);

    const orgId = context.getActiveOrganizationId();
    if (orgId) request.headers.set("X-Organization-Id", orgId);

    // Per contract cross-cutting rule 5: language is only ever the user's
    // explicit, persisted choice — never inferred from browser locale.
    request.headers.set("Accept-Language", context.getLocale());

    const persona = context.getMockPersona?.();
    if (persona) request.headers.set("x-mock-persona", persona);

    return request;
  },
  async onResponse({ response }) {
    if (!response.ok) {
      let body: ApiErrorBody;
      try {
        body = await response.clone().json();
      } catch {
        body = { code: "UNKNOWN_ERROR", message: response.statusText };
      }
      throw new ApiError(response.status, body);
    }
    return response;
  },
});

/** All POSTs that move money/financial state need this per contract rule 4. */
export function idempotencyHeader(key: string) {
  return { "Idempotency-Key": key };
}
