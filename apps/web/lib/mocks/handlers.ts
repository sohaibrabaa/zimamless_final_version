import { http, HttpResponse } from "msw";
import { mockUsers, type MockPersonaKey } from "./data";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000/v1";

// Dev-only header letting the auth mock UI pick which seeded persona is
// "logged in" without a real backend — never read in production code paths.
const PERSONA_HEADER = "x-mock-persona";

function personaFrom(request: Request): MockPersonaKey {
  const key = request.headers.get(PERSONA_HEADER) as MockPersonaKey | null;
  return key && key in mockUsers ? key : "supplier-owner";
}

export const handlers = [
  http.get(`${API_BASE}/health`, () => {
    return HttpResponse.json({ status: "ok" });
  }),

  http.get(`${API_BASE}/auth/me`, ({ request }) => {
    return HttpResponse.json(mockUsers[personaFrom(request)]);
  }),

  http.post(`${API_BASE}/auth/context`, async ({ request }) => {
    const body = (await request.json()) as { organizationId?: string };
    if (!body.organizationId) {
      return HttpResponse.json(
        { code: "VALIDATION_ERROR", message: "organizationId is required" },
        { status: 400 }
      );
    }
    return new HttpResponse(null, { status: 200 });
  }),

  http.patch(`${API_BASE}/auth/language`, async ({ request }) => {
    const body = (await request.json()) as { language?: string };
    if (body.language !== "EN" && body.language !== "AR") {
      return HttpResponse.json(
        { code: "VALIDATION_ERROR", message: "language must be EN or AR" },
        { status: 400 }
      );
    }
    return new HttpResponse(null, { status: 200 });
  }),
];
