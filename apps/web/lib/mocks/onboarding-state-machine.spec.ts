import { describe, it, expect, beforeEach } from "vitest";

import {
  bootstrapApplication,
  decideApplication,
  findApplicationByOrganization,
  recordBankAccount,
  recordConsents,
  resetOnboardingMocks,
  respondToInformationRequest,
  submitApplication,
} from "./onboarding-store";
import { ORG } from "./data";

/**
 * The §5.5 SLA-clock transitions, asserted against the mock store that the
 * Phase 2 screens render today.
 *
 * This is the same sequence as the phase-2 integration checkpoint (submit →
 * information request → response → approval, plus the unavailable-registry
 * drill). It is the client-side statement of what that checkpoint must show —
 * not a substitute for running it against Agent A's endpoints.
 */

beforeEach(() => resetOnboardingMocks());

function readySupplierApplication() {
  const application = findApplicationByOrganization(ORG.alnoor);
  expect(application?.id).toBeTruthy();
  recordConsents(application!.id!, [
    { consentType: "TERMS_OF_SERVICE", consentVersion: "1.0", granted: true },
  ]);
  recordBankAccount(application!.id!, {
    iban: "JO94CBJO0010000000000131000302",
    bankName: "Jordan National Bank",
    accountHolderName: "Al-Noor Trading Company",
  });
  return application!;
}

describe("onboarding state machine (§5.5)", () => {
  it("starts the demo supplier in DRAFT so the wizard is reachable", () => {
    expect(findApplicationByOrganization(ORG.alnoor)?.status).toBe("DRAFT");
  });

  it("starts the 24 business-hour clock on submit", () => {
    const application = readySupplierApplication();
    submitApplication(application.id!);

    // Live presents UNDER_REVIEW after submit — SUBMITTED and
    // AUTOMATED_VERIFICATION are transient inside the request and never
    // observable in a response, so the mock lands where live answers.
    expect(application.status).toBe("UNDER_REVIEW");
    expect(application.slaPaused).toBe(false);
    expect(application.slaRemainingBusinessSeconds).toBe(24 * 60 * 60);
  });

  it("pauses the clock and records a reason on an information request (ZM-SON-008)", () => {
    const application = readySupplierApplication();
    submitApplication(application.id!);
    decideApplication(
      application.id!,
      "INFORMATION_REQUIRED",
      "SIGNATORY_EVIDENCE_REQUIRED",
      "Please provide a signatory certificate."
    );

    expect(application.status).toBe("INFORMATION_REQUIRED");
    expect(application.slaPaused).toBe(true);
    // The live reason vocabulary: INFORMATION_REQUESTED is the *reason*,
    // distinct from the INFORMATION_REQUIRED *status* (Q-07 resolution).
    expect(application.slaPausedReason).toBe("INFORMATION_REQUESTED");
    expect(application.informationRequests).toHaveLength(1);
    expect(application.informationRequests?.[0].status).toBe("OPEN");
  });

  it("resumes the clock and closes the request when the supplier responds", () => {
    const application = readySupplierApplication();
    submitApplication(application.id!);
    decideApplication(application.id!, "INFORMATION_REQUIRED", "ESSENTIAL_FIELD_MISSING");
    respondToInformationRequest(application.id!, application.informationRequests![0].id!);

    expect(application.status).toBe("INFORMATION_RESUBMITTED");
    expect(application.slaPaused).toBe(false);
    expect(application.slaPausedReason).toBeUndefined();
    expect(application.informationRequests?.[0].status).toBe("FULFILLED");
  });

  it("stops the clock on approval", () => {
    const application = readySupplierApplication();
    submitApplication(application.id!);
    decideApplication(application.id!, "APPROVED");

    expect(application.status).toBe("APPROVED");
    expect(application.slaPaused).toBe(false);
    expect(application.slaRemainingBusinessSeconds).toBe(0);
  });

  it("refuses decisions the live transition whitelist refuses", () => {
    // The mock must 409 exactly where live 409s, or a screen built against
    // the mock will attempt transitions the real API rejects.
    const draft = readySupplierApplication();
    expect(decideApplication(draft.id!, "APPROVED")).toMatchObject({
      ok: false,
      error: "INVALID_STATE_TRANSITION",
    });

    submitApplication(draft.id!);
    decideApplication(draft.id!, "APPROVED");
    // Terminal states accept nothing further.
    expect(decideApplication(draft.id!, "REJECTED")).toMatchObject({
      ok: false,
      error: "INVALID_STATE_TRANSITION",
    });
  });

  it("permits only outright rejection while information is outstanding", () => {
    const application = readySupplierApplication();
    submitApplication(application.id!);
    decideApplication(application.id!, "INFORMATION_REQUIRED", "ESSENTIAL_FIELD_MISSING");

    expect(decideApplication(application.id!, "APPROVED")).toMatchObject({
      ok: false,
      error: "INVALID_STATE_TRANSITION",
    });
    expect(decideApplication(application.id!, "REJECTED", "COMPANY_NOT_ACTIVE")).toMatchObject({
      ok: true,
    });
  });
});

describe("government source availability (GOV_DUMMY_DATA §5)", () => {
  it("pauses rather than rejects when a registry does not answer (ZM-SON-010)", () => {
    // 90000001 is the frozen "source down" injection key — the same input
    // that makes Agent A's dummy adapter report UNAVAILABLE.
    const application = bootstrapApplication("90000001", "LIC-DOWN");
    const down = application.governmentRequests?.find((r) => r.sourceAvailable === false);

    expect(down?.status).toBe("UNAVAILABLE");

    recordConsents(application.id!, [
      { consentType: "TERMS_OF_SERVICE", consentVersion: "1.0", granted: true },
    ]);
    submitApplication(application.id!);

    expect(application.status).toBe("GOVERNMENT_SERVICE_UNAVAILABLE");
    expect(application.slaPaused).toBe(true);
    expect(application.status).not.toBe("REJECTED");
    // Nothing is invented to fill the gap the silent source left.
    expect(application.governmentData?.taxNumber).toBeUndefined();
  });

  it("keeps 'did not answer' distinct from 'answered, nothing found'", () => {
    // The fourth defining behaviour of the product: 90000001 and 90000002
    // both produce an absence of data, and only one of them may ever count
    // against the supplier.
    const unavailable = bootstrapApplication("90000001", "LIC-DOWN");
    const notFound = bootstrapApplication("90000002", "LIC-NF");

    const istdDown = unavailable.governmentRequests?.find((r) => r.source === "ISTD");
    const ccdNotFound = notFound.governmentRequests?.find((r) => r.source === "CCD");

    expect(istdDown?.sourceAvailable).toBe(false);
    expect(ccdNotFound?.sourceAvailable).toBe(true);
    expect(ccdNotFound?.status).toBe("NOT_FOUND");
  });

  it("is idempotent per establishment number (D-04)", () => {
    const first = bootstrapApplication("90000003", "LIC-PARTIAL");
    const second = bootstrapApplication("90000003", "LIC-PARTIAL");
    expect(first.id).toBe(second.id);
  });
});
