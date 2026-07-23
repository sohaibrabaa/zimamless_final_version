import { http, HttpResponse, passthrough } from "msw";
import { mockUsers, type MockPersonaKey } from "./data";
import { isLive, type EndpointStatusEntry } from "@/lib/api/endpoint-status";
import {
  bootstrapApplication,
  decideApplication,
  findApplication,
  findGovernmentRequest,
  listApplications,
  recordBankAccount,
  recordConsents,
  respondToInformationRequest,
  submitApplication,
} from "./onboarding-store";

// Fallback must match lib/api/client.ts exactly: the API owns port 3000
// (the contract's servers block names it; the web dev server is the one on
// 3001). A split here makes MSW intercept URLs the client never requests,
// and every mock silently misses.
const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000/v1";

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

/**
 * `POST /onboarding/applications/{id}/decide` is restricted to
 * PLATFORM_SUPPLIER_REVIEWER by the contract. Checking the role rather than
 * merely the organization type keeps the mock honest: a platform admin who
 * lacks the grant gets the same INSUFFICIENT_ROLE the live API would return,
 * instead of the UI appearing to work until integration day.
 */
function isSupplierReviewer(request: Request): boolean {
  return mockUsers[personaFrom(request)].memberships.some((m) =>
    m.roles?.includes("PLATFORM_SUPPLIER_REVIEWER")
  );
}

function isPlatformPersona(request: Request): boolean {
  return mockUsers[personaFrom(request)].memberships.some(
    (m) => m.organizationType === "PLATFORM"
  );
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

  // -------------------------------------------------------------------
  // PHASE 2 — SUPPLIER ONBOARDING
  // -------------------------------------------------------------------

  // D-04 bootstrap. Exempt from X-Organization-Id (the caller has no org
  // yet); idempotent per establishment number — a repeat call returns 200,
  // not 201, exactly as the overlay specifies.
  mockOnly("POST", "/onboarding/register", `${API_BASE}/onboarding/register`, async ({ request }) => {
    const body = (await request.json()) as {
      nationalEstablishmentNumber?: string;
      professionLicenceNumber?: string;
    };
    if (!body.nationalEstablishmentNumber || !body.professionLicenceNumber) {
      return HttpResponse.json(
        errorBody("VALIDATION_FAILED", "nationalEstablishmentNumber and professionLicenceNumber are required"),
        { status: 400 }
      );
    }
    const existed = listApplications().some(
      (a) => a.nationalEstablishmentNumber === body.nationalEstablishmentNumber
    );
    const application = bootstrapApplication(
      body.nationalEstablishmentNumber,
      body.professionLicenceNumber
    );
    return HttpResponse.json(
      { organizationId: application.organizationId, applicationId: application.id },
      { status: existed ? 200 : 201 }
    );
  }),

  // D-05 list. Role-split server-side: a supplier sees only its own, a
  // reviewer sees the queue. Reproducing the split here is what stops the
  // supplier screen being built against the full queue by accident.
  mockOnly("GET", "/onboarding/applications-list", `${API_BASE}/onboarding/applications-list`, ({ request }) => {
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const page = Math.max(1, Math.trunc(+(url.searchParams.get("page") ?? 1)) || 1);
    const pageSize = Math.max(1, Math.trunc(+(url.searchParams.get("pageSize") ?? 20)) || 20);

    const orgId = request.headers.get("X-Organization-Id");
    const scoped = isPlatformPersona(request)
      ? listApplications().filter((a) => a.status !== "DRAFT")
      : listApplications().filter((a) => !orgId || a.organizationId === orgId);

    const filtered = status ? scoped.filter((a) => a.status === status) : scoped;
    const start = (page - 1) * pageSize;

    return HttpResponse.json({
      items: filtered.slice(start, start + pageSize),
      pagination: {
        page,
        pageSize,
        total: filtered.length,
        totalPages: Math.max(1, Math.ceil(filtered.length / pageSize)),
      },
    });
  }),

  mockOnly("POST", "/onboarding/applications", `${API_BASE}/onboarding/applications`, async ({ request }) => {
    const body = (await request.json()) as {
      nationalEstablishmentNumber?: string;
      professionLicenceNumber?: string;
    };
    if (!body.nationalEstablishmentNumber || !body.professionLicenceNumber) {
      return HttpResponse.json(
        errorBody("VALIDATION_FAILED", "nationalEstablishmentNumber and professionLicenceNumber are required"),
        { status: 400 }
      );
    }
    return HttpResponse.json(
      bootstrapApplication(body.nationalEstablishmentNumber, body.professionLicenceNumber),
      { status: 201 }
    );
  }),

  mockOnly("GET", "/onboarding/applications/{id}", `${API_BASE}/onboarding/applications/:id`, ({ params }) => {
    const application = findApplication(String(params.id));
    return application
      ? HttpResponse.json(application)
      : HttpResponse.json(errorBody("NOT_FOUND", "Application not found"), { status: 404 });
  }),

  mockOnly("POST", "/onboarding/applications/{id}/submit", `${API_BASE}/onboarding/applications/:id/submit`, ({ params }) => {
    const application = findApplication(String(params.id));
    if (!application) {
      return HttpResponse.json(errorBody("NOT_FOUND", "Application not found"), { status: 404 });
    }
    if (application.status !== "DRAFT") {
      return HttpResponse.json(
        errorBody("INVALID_STATE_TRANSITION", "Only a DRAFT application can be submitted."),
        { status: 422 }
      );
    }
    // ZM-SON-012: refusal of an essential consent is a hard blocker, so the
    // server refuses the submission rather than letting it reach a reviewer.
    if (!application.consents?.some((c) => c.granted)) {
      return HttpResponse.json(
        errorBody("VALIDATION_FAILED", "All required consents must be granted."),
        { status: 422 }
      );
    }
    return HttpResponse.json(submitApplication(String(params.id)));
  }),

  mockOnly("POST", "/onboarding/applications/{id}/bank-account", `${API_BASE}/onboarding/applications/:id/bank-account`, async ({ params, request }) => {
    const body = (await request.json()) as {
      iban?: string;
      bankName?: string;
      accountHolderName?: string;
    };
    if (!body.iban || !body.bankName || !body.accountHolderName) {
      return HttpResponse.json(
        errorBody("VALIDATION_FAILED", "iban, bankName and accountHolderName are required"),
        { status: 400 }
      );
    }
    const updated = recordBankAccount(String(params.id), {
      iban: body.iban,
      bankName: body.bankName,
      accountHolderName: body.accountHolderName,
    });
    return updated
      ? new HttpResponse(null, { status: 201 })
      : HttpResponse.json(errorBody("NOT_FOUND", "Application not found"), { status: 404 });
  }),

  mockOnly("POST", "/onboarding/applications/{id}/consents", `${API_BASE}/onboarding/applications/:id/consents`, async ({ params, request }) => {
    const body = (await request.json()) as {
      consents?: { consentType: string; consentVersion: string; granted: boolean }[];
    };
    if (!Array.isArray(body.consents) || body.consents.length === 0) {
      return HttpResponse.json(errorBody("VALIDATION_FAILED", "consents is required"), { status: 400 });
    }
    const updated = recordConsents(String(params.id), body.consents);
    return updated
      ? new HttpResponse(null, { status: 201 })
      : HttpResponse.json(errorBody("NOT_FOUND", "Application not found"), { status: 404 });
  }),

  mockOnly("GET", "/onboarding/applications/{id}/information-requests", `${API_BASE}/onboarding/applications/:id/information-requests`, ({ params }) => {
    const application = findApplication(String(params.id));
    return application
      ? HttpResponse.json(application.informationRequests ?? [])
      : HttpResponse.json(errorBody("NOT_FOUND", "Application not found"), { status: 404 });
  }),

  mockOnly("POST", "/onboarding/applications/{id}/respond", `${API_BASE}/onboarding/applications/:id/respond`, async ({ params, request }) => {
    const body = (await request.json()) as { informationRequestId?: string; response?: string };
    if (!body.informationRequestId || !body.response) {
      return HttpResponse.json(
        errorBody("VALIDATION_FAILED", "informationRequestId and response are required"),
        { status: 400 }
      );
    }
    const updated = respondToInformationRequest(String(params.id), body.informationRequestId);
    return updated
      ? new HttpResponse(null, { status: 200 })
      : HttpResponse.json(errorBody("NOT_FOUND", "Application not found"), { status: 404 });
  }),

  mockOnly("POST", "/onboarding/applications/{id}/decide", `${API_BASE}/onboarding/applications/:id/decide`, async ({ params, request }) => {
    const body = (await request.json()) as {
      decision?: string;
      reasonCode?: string;
      notes?: string;
    };
    if (!body.decision) {
      return HttpResponse.json(errorBody("VALIDATION_FAILED", "decision is required"), { status: 400 });
    }
    if (!isSupplierReviewer(request)) {
      return HttpResponse.json(
        errorBody("INSUFFICIENT_ROLE", "PLATFORM_SUPPLIER_REVIEWER role required."),
        { status: 403 }
      );
    }
    const result = decideApplication(String(params.id), body.decision, body.reasonCode, body.notes);
    if (result.ok) return new HttpResponse(null, { status: 200 });
    return result.error === "NOT_FOUND"
      ? HttpResponse.json(errorBody("NOT_FOUND", "Application not found"), { status: 404 })
      : HttpResponse.json(
          errorBody("INVALID_STATE_TRANSITION", "The application cannot be decided in its current state."),
          { status: 409 }
        );
  }),

  // -------------------------------------------------------------------
  // PHASE 2 — GOVERNMENT VERIFICATION
  // -------------------------------------------------------------------

  mockOnly("POST", "/government/lookup", `${API_BASE}/government/lookup`, async ({ request }) => {
    const body = (await request.json()) as { source?: string; lookupKey?: string };
    if (!body.source || !body.lookupKey) {
      return HttpResponse.json(
        errorBody("VALIDATION_FAILED", "source and lookupKey are required"),
        { status: 400 }
      );
    }
    return HttpResponse.json(
      {
        id: `0eb00000-0000-4000-8000-${Date.now().toString().slice(-12)}`,
        source: body.source,
        status: "PENDING",
        // Deliberately absent, not false: PENDING means we do not yet know
        // whether the source will answer (ZM-GOV-008).
      },
      { status: 202 }
    );
  }),

  mockOnly("GET", "/government/requests/{id}", `${API_BASE}/government/requests/:id`, ({ params }) => {
    const found = findGovernmentRequest(String(params.id));
    return found
      ? HttpResponse.json(found)
      : HttpResponse.json(errorBody("NOT_FOUND", "Government request not found"), { status: 404 });
  }),
];
