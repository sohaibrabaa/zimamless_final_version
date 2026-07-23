/**
 * In-memory onboarding fixture store backing the Phase 2 MSW handlers.
 *
 * Stateful on purpose: the phase-2 integration checkpoint is a *sequence*
 * (register → wizard → submit → reviewer requests information → clock pauses →
 * supplier responds → clock resumes → reviewer approves), and static fixtures
 * can't demonstrate that the SLA pauses and resumes. This store reproduces the
 * state machine and clock transitions from requirements §5.5 so both halves of
 * the flow are exercisable before Agent A's endpoints land — then it drops out
 * of the request path endpoint by endpoint as entries flip to `live` in
 * endpoint-status.ts (handlers.ts calls passthrough() for those).
 *
 * Identities are the frozen ones from `docs/specs/GOV_DUMMY_DATA.md`, and org
 * ids are copied from `db/seed/0100_seed_dev.sql` — not invented. That is the
 * whole point of the shared identity list: after an endpoint goes live the
 * screen should show the same names and numbers it showed a minute earlier.
 *
 * Government payloads use the server's real shape — `{value, sourceKind,
 * source, retrievedAt}` — the **Q-05** resolution. If that ever changes, this
 * file and lib/onboarding/government.ts change together.
 */

import type { components } from "@/lib/api/generated/schema";
import type { GovernmentSource } from "@/lib/onboarding/government";
import { ORG } from "./data";

type SupplierApplication = components["schemas"]["SupplierApplication"];
type InformationRequest = components["schemas"]["InformationRequest"];
type GovernmentRequest = components["schemas"]["GovernmentRequest"];

/** Per-field provenance entry, exactly as the live API sends it (Q-05). */
interface GovField {
  value: string | string[] | null;
  sourceKind: "GOVERNMENT" | "SELF_DECLARED" | "DERIVED";
  source: GovernmentSource | null;
  retrievedAt: string;
}

export interface MockApplication extends SupplierApplication {
  /** Echoed back so the wizard can resume; not part of the frozen response shape. */
  nationalEstablishmentNumber?: string;
  professionLicenceNumber?: string;
  organizationName?: string;
  /** Q-07 recommended field — present so the UI path that reads it is exercised. */
  slaPausedReason?: string;
  /** Q-08 recommended field. */
  governmentRequests?: GovernmentRequest[];
  informationRequests?: InformationRequest[];
  consents?: { consentType: string; consentVersion: string; granted: boolean }[];
  bankAccount?: { iban: string; bankName: string; accountHolderName: string };
  decisionNotes?: string;
}

/**
 * S3 Jordan Valley Foods is frozen in GOV_DUMMY_DATA.md §2 but is **not yet in
 * `db/seed/0100_seed_dev.sql`** — that table marks it "no (Phase 2)", i.e. it
 * arrives with Agent A's Phase 2 seed. Its name and establishment number are
 * therefore authoritative; only this organization id is a placeholder, and it
 * is the one value in this file that has to be reconciled when A seeds S3.
 * Flagged in the daily log rather than left to be discovered at integration.
 */
const ORG_JORDAN_VALLEY_PENDING_SEED = "0e000000-0000-4000-8000-000000000007";

const RETRIEVED_AT = "2026-07-20T09:14:00.000Z";
const VALID_UNTIL = "2026-10-18T09:14:00.000Z";

function gov(value: string | string[] | null, source: GovernmentSource): GovField {
  return {
    value,
    sourceKind: "GOVERNMENT",
    source,
    retrievedAt: RETRIEVED_AT,
  };
}

function ccdBlock(name: string, establishmentNo: string, type: string, status: string) {
  return {
    legalCompanyName: gov(name, "CCD"),
    companyNumber: gov(`CR-${establishmentNo}`, "CCD"),
    companyType: gov(type, "CCD"),
    registryStatus: gov(status, "CCD"),
    registrationDate: gov("2016-03-14", "CCD"),
    registeredAddress: gov("Al-Abdali, Amman", "CCD"),
    governorate: gov("Amman", "CCD"),
    capital: gov("150000.000", "CCD"),
    authorizedSignatories: gov(["Rania Haddad"], "CCD"),
    businessPurposes: gov(["Wholesale trade", "Import and export"], "CCD"),
    partners: gov(["Rania Haddad (60%)", "Omar Khalil (40%)"], "CCD"),
  };
}

function istdBlock(establishmentNo: string) {
  return {
    taxNumber: gov(`TAX-${establishmentNo}`, "ISTD"),
    taxRegistrationStatus: gov("REGISTERED", "ISTD"),
  };
}

function gamBlock(licence: string, status: string, expiry: string) {
  return {
    licenceNumber: gov(licence, "GAM"),
    licenceStatus: gov(status, "GAM"),
    licenceActivity: gov("General trading", "GAM"),
    licenceExpiryDate: gov(expiry, "GAM"),
  };
}

function govRequest(
  id: string,
  source: GovernmentSource,
  status: GovernmentRequest["status"],
  sourceAvailable: boolean
): GovernmentRequest {
  return {
    id,
    source,
    status,
    sourceAvailable,
    retrievedAt: sourceAvailable ? RETRIEVED_AT : undefined,
    validUntil: sourceAvailable ? VALID_UNTIL : undefined,
  };
}

/**
 * The seeded queue, covering every state the phase-2 screens must render.
 *
 * Registry behaviour per supplier is copied from GOV_DUMMY_DATA.md §2:
 * S1 all sources full · S2 CCD full / GAM partial · S3 ISTD unavailable —
 * S3 being the file's designated SLA-pause scenario, which is exactly the
 * phase-2 failure drill.
 */
function seedApplications(): MockApplication[] {
  return [
    {
      // S1 Al-Noor — the demo protagonist. DRAFT so the wizard → submit →
      // reviewer decides → supplier responds sequence is drivable by persona
      // switching, not merely inspectable.
      id: "0ea00000-0000-4000-8000-000000000001",
      organizationId: ORG.alnoor,
      organizationName: "Al-Noor Trading Company",
      nationalEstablishmentNumber: "20000101",
      professionLicenceNumber: "AMN-2016-4471",
      status: "DRAFT",
      slaPaused: false,
      governmentData: {
        ...ccdBlock("Al-Noor Trading Company", "20000101", "LIMITED_LIABILITY", "ACTIVE"),
        ...istdBlock("20000101"),
        ...gamBlock("AMN-2016-4471", "ACTIVE", "2027-01-31"),
      },
      governmentRequests: [
        govRequest("0eb00000-0000-4000-8000-000000000001", "CCD", "SUCCESS", true),
        govRequest("0eb00000-0000-4000-8000-000000000002", "ISTD", "SUCCESS", true),
        govRequest("0eb00000-0000-4000-8000-000000000003", "GAM", "SUCCESS", true),
      ],
      informationRequests: [],
      consents: [],
    },
    {
      // S2 Petra — paused on an information request. GOV_DUMMY: CCD full,
      // GAM partial (licence fields present, activity/expiry absent).
      id: "0ea00000-0000-4000-8000-000000000002",
      organizationId: ORG.petra,
      organizationName: "Petra Industrial Supplies",
      nationalEstablishmentNumber: "20000102",
      professionLicenceNumber: "ZRQ-2019-8812",
      status: "INFORMATION_REQUIRED",
      submittedAt: "2026-07-20T09:00:00.000Z",
      slaDeadlineAt: "2026-07-27T10:00:00.000Z",
      slaRemainingBusinessSeconds: 30_600,
      slaPaused: true,
      slaPausedReason: "INFORMATION_REQUESTED",
      governmentData: {
        ...ccdBlock("Petra Industrial Supplies", "20000102", "LIMITED_LIABILITY", "ACTIVE"),
        ...istdBlock("20000102"),
        // GAM partial: the licence exists, the detail fields do not. Blank is
        // normal and not adverse (ZM-GOV-003).
        licenceNumber: gov("ZRQ-2019-8812", "GAM"),
        licenceStatus: gov("ACTIVE", "GAM"),
        licenceActivity: gov(null, "GAM"),
        licenceExpiryDate: gov(null, "GAM"),
      },
      governmentRequests: [
        govRequest("0eb00000-0000-4000-8000-000000000011", "CCD", "SUCCESS", true),
        govRequest("0eb00000-0000-4000-8000-000000000012", "ISTD", "SUCCESS", true),
        govRequest("0eb00000-0000-4000-8000-000000000013", "GAM", "PARTIAL", true),
      ],
      informationRequests: [
        {
          id: "0ec00000-0000-4000-8000-000000000001",
          requestedItem: "Authorized signatory certificate",
          description:
            "The account user does not appear among the authorized signatories in the CCD record. Please provide a recent signatory certificate or an authorization document.",
          status: "OPEN",
          requestedAt: "2026-07-21T11:05:00.000Z",
        },
      ],
      consents: [],
    },
    {
      // S3 Jordan Valley Foods — the failure drill. GOV_DUMMY §2 designates
      // this supplier's ISTD as unavailable, and §5 key 90000001 is the
      // deterministic "source down" injection. `sourceAvailable: false` is
      // the signal that must never render as adverse (ZM-GOV-008, ZM-SON-010).
      id: "0ea00000-0000-4000-8000-000000000003",
      organizationId: ORG_JORDAN_VALLEY_PENDING_SEED,
      organizationName: "Jordan Valley Foods",
      nationalEstablishmentNumber: "20000103",
      professionLicenceNumber: "IRB-2021-1190",
      status: "GOVERNMENT_SERVICE_UNAVAILABLE",
      submittedAt: "2026-07-22T07:45:00.000Z",
      slaDeadlineAt: "2026-07-28T09:00:00.000Z",
      slaRemainingBusinessSeconds: 62_100,
      slaPaused: true,
      slaPausedReason: "GOVERNMENT_SERVICE_UNAVAILABLE",
      governmentData: {
        ...ccdBlock("Jordan Valley Foods", "20000103", "LIMITED_LIABILITY", "ACTIVE"),
        // No ISTD fields at all — the source did not answer. Nothing is
        // fabricated to fill the gap.
        ...gamBlock("IRB-2021-1190", "ACTIVE", "2027-06-30"),
      },
      governmentRequests: [
        govRequest("0eb00000-0000-4000-8000-000000000021", "CCD", "SUCCESS", true),
        govRequest("0eb00000-0000-4000-8000-000000000022", "ISTD", "UNAVAILABLE", false),
        govRequest("0eb00000-0000-4000-8000-000000000023", "GAM", "SUCCESS", true),
      ],
      informationRequests: [],
      consents: [],
    },
  ];
}

let applications: MockApplication[] = seedApplications();
let sequence = 0;

function nextId(prefix: string): string {
  sequence += 1;
  return `0e${prefix}00000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

export function listApplications(): MockApplication[] {
  return applications;
}

export function findApplication(id: string): MockApplication | undefined {
  return applications.find((a) => a.id === id);
}

export function findApplicationByOrganization(organizationId: string): MockApplication | undefined {
  return applications.find((a) => a.organizationId === organizationId);
}

/**
 * Deterministic dummy-adapter behaviour keyed by establishment number, using
 * the **frozen failure-injection keys** from GOV_DUMMY_DATA.md §5 so a mock
 * screen and Agent A's real adapter misbehave on the same inputs:
 *
 *   90000001 → UNAVAILABLE, sourceAvailable=false (SLA pause; not adverse)
 *   90000002 → NOT_FOUND,   sourceAvailable=true  (adverse but answered)
 *   90000003 → PARTIAL      (half the fields present)
 *   90000004 → ERROR        (source returned 500)
 *   90000005 → success, slow
 *
 * The 90000001/90000002 pair is the fourth defining behaviour of the product:
 * identical-looking absences, one of which must never count against the
 * supplier. Both are reachable from the bootstrap form.
 *
 * ZM-SON-013 (sole proprietorship): the frozen answer to Q-10 is identity
 * **S4 `20000104` — Hani Auto Parts Establishment** (GOV_DUMMY_DATA.md §2),
 * an identity rather than a 9000000x injection key, added by Agent A in
 * Phase 2. The dummy CCD returns SOLE_PROPRIETORSHIP for it, which is what
 * triggers the hard rejection on both halves.
 */
const SOLE_PROPRIETORSHIP_ESTABLISHMENT = "20000104";

export function bootstrapApplication(
  nationalEstablishmentNumber: string,
  professionLicenceNumber: string
): MockApplication {
  const existing = applications.find(
    (a) => a.nationalEstablishmentNumber === nationalEstablishmentNumber
  );
  if (existing) return existing;

  const key = nationalEstablishmentNumber;
  const sourceDown = key === "90000001";
  const notFound = key === "90000002";
  const partial = key === "90000003";
  const soleProprietorship = key === SOLE_PROPRIETORSHIP_ESTABLISHMENT;

  const name = soleProprietorship ? "Hani Auto Parts Establishment" : `Company ${key}`;

  const application: MockApplication = {
    id: nextId("a"),
    organizationId: nextId("0"),
    organizationName: name,
    nationalEstablishmentNumber,
    professionLicenceNumber,
    status: "DRAFT",
    slaPaused: false,
    governmentData: notFound
      ? {}
      : {
          ...ccdBlock(
            name,
            key,
            soleProprietorship ? "SOLE_PROPRIETORSHIP" : "LIMITED_LIABILITY",
            "ACTIVE"
          ),
          // A source that was down contributes nothing — not a blank field,
          // no field at all.
          ...(sourceDown ? {} : istdBlock(key)),
          ...(partial ? {} : gamBlock(professionLicenceNumber, "ACTIVE", "2027-06-30")),
        },
    governmentRequests: [
      // A NOT_FOUND identity is unknown to every registry, not just CCD —
      // "answered, found nothing" (sourceAvailable stays true) must read
      // consistently on every panel row, or INV-9's pair renders wrong.
      govRequest(nextId("b"), "CCD", notFound ? "NOT_FOUND" : "SUCCESS", true),
      govRequest(
        nextId("b"),
        "ISTD",
        sourceDown ? "UNAVAILABLE" : notFound ? "NOT_FOUND" : "SUCCESS",
        !sourceDown
      ),
      govRequest(nextId("b"), "GAM", notFound ? "NOT_FOUND" : partial ? "PARTIAL" : "SUCCESS", true),
    ],
    informationRequests: [],
    consents: [],
  };

  applications = [application, ...applications];
  return application;
}

export function recordConsents(
  id: string,
  consents: { consentType: string; consentVersion: string; granted: boolean }[]
): MockApplication | undefined {
  const application = findApplication(id);
  if (!application) return undefined;
  application.consents = consents;
  return application;
}

export function recordBankAccount(
  id: string,
  bankAccount: { iban: string; bankName: string; accountHolderName: string }
): MockApplication | undefined {
  const application = findApplication(id);
  if (!application) return undefined;
  application.bankAccount = bankAccount;
  return application;
}

/** §5.5: SUBMITTED starts the clock. A source that didn't answer pauses it immediately. */
export function submitApplication(id: string): MockApplication | undefined {
  const application = findApplication(id);
  if (!application) return undefined;

  const unavailableSource = application.governmentRequests?.find((r) => r.sourceAvailable === false);
  application.submittedAt = new Date().toISOString();
  application.slaRemainingBusinessSeconds = 24 * 60 * 60;

  if (unavailableSource) {
    application.status = "GOVERNMENT_SERVICE_UNAVAILABLE";
    application.slaPaused = true;
    application.slaPausedReason = "GOVERNMENT_SERVICE_UNAVAILABLE";
  } else {
    // Live runs SUBMITTED → AUTOMATED_VERIFICATION → UNDER_REVIEW inside the
    // submit request; the transient states are never observable in a
    // response, so the mock lands where the live API actually answers.
    application.status = "UNDER_REVIEW";
    application.slaPaused = false;
    application.slaPausedReason = undefined;
  }
  return application;
}

/** §5.5: INFORMATION_RESUBMITTED resumes the clock. */
export function respondToInformationRequest(
  id: string,
  informationRequestId: string
): MockApplication | undefined {
  const application = findApplication(id);
  if (!application) return undefined;

  const request = application.informationRequests?.find((r) => r.id === informationRequestId);
  if (request) request.status = "FULFILLED";

  const stillOpen = application.informationRequests?.some((r) => r.status === "OPEN");
  if (!stillOpen) {
    application.status = "INFORMATION_RESUBMITTED";
    application.slaPaused = false;
    application.slaPausedReason = undefined;
  }
  return application;
}

/**
 * Which decisions are legal from which status — mirrors the server's
 * transition whitelist (apps/api application-state.ts) so the mock refuses
 * exactly where live returns 409 INVALID_STATE_TRANSITION. A DRAFT or
 * already-decided application cannot be decided, and INFORMATION_REQUIRED
 * only permits an outright rejection while waiting.
 */
const DECIDABLE: Record<string, readonly string[]> = {
  UNDER_REVIEW: ["APPROVED", "APPROVED_CONDITIONAL", "INFORMATION_REQUIRED", "REJECTED"],
  INFORMATION_RESUBMITTED: ["APPROVED", "APPROVED_CONDITIONAL", "INFORMATION_REQUIRED", "REJECTED"],
  FINAL_REVIEW: ["APPROVED", "APPROVED_CONDITIONAL", "INFORMATION_REQUIRED", "REJECTED"],
  INFORMATION_REQUIRED: ["REJECTED"],
};

export type DecideResult =
  | { ok: true; application: MockApplication }
  | { ok: false; error: "NOT_FOUND" | "INVALID_STATE_TRANSITION" };

export function decideApplication(
  id: string,
  decision: string,
  reasonCode?: string,
  notes?: string
): DecideResult {
  const application = findApplication(id);
  if (!application) return { ok: false, error: "NOT_FOUND" };

  const allowed = DECIDABLE[application.status ?? ""] ?? [];
  if (!allowed.includes(decision)) return { ok: false, error: "INVALID_STATE_TRANSITION" };

  if (decision === "INFORMATION_REQUIRED") {
    // §5.5: pauses the clock; the reviewer's note becomes the request itself.
    application.status = "INFORMATION_REQUIRED";
    application.slaPaused = true;
    application.slaPausedReason = "INFORMATION_REQUESTED";
    application.informationRequests = [
      ...(application.informationRequests ?? []),
      {
        id: nextId("c"),
        requestedItem: reasonCode ?? "Additional information",
        description: notes ?? "",
        status: "OPEN",
        requestedAt: new Date().toISOString(),
      },
    ];
    return { ok: true, application };
  }

  application.status = decision;
  application.decidedAt = new Date().toISOString();
  application.decisionReasonCode = reasonCode;
  application.decisionNotes = notes;
  application.slaPaused = false;
  application.slaPausedReason = undefined;
  application.slaRemainingBusinessSeconds = 0;
  return { ok: true, application };
}

export function findGovernmentRequest(requestId: string): GovernmentRequest | undefined {
  for (const application of applications) {
    const match = application.governmentRequests?.find((r) => r.id === requestId);
    if (match) return match;
  }
  return undefined;
}

/** Test/dev affordance: reset to the seeded queue without a page reload. */
export function resetOnboardingMocks() {
  applications = seedApplications();
  sequence = 0;
}
