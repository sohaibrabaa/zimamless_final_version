import test from "node:test";
import assert from "node:assert/strict";

import {
  financingBlocked,
  isDecided,
  slaClockState,
  statusTone,
} from "../lib/onboarding/status.ts";
import {
  breakDownBusinessSeconds,
  pauseReasonFor,
  slaProgressFraction,
} from "../lib/onboarding/sla.ts";
import {
  isSoleProprietorship,
  normalizeGovernmentData,
} from "../lib/onboarding/government.ts";
import { validateIban } from "../lib/onboarding/iban.ts";
import { allEssentialGranted, CONSENT_CATALOGUE } from "../lib/onboarding/consents.ts";

// --- SLA clock semantics (requirements §5.5) --------------------------------

test("clock state follows the §5.5 table", () => {
  assert.equal(slaClockState("DRAFT", undefined), "NOT_STARTED");
  assert.equal(slaClockState("UNDER_REVIEW", undefined), "RUNNING");
  assert.equal(slaClockState("INFORMATION_REQUIRED", undefined), "PAUSED");
  assert.equal(slaClockState("GOVERNMENT_SERVICE_UNAVAILABLE", undefined), "PAUSED");
  assert.equal(slaClockState("APPROVED", undefined), "STOPPED");
  assert.equal(slaClockState("REJECTED", undefined), "STOPPED");
});

test("the server's slaPaused flag overrides the status table while in progress", () => {
  assert.equal(slaClockState("UNDER_REVIEW", true), "PAUSED");
  assert.equal(slaClockState("INFORMATION_REQUIRED", false), "RUNNING");
});

test("a decided application is never shown as paused or running", () => {
  assert.equal(slaClockState("APPROVED", true), "STOPPED");
  assert.equal(slaClockState("DRAFT", true), "NOT_STARTED");
});

test("an unknown status still renders a clock rather than blanking the screen", () => {
  assert.equal(slaClockState("SOME_FUTURE_STATE", undefined), "RUNNING");
});

test("remaining business time breaks down without floating-point drift", () => {
  assert.deepEqual(breakDownBusinessSeconds(86_400), { hours: 24, minutes: 0, overdue: false });
  assert.deepEqual(breakDownBusinessSeconds(3_661), { hours: 1, minutes: 1, overdue: false });
  assert.deepEqual(breakDownBusinessSeconds(0), { hours: 0, minutes: 0, overdue: true });
  assert.equal(breakDownBusinessSeconds(undefined), null);
});

test("progress fraction is clamped and omitted when unknown", () => {
  assert.equal(slaProgressFraction(43_200), 0.5);
  assert.equal(slaProgressFraction(999_999), 1);
  assert.equal(slaProgressFraction(-50), 0);
  assert.equal(slaProgressFraction(undefined), null);
});

test("pause reason prefers the server's value and falls back to status", () => {
  assert.equal(pauseReasonFor("UNDER_REVIEW", "GOVERNMENT_SERVICE_UNAVAILABLE"), "GOVERNMENT_SERVICE_UNAVAILABLE");
  assert.equal(pauseReasonFor("INFORMATION_REQUIRED", undefined), "INFORMATION_REQUIRED");
  assert.equal(pauseReasonFor("UNDER_REVIEW", undefined), "UNSPECIFIED");
});

// --- Neutral presentation of non-adverse states ----------------------------

test("only a confirmed rejection is styled as adverse (ZM-SON-010, ZM-GOV-003)", () => {
  // The two states most at risk of being coloured as warnings must stay neutral.
  assert.equal(statusTone("GOVERNMENT_SERVICE_UNAVAILABLE"), "neutral");
  assert.equal(statusTone("INFORMATION_REQUIRED"), "neutral");
  assert.equal(statusTone("REJECTED"), "danger");
  assert.equal(statusTone("APPROVED"), "success");
});

// --- ZM-SON-011 financing gate ---------------------------------------------

test("financing is blocked in every state except full approval", () => {
  assert.equal(financingBlocked("APPROVED"), false);
  assert.equal(financingBlocked("APPROVED_CONDITIONAL"), true);
  assert.equal(financingBlocked("UNDER_REVIEW"), true);
  assert.equal(financingBlocked("REJECTED"), true);
  assert.equal(financingBlocked(undefined), true);
});

test("conditional approval counts as decided", () => {
  assert.equal(isDecided("APPROVED_CONDITIONAL"), true);
  assert.equal(isDecided("UNDER_REVIEW"), false);
});

// --- Government provenance normalization (Q-01 adapter) ---------------------

test("a provenance-shaped entry yields source and retrieval date", () => {
  const [field] = normalizeGovernmentData({
    legalCompanyName: {
      value: "Al-Mashriq Trading Co.",
      source: "CCD",
      retrievedAt: "2026-07-20T09:14:00.000Z",
      verificationStatus: "GOVERNMENT_VERIFIED",
    },
  });
  assert.equal(field.value, "Al-Mashriq Trading Co.");
  assert.equal(field.source, "CCD");
  assert.equal(field.retrievedAt, "2026-07-20T09:14:00.000Z");
});

test("a bare value degrades to a badge-less read-only field rather than guessing a source", () => {
  const [field] = normalizeGovernmentData({ taxNumber: "9911223344" });
  assert.equal(field.value, "9911223344");
  assert.equal(field.source, null);
});

test("an empty value is null, so it renders as 'not provided' and never as adverse", () => {
  const fields = normalizeGovernmentData({
    a: { value: null, source: "ISTD" },
    b: { value: "", source: "ISTD" },
    c: { value: "   ", source: "ISTD" },
  });
  assert.deepEqual(fields.map((f) => f.value), [null, null, null]);
});

test("array values flatten for display instead of rendering as [object Object]", () => {
  const [field] = normalizeGovernmentData({
    partners: { value: ["Rania Al-Khatib", "Faris Al-Khatib"], source: "CCD" },
  });
  assert.equal(field.value, "Rania Al-Khatib · Faris Al-Khatib");
});

test("normalization never throws on unexpected payload shapes", () => {
  assert.doesNotThrow(() => normalizeGovernmentData({ x: 42, y: true, z: { nested: {} } }));
  assert.deepEqual(normalizeGovernmentData(undefined), []);
});

test("sole proprietorship is detected from the registry's own company type (ZM-SON-013)", () => {
  const sole = normalizeGovernmentData({
    companyType: { value: "SOLE_PROPRIETORSHIP", source: "CCD" },
  });
  const llc = normalizeGovernmentData({
    companyType: { value: "LIMITED_LIABILITY", source: "CCD" },
  });
  assert.equal(isSoleProprietorship(sole), true);
  assert.equal(isSoleProprietorship(llc), false);
  // Absent company type is not an ineligibility finding.
  assert.equal(isSoleProprietorship(normalizeGovernmentData({})), false);
});

// --- IBAN input hygiene -----------------------------------------------------

test("a valid Jordanian IBAN passes, in any spacing or case", () => {
  assert.equal(validateIban("JO94CBJO0010000000000131000302"), null);
  assert.equal(validateIban("jo94 cbjo 0010 0000 0000 0131 0003 02"), null);
});

test("IBAN problems are distinguished so the message can be specific", () => {
  assert.equal(validateIban("not-an-iban"), "FORMAT");
  assert.equal(validateIban("GB82WEST12345698765432"), "COUNTRY");
  assert.equal(validateIban("JO94CBJO00100000000001"), "LENGTH");
  assert.equal(validateIban("JO95CBJO0010000000000131000302"), "CHECKSUM");
});

// --- Consents (ZM-SON-012) --------------------------------------------------

test("every catalogued consent is essential, so partial grants can't submit", () => {
  assert.ok(CONSENT_CATALOGUE.every((c) => c.essential));
  const partial = Object.fromEntries(CONSENT_CATALOGUE.map((c, i) => [c.consentType, i === 0]));
  const all = Object.fromEntries(CONSENT_CATALOGUE.map((c) => [c.consentType, true]));
  assert.equal(allEssentialGranted(partial), false);
  assert.equal(allEssentialGranted(all), true);
  assert.equal(allEssentialGranted({}), false);
});
