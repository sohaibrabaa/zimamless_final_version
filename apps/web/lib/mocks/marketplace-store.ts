/**
 * Listing + offer store for Phase 5 — the real deliverable, not the Phase 4
 * head-start's static two-listing stub (which is gone; see the daily log for
 * why keeping it around would have meant two competing sources of truth for
 * "what listings exist").
 *
 * Built on top of the real Phase 3 transaction store rather than invented
 * fixtures: activating a listing requires a genuinely `ELIGIBLE` transaction
 * (ZM-MKT-004), and the listing's supplier/buyer/invoice/risk data is read
 * live off that transaction, the supplier's Phase 2 onboarding application,
 * and the Phase 4 risk engine. Nothing about a listing's content is
 * hand-authored — the only invented value left anywhere in this pipeline
 * (Phase 4's placeholder `INV-2026-0004`) is gone along with the static seed
 * that carried it.
 *
 * Confidentiality (ZM-MKT-011/012, ZM-OFR-013): each bank's own offer is
 * tracked separately from every other bank's, and the functions here are the
 * allow-list boundary — `bankListingView`/`listOffersForBank`/
 * `listOffersForListing` never accept "give me everything" and always take
 * the calling bank's organization id as a required parameter that scopes the
 * result, mirroring the confidentiality-serializer discipline the phase file
 * asks for (Test Strategy 5.4) even though there is no real serializer layer
 * in a mock.
 */

import { computeListingDeadlines, isOfferWindowOpen, type ListingStatus } from "@/lib/marketplace/listing-domain";
import {
  computeCommission,
  computeNetSupplierPayout,
  isBelowFloor,
  LISTING_FEE_AMOUNT,
} from "@/lib/marketplace/offer-money";
import { evaluateEligibility, type EligibilityResult, type ListingFacts } from "@/lib/marketplace/policy-filters";
import type { OfferInputPayload } from "@/lib/marketplace/offer-domain";
import { contentHash } from "@/lib/contracts/contract-domain";
import { compareMoney, isValidMoneyString } from "@/lib/money";
import { computeRiskAssessment, type RiskInputs } from "@/lib/risk/risk-engine";
import type { RiskAssessment } from "@/lib/risk/risk-presentation";
import type { components } from "@/lib/api/generated/schema";
import { findApplicationByOrganization } from "./onboarding-store";
import { activeFilterFor } from "./policy-filter-store";
import { findTransaction, setTransactionState, type MockTransaction } from "./transaction-store";
import { getStoredRiskMode } from "./risk-mode-store";
import { ORG } from "./data";

type Buyer = components["schemas"]["Buyer"];
type BankListingView = components["schemas"]["BankListingView"];

// "Every active bank" (ZM-MKT-005) — there is no admin screen in this
// phase's scope to mark a bank inactive, so both seeded bank organizations
// are treated as active. Eligibility still depends on each bank's own
// policy filter matching, evaluated per listing below.
const ACTIVE_BANK_ORGS: { organizationId: string; bankName: string }[] = [
  { organizationId: ORG.jnb, bankName: "Jordan National Bank" },
  { organizationId: ORG.lcb, bankName: "Levant Commercial Bank" },
];

export interface OfferConditionRecord {
  id: string;
  conditionType: string;
  title: string;
  description: string;
  isMandatory: boolean;
  fulfilment: "PENDING" | "FULFILLED" | "WAIVED" | "FAILED";
  /** Set only once fulfilled (`POST /conditions/{id}/fulfil`) — evidence attached in the conditions checklist. */
  evidenceDocumentIds?: string[];
  fulfilmentNotes?: string;
}

export type OfferStatus =
  | "PENDING_INTERNAL_APPROVAL"
  | "ACTIVE"
  | "SELECTED"
  | "NOT_SELECTED"
  | "WITHDRAWN"
  | "EXPIRED";

export interface OfferRecord {
  id: string;
  listingId: string;
  bankOrganizationId: string;
  bankName: string;
  createdByUserId: string;
  createdByUserName: string;
  approvedByUserId?: string;
  approvedAt?: string;
  /** ZM-SEL-005: an explicit supplier act, never automatic. */
  selectedBy?: string;
  selectedAt?: string;
  status: OfferStatus;
  versionNumber: number;
  previousOfferId?: string;
  transactionType: string;
  recourseType: string;
  grossFundingAmount: string;
  bankDiscountAmount: string;
  bankFeesAmount: string;
  platformCommissionAmount: string;
  listingFeeAmount: string;
  otherDeductionsAmount: string;
  netSupplierPayout: string;
  expectedPayoutDate?: string;
  validUntil: string;
  conditions: OfferConditionRecord[];
  submittedAt: string;
}

export interface ListingRecord {
  id: string;
  transactionId: string;
  supplierOrganizationId: string;
  roundNumber: number;
  status: ListingStatus;
  activatedAt: string;
  offerSubmissionDeadline: string;
  supplierSelectionDeadline: string;
  listingFeeAmount: string;
  /** ZM-MKT-003: persisted per bank, not recomputed silently on every read. */
  eligibility: Record<string, EligibilityResult>;
}

let listings: ListingRecord[] = [];
let offers: OfferRecord[] = [];
let offerHistory: OfferRecord[] = [];
let sequence = 0;

function nextId(prefix: string): string {
  sequence += 1;
  return `0ef${prefix}0000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

export function resetMarketplaceMocks() {
  listings = [];
  offers = [];
  offerHistory = [];
  snapshots = [];
  idempotencyResults.clear();
  sequence = 0;
}

// ---------------------------------------------------------------------------
// Supplier identity + risk, read live off other stores rather than invented
// ---------------------------------------------------------------------------

function supplierIdentity(organizationId: string) {
  const application = findApplicationByOrganization(organizationId);
  const registryStatus = application?.governmentData?.registryStatus as
    | { value?: string | null }
    | undefined;
  return {
    legalName: application?.organizationName ?? "Unknown supplier",
    nationalEstablishmentNumber: application?.nationalEstablishmentNumber ?? "",
    registryStatus: (registryStatus?.value as string | undefined) ?? "ACTIVE",
  };
}

function tenorDaysFor(transaction: MockTransaction): number | null {
  const dueDate = transaction.invoice?.dueDate;
  if (!dueDate) return null;
  const due = new Date(`${dueDate}T00:00:00Z`).getTime();
  return Math.floor((due - Date.now()) / 86_400_000);
}

function riskFor(transaction: MockTransaction): RiskAssessment {
  const mode = getStoredRiskMode();
  const inputs: RiskInputs = {
    buyerRegistryStatus: transaction.buyer?.registryStatus,
    verificationOverallResult: transaction.verification?.overallResult as RiskInputs["verificationOverallResult"],
    tenorDays: tenorDaysFor(transaction),
    priorDuplicateFlags: 0,
    sourceAvailability: { ccdAvailable: true, istdAvailable: true, gamAvailable: true },
    mlUsed: mode === "ml",
    mlFallbackReason: mode === "rules-only" ? "ML_SERVICE_UNAVAILABLE" : undefined,
  };
  return computeRiskAssessment(inputs, new Date().toISOString());
}

function listingFacts(transaction: MockTransaction, risk: RiskAssessment): ListingFacts {
  return {
    outstandingAmount: transaction.outstandingAmount ?? "0.000",
    tenorDays: tenorDaysFor(transaction),
    compositeScore: risk.compositeScore ?? 0,
    band: (risk.band as ListingFacts["band"]) ?? "HIGH",
    buyerNationalEstablishmentNumber: transaction.buyer?.nationalEstablishmentNumber,
    supplierNationalEstablishmentNumber: supplierIdentity(transaction.organizationId).nationalEstablishmentNumber,
    buyerGovernorate: transaction.buyer?.governorate,
    documentTypes: transaction.documents.map((d) => d.documentType),
  };
}

// ---------------------------------------------------------------------------
// Listing activation (ZM-MKT-004..006)
// ---------------------------------------------------------------------------

export type ActivateListingResult =
  | { ok: true; listing: ListingRecord }
  | { ok: false; error: "NOT_FOUND" | "NOT_ELIGIBLE" | "ALREADY_LISTED" };

export function activateListing(transactionId: string): ActivateListingResult {
  const transaction = findTransaction(transactionId);
  if (!transaction) return { ok: false, error: "NOT_FOUND" };
  // Checked before the state check: once activation succeeds the
  // transaction leaves ELIGIBLE (below), so without this ordering a repeat
  // call would always report NOT_ELIGIBLE — true, but a less specific
  // answer than "you already listed this."
  if (listings.some((l) => l.transactionId === transactionId && l.status === "OPEN_FOR_OFFERS")) {
    return { ok: false, error: "ALREADY_LISTED" };
  }
  if (transaction.state !== "ELIGIBLE") return { ok: false, error: "NOT_ELIGIBLE" };

  const risk = riskFor(transaction);
  const facts = listingFacts(transaction, risk);
  const activatedAt = new Date();
  const deadlines = computeListingDeadlines(activatedAt);
  const roundNumber = listings.filter((l) => l.transactionId === transactionId).length + 1;

  const eligibility: Record<string, EligibilityResult> = {};
  for (const bank of ACTIVE_BANK_ORGS) {
    eligibility[bank.organizationId] = evaluateEligibility(activeFilterFor(bank.organizationId), facts);
  }

  const listing: ListingRecord = {
    id: nextId("l"),
    transactionId,
    supplierOrganizationId: transaction.organizationId,
    roundNumber,
    status: "OPEN_FOR_OFFERS",
    activatedAt: activatedAt.toISOString(),
    offerSubmissionDeadline: deadlines.offerSubmissionDeadline,
    supplierSelectionDeadline: deadlines.supplierSelectionDeadline,
    listingFeeAmount: LISTING_FEE_AMOUNT,
    eligibility,
  };
  listings = [listing, ...listings];
  // ZM-MKT-006: the invoice enters OPEN_FOR_OFFERS.
  setTransactionState(transactionId, "OPEN_FOR_OFFERS");
  return { ok: true, listing };
}

export function currentListingForTransaction(transactionId: string): ListingRecord | undefined {
  return listings.find((l) => l.transactionId === transactionId);
}

export function findListingRecord(id: string): ListingRecord | undefined {
  return listings.find((l) => l.id === id);
}

function offerCountForListing(listingId: string): number {
  return offers.filter(
    (o) => o.listingId === listingId && (o.status === "ACTIVE" || o.status === "PENDING_INTERNAL_APPROVAL")
  ).length;
}

/** Supplier/platform view — `Listing` shape, offerCount included (SUPPLIER ONLY). */
export function supplierListingView(listing: ListingRecord) {
  return {
    id: listing.id,
    transactionId: listing.transactionId,
    roundNumber: listing.roundNumber,
    status: listing.status,
    activatedAt: listing.activatedAt,
    offerSubmissionDeadline: listing.offerSubmissionDeadline,
    supplierSelectionDeadline: listing.supplierSelectionDeadline,
    listingFeeAmount: listing.listingFeeAmount,
    offerCount: offerCountForListing(listing.id),
  };
}

// ---------------------------------------------------------------------------
// Bank-facing views (confidentiality: no floor, no offerCount, no competitors)
// ---------------------------------------------------------------------------

export type BankListingResult = { ok: true; view: BankListingView } | { ok: false; error: "NOT_FOUND" | "NOT_ELIGIBLE" };

function toBankListingView(listing: ListingRecord, bankOrganizationId: string): BankListingView {
  const transaction = findTransaction(listing.transactionId)!;
  const risk = riskFor(transaction);
  const supplier = supplierIdentity(listing.supplierOrganizationId);
  const myOffer = offers.find(
    (o) => o.listingId === listing.id && o.bankOrganizationId === bankOrganizationId
  );
  return {
    listingId: listing.id,
    offerSubmissionDeadline: listing.offerSubmissionDeadline,
    supplier,
    buyer: transaction.buyer as Buyer,
    invoice: transaction.invoice,
    risk,
    documents: transaction.documents.map((d) => ({ id: d.id, documentType: d.documentType })),
    myOffer: myOffer ? toOfferView(myOffer) : undefined,
  };
}

export function bankListingView(listingId: string, bankOrganizationId: string): BankListingResult {
  const listing = findListingRecord(listingId);
  if (!listing) return { ok: false, error: "NOT_FOUND" };
  const eligibility = listing.eligibility[bankOrganizationId];
  if (!eligibility?.eligible) return { ok: false, error: "NOT_ELIGIBLE" };
  return { ok: true, view: toBankListingView(listing, bankOrganizationId) };
}

export function listEligibleListingsForBank(bankOrganizationId: string): BankListingView[] {
  return listings
    .filter((l) => l.eligibility[bankOrganizationId]?.eligible)
    .map((l) => toBankListingView(l, bankOrganizationId));
}

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

function toOfferView(offer: OfferRecord) {
  return {
    id: offer.id,
    listingId: offer.listingId,
    bankName: offer.bankName,
    status: offer.status,
    versionNumber: offer.versionNumber,
    previousOfferId: offer.previousOfferId,
    transactionType: offer.transactionType,
    recourseType: offer.recourseType,
    grossFundingAmount: offer.grossFundingAmount,
    bankDiscountAmount: offer.bankDiscountAmount,
    bankFeesAmount: offer.bankFeesAmount,
    platformCommissionAmount: offer.platformCommissionAmount,
    listingFeeAmount: offer.listingFeeAmount,
    otherDeductionsAmount: offer.otherDeductionsAmount,
    netSupplierPayout: offer.netSupplierPayout,
    expectedPayoutDate: offer.expectedPayoutDate,
    validUntil: offer.validUntil,
    conditions: offer.conditions,
    submittedAt: offer.submittedAt,
  };
}

/**
 * Includes maker identity (Q-14) and `transactionId` — approval-queue/
 * my-offers/offer-status screens only, never the bank-listing view.
 * `transactionId` rides along for the same reason `createdByUserId` does:
 * both endpoints this feeds are already scoped to the offer's own bank, and
 * a bank needs its own offer's transaction id to reach the Phase 6
 * conditions/contract endpoints, which are keyed by transaction, not by
 * listing or offer.
 */
function toOfferViewWithCreator(offer: OfferRecord) {
  const listing = findListingRecord(offer.listingId);
  return {
    ...toOfferView(offer),
    createdByUserId: offer.createdByUserId,
    createdByUserName: offer.createdByUserName,
    transactionId: listing?.transactionId,
  };
}

export type CreateOfferResult =
  | { ok: true; offer: OfferRecord }
  | { ok: false; error: "NOT_FOUND" | "NOT_ELIGIBLE" | "WINDOW_CLOSED" | "ALREADY_HAS_OFFER" | "INVALID_GROSS" | "BELOW_FLOOR" };

function buildOffer(
  listing: ListingRecord,
  transaction: MockTransaction,
  bank: { organizationId: string; bankName: string },
  actorUserId: string,
  actorUserName: string,
  input: OfferInputPayload,
  versionNumber: number,
  previousOfferId?: string
): { ok: true; offer: OfferRecord } | { ok: false; error: "INVALID_GROSS" | "BELOW_FLOOR" } {
  const gross = input.grossFundingAmount;
  const outstanding = transaction.outstandingAmount ?? "0.000";
  if (!isValidMoneyString(gross)) return { ok: false, error: "INVALID_GROSS" };
  // ZM-OFR-004: grossFundingAmount ≤ invoice.outstandingAmount.
  if (compareMoney(gross, outstanding) > 0) return { ok: false, error: "INVALID_GROSS" };

  const bankDiscountAmount = input.bankDiscountAmount ?? "0.000";
  const bankFeesAmount = input.bankFeesAmount ?? "0.000";
  const otherDeductionsAmount = input.otherDeductionsAmount ?? "0.000";
  const platformCommissionAmount = computeCommission(gross);
  const listingFeeAmount = listing.listingFeeAmount;

  const netSupplierPayout = computeNetSupplierPayout({
    grossFundingAmount: gross,
    bankDiscountAmount,
    bankFeesAmount,
    platformCommissionAmount,
    unpaidListingFeeAmount: listingFeeAmount,
    otherDeductionsAmount,
  });

  // ZM-MKT-012 / the design note under it: the floor check happens here,
  // server-side, and the caller (the handler) must render only the generic
  // rejection — this function does not even return the shortfall.
  if (transaction.minimumAcceptableAmount && isBelowFloor(netSupplierPayout, transaction.minimumAcceptableAmount)) {
    return { ok: false, error: "BELOW_FLOOR" };
  }

  const offer: OfferRecord = {
    id: nextId("o"),
    listingId: listing.id,
    bankOrganizationId: bank.organizationId,
    bankName: bank.bankName,
    createdByUserId: actorUserId,
    createdByUserName: actorUserName,
    status: "PENDING_INTERNAL_APPROVAL",
    versionNumber,
    previousOfferId,
    transactionType: input.transactionType,
    recourseType: input.recourseType,
    grossFundingAmount: gross,
    bankDiscountAmount,
    bankFeesAmount,
    platformCommissionAmount,
    listingFeeAmount,
    otherDeductionsAmount,
    netSupplierPayout,
    expectedPayoutDate: input.expectedPayoutDate,
    validUntil: input.validUntil,
    conditions: (input.conditions ?? []).map((c, i) => ({
      id: nextId(`c${i}`),
      conditionType: c.conditionType ?? "OTHER",
      title: c.title ?? "",
      description: c.description ?? "",
      isMandatory: c.isMandatory ?? false,
      fulfilment: "PENDING",
    })),
    submittedAt: new Date().toISOString(),
  };
  return { ok: true, offer };
}

export function createOffer(
  listingId: string,
  bankOrganizationId: string,
  actorUserId: string,
  actorUserName: string,
  input: OfferInputPayload
): CreateOfferResult {
  const listing = findListingRecord(listingId);
  if (!listing) return { ok: false, error: "NOT_FOUND" };
  if (!listing.eligibility[bankOrganizationId]?.eligible) return { ok: false, error: "NOT_ELIGIBLE" };
  if (!isOfferWindowOpen(listing.offerSubmissionDeadline)) return { ok: false, error: "WINDOW_CLOSED" };
  const existing = offers.find(
    (o) => o.listingId === listingId && o.bankOrganizationId === bankOrganizationId && o.status !== "WITHDRAWN"
  );
  if (existing) return { ok: false, error: "ALREADY_HAS_OFFER" };

  const transaction = findTransaction(listing.transactionId);
  if (!transaction) return { ok: false, error: "NOT_FOUND" };
  const bank = ACTIVE_BANK_ORGS.find((b) => b.organizationId === bankOrganizationId);
  if (!bank) return { ok: false, error: "NOT_ELIGIBLE" };

  const built = buildOffer(listing, transaction, bank, actorUserId, actorUserName, input, 1);
  if (!built.ok) return built;
  offers = [...offers, built.offer];
  return { ok: true, offer: built.offer };
}

export type ReviseOfferResult = CreateOfferResult;

export function reviseOffer(
  offerId: string,
  bankOrganizationId: string,
  actorUserId: string,
  actorUserName: string,
  input: OfferInputPayload
): ReviseOfferResult {
  const current = offers.find((o) => o.id === offerId && o.bankOrganizationId === bankOrganizationId);
  if (!current) return { ok: false, error: "NOT_FOUND" };
  if (current.status !== "ACTIVE" && current.status !== "PENDING_INTERNAL_APPROVAL") {
    return { ok: false, error: "ALREADY_HAS_OFFER" };
  }
  const listing = findListingRecord(current.listingId);
  if (!listing) return { ok: false, error: "NOT_FOUND" };
  if (!isOfferWindowOpen(listing.offerSubmissionDeadline)) return { ok: false, error: "WINDOW_CLOSED" };

  const transaction = findTransaction(listing.transactionId);
  if (!transaction) return { ok: false, error: "NOT_FOUND" };
  const bank = ACTIVE_BANK_ORGS.find((b) => b.organizationId === bankOrganizationId);
  if (!bank) return { ok: false, error: "NOT_ELIGIBLE" };

  const built = buildOffer(
    listing,
    transaction,
    bank,
    actorUserId,
    actorUserName,
    input,
    current.versionNumber + 1,
    current.id
  );
  if (!built.ok) return built;

  // ZM-OFR-013: revisions supersede; every prior version is retained immutably.
  offerHistory = [...offerHistory, current];
  offers = offers.map((o) => (o.id === current.id ? built.offer : o));
  return { ok: true, offer: built.offer };
}

export type WithdrawOfferResult = { ok: true } | { ok: false; error: "NOT_FOUND" | "INVALID_STATE" };

export function withdrawOffer(offerId: string, bankOrganizationId: string): WithdrawOfferResult {
  const offer = offers.find((o) => o.id === offerId && o.bankOrganizationId === bankOrganizationId);
  if (!offer) return { ok: false, error: "NOT_FOUND" };
  if (offer.status !== "ACTIVE" && offer.status !== "PENDING_INTERNAL_APPROVAL") {
    return { ok: false, error: "INVALID_STATE" };
  }
  offer.status = "WITHDRAWN";
  return { ok: true };
}

export type ApproveOfferResult =
  | { ok: true }
  | { ok: false; error: "NOT_FOUND" | "INVALID_STATE" | "SELF_APPROVAL_FORBIDDEN" };

/** ZM-ROL-002 / ZM-OFR-016: rejected server-side even though the UI also blocks it. */
export function approveOffer(
  offerId: string,
  approverOrganizationId: string,
  approverUserId: string
): ApproveOfferResult {
  const offer = offers.find((o) => o.id === offerId && o.bankOrganizationId === approverOrganizationId);
  if (!offer) return { ok: false, error: "NOT_FOUND" };
  if (offer.status !== "PENDING_INTERNAL_APPROVAL") return { ok: false, error: "INVALID_STATE" };
  if (offer.createdByUserId === approverUserId) return { ok: false, error: "SELF_APPROVAL_FORBIDDEN" };
  offer.status = "ACTIVE";
  offer.approvedByUserId = approverUserId;
  offer.approvedAt = new Date().toISOString();
  return { ok: true };
}

export function findOffer(offerId: string) {
  return offers.find((o) => o.id === offerId);
}

/** `/offers` — this bank's own offers, any status. Used by both my-offers and the approval queue (status filter). */
export function listOffersForBank(bankOrganizationId: string, status?: string) {
  return offers
    .filter((o) => o.bankOrganizationId === bankOrganizationId && (!status || o.status === status))
    .map(toOfferViewWithCreator);
}

/**
 * `/listings/{id}/offers` — role-split. Supplier/platform sees every ACTIVE
 * offer in full; a bank sees only its own current offer (any status), never
 * another bank's, never a competitor count (ZM-MKT-011/013).
 */
export function listOffersForListing(
  listingId: string,
  callerOrganizationId: string,
  callerIsBank: boolean
) {
  if (callerIsBank) {
    return offers
      .filter((o) => o.listingId === listingId && o.bankOrganizationId === callerOrganizationId)
      .map(toOfferView);
  }
  return offers.filter((o) => o.listingId === listingId && o.status === "ACTIVE").map(toOfferView);
}

export function offerBelongsToOrganization(offerId: string, organizationId: string): boolean {
  return offers.some((o) => o.id === offerId && o.bankOrganizationId === organizationId);
}

// ---------------------------------------------------------------------------
// Acceptance (§12.1) — the highest-risk code in the system. A mock cannot
// reproduce a real `SELECT … FOR UPDATE` database transaction, but every
// *observable* invariant §12.1 lists is enforced here: a locked transaction
// can never be locked twice, every other active/pending offer on the same
// listing is marked NOT_SELECTED in the same call, the snapshot is written
// before this function returns (never "eventually"), and an idempotency-key
// replay returns the original result without re-running any of it.
// ---------------------------------------------------------------------------

export interface AcceptedOfferSnapshotRecord {
  id: string;
  transactionId: string;
  offerId: string;
  bankOrganizationId: string;
  bankName: string;
  supplierOrganizationId: string;
  transactionType: string;
  recourseType: string;
  grossFundingAmount: string;
  bankDiscountAmount: string;
  bankFeesAmount: string;
  platformCommissionAmount: string;
  listingFeeAmount: string;
  otherDeductionsAmount: string;
  netSupplierPayout: string;
  expectedPayoutDate?: string;
  validUntil: string;
  conditions: OfferConditionRecord[];
  sourceOfferVersion: number;
  selectedBy: string;
  selectedAt: string;
  snapshotHash: string;
}

let snapshots: AcceptedOfferSnapshotRecord[] = [];
const idempotencyResults = new Map<string, AcceptOfferResult>();

export type AcceptOfferResult =
  | { ok: true; snapshot: AcceptedOfferSnapshotRecord }
  | {
      ok: false;
      error: "NOT_FOUND" | "ALREADY_LOCKED" | "OFFER_NOT_ACTIVE" | "OFFER_EXPIRED" | "BELOW_FLOOR" | "INVALID_GROSS";
    };

function snapshotContent(offer: OfferRecord, transactionId: string): string {
  return JSON.stringify({
    transactionId,
    offerId: offer.id,
    versionNumber: offer.versionNumber,
    grossFundingAmount: offer.grossFundingAmount,
    bankDiscountAmount: offer.bankDiscountAmount,
    bankFeesAmount: offer.bankFeesAmount,
    platformCommissionAmount: offer.platformCommissionAmount,
    listingFeeAmount: offer.listingFeeAmount,
    otherDeductionsAmount: offer.otherDeductionsAmount,
    netSupplierPayout: offer.netSupplierPayout,
    conditions: offer.conditions,
  });
}

/**
 * ZM-SEL-001..008. `supplierOrganizationId` and `idempotencyKey` are both
 * required — the former is the ownership check (a supplier can only accept
 * an offer on their own listing), the latter is what makes a network retry
 * safe (a second call with the same key returns the first call's exact
 * result rather than double-locking or double-notifying).
 */
export function acceptOffer(
  offerId: string,
  supplierOrganizationId: string,
  actorUserId: string,
  idempotencyKey: string
): AcceptOfferResult {
  const cached = idempotencyResults.get(idempotencyKey);
  if (cached) return cached;

  const result = acceptOfferUncached(offerId, supplierOrganizationId, actorUserId);
  idempotencyResults.set(idempotencyKey, result);
  return result;
}

function acceptOfferUncached(
  offerId: string,
  supplierOrganizationId: string,
  actorUserId: string
): AcceptOfferResult {
  const offer = offers.find((o) => o.id === offerId);
  if (!offer) return { ok: false, error: "NOT_FOUND" };
  const listing = findListingRecord(offer.listingId);
  if (!listing || listing.supplierOrganizationId !== supplierOrganizationId) {
    return { ok: false, error: "NOT_FOUND" };
  }
  const transaction = findTransaction(listing.transactionId);
  if (!transaction) return { ok: false, error: "NOT_FOUND" };

  // ZM-SEL-004: the lock check comes first and is checked against the
  // transaction, not the offer — this is what makes a second acceptance
  // attempt (on this offer or any other on the same listing) impossible
  // once the first has landed.
  if (transaction.lockedAt) return { ok: false, error: "ALREADY_LOCKED" };
  if (offer.status !== "ACTIVE") return { ok: false, error: "OFFER_NOT_ACTIVE" };
  if (!isOfferWindowOpen(offer.validUntil)) return { ok: false, error: "OFFER_EXPIRED" };

  const outstanding = transaction.outstandingAmount ?? "0.000";
  if (compareMoney(offer.grossFundingAmount, outstanding) > 0) return { ok: false, error: "INVALID_GROSS" };
  if (
    transaction.minimumAcceptableAmount &&
    isBelowFloor(offer.netSupplierPayout, transaction.minimumAcceptableAmount)
  ) {
    return { ok: false, error: "BELOW_FLOOR" };
  }

  const now = new Date().toISOString();

  // Every other active/pending offer on this listing loses, in the same
  // call — ZM-SEL-002 step 6.
  offers = offers.map((o) => {
    if (o.listingId !== listing.id || o.id === offer.id) return o;
    if (o.status === "ACTIVE" || o.status === "PENDING_INTERNAL_APPROVAL") {
      return { ...o, status: "NOT_SELECTED" as OfferStatus };
    }
    return o;
  });

  offer.status = "SELECTED";
  offer.selectedBy = actorUserId;
  offer.selectedAt = now;

  listing.status = "OFFER_SELECTED";
  transaction.lockedAt = now;
  // §8.6/§10.5: OFFER_ACCEPTED, or straight to CONDITIONS_PENDING if this
  // offer actually has mandatory conditions to clear before a contract can
  // generate (ZM-CON-006) — never silently skipped.
  setTransactionState(
    transaction.id!,
    offer.conditions.some((c) => c.isMandatory) ? "CONDITIONS_PENDING" : "OFFER_ACCEPTED"
  );

  const snapshot: AcceptedOfferSnapshotRecord = {
    id: nextId("snap"),
    transactionId: transaction.id!,
    offerId: offer.id,
    bankOrganizationId: offer.bankOrganizationId,
    bankName: offer.bankName,
    supplierOrganizationId,
    transactionType: offer.transactionType,
    recourseType: offer.recourseType,
    grossFundingAmount: offer.grossFundingAmount,
    bankDiscountAmount: offer.bankDiscountAmount,
    bankFeesAmount: offer.bankFeesAmount,
    platformCommissionAmount: offer.platformCommissionAmount,
    listingFeeAmount: offer.listingFeeAmount,
    otherDeductionsAmount: offer.otherDeductionsAmount,
    netSupplierPayout: offer.netSupplierPayout,
    expectedPayoutDate: offer.expectedPayoutDate,
    validUntil: offer.validUntil,
    // A copy, not a reference — ZM-SEL-008: the snapshot must stay
    // unchanged even if the source offer is later modified. There is no
    // path that mutates a SELECTED offer's conditions after this point,
    // but the copy makes that a non-issue rather than an invariant someone
    // has to remember never to break.
    conditions: offer.conditions.map((c) => ({ ...c })),
    sourceOfferVersion: offer.versionNumber,
    selectedBy: actorUserId,
    selectedAt: now,
    snapshotHash: contentHash(snapshotContent(offer, transaction.id!)),
  };
  snapshots = [...snapshots, snapshot];

  return { ok: true, snapshot };
}

export function findSnapshotForTransaction(transactionId: string): AcceptedOfferSnapshotRecord | undefined {
  return snapshots.find((s) => s.transactionId === transactionId);
}

/**
 * `POST /conditions/{id}/fulfil` is keyed on the condition alone — the
 * contract has no transaction id in that path — so fulfilling one has to
 * find its owning snapshot by searching every condition on every snapshot.
 * Condition ids are generated per-snapshot (`nextId`), so this is exact,
 * not a heuristic.
 */
export function findSnapshotByConditionId(conditionId: string): AcceptedOfferSnapshotRecord | undefined {
  return snapshots.find((s) => s.conditions.some((c) => c.id === conditionId));
}

export type RejectAllResult = { ok: true } | { ok: false; error: "NOT_FOUND" };

/** ZM-MKT (§10.5 outcomes table): the transaction returns to ELIGIBLE, free to be relisted. */
export function rejectAllOffers(listingId: string, supplierOrganizationId: string): RejectAllResult {
  const listing = findListingRecord(listingId);
  if (!listing || listing.supplierOrganizationId !== supplierOrganizationId) {
    return { ok: false, error: "NOT_FOUND" };
  }
  offers = offers.map((o) => {
    if (o.listingId !== listingId) return o;
    if (o.status === "ACTIVE" || o.status === "PENDING_INTERNAL_APPROVAL") {
      return { ...o, status: "NOT_SELECTED" as OfferStatus };
    }
    return o;
  });
  listing.status = "CANCELLED";
  setTransactionState(listing.transactionId, "ELIGIBLE");
  return { ok: true };
}
