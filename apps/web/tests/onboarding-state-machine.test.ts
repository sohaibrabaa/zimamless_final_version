import test from "node:test";
import assert from "node:assert/strict";

import {
  bootstrapApplication,
  decideApplication,
  findApplicationByOrganization,
  recordBankAccount,
  recordConsents,
  resetOnboardingMocks,
  respondToInformationRequest,
  submitApplication,
} from "../lib/mocks/onboarding-store.ts";

/**
 * These assert the SLA-clock transitions of requirements §5.5 against the mock
 * store, which is what the Phase 2 screens render today. When Agent A's
 * endpoints go live the same sequence becomes the integration checkpoint —
 * these tests are the client-side statement of what that checkpoint must show,
 * not a substitute for it.
 */

test.beforeEach(() => resetOnboardingMocks());

const SUPPLIER_ORG = "10000000-0000-0000-0000-000000000001";

function readySupplierApplication() {
  const application = findApplicationByOrganization(SUPPLIER_ORG);
  assert.ok(application?.id);
  recordConsents(application.id, [
    { consentType: "TERMS_OF_SERVICE", consentVersion: "1.0", granted: true },
  ]);
  recordBankAccount(application.id, {
    iban: "JO94CBJO0010000000000131000302",
    bankName: "Jordan First Bank",
    accountHolderName: "Al-Mashriq Trading Co.",
  });
  return application;
}

test("the supplier's own application starts in DRAFT so the wizard is reachable", () => {
  assert.equal(findApplicationByOrganization(SUPPLIER_ORG)?.status, "DRAFT");
});

test("submitting starts the 24 business-hour clock (§5.5 SUBMITTED)", () => {
  const application = readySupplierApplication();
  submitApplication(application.id!);

  assert.equal(application.status, "AUTOMATED_VERIFICATION");
  assert.equal(application.slaPaused, false);
  assert.equal(application.slaRemainingBusinessSeconds, 24 * 60 * 60);
});

test("an information request pauses the clock and records a reason (ZM-SON-008)", () => {
  const application = readySupplierApplication();
  submitApplication(application.id!);
  decideApplication(
    application.id!,
    "INFORMATION_REQUIRED",
    "SIGNATORY_EVIDENCE_REQUIRED",
    "Please provide a signatory certificate."
  );

  assert.equal(application.status, "INFORMATION_REQUIRED");
  assert.equal(application.slaPaused, true);
  assert.equal(application.slaPausedReason, "INFORMATION_REQUIRED");
  assert.equal(application.informationRequests?.length, 1);
  assert.equal(application.informationRequests?.[0].status, "OPEN");
});

test("responding resumes the clock and closes the request (§5.5 INFORMATION_RESUBMITTED)", () => {
  const application = readySupplierApplication();
  submitApplication(application.id!);
  decideApplication(application.id!, "INFORMATION_REQUIRED", "ESSENTIAL_FIELD_MISSING");
  respondToInformationRequest(application.id!, application.informationRequests![0].id!);

  assert.equal(application.status, "INFORMATION_RESUBMITTED");
  assert.equal(application.slaPaused, false);
  assert.equal(application.slaPausedReason, undefined);
  assert.equal(application.informationRequests?.[0].status, "FULFILLED");
});

test("approval stops the clock", () => {
  const application = readySupplierApplication();
  submitApplication(application.id!);
  decideApplication(application.id!, "APPROVED");

  assert.equal(application.status, "APPROVED");
  assert.equal(application.slaPaused, false);
  assert.equal(application.slaRemainingBusinessSeconds, 0);
});

test("an unresponsive registry pauses the clock and is never adverse (ZM-SON-010)", () => {
  // Establishment numbers ending in 9 are the deterministic GAM-unavailable
  // variant — the phase-2 failure drill.
  const application = bootstrapApplication("200111119", "LIC-9");
  const gam = application.governmentRequests?.find((r) => r.source === "GAM");

  assert.equal(gam?.sourceAvailable, false);
  assert.equal(gam?.status, "UNAVAILABLE");

  recordConsents(application.id!, [
    { consentType: "TERMS_OF_SERVICE", consentVersion: "1.0", granted: true },
  ]);
  submitApplication(application.id!);

  assert.equal(application.status, "GOVERNMENT_SERVICE_UNAVAILABLE");
  assert.equal(application.slaPaused, true);
  assert.notEqual(application.status, "REJECTED");
  // Nothing is invented to fill the gap the unanswered source left.
  assert.equal(application.governmentData?.licenceStatus, undefined);
});

test("bootstrap is idempotent per establishment number (D-04)", () => {
  const first = bootstrapApplication("200111110", "LIC-0");
  const second = bootstrapApplication("200111110", "LIC-0");
  assert.equal(first.id, second.id);
});
