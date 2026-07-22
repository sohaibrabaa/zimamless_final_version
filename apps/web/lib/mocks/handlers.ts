import { http, HttpResponse } from "msw";
import { mockUsers, type MockPersonaKey } from "./data";
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

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000/v1";

// Dev-only header letting the auth mock UI pick which seeded persona is
// "logged in" without a real backend — never read in production code paths.
const PERSONA_HEADER = "x-mock-persona";

function personaFrom(request: Request): MockPersonaKey {
  const key = request.headers.get(PERSONA_HEADER) as MockPersonaKey | null;
  return key && key in mockUsers ? key : "supplier-owner";
}

function notFound(message: string) {
  return HttpResponse.json({ code: "NOT_FOUND", message }, { status: 404 });
}

function validationError(message: string) {
  return HttpResponse.json({ code: "VALIDATION_ERROR", message }, { status: 400 });
}

/**
 * The reviewer queue is role-scoped server-side (`/onboarding/applications-list`
 * — supplier sees its own, PLATFORM_SUPPLIER_REVIEWER sees the queue). The mock
 * reproduces that split off the persona so the supplier screen can never
 * accidentally be built against the full queue and then break when it goes live.
 */
function isReviewerPersona(request: Request): boolean {
  const me = mockUsers[personaFrom(request)];
  return me.memberships.some((m) => m.organizationType === "PLATFORM");
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

  // -----------------------------------------------------------------
  // PHASE 2 — SUPPLIER ONBOARDING
  // -----------------------------------------------------------------

  // D-04 bootstrap. Exempt from X-Organization-Id (the caller has no org yet);
  // idempotent per establishment number — a repeat call returns 200, not 201.
  http.post(`${API_BASE}/onboarding/register`, async ({ request }) => {
    const body = (await request.json()) as {
      nationalEstablishmentNumber?: string;
      professionLicenceNumber?: string;
    };
    if (!body.nationalEstablishmentNumber || !body.professionLicenceNumber) {
      return validationError("nationalEstablishmentNumber and professionLicenceNumber are required");
    }
    const existing = listApplications().find(
      (a) => a.nationalEstablishmentNumber === body.nationalEstablishmentNumber
    );
    const application = bootstrapApplication(
      body.nationalEstablishmentNumber,
      body.professionLicenceNumber
    );
    return HttpResponse.json(
      { organizationId: application.organizationId, applicationId: application.id },
      { status: existing ? 200 : 201 }
    );
  }),

  // D-05 list. Role-split, status filter, pagination.
  http.get(`${API_BASE}/onboarding/applications-list`, ({ request }) => {
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const pageParam = url.searchParams.get("page");
    const pageSizeParam = url.searchParams.get("pageSize");
    const page = pageParam ? Math.max(1, Math.trunc(+pageParam)) : 1;
    const pageSize = pageSizeParam ? Math.max(1, Math.trunc(+pageSizeParam)) : 20;

    const orgId = request.headers.get("X-Organization-Id");
    const scoped = isReviewerPersona(request)
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

  http.post(`${API_BASE}/onboarding/applications`, async ({ request }) => {
    const body = (await request.json()) as {
      nationalEstablishmentNumber?: string;
      professionLicenceNumber?: string;
    };
    if (!body.nationalEstablishmentNumber || !body.professionLicenceNumber) {
      return validationError("nationalEstablishmentNumber and professionLicenceNumber are required");
    }
    const application = bootstrapApplication(
      body.nationalEstablishmentNumber,
      body.professionLicenceNumber
    );
    return HttpResponse.json(application, { status: 201 });
  }),

  http.get(`${API_BASE}/onboarding/applications/:id`, ({ params }) => {
    const application = findApplication(String(params.id));
    return application ? HttpResponse.json(application) : notFound("Application not found");
  }),

  http.post(`${API_BASE}/onboarding/applications/:id/submit`, ({ params }) => {
    const application = findApplication(String(params.id));
    if (!application) return notFound("Application not found");
    if (application.status !== "DRAFT") {
      return HttpResponse.json(
        { code: "INVALID_STATE", message: "Only a DRAFT application can be submitted." },
        { status: 422 }
      );
    }
    // ZM-SON-012: refusal of an essential consent is a hard blocker, so the
    // server refuses the submission rather than letting it reach a reviewer.
    if (!application.consents?.some((c) => c.granted)) {
      return HttpResponse.json(
        { code: "CONSENTS_REQUIRED", message: "All required consents must be granted." },
        { status: 422 }
      );
    }
    return HttpResponse.json(submitApplication(String(params.id)));
  }),

  http.post(`${API_BASE}/onboarding/applications/:id/bank-account`, async ({ params, request }) => {
    const body = (await request.json()) as {
      iban?: string;
      bankName?: string;
      accountHolderName?: string;
    };
    if (!body.iban || !body.bankName || !body.accountHolderName) {
      return validationError("iban, bankName and accountHolderName are required");
    }
    const updated = recordBankAccount(String(params.id), {
      iban: body.iban,
      bankName: body.bankName,
      accountHolderName: body.accountHolderName,
    });
    return updated ? new HttpResponse(null, { status: 201 }) : notFound("Application not found");
  }),

  http.post(`${API_BASE}/onboarding/applications/:id/consents`, async ({ params, request }) => {
    const body = (await request.json()) as {
      consents?: { consentType: string; consentVersion: string; granted: boolean }[];
    };
    if (!Array.isArray(body.consents) || body.consents.length === 0) {
      return validationError("consents is required");
    }
    const updated = recordConsents(String(params.id), body.consents);
    return updated ? new HttpResponse(null, { status: 201 }) : notFound("Application not found");
  }),

  http.get(`${API_BASE}/onboarding/applications/:id/information-requests`, ({ params }) => {
    const application = findApplication(String(params.id));
    if (!application) return notFound("Application not found");
    return HttpResponse.json(application.informationRequests ?? []);
  }),

  http.post(`${API_BASE}/onboarding/applications/:id/respond`, async ({ params, request }) => {
    const body = (await request.json()) as { informationRequestId?: string; response?: string };
    if (!body.informationRequestId || !body.response) {
      return validationError("informationRequestId and response are required");
    }
    const updated = respondToInformationRequest(String(params.id), body.informationRequestId);
    return updated ? new HttpResponse(null, { status: 200 }) : notFound("Application not found");
  }),

  http.post(`${API_BASE}/onboarding/applications/:id/decide`, async ({ params, request }) => {
    const body = (await request.json()) as {
      decision?: string;
      reasonCode?: string;
      notes?: string;
    };
    if (!body.decision) return validationError("decision is required");
    if (!isReviewerPersona(request)) {
      return HttpResponse.json(
        { code: "FORBIDDEN", message: "PLATFORM_SUPPLIER_REVIEWER role required." },
        { status: 403 }
      );
    }
    const updated = decideApplication(
      String(params.id),
      body.decision,
      body.reasonCode,
      body.notes
    );
    return updated ? new HttpResponse(null, { status: 200 }) : notFound("Application not found");
  }),

  // -----------------------------------------------------------------
  // PHASE 2 — GOVERNMENT VERIFICATION
  // -----------------------------------------------------------------

  http.post(`${API_BASE}/government/lookup`, async ({ request }) => {
    const body = (await request.json()) as { source?: string; lookupKey?: string };
    if (!body.source || !body.lookupKey) {
      return validationError("source and lookupKey are required");
    }
    return HttpResponse.json(
      {
        id: `g0000000-0000-0000-0000-${Date.now().toString().slice(-12)}`,
        source: body.source,
        status: "PENDING",
        // Deliberately absent, not false: PENDING means we don't know yet
        // whether the source will answer (ZM-GOV-008).
      },
      { status: 202 }
    );
  }),

  http.get(`${API_BASE}/government/requests/:id`, ({ params }) => {
    const found = findGovernmentRequest(String(params.id));
    return found ? HttpResponse.json(found) : notFound("Government request not found");
  }),
];
