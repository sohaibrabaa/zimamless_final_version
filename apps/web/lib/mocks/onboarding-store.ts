/**
 * In-memory onboarding fixture store backing the Phase 2 MSW handlers.
 *
 * Stateful on purpose: the phase-2 integration checkpoint is a *sequence*
 * (register → wizard → submit → reviewer requests information → clock pauses →
 * supplier responds → clock resumes → reviewer approves), and a set of static
 * fixtures can't demonstrate that the SLA pauses and resumes. This store
 * reproduces the state machine and the clock transitions from requirements
 * §5.5 so both halves of the flow are exercisable before Agent A's endpoints
 * land — then it is deleted from the request path endpoint by endpoint as
 * entries flip to `live` in endpoint-status.ts.
 *
 * Government payloads follow the shape recommended in **Q-01**; if the ruling
 * differs, this file and lib/onboarding/government.ts change together.
 *
 * Identities are still the Phase 1 placeholders — docs/specs/SEED_DATA.md is
 * an Agent A deliverable and does not exist yet (carried over from Phase 1,
 * still an open NEEDS FROM A).
 */

import type { components } from "@/lib/api/generated/schema";
import type { GovernmentSource } from "@/lib/onboarding/government";

type SupplierApplication = components["schemas"]["SupplierApplication"];
type InformationRequest = components["schemas"]["InformationRequest"];
type GovernmentRequest = components["schemas"]["GovernmentRequest"];

/** Q-01 recommended per-field provenance entry. */
interface GovField {
  value: string | string[] | null;
  source: GovernmentSource;
  retrievedAt: string;
  verificationStatus: "GOVERNMENT_VERIFIED" | "SELF_DECLARED" | "UNVERIFIED";
  sourceReference?: string;
}

export interface MockApplication extends SupplierApplication {
  /** Echoed back so the wizard can resume; not part of the frozen response shape. */
  nationalEstablishmentNumber?: string;
  professionLicenceNumber?: string;
  organizationName?: string;
  /** Q-03 recommended field — present here so the UI path that reads it is exercised. */
  slaPausedReason?: string;
  /** Q-04 recommended field. */
  governmentRequests?: GovernmentRequest[];
  informationRequests?: InformationRequest[];
  consents?: { consentType: string; consentVersion: string; granted: boolean }[];
  bankAccount?: { iban: string; bankName: string; accountHolderName: string };
  decisionNotes?: string;
}

const RETRIEVED_AT = "2026-07-20T09:14:00.000Z";
const VALID_UNTIL = "2026-10-18T09:14:00.000Z";

function gov(
  value: string | string[] | null,
  source: GovernmentSource,
  sourceReference?: string
): GovField {
  return {
    value,
    source,
    retrievedAt: RETRIEVED_AT,
    verificationStatus: "GOVERNMENT_VERIFIED",
    sourceReference,
  };
}

function ccdBlock(name: string, number: string, type: string, status: string) {
  return {
    legalCompanyName: gov(name, "CCD", `CCD/${number}`),
    companyNumber: gov(number, "CCD", `CCD/${number}`),
    companyType: gov(type, "CCD"),
    registryStatus: gov(status, "CCD"),
    registrationDate: gov("2016-03-14", "CCD"),
    registeredAddress: gov("Al-Abdali, Amman", "CCD"),
    governorate: gov("Amman", "CCD"),
    capital: gov("150000.000", "CCD"),
    authorizedSignatories: gov(["Rania Al-Khatib", "Faris Al-Khatib"], "CCD"),
    businessPurposes: gov(["Wholesale trade", "Import and export"], "CCD"),
    partners: gov(["Rania Al-Khatib (60%)", "Faris Al-Khatib (40%)"], "CCD"),
  };
}

function istdBlock(taxNumber: string | null) {
  return {
    taxNumber: gov(taxNumber, "ISTD"),
    taxRegistrationStatus: gov(taxNumber ? "REGISTERED" : null, "ISTD"),
  };
}

function gamBlock(licence: string, status: string, expiry: string) {
  return {
    licenceNumber: gov(licence, "GAM", `GAM/${licence}`),
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
 * The seeded queue. States chosen to cover every branch the phase-2 screens
 * have to render — including one paused on an information request and one
 * paused on a government source that did not answer (the failure drill).
 */
function seedApplications(): MockApplication[] {
  return [
    {
      id: "a0000000-0000-0000-0000-000000000001",
      organizationId: "10000000-0000-0000-0000-000000000001",
      organizationName: "Al-Mashriq Trading Co.",
      nationalEstablishmentNumber: "200145678",
      professionLicenceNumber: "AMN-2016-4471",
      // DRAFT on purpose: this is the `supplier-owner` persona's own
      // application, so the wizard → submit → reviewer decides →
      // supplier responds sequence of the phase-2 checkpoint can be driven
      // end to end by switching personas, rather than only inspected.
      status: "DRAFT",
      slaPaused: false,
      governmentData: {
        ...ccdBlock("Al-Mashriq Trading Co.", "200145678", "LIMITED_LIABILITY", "ACTIVE"),
        ...istdBlock("9911223344"),
        ...gamBlock("AMN-2016-4471", "ACTIVE", "2027-01-31"),
      },
      governmentRequests: [
        govRequest("g0000000-0000-0000-0000-000000000001", "CCD", "SUCCESS", true),
        govRequest("g0000000-0000-0000-0000-000000000002", "ISTD", "SUCCESS", true),
        govRequest("g0000000-0000-0000-0000-000000000003", "GAM", "SUCCESS", true),
      ],
      informationRequests: [],
      consents: [],
    },
    {
      id: "a0000000-0000-0000-0000-000000000002",
      organizationId: "10000000-0000-0000-0000-000000000002",
      organizationName: "Petra Steel Works",
      nationalEstablishmentNumber: "200987654",
      professionLicenceNumber: "AMN-2019-8812",
      status: "INFORMATION_REQUIRED",
      submittedAt: "2026-07-20T09:00:00.000Z",
      slaDeadlineAt: "2026-07-27T10:00:00.000Z",
      slaRemainingBusinessSeconds: 30_600,
      slaPaused: true,
      slaPausedReason: "INFORMATION_REQUIRED",
      governmentData: {
        ...ccdBlock("Petra Steel Works", "200987654", "LIMITED_LIABILITY", "ACTIVE"),
        // ISTD answered but held no tax number — blank, and NOT adverse (ZM-GOV-003).
        ...istdBlock(null),
        ...gamBlock("AMN-2019-8812", "ACTIVE", "2026-11-30"),
      },
      governmentRequests: [
        govRequest("g0000000-0000-0000-0000-000000000011", "CCD", "SUCCESS", true),
        govRequest("g0000000-0000-0000-0000-000000000012", "ISTD", "PARTIAL", true),
        govRequest("g0000000-0000-0000-0000-000000000013", "GAM", "SUCCESS", true),
      ],
      informationRequests: [
        {
          id: "i0000000-0000-0000-0000-000000000001",
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
      id: "a0000000-0000-0000-0000-000000000003",
      organizationId: "10000000-0000-0000-0000-000000000003",
      organizationName: "Jerash Foods",
      nationalEstablishmentNumber: "200555222",
      professionLicenceNumber: "AMN-2021-1190",
      status: "GOVERNMENT_SERVICE_UNAVAILABLE",
      submittedAt: "2026-07-22T07:45:00.000Z",
      slaDeadlineAt: "2026-07-28T09:00:00.000Z",
      slaRemainingBusinessSeconds: 62_100,
      slaPaused: true,
      slaPausedReason: "GOVERNMENT_SERVICE_UNAVAILABLE",
      governmentData: {
        ...ccdBlock("Jerash Foods", "200555222", "LIMITED_LIABILITY", "ACTIVE"),
        ...istdBlock("9955667788"),
        // GAM did not answer at all: no licence fields, and the request below
        // carries sourceAvailable=false. This is the failure-drill fixture —
        // it must render as "not yet retrieved", never as adverse (ZM-SON-010).
      },
      governmentRequests: [
        govRequest("g0000000-0000-0000-0000-000000000021", "CCD", "SUCCESS", true),
        govRequest("g0000000-0000-0000-0000-000000000022", "ISTD", "SUCCESS", true),
        govRequest("g0000000-0000-0000-0000-000000000023", "GAM", "UNAVAILABLE", false),
      ],
      informationRequests: [],
      consents: [],
    },
    {
      id: "a0000000-0000-0000-0000-000000000004",
      organizationId: "10000000-0000-0000-0000-000000000004",
      organizationName: "Aqaba Marine Supplies",
      nationalEstablishmentNumber: "200333111",
      professionLicenceNumber: "AQB-2018-2204",
      status: "APPROVED_CONDITIONAL",
      submittedAt: "2026-07-16T08:15:00.000Z",
      decidedAt: "2026-07-17T13:40:00.000Z",
      decisionReasonCode: "OPERATIONAL_ITEM_OUTSTANDING",
      decisionNotes: "Licence renewal receipt outstanding; financing actions remain disabled.",
      slaPaused: false,
      slaRemainingBusinessSeconds: 0,
      governmentData: {
        ...ccdBlock("Aqaba Marine Supplies", "200333111", "LIMITED_LIABILITY", "ACTIVE"),
        ...istdBlock("9944332211"),
        ...gamBlock("AQB-2018-2204", "PENDING_RENEWAL", "2026-07-31"),
      },
      governmentRequests: [
        govRequest("g0000000-0000-0000-0000-000000000031", "CCD", "SUCCESS", true),
        govRequest("g0000000-0000-0000-0000-000000000032", "ISTD", "SUCCESS", true),
        govRequest("g0000000-0000-0000-0000-000000000033", "GAM", "SUCCESS", true),
      ],
      informationRequests: [],
      consents: [],
    },
    {
      id: "a0000000-0000-0000-0000-000000000005",
      organizationId: "10000000-0000-0000-0000-000000000005",
      organizationName: "Madaba Textiles Est.",
      nationalEstablishmentNumber: "200777999",
      professionLicenceNumber: "MDB-2020-3345",
      status: "REJECTED",
      submittedAt: "2026-07-15T08:00:00.000Z",
      decidedAt: "2026-07-15T15:20:00.000Z",
      // ZM-SON-013 — the ineligibility fixture behind the dedicated screen.
      decisionReasonCode: "ENTITY_TYPE_NOT_ELIGIBLE_V3",
      slaPaused: false,
      slaRemainingBusinessSeconds: 0,
      governmentData: {
        ...ccdBlock("Madaba Textiles Est.", "200777999", "SOLE_PROPRIETORSHIP", "ACTIVE"),
        ...istdBlock("9977665544"),
      },
      governmentRequests: [
        govRequest("g0000000-0000-0000-0000-000000000041", "CCD", "SUCCESS", true),
        govRequest("g0000000-0000-0000-0000-000000000042", "ISTD", "SUCCESS", true),
      ],
      informationRequests: [],
      consents: [],
    },
  ];
}

let applications: MockApplication[] = seedApplications();
let sequence = 100;

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}0000000-0000-0000-0000-${String(sequence).padStart(12, "0")}`;
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
 * Deterministic dummy-adapter behaviour keyed by establishment number, mirroring
 * the contract Agent A implements for the real adapters (ZM-GOV-008): the same
 * number always produces the same variant.
 * - ending 0 → sole proprietorship (ineligible, ZM-SON-013)
 * - ending 9 → GAM does not answer (sourceAvailable=false, paused not adverse)
 * - anything else → full CCD + ISTD + GAM
 */
export function bootstrapApplication(
  nationalEstablishmentNumber: string,
  professionLicenceNumber: string
): MockApplication {
  const existing = applications.find(
    (a) => a.nationalEstablishmentNumber === nationalEstablishmentNumber
  );
  if (existing) return existing;

  const lastDigit = nationalEstablishmentNumber.slice(-1);
  const soleProprietorship = lastDigit === "0";
  const gamUnavailable = lastDigit === "9";

  const application: MockApplication = {
    id: nextId("a"),
    organizationId: nextId("1"),
    organizationName: soleProprietorship
      ? `Establishment ${nationalEstablishmentNumber}`
      : `Company ${nationalEstablishmentNumber}`,
    nationalEstablishmentNumber,
    professionLicenceNumber,
    status: "DRAFT",
    slaPaused: false,
    governmentData: {
      ...ccdBlock(
        soleProprietorship
          ? `Establishment ${nationalEstablishmentNumber}`
          : `Company ${nationalEstablishmentNumber}`,
        nationalEstablishmentNumber,
        soleProprietorship ? "SOLE_PROPRIETORSHIP" : "LIMITED_LIABILITY",
        "ACTIVE"
      ),
      ...istdBlock(`99${nationalEstablishmentNumber.slice(0, 8)}`),
      ...(gamUnavailable ? {} : gamBlock(professionLicenceNumber, "ACTIVE", "2027-06-30")),
    },
    governmentRequests: [
      govRequest(nextId("g"), "CCD", "SUCCESS", true),
      govRequest(nextId("g"), "ISTD", "SUCCESS", true),
      govRequest(
        nextId("g"),
        "GAM",
        gamUnavailable ? "UNAVAILABLE" : "SUCCESS",
        !gamUnavailable
      ),
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
    application.status = "AUTOMATED_VERIFICATION";
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

export function decideApplication(
  id: string,
  decision: string,
  reasonCode?: string,
  notes?: string
): MockApplication | undefined {
  const application = findApplication(id);
  if (!application) return undefined;

  if (decision === "INFORMATION_REQUIRED") {
    // §5.5: pauses the clock; the reviewer's note becomes the request itself.
    application.status = "INFORMATION_REQUIRED";
    application.slaPaused = true;
    application.slaPausedReason = "INFORMATION_REQUIRED";
    application.informationRequests = [
      ...(application.informationRequests ?? []),
      {
        id: nextId("i"),
        requestedItem: reasonCode ?? "Additional information",
        description: notes ?? "",
        status: "OPEN",
        requestedAt: new Date().toISOString(),
      },
    ];
    return application;
  }

  application.status = decision;
  application.decidedAt = new Date().toISOString();
  application.decisionReasonCode = reasonCode;
  application.decisionNotes = notes;
  application.slaPaused = false;
  application.slaPausedReason = undefined;
  application.slaRemainingBusinessSeconds = 0;
  return application;
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
  sequence = 100;
}
