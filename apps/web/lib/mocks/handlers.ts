import { http, HttpResponse, passthrough } from "msw";
import { mockUsers, type MockPersonaKey } from "./data";
import { isLive, type EndpointStatusEntry } from "@/lib/api/endpoint-status";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001/v1";

/**
 * /health is served at the server root, outside the /v1 prefix, and is
 * deliberately absent from the frozen contract and from /docs-json — so it
 * is not in the generated client either. Deriving its URL from API_BASE's
 * origin keeps the mock pointing where the real one actually lives.
 */
const HEALTH_URL = new URL("/health", API_BASE).toString();

// Dev-only header letting the auth mock UI pick which seeded persona is
// "logged in" without a real backend — never read in production code paths.
const PERSONA_HEADER = "x-mock-persona";

function personaFrom(request: Request): MockPersonaKey {
  const key = request.headers.get(PERSONA_HEADER) as MockPersonaKey | null;
  return key && key in mockUsers ? key : "supplier-owner";
}

/** Mirrors the API's error envelope, correlation id included. */
function errorBody(code: string, message: string) {
  return { code, message, correlationId: `mock-${code.toLowerCase()}` };
}

/**
 * Registers a handler only while the endpoint is marked `mock`.
 *
 * Flipping an entry to "live" in endpoint-status.ts has to actually reach
 * the real API — otherwise the map is decorative and the dev badge reports a
 * promotion that never happened.
 */
function mockOnly<Method extends EndpointStatusEntry["method"]>(
  method: Method,
  contractPath: string,
  url: string,
  resolver: Parameters<typeof http.get>[1]
) {
  const verb = method.toLowerCase() as "get" | "post" | "patch" | "put" | "delete";
  return http[verb](url, (info) => (isLive(method, contractPath) ? passthrough() : resolver(info)));
}

export const handlers = [
  mockOnly("GET", "/health", HEALTH_URL, () =>
    HttpResponse.json({ status: "ok", database: "ok" })
  ),

  mockOnly("GET", "/auth/me", `${API_BASE}/auth/me`, ({ request }) =>
    HttpResponse.json(mockUsers[personaFrom(request)])
  ),

  mockOnly("POST", "/auth/context", `${API_BASE}/auth/context`, async ({ request }) => {
    const body = (await request.json()) as { organizationId?: string };
    if (!body.organizationId) {
      return HttpResponse.json(
        errorBody("VALIDATION_FAILED", "organizationId is required"),
        { status: 400 }
      );
    }

    // The live API answers one identical 403 whether the organization does
    // not exist or the user merely is not a member of it — the pair must not
    // become an oracle for which organization ids exist. Mirroring that here
    // is what makes the mock→live swap behave the same.
    const me = mockUsers[personaFrom(request)];
    const isMember = me.memberships.some((m) => m.organizationId === body.organizationId);
    if (!isMember) {
      return HttpResponse.json(
        errorBody("ORGANIZATION_CONTEXT_INVALID", "No active membership in that organization."),
        { status: 403 }
      );
    }

    // 200 and no body, exactly as the contract specifies — not 201. (The
    // live API additionally returns {organizationId}; that field is absent
    // from the contract, so nothing may depend on it. Filed as Q-04.)
    return new HttpResponse(null, { status: 200 });
  }),

  mockOnly("PATCH", "/auth/language", `${API_BASE}/auth/language`, async ({ request }) => {
    const body = (await request.json()) as { language?: string };
    if (body.language !== "EN" && body.language !== "AR") {
      return HttpResponse.json(
        errorBody("VALIDATION_FAILED", "language must be EN or AR"),
        { status: 400 }
      );
    }
    return new HttpResponse(null, { status: 200 });
  }),
];
