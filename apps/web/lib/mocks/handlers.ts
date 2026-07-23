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
import {
  createDocument,
  createTransaction,
  extractionForDocument,
  findBuyerById,
  findDocument,
  findTransaction,
  linkBuyer,
  listTransactions,
  resolveBuyer,
  searchBuyers,
  setDeclarations,
  setInvoice,
  setMinimumAmount,
  setTransactionState,
  submitTransaction,
  verificationFor,
  type MockTransaction,
} from "./transaction-store";
import { riskForTransaction } from "./risk-store";
import {
  acceptOffer,
  activateListing,
  approveOffer,
  bankListingView,
  createOffer,
  currentListingForTransaction,
  findListingRecord,
  findOffer,
  findSnapshotForTransaction,
  listEligibleListingsForBank,
  listOffersForBank,
  listOffersForListing,
  rejectAllOffers,
  reviseOffer,
  supplierListingView,
  withdrawOffer,
  type AcceptedOfferSnapshotRecord,
} from "./marketplace-store";
import { createFilter, listFilters, updateFilter } from "./policy-filter-store";
import {
  confirmOtp as confirmFundingOtp,
  findSettlementByTransaction,
  generateOtp as generateFundingOtp,
  markSent as fundingMarkSent,
  retryPayout as retryFundingPayout,
} from "./funding-store";
import {
  conditionsForTransaction,
  findContractById,
  findContractForTransaction,
  fulfilCondition,
  generateContract,
  signContract,
  type ContractRecord,
} from "./contract-store";
import type { PolicyFilterRecord } from "@/lib/marketplace/policy-filters";
import type { OfferInputPayload } from "@/lib/marketplace/offer-domain";

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

/** The active membership for the calling persona's `X-Organization-Id`, if any. */
function activeMembership(request: Request) {
  const orgId = request.headers.get("X-Organization-Id");
  return mockUsers[personaFrom(request)].memberships.find((m) => m.organizationId === orgId);
}

/** AS-01 default: Supplier Owner (the only seeded role matching "Owner/Admin"). */
function hasAcceptanceRole(request: Request): boolean {
  const membership = activeMembership(request);
  return membership?.organizationType === "SUPPLIER" && !!membership.roles?.includes("SUPPLIER_OWNER");
}

/**
 * ZM-CON-008/010: only an authorized signatory of the transaction's own
 * supplier org, or of the winning bank's own org, may sign — and only for
 * their own side. Returns which side they signed for, or undefined if not
 * authorized at all.
 */
function signerAuthorization(
  request: Request,
  transactionId: string
): { organizationType: "SUPPLIER" | "BANK" } | undefined {
  const membership = activeMembership(request);
  if (!membership?.isAuthorizedSignatory) return undefined;
  const transaction = findTransaction(transactionId);
  if (membership.organizationType === "SUPPLIER" && membership.organizationId === transaction?.organizationId) {
    return { organizationType: "SUPPLIER" };
  }
  const snapshot = findSnapshotForTransaction(transactionId);
  if (membership.organizationType === "BANK" && membership.organizationId === snapshot?.bankOrganizationId) {
    return { organizationType: "BANK" };
  }
  return undefined;
}

/**
 * `AcceptedOfferSnapshot` as declared omits half the money components and
 * types `conditionsSnapshot` as an array of empty objects (Q-15) — the
 * mock returns its full internal record, and the client widens the
 * generated type to read the extra fields, same pattern as Q-14.
 */
function toSnapshotResponse(snapshot: AcceptedOfferSnapshotRecord) {
  return snapshot;
}

/**
 * `Contract` has no field for the rendered document text — a real API
 * would more likely serve it via `documentId` + a signed download URL, the
 * pattern Phase 3's documents already use. This mock renders text
 * synchronously server-side and returns it inline (`bodyEn`/`bodyAr`)
 * rather than standing up a second signed-URL flow for one document type;
 * the client widens `Contract` to read it, under the same Q-15 umbrella.
 */
function toContractResponse(contract: ContractRecord) {
  return contract;
}

function isBankCaller(request: Request): boolean {
  return activeMembership(request)?.organizationType === "BANK";
}

function currentActor(request: Request): { userId: string; userName: string } {
  const me = mockUsers[personaFrom(request)];
  return { userId: me.user!.id!, userName: me.user!.fullName! };
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

  // -------------------------------------------------------------------
  // PHASE 3 — BUYERS
  // -------------------------------------------------------------------

  mockOnly("GET", "/buyers/search", `${API_BASE}/buyers/search`, ({ request }) => {
    const q = new URL(request.url).searchParams.get("q") ?? "";
    if (q.trim().length < 2) {
      return HttpResponse.json(
        errorBody("VALIDATION_FAILED", "q must be at least 2 characters"),
        { status: 400 }
      );
    }
    // Note what this response deliberately does not contain: any notion of a
    // selected or best candidate. ZM-BUY-009 forbids the platform choosing on
    // name similarity "under any circumstances", so there is no field for the
    // UI to read even if it wanted to.
    return HttpResponse.json(searchBuyers(q));
  }),

  mockOnly("POST", "/buyers/resolve", `${API_BASE}/buyers/resolve`, async ({ request }) => {
    const body = (await request.json()) as {
      nationalEstablishmentNumber?: string;
      confirmedByUser?: boolean;
      contact?: {
        contactName: string;
        contactRole: string;
        contactPhone: string;
        contactEmail?: string;
      };
    };
    if (!body.nationalEstablishmentNumber) {
      return HttpResponse.json(
        errorBody("VALIDATION_FAILED", "nationalEstablishmentNumber is required"),
        { status: 400 }
      );
    }
    // `confirmedByUser` must be true — the contract describes it as "explicit
    // supplier confirmation", which is the wire-level expression of the
    // never-auto-select rule. Accepting a falsy value here would let a future
    // caller resolve a buyer nobody chose.
    if (body.confirmedByUser !== true) {
      return HttpResponse.json(
        errorBody("VALIDATION_FAILED", "confirmedByUser must be true — the supplier must choose the buyer."),
        { status: 400 }
      );
    }

    const orgId = request.headers.get("X-Organization-Id") ?? "";
    const result = resolveBuyer(orgId, body.nationalEstablishmentNumber, body.contact);
    if (result.ok) return HttpResponse.json(result.buyer, { status: 200 });

    if (result.error === "NOT_FOUND") {
      return HttpResponse.json(errorBody("NOT_FOUND", "No registry record for that establishment number."), {
        status: 404,
      });
    }
    return HttpResponse.json(
      {
        ...errorBody("BUYER_BLOCKED", "This buyer cannot be financed while its registry record is in this state."),
        details: { registryStatus: result.registryStatus },
      },
      { status: 409 }
    );
  }),

  mockOnly("GET", "/buyers/{id}", `${API_BASE}/buyers/:id`, ({ params }) => {
    const buyer = findBuyerById(String(params.id));
    return buyer
      ? HttpResponse.json(buyer)
      : HttpResponse.json(errorBody("NOT_FOUND", "Buyer not found"), { status: 404 });
  }),

  // -------------------------------------------------------------------
  // PHASE 3 — DOCUMENTS
  // -------------------------------------------------------------------

  mockOnly("POST", "/documents/upload-url", `${API_BASE}/documents/upload-url`, async ({ request }) => {
    const body = (await request.json()) as {
      documentType?: string;
      fileName?: string;
      mimeType?: string;
      sizeBytes?: number;
      subjectType?: string;
      subjectId?: string;
    };
    if (!body.documentType || !body.fileName || !body.mimeType || body.sizeBytes === undefined) {
      return HttpResponse.json(
        errorBody("VALIDATION_FAILED", "documentType, fileName, mimeType and sizeBytes are required"),
        { status: 400 }
      );
    }
    const doc = createDocument({
      documentType: body.documentType,
      fileName: body.fileName,
      mimeType: body.mimeType,
      sizeBytes: body.sizeBytes,
      subjectId: body.subjectId,
    });
    return HttpResponse.json({
      documentId: doc.id,
      // A mock URL that is deliberately not a real storage endpoint. The
      // authorization that makes the real one safe (ZM-DOC-004) happens
      // server-side, and a mock cannot stand in for it — so this must never
      // be mistaken for a working upload target.
      uploadUrl: `https://mock-storage.zimmamless.test/upload/${doc.id}`,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });
  }),

  mockOnly("GET", "/documents/{id}/download-url", `${API_BASE}/documents/:id/download-url`, ({ params, request }) => {
    const doc = findDocument(String(params.id));
    if (!doc) {
      return HttpResponse.json(errorBody("NOT_FOUND", "Document not found"), { status: 404 });
    }
    // The signed-URL authorization drill in the phase checkpoint is a bank JWT
    // failing to fetch a supplier's document. Reproduced here so the UI path
    // exists on both sides of the swap — but the real check is Agent A's, and
    // a 404 (not 403) is the same no-enumeration-oracle choice the rest of the
    // API makes.
    const isBank = mockUsers[personaFrom(request)].memberships.some(
      (m) => m.organizationType === "BANK"
    );
    if (isBank) {
      return HttpResponse.json(errorBody("NOT_FOUND", "Document not found"), { status: 404 });
    }
    return HttpResponse.json({
      url: `https://mock-storage.zimmamless.test/download/${doc.id}`,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
  }),

  mockOnly("GET", "/documents/{id}/extraction", `${API_BASE}/documents/:id/extraction`, ({ params }) => {
    const extraction = extractionForDocument(String(params.id));
    return extraction
      ? HttpResponse.json(extraction)
      : HttpResponse.json(errorBody("NOT_FOUND", "No extraction for that document"), { status: 404 });
  }),

  // -------------------------------------------------------------------
  // PHASE 3 — TRANSACTIONS
  // -------------------------------------------------------------------

  mockOnly("GET", "/transactions", `${API_BASE}/transactions`, ({ request }) => {
    const url = new URL(request.url);
    const state = url.searchParams.get("state");
    const page = Math.max(1, Math.trunc(+(url.searchParams.get("page") ?? 1)) || 1);
    const pageSize = Math.max(1, Math.trunc(+(url.searchParams.get("pageSize") ?? 20)) || 20);
    const orgId = request.headers.get("X-Organization-Id");

    const scoped = listTransactions(orgId);
    const filtered = state ? scoped.filter((t) => t.state === state) : scoped;
    const start = (page - 1) * pageSize;

    return HttpResponse.json({
      items: filtered.slice(start, start + pageSize).map(toSummary),
      pagination: {
        page,
        pageSize,
        total: filtered.length,
        totalPages: Math.max(1, Math.ceil(filtered.length / pageSize)),
      },
    });
  }),

  mockOnly("POST", "/transactions", `${API_BASE}/transactions`, ({ request }) => {
    const orgId = request.headers.get("X-Organization-Id");
    if (!orgId) {
      return HttpResponse.json(
        errorBody("ORGANIZATION_CONTEXT_REQUIRED", "X-Organization-Id is required."),
        { status: 403 }
      );
    }
    return HttpResponse.json(createTransaction(orgId), { status: 201 });
  }),

  mockOnly("GET", "/transactions/{id}", `${API_BASE}/transactions/:id`, ({ params, request }) => {
    const transaction = findTransaction(String(params.id));
    if (!transaction) {
      return HttpResponse.json(errorBody("NOT_FOUND", "Transaction not found"), { status: 404 });
    }
    return HttpResponse.json(forCaller(transaction, request));
  }),

  mockOnly("PUT", "/transactions/{id}/invoice", `${API_BASE}/transactions/:id/invoice`, async ({ params, request }) => {
    const body = (await request.json()) as Record<string, string>;
    const required = [
      "invoiceNumber",
      "einvoiceIdentifier",
      "issueDate",
      "dueDate",
      "subtotalAmount",
      "taxAmount",
      "faceValue",
    ];
    const missing = required.filter((f) => !body[f]);
    if (missing.length > 0) {
      return HttpResponse.json(
        { ...errorBody("VALIDATION_FAILED", `Missing: ${missing.join(", ")}`), details: { missing } },
        { status: 400 }
      );
    }
    const updated = setInvoice(String(params.id), body as never);
    return updated
      ? HttpResponse.json(updated.invoice)
      : HttpResponse.json(errorBody("NOT_FOUND", "Transaction not found"), { status: 404 });
  }),

  mockOnly("PUT", "/transactions/{id}/buyer", `${API_BASE}/transactions/:id/buyer`, async ({ params, request }) => {
    const body = (await request.json()) as {
      buyerId?: string;
      contact?: {
        contactName: string;
        contactRole: string;
        contactPhone: string;
        contactEmail?: string;
      };
    };
    if (!body.buyerId) {
      return HttpResponse.json(errorBody("VALIDATION_FAILED", "buyerId is required"), { status: 400 });
    }
    const updated = linkBuyer(String(params.id), body.buyerId, body.contact);
    return updated
      ? new HttpResponse(null, { status: 200 })
      : HttpResponse.json(errorBody("NOT_FOUND", "Transaction or buyer not found"), { status: 404 });
  }),

  mockOnly("PUT", "/transactions/{id}/minimum-amount", `${API_BASE}/transactions/:id/minimum-amount`, async ({ params, request }) => {
    const body = (await request.json()) as { minimumAcceptableAmount?: string };
    if (!body.minimumAcceptableAmount) {
      return HttpResponse.json(
        errorBody("VALIDATION_FAILED", "minimumAcceptableAmount is required"),
        { status: 400 }
      );
    }
    const result = setMinimumAmount(String(params.id), body.minimumAcceptableAmount);
    if (result.ok) return new HttpResponse(null, { status: 200 });
    if (result.error === "NOT_FOUND") {
      return HttpResponse.json(errorBody("NOT_FOUND", "Transaction not found"), { status: 404 });
    }
    // The contract declares 422 for "exceeds invoice outstanding amount"; a
    // non-positive floor is the same class of refusal and uses the same code.
    return HttpResponse.json(
      {
        ...errorBody(
          "VALIDATION_FAILED",
          result.error === "EXCEEDS_OUTSTANDING"
            ? "The minimum cannot exceed the outstanding amount."
            : "The minimum must be greater than zero."
        ),
        details: { reason: result.error },
      },
      { status: 422 }
    );
  }),

  mockOnly("POST", "/transactions/{id}/declarations", `${API_BASE}/transactions/:id/declarations`, async ({ params, request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    const version = body.declarationTemplateVersion;
    if (typeof version !== "string" || version === "") {
      return HttpResponse.json(
        errorBody("VALIDATION_FAILED", "declarationTemplateVersion is required"),
        { status: 400 }
      );
    }
    // Every affirmation is `enum: [true]` in the contract, so anything other
    // than true is a malformed body rather than a recorded refusal.
    const affirmations = [
      "isAuthentic",
      "goodsDelivered",
      "unpaidAndNotCancelled",
      "noKnownDispute",
      "notPreviouslyFinanced",
      "buyerIsNamedEntity",
      "contactIsBuyerRep",
      "acceptsRecourse",
    ];
    const unaffirmed = affirmations.filter((k) => body[k] !== true);
    if (unaffirmed.length > 0) {
      return HttpResponse.json(
        {
          ...errorBody("VALIDATION_FAILED", "All declarations must be affirmed."),
          details: { unaffirmed },
        },
        { status: 400 }
      );
    }
    const updated = setDeclarations(String(params.id), version);
    return updated
      ? new HttpResponse(null, { status: 201 })
      : HttpResponse.json(errorBody("NOT_FOUND", "Transaction not found"), { status: 404 });
  }),

  mockOnly("POST", "/transactions/{id}/submit", `${API_BASE}/transactions/:id/submit`, ({ params, request }) => {
    const result = submitTransaction(String(params.id));
    if (result.ok) return HttpResponse.json(forCaller(result.transaction, request));

    switch (result.error) {
      case "NOT_FOUND":
        return HttpResponse.json(errorBody("NOT_FOUND", "Transaction not found"), { status: 404 });
      case "INVALID_STATE_TRANSITION":
        return HttpResponse.json(
          errorBody("INVALID_STATE_TRANSITION", "Only a DRAFT transaction can be submitted."),
          { status: 409 }
        );
      case "INCOMPLETE":
        return HttpResponse.json(
          {
            ...errorBody("VALIDATION_FAILED", "The submission is incomplete."),
            details: { missing: result.missing },
          },
          { status: 422 }
        );
      case "DUPLICATE":
        // ZM-VER-001. The review reference travels in `details`, which the
        // contract declares free-form — the assumption is isolated in
        // lib/invoices/duplicate.ts and filed as Q-11.
        return HttpResponse.json(
          {
            ...errorBody(
              "DUPLICATE_INVOICE",
              "This invoice has already been submitted to the platform."
            ),
            details: { reviewReference: result.reviewReference },
          },
          { status: 409 }
        );
    }
  }),

  mockOnly("GET", "/transactions/{id}/verification", `${API_BASE}/transactions/:id/verification`, ({ params }) => {
    const run = verificationFor(String(params.id));
    return run
      ? HttpResponse.json(run)
      : HttpResponse.json(errorBody("NOT_FOUND", "No verification run for that transaction"), {
          status: 404,
        });
  }),

  // -------------------------------------------------------------------
  // PHASE 4 — RISK, TRUST SCORE
  // -------------------------------------------------------------------

  // The five components and dataAvailabilityPct are computed by
  // lib/risk/risk-engine.ts, not hard-coded here — the INV-9 property (a
  // sourceAvailability change moves only dataAvailabilityPct) has to survive
  // through this handler as well as through the pure function, or a screen
  // built against this endpoint could still show the bug the engine itself
  // is proven not to have.
  mockOnly("GET", "/transactions/{id}/risk", `${API_BASE}/transactions/:id/risk`, ({ params }) => {
    const risk = riskForTransaction(String(params.id));
    return risk
      ? HttpResponse.json(risk)
      : HttpResponse.json(
          errorBody("NOT_FOUND", "No risk assessment for that transaction yet."),
          { status: 404 }
        );
  }),

  // -------------------------------------------------------------------
  // PHASE 5 — MARKETPLACE + OFFERS
  // -------------------------------------------------------------------
  //
  // Listings and offers are read live off the Phase 3 transaction store
  // (via marketplace-store.ts) rather than a static fixture — activating a
  // listing genuinely requires an ELIGIBLE transaction, and every screen
  // below is driven by real store state, the same discipline Phase 2's and
  // Phase 3's stores established for their own checkpoints. The deadline
  // *jobs* (auto-close, expiry sweep) are Agent A's — nothing here advances
  // a listing past OPEN_FOR_OFFERS on its own; `isOfferWindowOpen` only
  // gates new writes once the deadline has passed.

  mockOnly("POST", "/transactions/{id}/listing", `${API_BASE}/transactions/:id/listing`, ({ params }) => {
    const result = activateListing(String(params.id));
    if (result.ok) return HttpResponse.json(supplierListingView(result.listing), { status: 201 });
    switch (result.error) {
      case "NOT_FOUND":
        return HttpResponse.json(errorBody("NOT_FOUND", "Transaction not found"), { status: 404 });
      case "ALREADY_LISTED":
        return HttpResponse.json(
          errorBody("INVALID_STATE_TRANSITION", "This transaction already has an open listing."),
          { status: 409 }
        );
      case "NOT_ELIGIBLE":
      default:
        // ZM-MKT-004: only an ELIGIBLE invoice may be listed.
        return HttpResponse.json(
          errorBody("INVALID_STATE_TRANSITION", "Only an ELIGIBLE invoice can be listed."),
          { status: 409 }
        );
    }
  }),

  mockOnly(
    "GET",
    "/transactions/{id}/listing-current",
    `${API_BASE}/transactions/:id/listing-current`,
    ({ params }) => {
      const listing = currentListingForTransaction(String(params.id));
      return listing
        ? HttpResponse.json(supplierListingView(listing))
        : HttpResponse.json(errorBody("NOT_FOUND", "No listing exists for this transaction"), {
            status: 404,
          });
    }
  ),

  mockOnly("GET", "/listings/{id}", `${API_BASE}/listings/:id`, ({ params }) => {
    const listing = findListingRecord(String(params.id));
    return listing
      ? HttpResponse.json(supplierListingView(listing))
      : HttpResponse.json(errorBody("NOT_FOUND", "Listing not found"), { status: 404 });
  }),

  // Role-split per the contract description: supplier sees every ACTIVE
  // offer in full; a bank sees only its own current offer.
  mockOnly("GET", "/listings/{id}/offers", `${API_BASE}/listings/:id/offers`, ({ params, request }) => {
    const isBank = isBankCaller(request);
    const orgId = request.headers.get("X-Organization-Id") ?? "";
    return HttpResponse.json(listOffersForListing(String(params.id), orgId, isBank));
  }),

  mockOnly("GET", "/marketplace/eligible", `${API_BASE}/marketplace/eligible`, ({ request }) => {
    const url = new URL(request.url);
    const page = Math.max(1, Math.trunc(+(url.searchParams.get("page") ?? 1)) || 1);
    const pageSize = Math.max(1, Math.trunc(+(url.searchParams.get("pageSize") ?? 20)) || 20);
    const orgId = request.headers.get("X-Organization-Id") ?? "";
    const items = listEligibleListingsForBank(orgId);
    const start = (page - 1) * pageSize;
    return HttpResponse.json({
      items: items.slice(start, start + pageSize),
      pagination: {
        page,
        pageSize,
        total: items.length,
        totalPages: Math.max(1, Math.ceil(items.length / pageSize)),
      },
    });
  }),

  mockOnly(
    "GET",
    "/marketplace/listings/{id}",
    `${API_BASE}/marketplace/listings/:id`,
    ({ params, request }) => {
      const orgId = request.headers.get("X-Organization-Id") ?? "";
      const result = bankListingView(String(params.id), orgId);
      if (result.ok) return HttpResponse.json(result.view);
      if (result.error === "NOT_FOUND") {
        return HttpResponse.json(errorBody("NOT_FOUND", "Listing not found"), { status: 404 });
      }
      return HttpResponse.json(
        errorBody("FORBIDDEN", "This bank is not eligible for this listing."),
        { status: 403 }
      );
    }
  ),

  // ---------------------------------------------------------------------
  // Policy filters (ZM-MKT-001, D-12)
  // ---------------------------------------------------------------------

  mockOnly("GET", "/banks/policy-filters", `${API_BASE}/banks/policy-filters`, ({ request }) => {
    const orgId = request.headers.get("X-Organization-Id") ?? "";
    return HttpResponse.json(listFilters(orgId));
  }),

  mockOnly("POST", "/banks/policy-filters", `${API_BASE}/banks/policy-filters`, async ({ request }) => {
    const orgId = request.headers.get("X-Organization-Id");
    if (!orgId) {
      return HttpResponse.json(
        errorBody("ORGANIZATION_CONTEXT_REQUIRED", "X-Organization-Id is required."),
        { status: 403 }
      );
    }
    const body = (await request.json()) as Omit<PolicyFilterRecord, "id" | "bankOrganizationId">;
    createFilter(orgId, body);
    return new HttpResponse(null, { status: 201 });
  }),

  mockOnly(
    "PATCH",
    "/banks/policy-filters/{id}",
    `${API_BASE}/banks/policy-filters/:id`,
    async ({ params, request }) => {
      const orgId = request.headers.get("X-Organization-Id") ?? "";
      const body = (await request.json()) as Partial<PolicyFilterRecord>;
      const updated = updateFilter(String(params.id), orgId, body);
      return updated
        ? new HttpResponse(null, { status: 200 })
        : HttpResponse.json(errorBody("NOT_FOUND", "Policy filter not found"), { status: 404 });
    }
  ),

  // ---------------------------------------------------------------------
  // Offers (§11) — creation, revision, approval, withdrawal
  // ---------------------------------------------------------------------

  mockOnly(
    "POST",
    "/listings/{id}/offers/create",
    `${API_BASE}/listings/:id/offers/create`,
    async ({ params, request }) => {
      const orgId = request.headers.get("X-Organization-Id") ?? "";
      const { userId, userName } = currentActor(request);
      const body = (await request.json()) as OfferInputPayload;
      const result = createOffer(String(params.id), orgId, userId, userName, body);
      if (result.ok) return HttpResponse.json(toOfferResponse(result.offer), { status: 201 });
      return offerErrorResponse(result.error);
    }
  ),

  mockOnly("GET", "/offers", `${API_BASE}/offers`, ({ request }) => {
    const url = new URL(request.url);
    const status = url.searchParams.get("status") ?? undefined;
    const orgId = request.headers.get("X-Organization-Id") ?? "";
    const items = listOffersForBank(orgId, status);
    return HttpResponse.json({ items, pagination: { page: 1, pageSize: items.length || 1, total: items.length, totalPages: 1 } });
  }),

  mockOnly("GET", "/offers/{id}", `${API_BASE}/offers/:id`, ({ params }) => {
    const offer = findOffer(String(params.id));
    return offer
      ? HttpResponse.json(toOfferResponse(offer))
      : HttpResponse.json(errorBody("NOT_FOUND", "Offer not found"), { status: 404 });
  }),

  mockOnly("PATCH", "/offers/{id}", `${API_BASE}/offers/:id`, async ({ params, request }) => {
    const orgId = request.headers.get("X-Organization-Id") ?? "";
    const { userId, userName } = currentActor(request);
    const body = (await request.json()) as OfferInputPayload;
    const result = reviseOffer(String(params.id), orgId, userId, userName, body);
    if (result.ok) return new HttpResponse(null, { status: 200 });
    return offerErrorResponse(result.error);
  }),

  mockOnly("POST", "/offers/{id}/approve", `${API_BASE}/offers/:id/approve`, ({ params, request }) => {
    const orgId = request.headers.get("X-Organization-Id") ?? "";
    const { userId } = currentActor(request);
    const result = approveOffer(String(params.id), orgId, userId);
    if (result.ok) return new HttpResponse(null, { status: 200 });
    if (result.error === "SELF_APPROVAL_FORBIDDEN") {
      return HttpResponse.json(
        errorBody("SELF_APPROVAL_FORBIDDEN", "An offer cannot be approved by the user who created it."),
        { status: 403 }
      );
    }
    return HttpResponse.json(errorBody("NOT_FOUND", "Offer not found"), { status: 404 });
  }),

  mockOnly("POST", "/offers/{id}/withdraw", `${API_BASE}/offers/:id/withdraw`, ({ params, request }) => {
    const orgId = request.headers.get("X-Organization-Id") ?? "";
    const result = withdrawOffer(String(params.id), orgId);
    return result.ok
      ? new HttpResponse(null, { status: 200 })
      : HttpResponse.json(errorBody("NOT_FOUND", "Offer not found"), { status: 404 });
  }),

  // -------------------------------------------------------------------
  // PHASE 6 — SELECTION, CONDITIONS, CONTRACTS
  // -------------------------------------------------------------------

  // ZM-SEL-001..008 / AS-01. A mock cannot reproduce a real
  // `SELECT … FOR UPDATE` transaction, but every observable invariant is
  // enforced in marketplace-store.ts's acceptOffer — see its own comment.
  mockOnly("POST", "/offers/{id}/accept", `${API_BASE}/offers/:id/accept`, ({ params, request }) => {
    const orgId = request.headers.get("X-Organization-Id") ?? "";
    if (!hasAcceptanceRole(request)) {
      return HttpResponse.json(
        errorBody("INSUFFICIENT_ROLE", "Only the Supplier Owner may accept an offer."),
        { status: 403 }
      );
    }
    const idempotencyKey = request.headers.get("Idempotency-Key") ?? "";
    const { userId } = currentActor(request);
    const result = acceptOffer(String(params.id), orgId, userId, idempotencyKey);
    if (result.ok) return HttpResponse.json(toSnapshotResponse(result.snapshot));
    switch (result.error) {
      case "NOT_FOUND":
        return HttpResponse.json(errorBody("NOT_FOUND", "Offer not found"), { status: 404 });
      case "ALREADY_LOCKED":
        return HttpResponse.json(
          errorBody("ALREADY_LOCKED", "This transaction has already been locked by an accepted offer."),
          { status: 409 }
        );
      case "OFFER_NOT_ACTIVE":
        return HttpResponse.json(errorBody("OFFER_NOT_ACTIVE", "This offer is no longer active."), {
          status: 409,
        });
      case "OFFER_EXPIRED":
        return HttpResponse.json(errorBody("OFFER_EXPIRED", "This offer has expired."), { status: 409 });
      default:
        // BELOW_FLOOR / INVALID_GROSS: re-validation failures at the moment
        // of acceptance (ZM-SEL-002 steps 1-3) — the same generic wording
        // as offer creation, never a number.
        return HttpResponse.json(
          errorBody("VALIDATION_FAILED", "This offer no longer meets the requirements to be accepted."),
          { status: 409 }
        );
    }
  }),

  mockOnly(
    "POST",
    "/listings/{id}/reject-all",
    `${API_BASE}/listings/:id/reject-all`,
    ({ params, request }) => {
      const orgId = request.headers.get("X-Organization-Id") ?? "";
      const result = rejectAllOffers(String(params.id), orgId);
      return result.ok
        ? new HttpResponse(null, { status: 200 })
        : HttpResponse.json(errorBody("NOT_FOUND", "Listing not found"), { status: 404 });
    }
  ),

  mockOnly("GET", "/transactions/{id}/contract", `${API_BASE}/transactions/:id/contract`, ({ params }) => {
    const contract = findContractForTransaction(String(params.id));
    return contract
      ? HttpResponse.json(toContractResponse(contract))
      : HttpResponse.json(errorBody("NOT_FOUND", "No contract has been generated for this transaction."), {
          status: 404,
        });
  }),

  mockOnly("POST", "/transactions/{id}/contract", `${API_BASE}/transactions/:id/contract`, ({ params }) => {
    const result = generateContract(String(params.id));
    if (result.ok) return HttpResponse.json(toContractResponse(result.contract), { status: 201 });
    if (result.error === "PRE_CONTRACT_CHECK_FAILED") {
      return HttpResponse.json(
        {
          ...errorBody("PRE_CONTRACT_CHECK_FAILED", "This transaction is not yet ready for a contract."),
          details: { failures: result.failures },
        },
        { status: 422 }
      );
    }
    return HttpResponse.json(
      errorBody("NOT_FOUND", result.error === "NOT_ACCEPTED" ? "No offer has been accepted on this transaction yet." : "Transaction not found"),
      { status: 404 }
    );
  }),

  mockOnly("POST", "/contracts/{id}/sign", `${API_BASE}/contracts/:id/sign`, async ({ params, request }) => {
    const membership = activeMembership(request);
    const contract = findContractById(String(params.id));
    if (!contract) return HttpResponse.json(errorBody("NOT_FOUND", "Contract not found"), { status: 404 });

    const authorization = signerAuthorization(request, contract.transactionId);
    if (!authorization) {
      return HttpResponse.json(
        errorBody("FORBIDDEN", "You are not an authorized signatory for this contract."),
        { status: 403 }
      );
    }

    const body = (await request.json()) as { accepted?: boolean };
    const { userName } = currentActor(request);
    const result = signContract(
      String(params.id),
      authorization.organizationType,
      userName,
      membership?.roles?.[0] ?? "Authorized Signatory",
      body.accepted === true
    );
    if (result.ok) return HttpResponse.json(toContractResponse(result.contract));
    if (result.error === "ALREADY_SIGNED") {
      return HttpResponse.json(
        errorBody("ALREADY_SIGNED", "Your organization has already signed this contract."),
        { status: 409 }
      );
    }
    if (result.error === "DECLINED") {
      return HttpResponse.json(errorBody("VALIDATION_FAILED", "accepted must be true to sign."), {
        status: 400,
      });
    }
    return HttpResponse.json(errorBody("NOT_FOUND", "Contract not found"), { status: 404 });
  }),

  mockOnly(
    "GET",
    "/transactions/{id}/conditions",
    `${API_BASE}/transactions/:id/conditions`,
    ({ params }) => HttpResponse.json(conditionsForTransaction(String(params.id)))
  ),

  mockOnly("POST", "/conditions/{id}/fulfil", `${API_BASE}/conditions/:id/fulfil`, async ({ params, request }) => {
    const body = (await request.json()) as { documentIds?: string[]; notes?: string } | null;
    const result = fulfilCondition(String(params.id), body?.documentIds ?? [], body?.notes);
    return result.ok
      ? new HttpResponse(null, { status: 200 })
      : HttpResponse.json(errorBody("NOT_FOUND", "Condition not found"), { status: 404 });
  }),

  // ---------------------------------------------------------------
  // Phase 7 — funding, OTP, settlement
  // ---------------------------------------------------------------

  mockOnly(
    "POST",
    "/transactions/{id}/funding/mark-sent",
    `${API_BASE}/transactions/:id/funding/mark-sent`,
    async ({ params, request }) => {
      const transactionId = String(params.id);
      const snapshot = findSnapshotForTransaction(transactionId);
      if (!snapshot) {
        return HttpResponse.json(
          errorBody("CONFLICT", "This transaction has no accepted offer to fund."),
          { status: 409 }
        );
      }

      const body = (await request.json().catch(() => null)) as { providerReference?: string } | null;
      // The settlement's money comes from the immutable snapshot, never from
      // the request — the same rule the API enforces, so a screen cannot be
      // built that expects to influence the numbers.
      const result = fundingMarkSent(
        transactionId,
        {
          grossFundingAmount: snapshot.grossFundingAmount,
          platformCommissionAmount: snapshot.platformCommissionAmount,
          listingFeeDeducted: snapshot.listingFeeAmount,
          netSupplierPayout: snapshot.netSupplierPayout,
        },
        body?.providerReference ?? null,
        new Date()
      );

      if (!result.ok) {
        return HttpResponse.json(
          errorBody("CONFLICT", "This transfer has already been marked sent."),
          { status: 409 }
        );
      }

      // FUNDING_CONFIRMATION_PENDING, not FUNDED. The bank cannot fund alone.
      setTransactionState(transactionId, "FUNDING_CONFIRMATION_PENDING");
      return HttpResponse.json(result.settlement);
    }
  ),

  mockOnly(
    "POST",
    "/transactions/{id}/funding/otp",
    `${API_BASE}/transactions/:id/funding/otp`,
    ({ params }) => {
      const result = generateFundingOtp(String(params.id), new Date());
      if (!result.ok) {
        return HttpResponse.json(
          errorBody("RATE_LIMITED", "Maximum regenerations reached for this transaction."),
          { status: 429 }
        );
      }
      // 201, per the contract — the only place this code is ever returned.
      return HttpResponse.json(
        { otp: result.otp, expiresAt: result.expiresAt, resendsRemaining: result.resendsRemaining },
        { status: 201 }
      );
    }
  ),

  mockOnly(
    "POST",
    "/transactions/{id}/funding/confirm",
    `${API_BASE}/transactions/:id/funding/confirm`,
    async ({ params, request }) => {
      const transactionId = String(params.id);
      const body = (await request.json().catch(() => null)) as { otp?: string } | null;
      const result = confirmFundingOtp(transactionId, String(body?.otp ?? ""), new Date());

      if (!result.ok) {
        // One shape for every failure. `attemptsRemaining` is the only detail
        // disclosed — no message that hints at wrong vs expired vs used.
        return HttpResponse.json(
          { ...errorBody("OTP_INVALID", "That code was not accepted."), attemptsRemaining: result.attemptsRemaining },
          { status: 401 }
        );
      }

      if (result.transactionState === "FUNDED") setTransactionState(transactionId, "FUNDED");
      return HttpResponse.json({
        transactionState: result.transactionState,
        fundedAt: result.fundedAt ?? undefined,
      });
    }
  ),

  mockOnly(
    "GET",
    "/transactions/{id}/settlement",
    `${API_BASE}/transactions/:id/settlement`,
    ({ params }) => {
      const settlement = findSettlementByTransaction(String(params.id));
      return settlement
        ? HttpResponse.json(settlement)
        : HttpResponse.json(errorBody("NOT_FOUND", "No settlement exists yet."), { status: 404 });
    }
  ),

  mockOnly("POST", "/settlements/{id}/retry", `${API_BASE}/settlements/:id/retry`, ({ params }) => {
    const settlement = retryFundingPayout(String(params.id), new Date());
    return settlement
      ? HttpResponse.json(settlement)
      : HttpResponse.json(errorBody("NOT_FOUND", "Settlement not found"), { status: 404 });
  }),
];

/**
 * The contract's `Offer` schema has no field for the maker's identity, so
 * the approval-queue's "creator shown" and the UI's own self-approval guard
 * have nothing declared to read. Filed as **Q-14** — the same class of gap
 * as Q-08/Q-12 (something a screen needs is missing from an otherwise
 * complete shape). The mock carries `createdByUserId`/`createdByUserName`
 * past the typed `Offer` response anyway (both endpoints here are bank-only,
 * scoped to the offer's own bank, so nothing confidential leaks); the
 * client widens the type locally to read them rather than the contract
 * declaring a second endpoint.
 */
function toOfferResponse(offer: ReturnType<typeof findOffer>) {
  return offer;
}

function offerErrorResponse(error: string) {
  switch (error) {
    case "NOT_FOUND":
      return HttpResponse.json(errorBody("NOT_FOUND", "Listing or offer not found"), { status: 404 });
    case "NOT_ELIGIBLE":
      return HttpResponse.json(
        errorBody("FORBIDDEN", "This bank is not eligible for this listing."),
        { status: 403 }
      );
    case "WINDOW_CLOSED":
      return HttpResponse.json(
        errorBody("OFFER_WINDOW_CLOSED", "The offer submission window has closed."),
        { status: 409 }
      );
    case "ALREADY_HAS_OFFER":
      return HttpResponse.json(
        errorBody("INVALID_STATE_TRANSITION", "This bank already has a current offer on this listing."),
        { status: 409 }
      );
    case "INVALID_GROSS":
      return HttpResponse.json(
        errorBody("VALIDATION_FAILED", "grossFundingAmount cannot exceed the invoice's outstanding amount."),
        { status: 422 }
      );
    case "BELOW_FLOOR":
    default:
      // ZM-MKT-012's design note: generic message, zero numeric detail.
      return HttpResponse.json(
        errorBody(
          "OFFER_BELOW_SUPPLIER_REQUIREMENT",
          "This offer does not currently meet the supplier's requirements."
        ),
        { status: 422 }
      );
  }
}

function toSummary(t: MockTransaction) {
  return {
    id: t.id,
    referenceNumber: t.referenceNumber,
    state: t.state,
    invoiceNumber: t.invoiceNumber,
    buyerName: t.buyerName,
    faceValue: t.faceValue,
    outstandingAmount: t.outstandingAmount,
    dueDate: t.dueDate,
    createdAt: t.createdAt,
  };
}

/**
 * Strips the supplier's floor from bank-facing responses.
 *
 * `minimumAcceptableAmount` is SUPPLIER AND PLATFORM ONLY — the contract says
 * it "MUST be absent from every bank-facing response", and the brief calls a
 * leak a critical defect. The live API and RLS (D-02) are the real boundary;
 * this exists so the mock cannot teach a screen that the field is always
 * present, which is exactly how a bank component ends up reading it.
 */
function forCaller(transaction: MockTransaction, request: Request) {
  const isBank = mockUsers[personaFrom(request)].memberships.some(
    (m) => m.organizationType === "BANK"
  );
  // Built field by field rather than by spreading and deleting: the store's
  // internal bookkeeping (organizationId, the raw verification run, the
  // relationship contact) is not part of any declared response, and an
  // allow-list is the shape that stays correct when the store grows a field.
  const payload: Record<string, unknown> = {
    id: transaction.id,
    referenceNumber: transaction.referenceNumber,
    state: transaction.state,
    invoiceNumber: transaction.invoiceNumber,
    buyerName: transaction.buyerName,
    faceValue: transaction.faceValue,
    outstandingAmount: transaction.outstandingAmount,
    dueDate: transaction.dueDate,
    createdAt: transaction.createdAt,
    submittedAt: transaction.submittedAt,
    invoice: transaction.invoice,
    buyer: transaction.buyer,
    declarationTemplateVersion: transaction.declarationTemplateVersion,
    // Q-12's resolution, and exactly the four fields the API sends — the
    // contract's listing `documents[]` shape (`{id, documentType}`) plus the
    // two a human needs to tell one attachment from another. `mimeType` and
    // `sizeBytes` were dropped from this payload deliberately: the mock used
    // to carry them, and a screen built against fields live does not send is
    // the drift the whole endpoint-status discipline exists to prevent.
    documents: transaction.documents.map((d) => ({
      id: d.id,
      documentType: d.documentType,
      fileName: d.fileName,
      uploadedAt: d.uploadedAt,
    })),
  };
  if (!isBank) payload.minimumAcceptableAmount = transaction.minimumAcceptableAmount;
  return payload;
}
